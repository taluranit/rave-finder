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
 * and city — no hardcoded Facebook page list, it relies on the Actor's own search.
 * Costs roughly $0.013/event, so this is skipped entirely when includeFacebookEvents is
 * false, and hard-capped by maxFacebookEvents.
 *
 * NOTE: this Actor's exact input field names aren't pinned down here beyond what's
 * documented for it (searchQueries + a result cap) — double check against the Actor's
 * current input schema on Apify Store before relying on this in production, since
 * third-party Actor schemas can change.
 *
 * @param {object} params
 * @param {string[]} params.genres
 * @param {string} params.city
 * @param {number} params.maxFacebookEvents
 * @returns {Promise<object[]>}
 */
export async function crawlFacebookEvents({ genres, city, maxFacebookEvents }) {
    if (maxFacebookEvents <= 0) return [];

    const searchQueries = genres.map((genre) => `${GENRE_SEARCH_KEYWORDS[genre] || genre} ${city}`);

    log.info(`Running facebook-events-scraper with queries: ${searchQueries.join(', ')} (cap ${maxFacebookEvents})`);

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

    return results.filter((e) => e.date);
}
