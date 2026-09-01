import { Actor, log } from 'apify';

const MAPS_SCRAPER_ACTOR_ID = 'compass/crawler-google-places';

// Broad enough to catch venues the seed list doesn't know about, in any Czech city/radius.
// Downstream genre-keyword matching on each venue's actual program filters out the noise
// (a "night club" or generic "klub" match that never mentions techno/house/D&B just yields
// zero events for that venue, which is harmless — it costs a wasted crawl, not a bad result).
const SEARCH_TERMS = ['night club', 'hudební klub', 'taneční klub'];

/**
 * Discovers club-like venues near a geocoded point via Google Maps (compass/crawler-google-places,
 * pay-per-event at ~$1.50/1,000 places — billed through the normal Apify account, unlike the
 * x402-gated crawler mode). This exists to cover any Czech city/radius the user asks for, not
 * just the ~15 venues in the curated CLUB_SITES seed list.
 *
 * Only returns venues that have a website listed (nothing to crawl for events otherwise), and
 * carries through each venue's Maps coordinates so the caller doesn't need to re-geocode it.
 *
 * @param {object} params
 * @param {{lat: number, lon: number}} params.cityCoords
 * @param {number} params.radiusKm
 * @param {number} params.maxMapsVenues - cap per search term; 0 disables discovery entirely.
 * @returns {Promise<Array<{name: string, city: string, url: string, confidence: string, lat: number, lon: number}>>}
 */
export async function discoverClubSitesViaMaps({ cityCoords, radiusKm, maxMapsVenues }) {
    if (!maxMapsVenues || maxMapsVenues <= 0) return [];

    const client = Actor.newClient();
    let run;
    try {
        run = await client.actor(MAPS_SCRAPER_ACTOR_ID).call({
            searchStringsArray: SEARCH_TERMS,
            customGeolocation: {
                type: 'Point',
                coordinates: [cityCoords.lon, cityCoords.lat], // GeoJSON order: [lon, lat]
                radiusKm,
            },
            maxCrawledPlacesPerSearch: maxMapsVenues,
        });
    } catch (err) {
        log.warning(`Maps venue discovery failed: ${err.message}`);
        return [];
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const seenUrls = new Set();
    const venues = [];
    for (const item of items) {
        const url = item.website?.trim();
        if (!url || seenUrls.has(url)) continue; // no site to crawl, or same place matched >1 search term
        seenUrls.add(url);

        venues.push({
            name: item.title || url,
            city: '',
            url,
            confidence: 'low', // genre focus isn't manually verified the way the seed list is
            lat: item.location?.lat,
            lon: item.location?.lng,
        });
    }

    log.info(`Maps discovery found ${venues.length} venue(s) with a website near the search center.`);
    return venues;
}
