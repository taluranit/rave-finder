import { Actor, log } from 'apify';
import { crawlAggregators } from './crawlers/aggregatorCrawler.js';
import { crawlClubSites } from './crawlers/clubSiteCrawler.js';
import { discoverClubSitesViaMaps } from './crawlers/mapsDiscoveryCrawler.js';
import { crawlFacebookVenuePages } from './crawlers/facebookEventsCrawler.js';
import { crawlResidentAdvisor } from './crawlers/residentAdvisorCrawler.js';
import { CLUB_SITES, FACEBOOK_VENUE_PAGES } from './sources/seedSources.js';
import { geocode, haversineDistanceKm } from './geocode.js';
import { dedupeEvents } from './dedupe.js';

const CONFIDENCE_RANK = { high: 0, moderate: 1, low: 2 };

// Allows for a venue sitting out toward the edge of a large city rather than at the point its
// city name geocodes to. Only applies to seeded venues, where all we know is the city —
// Maps-discovered venues carry their own exact coordinates and are filtered strictly.
const VENUE_CITY_SLACK_KM = 15;

// Wider than the Czech Republic is across, so any "city" resolving further than this is a
// mis-geocode rather than a real place — see cityIsPlausiblyInRange.
const IMPLAUSIBLE_CITY_DISTANCE_KM = 1000;

// Everything this Actor finds is pushed in a single call at the very end, so overshooting the
// platform's run timeout doesn't degrade the output — it destroys it. A run aborted at 300s
// publishes nothing, discarding work every other source already completed. That is not
// hypothetical: enabling the (now removed) Facebook event search did exactly this.
//
// Geocoding is the only step that can still get there. Nominatim's usage policy caps us at 1
// request/second and a lookup that fails is retried three times with backoff, so a batch of
// unplaceable venues is expensive — a Návsí run had 17 of them, at roughly 6s each. A normal
// run finishes in about 130s locally, so this deadline should never fire; it exists so that
// when it does, the run still publishes what it managed to place.
const ASSUMED_RUN_TIMEOUT_MS = 300_000;
const OUTPUT_RESERVE_MS = 45_000;
const runStartedAt = Date.now();
const geocodingDeadline = runStartedAt + ASSUMED_RUN_TIMEOUT_MS - OUTPUT_RESERVE_MS;

/** True once the time budget for new geocoding lookups is spent. */
function outOfGeocodingTime() {
    return Date.now() > geocodingDeadline;
}

// Appends ", Czech Republic" for Nominatim, unless the place already names the country —
// e.g. a user typing "Návsí, Czech Republic" as the city input would otherwise end up
// geocoding "Návsí, Czech Republic, Czech Republic", which Nominatim fails to resolve.
function withCountry(place) {
    return /czech/i.test(place) ? place : `${place}, Czech Republic`;
}

/**
 * Trims a redundant country from a city value before it's stored. Facebook returns city as
 * "Jablunkov, Czech Republic", which reads oddly next to a dedicated country-wide scope and
 * makes the field inconsistent with every other source's bare town name.
 */
function cityLabel(city) {
    return (city || '').replace(/,?\s*(czech republic|czechia|česká republika|cesko|česko)\s*$/i, '').trim();
}

/** Readable source label for a user-supplied Facebook URL, e.g. ".../rokac.cz" -> "rokac.cz". */
function facebookPageLabel(url) {
    const path = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split('facebook.com/')[1] || url;
    return path.replace(/\/(upcoming_hosted_events|past_hosted_events|events)$/, '') || url;
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
        includeFacebookVenuePages = true,
        facebookPages = [],
        maxFacebookEvents = 20,
        maxMapsVenues = 5,
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
    // Crawlee; Resident Advisor is a plain HTTPS call to a free, keyless API), plus Maps
    // discovery, which is the one Actor call here.
    const [aggregatorEvents, raEvents, mapsVenues] = await Promise.all([
        crawlAggregators(),
        crawlResidentAdvisor({ dateRangeDays }),
        discoverClubSitesViaMaps({ cityCoords, radiusKm, maxMapsVenues }),
    ]);

    // Phase 2 — club sites, one Actor call each, so only crawl venues that could actually be
    // in range. Facebook pages are excluded from *this* step: website-content-crawler in
    // cheerio mode gets nothing useful from facebook.com (it needs JS and a session). Maps
    // discovery frequently returns a venue's Facebook page as its "website", and those are
    // routed to crawlFacebookVenuePages below instead, which is the right tool for them.
    // Distance-filter every known venue first — seeded sites, Facebook-only venues, and
    // Maps discoveries alike — then split by what can actually be fetched from each.
    // User-supplied Facebook pages, from the `facebookPages` input. They carry no city, which
    // means venueCouldBeInRange lets them through unconditionally — deliberate, since the
    // point is to reach a promoter the Actor doesn't know about and whose town it can't guess.
    // Nothing is lost by that: Facebook returns real venue coordinates, so the per-event
    // radius filter still decides whether the result is actually nearby.
    const userVenues = facebookPages
        .filter((url) => typeof url === 'string' && /facebook\.com/i.test(url))
        .map((url) => ({ name: facebookPageLabel(url), city: '', facebookPage: url.trim(), confidence: 'moderate' }));
    if (facebookPages.length > userVenues.length) {
        log.warning(`Ignored ${facebookPages.length - userVenues.length} facebookPages entr(ies) that aren't facebook.com URLs.`);
    }

    const knownVenues = [
        ...CLUB_SITES,
        ...FACEBOOK_VENUE_PAGES,
        ...userVenues,
        ...mapsVenues.filter((v) => !/facebook\.com/i.test(v.url)),
    ];
    const inRangeVenues = [];
    for (const site of knownVenues) {
        if (await venueCouldBeInRange(site, cityCoords, radiusKm)) inRangeVenues.push(site);
    }
    // Only entries with a website can be web-crawled; Facebook-only venues have no `url`.
    const crawlableVenues = inRangeVenues.filter((v) => v.url);
    log.info(
        `${inRangeVenues.length} of ${knownVenues.length} known venue(s) in range of "${city}" — ` +
            `${crawlableVenues.length} with a crawlable website.`,
    );
    const clubEvents = await crawlClubSites(crawlableVenues);

    // Facebook events straight off in-range venues' own pages. Unlike Facebook *search*
    // (off by default — see README), this is targeted: it only asks about venues already
    // established to be nearby, and verified live to return dated events with coordinates.
    // Sources are the seed list's verified facebookPage entries plus any Maps-discovered
    // venue whose "website" is itself a Facebook page.
    // Deduped by page URL: a seeded venue's facebookPage and a Maps discovery of that same
    // page would otherwise each spend a paid Actor call fetching identical events. The seeded
    // entry is kept, since its genre/confidence flags are hand-verified.
    const venuePagesByUrl = new Map();
    for (const venue of [
        ...mapsVenues
            .filter((v) => /facebook\.com/i.test(v.url))
            .filter((v) => typeof v.lat !== 'number' || haversineDistanceKm(cityCoords, { lat: v.lat, lon: v.lon }) <= radiusKm)
            .map((v) => ({ ...v, facebookPage: v.url })),
        ...inRangeVenues.filter((v) => v.facebookPage),
    ]) {
        venuePagesByUrl.set(venue.facebookPage.replace(/\/+$/, '').toLowerCase(), venue);
    }
    const venuePages = [...venuePagesByUrl.values()];
    const facebookVenueEvents = includeFacebookVenuePages
        ? await crawlFacebookVenuePages({ venues: venuePages, maxFacebookEvents })
        : [];

    let candidates = [...raEvents, ...aggregatorEvents, ...clubEvents, ...facebookVenueEvents];
    log.info(
        `Collected ${candidates.length} raw candidate event(s): ` +
            `${raEvents.length} Resident Advisor, ${aggregatorEvents.length} aggregator, ` +
            `${clubEvents.length} club site, ${facebookVenueEvents.length} Facebook venue page.`,
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
    let cityChecksSkippedForTime = 0;
    for (const event of candidates) {
        // Events that already carry exact coordinates skip this — they're judged directly.
        const hasCoords = typeof event.lat === 'number' && typeof event.lon === 'number';
        if (hasCoords) {
            cityFiltered.push(event);
            continue;
        }
        // Out of time: an event we can't place can't clear the radius filter anyway, so
        // stop paying for lookups and let the ones already located go through.
        if (outOfGeocodingTime()) {
            cityChecksSkippedForTime += 1;
            continue;
        }
        if (await cityIsPlausiblyInRange(event.city)) cityFiltered.push(event);
    }
    candidates = cityFiltered;
    log.info(
        `${candidates.length} remain after city-level pre-filter ` +
            `(dropped ${beforeCityFilter - candidates.length} in cities outside the radius, without geocoding each venue).`,
    );
    if (cityChecksSkippedForTime > 0) {
        log.warning(
            `Ran out of geocoding time: skipped the city check for ${cityChecksSkippedForTime} candidate(s) ` +
                `so this run can still publish what it placed.`,
        );
    }

    // Fine pass: geocode the remaining venues and filter precisely. Events whose venue
    // coordinates are already known (Maps discovery, Facebook) skip this entirely.
    const withDistance = [];
    let uncodableCount = 0;
    let tooFarCount = 0;
    let venuesSkippedForTime = 0;
    for (const event of candidates) {
        let venueCoords = typeof event.lat === 'number' && typeof event.lon === 'number' ? { lat: event.lat, lon: event.lon } : null;
        if (!venueCoords && outOfGeocodingTime()) {
            venuesSkippedForTime += 1;
            continue; // same trade as above: publish what's placed rather than lose the run
        }
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
            // The event's own city, or blank — never the *input* city as a fallback. Defaulting
            // to the input labelled a Resident Advisor event at Dock, 43km away in Ostrava, as
            // being in "Návsí". The distance is right there in the same record contradicting
            // it, and output that says an event is in your village when it isn't is worse
            // than one that admits it doesn't know the town.
            city: cityLabel(event.city),
        });
    }

    log.info(
        `${withDistance.length} remain after geocoding + radius filtering (within ${radiusKm}km) — ` +
            `dropped ${uncodableCount} unplaceable, ${tooFarCount} too far.`,
    );
    if (venuesSkippedForTime > 0) {
        log.warning(
            `Ran out of geocoding time: ${venuesSkippedForTime} candidate(s) were never geocoded, so this ` +
                `result is incomplete. Re-running fills them in — successful lookups are cached in the ` +
                `key-value store, so the next run gets further.`,
        );
    }

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

    await Actor.exit();
} catch (err) {
    log.error(err.message);
    await Actor.exit({ exitCode: 1, statusMessage: err.message });
}
