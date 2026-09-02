import { Actor, log } from 'apify';
import { classifyForInclusion } from '../genreClassifier.js';

const FACEBOOK_EVENTS_SCRAPER_ACTOR_ID = 'UZBnerCFBo5FgGouO'; // apify/facebook-events-scraper

// Representative search keyword per genre, combined with the city (e.g. "techno Brno").
const GENRE_SEARCH_KEYWORDS = {
    techno: 'techno',
    house: 'house',
    drum_and_bass: 'drum and bass',
};

/**
 * Calls apify/facebook-events-scraper with search queries built from the requested genres
 * and the *towns Facebook actually indexes* near the search point — no hardcoded page list.
 * Costs roughly $0.013/event, so this is skipped entirely when includeFacebookEvents is
 * false, and hard-capped by maxFacebookEvents.
 *
 * Searching the literal input city was the mistake here: Facebook's event search is keyword
 * matching, not a location filter. Verified live for "Návsí" — techno/house/electronic each
 * returned "No events found" (no place index for a village that size), while "drum and bass
 * Návsí" silently ignored the place and returned ~150 global D&B events from Coventry,
 * Budapest, Brooklyn and so on. Every one was then correctly discarded by the radius filter,
 * i.e. the whole call was spent on noise. Searching real nearby towns instead (Ostrava,
 * Frýdek-Místek, Žilina…) targets places Facebook has actual event listings for.
 *
 * Input field names verified against the Actor's live input schema: searchQueries (array),
 * startUrls (array), maxEvents (integer).
 *
 * @param {object} params
 * @param {string[]} params.genres
 * @param {string} params.city - the input city, used as a fallback when no towns were found
 * @param {string[]} [params.searchCities] - real nearby towns to search (see nearbyTowns.js)
 * @param {number} params.maxFacebookEvents
 * @returns {Promise<object[]>}
 */
export async function crawlFacebookEvents({ genres, city, searchCities = [], maxFacebookEvents }) {
    if (maxFacebookEvents <= 0) return [];

    // Fall back to the input city only if the nearby-town lookup came back empty.
    const places = searchCities.length > 0 ? searchCities : [city];
    const searchQueries = places.flatMap((place) =>
        genres.map((genre) => `${GENRE_SEARCH_KEYWORDS[genre] || genre} ${place}`),
    );

    log.info(`Running facebook-events-scraper with ${searchQueries.length} quer(ies) across ${places.join(', ')} (cap ${maxFacebookEvents})`);

    const client = Actor.newClient();
    let run;
    try {
        run = await client.actor(FACEBOOK_EVENTS_SCRAPER_ACTOR_ID).call({
            searchQueries,
            maxEvents: maxFacebookEvents,
        });
    } catch (err) {
        log.warning(`facebook-events-scraper run failed: ${err.message}`);
        return [];
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: maxFacebookEvents });

    const results = [];
    for (const item of items) {
        const eventName = item.name || item.title || '';
        const description = item.description || '';
        // Not trusted outright: Facebook's own search isn't reliably location- or
        // genre-scoped (see README), so an event still needs its own electronic/DJ signal.
        const genresMatched = classifyForInclusion(`${eventName} ${description}`);
        if (genresMatched.length === 0) continue;

        results.push({
            eventName,
            date: item.utcStartDate ? item.utcStartDate.slice(0, 10) : null,
            venue: item.location?.name || '',
            address: item.location?.streetAddress || '',
            city: item.location?.city || city,
            // Facebook already gives precise venue coordinates — use them directly rather than
            // re-geocoding by name/city string downstream. That string-based fallback is what
            // let an international event with no city set slip past the radius filter: with no
            // real coordinates to check, it was silently treated as being at the input city.
            lat: item.location?.latitude,
            lon: item.location?.longitude,
            description,
            genres: genresMatched,
            sourceName: 'Facebook Events',
            sourceUrl: item.url || '',
            confidence: 'moderate',
        });
    }

    // Requiring real coordinates (not just a date) matters specifically here: Facebook's
    // search isn't location-scoped (see README) and returns plenty of international results,
    // so an event with no location.latitude/longitude would otherwise fall through to
    // main.js's string-based geocode fallback — which for an event with no real city either
    // ends up geocoding just the input city itself, i.e. an unrelated event "passing" the
    // radius filter at ~0km away. Safer to drop it than risk a false-positive location.
    return results.filter((e) => e.date && typeof e.lat === 'number' && typeof e.lon === 'number');
}
