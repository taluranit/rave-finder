import { Actor, log } from 'apify';
import { crawlAggregators } from './crawlers/aggregatorCrawler.js';
import { crawlClubSites } from './crawlers/clubSiteCrawler.js';
import { discoverClubSitesViaMaps } from './crawlers/mapsDiscoveryCrawler.js';
import { crawlFacebookEvents } from './crawlers/facebookEventsCrawler.js';
import { geocode, haversineDistanceKm } from './geocode.js';
import { dedupeEvents } from './dedupe.js';
import { maybeSendDigest } from './email.js';

const CONFIDENCE_RANK = { high: 0, moderate: 1, low: 2 };

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
        genres = ['techno', 'house', 'drum_and_bass'],
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

    const cityCoords = await geocode(`${city}, Czech Republic`);
    if (!cityCoords) {
        throw new Error(`Could not geocode city "${city}" — check the spelling and try again.`);
    }

    // Gather candidate events from every source in parallel. Facebook is skipped entirely
    // (no cost incurred) if includeFacebookEvents is false; Maps discovery is skipped if
    // maxMapsVenues is 0. Maps discovery covers cities/venues outside the curated seed list —
    // its found venues are crawled the same way as the seeded ones once discovered.
    const [aggregatorEvents, seededClubEvents, mapsClubEvents, facebookEvents] = await Promise.all([
        crawlAggregators(),
        crawlClubSites(),
        discoverClubSitesViaMaps({ cityCoords, radiusKm, maxMapsVenues }).then((venues) => crawlClubSites(venues)),
        includeFacebookEvents ? crawlFacebookEvents({ genres, city, maxFacebookEvents }) : Promise.resolve([]),
    ]);

    let candidates = [...aggregatorEvents, ...seededClubEvents, ...mapsClubEvents, ...facebookEvents];
    log.info(`Collected ${candidates.length} raw candidate event(s) across all sources.`);

    // Keep only events matching a requested genre (an event can match more than one).
    candidates = candidates.filter((event) => event.genres.some((g) => genres.includes(g)));

    // Keep only events within the requested date range.
    candidates = candidates.filter((event) => withinDateRange(event.date, dateRangeDays));

    // Geocode each venue (cached) and filter by distance from the city center. Events whose
    // venue coordinates are already known (Maps-discovered venues carry their own lat/lon)
    // skip this — no point re-geocoding a place Google Maps already located precisely.
    const withDistance = [];
    for (const event of candidates) {
        let venueCoords = typeof event.lat === 'number' && typeof event.lon === 'number' ? { lat: event.lat, lon: event.lon } : null;
        if (!venueCoords) {
            const query = event.address ? `${event.address}, ${city}, Czech Republic` : `${event.venue}, ${city || event.city}, Czech Republic`;
            venueCoords = await geocode(query);
        }
        if (!venueCoords) continue; // can't place it, can't filter it by radius — drop it

        const distanceKm = haversineDistanceKm(cityCoords, venueCoords);
        if (distanceKm > radiusKm) continue;

        withDistance.push({
            ...event,
            lat: venueCoords.lat,
            lon: venueCoords.lon,
            distanceKm,
            city: event.city || city,
        });
    }

    // Dedupe across sources, preferring higher-confidence sources when the same event
    // appears more than once (sort so the highest-confidence copy is seen first and kept).
    withDistance.sort((a, b) => (CONFIDENCE_RANK[a.confidence] ?? 1) - (CONFIDENCE_RANK[b.confidence] ?? 1));
    const finalEvents = dedupeEvents(withDistance);

    log.info(`${finalEvents.length} event(s) after genre/date/radius filtering and dedup.`);

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
