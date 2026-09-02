import { Actor, log } from 'apify';
import { crawlAggregators } from './crawlers/aggregatorCrawler.js';
import { crawlClubSites } from './crawlers/clubSiteCrawler.js';
import { discoverClubSitesViaMaps } from './crawlers/mapsDiscoveryCrawler.js';
import { crawlFacebookEvents } from './crawlers/facebookEventsCrawler.js';
import { CLUB_SITES } from './sources/seedSources.js';
import { geocode, haversineDistanceKm } from './geocode.js';
import { dedupeEvents } from './dedupe.js';
import { maybeSendDigest } from './email.js';

const CONFIDENCE_RANK = { high: 0, moderate: 1, low: 2 };

// Appends ", Czech Republic" for Nominatim, unless the place already names the country —
// e.g. a user typing "Návsí, Czech Republic" as the city input would otherwise end up
// geocoding "Návsí, Czech Republic, Czech Republic", which Nominatim fails to resolve.
function withCountry(place) {
    return /czech/i.test(place) ? place : `${place}, Czech Republic`;
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
        maxFacebookEvents = 50,
        maxMapsVenues = 20,
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

    // Apify's concurrent-Actor-run cap is shared across the whole account (confirmed live:
    // 5 total, including this Actor's own run). Aggregators run in-process (Crawlee's own
    // CheerioCrawler, not a separate Actor call) so they're free to run alongside anything;
    // Maps discovery and Facebook are each one Actor call, so running those two together
    // with this run itself is 3 of the 5 slots — safe. Club sites are crawled *after* this
    // resolves, not concurrently with it: two 5-wide crawl pools (seeded + Maps-discovered)
    // running at the same time as Maps discovery and Facebook were blowing straight through
    // the cap, and every club-site crawl failed outright as a result.
    const [aggregatorEvents, mapsVenues, facebookEvents] = await Promise.all([
        crawlAggregators(),
        discoverClubSitesViaMaps({ cityCoords, radiusKm, maxMapsVenues }),
        includeFacebookEvents ? crawlFacebookEvents({ genres, city, maxFacebookEvents }) : Promise.resolve([]),
    ]);

    // Seeded and Maps-discovered venues share one crawl pool (see CLUB_SITE_CONCURRENCY).
    const clubEvents = await crawlClubSites([...CLUB_SITES, ...mapsVenues]);

    let candidates = [...aggregatorEvents, ...clubEvents, ...facebookEvents];
    log.info(
        `Collected ${candidates.length} raw candidate event(s): ` +
            `${aggregatorEvents.length} aggregator, ${clubEvents.length} club ` +
            `(${CLUB_SITES.length} seeded + ${mapsVenues.length} Maps-discovered), ${facebookEvents.length} Facebook.`,
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
