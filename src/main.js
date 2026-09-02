import { Actor, log } from 'apify';
import { crawlAggregators } from './crawlers/aggregatorCrawler.js';
import { crawlClubSites } from './crawlers/clubSiteCrawler.js';
import { discoverClubSitesViaMaps } from './crawlers/mapsDiscoveryCrawler.js';
import { crawlFacebookEvents } from './crawlers/facebookEventsCrawler.js';
import { crawlResidentAdvisor } from './crawlers/residentAdvisorCrawler.js';
import { CLUB_SITES } from './sources/seedSources.js';
import { findNearbyTowns } from './nearbyTowns.js';
import { geocode, haversineDistanceKm } from './geocode.js';
import { dedupeEvents } from './dedupe.js';
import { maybeSendDigest } from './email.js';

const CONFIDENCE_RANK = { high: 0, moderate: 1, low: 2 };

// Allows for a venue sitting out toward the edge of a large city rather than at the point its
// city name geocodes to. Only applies to seeded venues, where all we know is the city —
// Maps-discovered venues carry their own exact coordinates and are filtered strictly.
const VENUE_CITY_SLACK_KM = 15;

// Appends ", Czech Republic" for Nominatim, unless the place already names the country —
// e.g. a user typing "Návsí, Czech Republic" as the city input would otherwise end up
// geocoding "Návsí, Czech Republic, Czech Republic", which Nominatim fails to resolve.
function withCountry(place) {
    return /czech/i.test(place) ? place : `${place}, Czech Republic`;
}

/**
 * True if a venue could plausibly fall inside the search radius, so it's worth spending an
 * Actor call crawling it. Searching Návsí previously crawled Cross Club, Roxy, Ankali,
 * MeetFactory, Lucerna and the rest of the Prague/Brno seed list — ~350km away, one Actor
 * call each, every resulting event discarded by the radius filter afterwards.
 * Errs toward keeping a venue: if it can't be placed at all, crawl it and let the per-event
 * radius filter decide.
 */
async function venueCouldBeInRange(site, cityCoords, radiusKm) {
    if (typeof site.lat === 'number' && typeof site.lon === 'number') {
        return haversineDistanceKm(cityCoords, { lat: site.lat, lon: site.lon }) <= radiusKm;
    }
    if (!site.city) return true;
    const coords = await geocode(withCountry(site.city));
    if (!coords) return true;
    return haversineDistanceKm(cityCoords, coords) <= radiusKm + VENUE_CITY_SLACK_KM;
}

function withinDateRange(isoDate, dateRangeDays) {
    if (!isoDate) return false;
    const date = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return false;

    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rangeEnd = new Date(todayUtc.getTime() + dateRangeDays * 24 * 60 * 60 * 1000);

    return date >= todayUtc && date <= rangeEnd;
}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        city,
        radiusKm = 30,
        genres = ['techno', 'house', 'drum_and_bass', 'electronic'],
        dateRangeDays = 30,
        includeFacebookEvents = true,
        maxFacebookEvents = 20,
        maxMapsVenues = 5,
        subscriberEmail,
        digestFrequency = 'weekly',
        resendApiKey,
    } = input;

    if (!city) {
        throw new Error('Input is missing required field "city".');
    }

    log.info(`Rave Finder starting for "${city}", radius ${radiusKm}km, genres: ${genres.join(', ')}.`);

    const cityCoords = await geocode(withCountry(city));
    if (!cityCoords) {
        throw new Error(`Could not geocode city "${city}" — check the spelling and try again.`);
    }

    // Work is split into phases because Apify's concurrent-Actor-run cap is shared across the
    // whole account (confirmed live: 5 total, including this Actor's own run). Running
    // everything at once blew straight through it and failed every club-site crawl outright.
    //
    // Phase 1 — sources that cost no Actor slots at all (aggregators run in-process via
    // Crawlee; Resident Advisor and the nearby-town lookup are plain HTTPS calls to free,
    // keyless APIs), plus Maps discovery, which is the one Actor call here.
    const [aggregatorEvents, raEvents, mapsVenues, nearbyTowns] = await Promise.all([
        crawlAggregators(),
        crawlResidentAdvisor({ dateRangeDays }),
        discoverClubSitesViaMaps({ cityCoords, radiusKm, maxMapsVenues }),
        includeFacebookEvents ? findNearbyTowns({ center: cityCoords, radiusKm }) : Promise.resolve([]),
    ]);

    // Phase 2 — Facebook, which needs phase 1's nearby-town list to search places Facebook
    // actually indexes rather than the literal input city.
    const facebookEvents = includeFacebookEvents
        ? await crawlFacebookEvents({ genres, city, searchCities: nearbyTowns, maxFacebookEvents })
        : [];

    // Phase 3 — club sites, one Actor call each, so only crawl venues that could actually be
    // in range. Facebook pages are excluded outright: website-content-crawler in cheerio mode
    // gets nothing useful from facebook.com (it needs JS and a session), and Maps discovery
    // frequently returns a venue's Facebook page as its "website". Feeding those to
    // facebook-events-scraper as startUrls would be the better use of them, but that Actor
    // documents startUrls as event/search URLs rather than venue page URLs — unverified, so
    // not wired up on a guess.
    const crawlableVenues = [...CLUB_SITES, ...mapsVenues.filter((v) => !/facebook\.com/i.test(v.url))];
    const inRangeVenues = [];
    for (const site of crawlableVenues) {
        if (await venueCouldBeInRange(site, cityCoords, radiusKm)) inRangeVenues.push(site);
    }
    log.info(
        `Crawling ${inRangeVenues.length} of ${crawlableVenues.length} club site(s) — ` +
            `skipped ${crawlableVenues.length - inRangeVenues.length} too far from "${city}" to matter.`,
    );
    const clubEvents = await crawlClubSites(inRangeVenues);

    let candidates = [...raEvents, ...aggregatorEvents, ...clubEvents, ...facebookEvents];
    log.info(
        `Collected ${candidates.length} raw candidate event(s): ` +
            `${raEvents.length} Resident Advisor, ${aggregatorEvents.length} aggregator, ` +
            `${clubEvents.length} club, ${facebookEvents.length} Facebook.`,
    );

    // Keep only events matching a requested genre (an event can match more than one).
    candidates = candidates.filter((event) => event.genres.some((g) => genres.includes(g)));
    log.info(`${candidates.length} remain after genre filtering (requested: ${genres.join(', ')}).`);

    // Keep only events within the requested date range.
    candidates = candidates.filter((event) => withinDateRange(event.date, dateRangeDays));
    log.info(`${candidates.length} remain after date filtering (next ${dateRangeDays} day(s)).`);

    // Geocode each venue (cached) and filter by distance from the city center. Events whose
    // venue coordinates are already known (Maps-discovered venues carry their own lat/lon)
    // skip this — no point re-geocoding a place Google Maps already located precisely.
    const withDistance = [];
    let uncodableCount = 0;
    let tooFarCount = 0;
    for (const event of candidates) {
        let venueCoords = typeof event.lat === 'number' && typeof event.lon === 'number' ? { lat: event.lat, lon: event.lon } : null;
        if (!venueCoords) {
            // Prefer the event's own city (e.g. a Facebook event's actual location) over the
            // input city — using the input city here was the bug that let a Berlin Facebook
            // event pass a 50km radius filter: the query became "{Berlin venue}, {input city}",
            // which Nominatim couldn't resolve to the real venue and fell back to matching just
            // the input city itself, i.e. ~0km away.
            const eventCity = event.city || city;
            const query = withCountry(event.address ? `${event.address}, ${eventCity}` : `${event.venue}, ${eventCity}`);
            venueCoords = await geocode(query);
        }
        if (!venueCoords) {
            uncodableCount += 1;
            continue; // can't place it, can't filter it by radius — drop it
        }

        const distanceKm = haversineDistanceKm(cityCoords, venueCoords);
        if (distanceKm > radiusKm) {
            tooFarCount += 1;
            continue;
        }

        withDistance.push({
            ...event,
            lat: venueCoords.lat,
            lon: venueCoords.lon,
            distanceKm,
            city: event.city || city,
        });
    }

    log.info(
        `${withDistance.length} remain after geocoding + radius filtering (within ${radiusKm}km) — ` +
            `dropped ${uncodableCount} unplaceable, ${tooFarCount} too far.`,
    );

    // Dedupe across sources, preferring higher-confidence sources when the same event
    // appears more than once (sort so the highest-confidence copy is seen first and kept).
    withDistance.sort((a, b) => (CONFIDENCE_RANK[a.confidence] ?? 1) - (CONFIDENCE_RANK[b.confidence] ?? 1));
    const finalEvents = dedupeEvents(withDistance);

    log.info(`${finalEvents.length} event(s) after dedup — final result.`);

    await Actor.pushData(
        finalEvents.map((event) => ({
            eventName: event.eventName,
            date: event.date,
            venue: event.venue,
            address: event.address,
            city: event.city,
            lat: event.lat,
            lon: event.lon,
            distanceKm: Math.round(event.distanceKm * 10) / 10,
            genres: event.genres,
            sourceName: event.sourceName,
            sourceUrl: event.sourceUrl,
            description: event.description,
            confidence: event.confidence,
        })),
    );

    await maybeSendDigest({ subscriberEmail, resendApiKey, digestFrequency, events: finalEvents });

    await Actor.exit();
} catch (err) {
    log.error(err.message);
    await Actor.exit({ exitCode: 1, statusMessage: err.message });
}
