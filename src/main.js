import { Actor, log } from 'apify';
import { crawlAggregators } from './crawlers/aggregatorCrawler.js';
import { crawlClubSites } from './crawlers/clubSiteCrawler.js';
import { discoverClubSitesViaMaps } from './crawlers/mapsDiscoveryCrawler.js';
import { crawlFacebookEvents, crawlFacebookVenuePages } from './crawlers/facebookEventsCrawler.js';
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

// The Actor's run timeout is a platform setting, not something actor.json can control, and
// it defaults to 300s — a run that overshoots is aborted having pushed nothing at all. So
// reserve the tail of the budget for the steps that actually produce output (remaining
// geocoding, dedupe, pushData, the email digest) and stop starting new club-site crawls
// once it's gone. Assumes the 300s default; harmless if the timeout has been raised, since
// a fast run never reaches the deadline.
const ASSUMED_RUN_TIMEOUT_MS = 300_000;
const OUTPUT_RESERVE_MS = 75_000;

// Wider than the Czech Republic is across, so any "city" resolving further than this is a
// mis-geocode rather than a real place — see cityIsPlausiblyInRange.
const IMPLAUSIBLE_CITY_DISTANCE_KM = 1000;

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

const runStartedAt = Date.now();
const clubCrawlDeadline = runStartedAt + ASSUMED_RUN_TIMEOUT_MS - OUTPUT_RESERVE_MS;

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        city,
        radiusKm = 30,
        genres = ['techno', 'house', 'drum_and_bass', 'electronic'],
        dateRangeDays = 30,
        includeFacebookEvents = false,
        includeFacebookVenuePages = true,
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
    // in range. Facebook pages are excluded from *this* step: website-content-crawler in
    // cheerio mode gets nothing useful from facebook.com (it needs JS and a session). Maps
    // discovery frequently returns a venue's Facebook page as its "website", and those are
    // routed to crawlFacebookVenuePages below instead, which is the right tool for them.
    const crawlableVenues = [...CLUB_SITES, ...mapsVenues.filter((v) => !/facebook\.com/i.test(v.url))];
    const inRangeVenues = [];
    for (const site of crawlableVenues) {
        if (await venueCouldBeInRange(site, cityCoords, radiusKm)) inRangeVenues.push(site);
    }
    log.info(
        `Crawling ${inRangeVenues.length} of ${crawlableVenues.length} club site(s) — ` +
            `skipped ${crawlableVenues.length - inRangeVenues.length} too far from "${city}" to matter.`,
    );
    const clubEvents = await crawlClubSites(inRangeVenues, { deadline: clubCrawlDeadline });

    // Facebook events straight off in-range venues' own pages. Unlike Facebook *search*
    // (off by default — see README), this is targeted: it only asks about venues already
    // established to be nearby, and verified live to return dated events with coordinates.
    // Sources are the seed list's verified facebookPage entries plus any Maps-discovered
    // venue whose "website" is itself a Facebook page.
    const venuePages = [
        ...inRangeVenues.filter((v) => v.facebookPage).map((v) => ({ ...v, facebookPage: v.facebookPage })),
        ...mapsVenues
            .filter((v) => /facebook\.com/i.test(v.url))
            .filter((v) => typeof v.lat !== 'number' || haversineDistanceKm(cityCoords, { lat: v.lat, lon: v.lon }) <= radiusKm)
            .map((v) => ({ ...v, facebookPage: v.url })),
    ];
    const facebookVenueEvents = includeFacebookVenuePages
        ? await crawlFacebookVenuePages({ venues: venuePages, maxFacebookEvents })
        : [];

    let candidates = [...raEvents, ...aggregatorEvents, ...clubEvents, ...facebookVenueEvents, ...facebookEvents];
    log.info(
        `Collected ${candidates.length} raw candidate event(s): ` +
            `${raEvents.length} Resident Advisor, ${aggregatorEvents.length} aggregator, ` +
            `${clubEvents.length} club site, ${facebookVenueEvents.length} Facebook venue page, ` +
            `${facebookEvents.length} Facebook search.`,
    );

    // Keep only events matching a requested genre (an event can match more than one).
    candidates = candidates.filter((event) => event.genres.some((g) => genres.includes(g)));
    log.info(`${candidates.length} remain after genre filtering (requested: ${genres.join(', ')}).`);

    // Keep only events within the requested date range.
    candidates = candidates.filter((event) => withinDateRange(event.date, dateRangeDays));
    log.info(`${candidates.length} remain after date filtering (next ${dateRangeDays} day(s)).`);

    // Coarse pass first: drop whole cities before geocoding a single venue in them.
    // Nominatim's usage policy caps us at 1 request/second, so per-venue geocoding is the
    // dominant cost in the run's fixed time budget. Resident Advisor returns the whole
    // country (105 of its ~114 Czech events are in Prague), and geocoding each of those
    // individually burned ~110 seconds per run to then discard all of them for being 350km
    // away. Geocoding "Prague" *once* rules out the lot. Same slack as the venue pre-filter,
    // since a venue can sit out toward the edge of a large city.
    const cityDistanceCache = new Map();
    async function cityIsPlausiblyInRange(eventCity) {
        if (!eventCity) return true; // no city to judge by — fall through to per-venue geocoding
        if (!cityDistanceCache.has(eventCity)) {
            const coords = await geocode(withCountry(eventCity));
            cityDistanceCache.set(
                eventCity,
                coords ? haversineDistanceKm(cityCoords, coords) : null,
            );
        }
        const distance = cityDistanceCache.get(eventCity);
        if (distance === null) return true; // couldn't place the city — don't discard on that basis
        // Sanity bound: this Actor's scope is one country, so a "city" that resolves further
        // than IMPLAUSIBLE_CITY_DISTANCE_KM is a bad geocode rather than a real faraway city
        // (a source once reported its country-wide area as a city literally named "All",
        // which geocoded ~9,700km away). Don't drop events on the strength of that — let
        // them through to be placed by their own venue address.
        if (distance > IMPLAUSIBLE_CITY_DISTANCE_KM) {
            log.warning(`Ignoring implausible city distance for "${eventCity}" (${Math.round(distance)}km) — placing those events by venue instead.`);
            return true;
        }
        return distance <= radiusKm + VENUE_CITY_SLACK_KM;
    }

    const beforeCityFilter = candidates.length;
    const cityFiltered = [];
    for (const event of candidates) {
        // Events that already carry exact coordinates skip this — they're judged directly.
        const hasCoords = typeof event.lat === 'number' && typeof event.lon === 'number';
        if (hasCoords || (await cityIsPlausiblyInRange(event.city))) cityFiltered.push(event);
    }
    candidates = cityFiltered;
    log.info(
        `${candidates.length} remain after city-level pre-filter ` +
            `(dropped ${beforeCityFilter - candidates.length} in cities outside the radius, without geocoding each venue).`,
    );

    // Fine pass: geocode the remaining venues and filter precisely. Events whose venue
    // coordinates are already known (Maps discovery, Facebook) skip this entirely.
    const withDistance = [];
    let uncodableCount = 0;
    let tooFarCount = 0;
    for (const event of candidates) {
        let venueCoords = typeof event.lat === 'number' && typeof event.lon === 'number' ? { lat: event.lat, lon: event.lon } : null;
        if (!venueCoords) {
            // Never fold the *input* city into this query. Doing so was the bug that let a
            // Berlin Facebook event pass a 50km radius filter — "{Berlin venue}, Návsí" doesn't
            // resolve to the venue, so Nominatim fell back to matching Návsí itself, i.e. ~0km
            // away. It also broke the reverse case: a Resident Advisor event whose only
            // locator is an address became "Sklub, Návsí" and failed to resolve at all,
            // which is why a Návsí run reported 12 otherwise-good events as unplaceable.
            //
            // A street address already names its own locality (RA returns e.g.
            // "Krymská 21, Praha"), so it's used alone. Only a bare venue name needs a city,
            // and only the event's own.
            const query = event.address
                ? withCountry(event.address)
                : withCountry([event.venue, event.city].filter(Boolean).join(', '));
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
