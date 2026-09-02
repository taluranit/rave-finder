import { log } from 'apify';

/**
 * Finds real towns/cities within the search radius, via OpenStreetMap's Overpass API
 * (free, no API key).
 *
 * This exists because Facebook's event search is keyword-based, not location-scoped: it has
 * no place index for a small village, so searching "techno Návsí" returns either nothing or
 * — worse — global results that merely match the genre keyword. Verified live: for Návsí
 * within 50km this returns Ostrava (280k), Žilina, Havířov, Frýdek-Místek, Karviná, Třinec —
 * all places Facebook does index, and where the region's events are actually listed.
 *
 * Note this legitimately crosses borders near a tripoint like Návsí (Polish and Slovak towns
 * come back too), which is correct for a radius search — the radius filter later still
 * applies to each event's own venue coordinates.
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_SECS = 25;
// Overpass rejects requests without a User-Agent with HTTP 406 (confirmed live), and its
// usage policy asks for a descriptive one — same as Nominatim.
const USER_AGENT = 'RaveFinder/0.1 (Apify Actor; contact via apify.com store page)';

/**
 * @param {object} params
 * @param {{lat: number, lon: number}} params.center
 * @param {number} params.radiusKm
 * @param {number} [params.limit] - how many towns to return, largest first by population.
 * @returns {Promise<string[]>} town names, most populous first
 */
export async function findNearbyTowns({ center, radiusKm, limit = 6 }) {
    // Overpass wants metres. Sorting by population happens client-side: the `population` tag
    // is present on most sizeable places but not all, so places without it sort last rather
    // than being dropped.
    const query = `[out:json][timeout:${TIMEOUT_SECS}];`
        + `node["place"~"^(city|town)$"](around:${Math.round(radiusKm * 1000)},${center.lat},${center.lon});`
        + `out body 60;`;

    let elements;
    try {
        const response = await fetch(OVERPASS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
                Accept: 'application/json',
            },
            body: new URLSearchParams({ data: query }).toString(),
        });
        if (!response.ok) {
            log.warning(`Overpass returned ${response.status}; falling back to the input city alone.`);
            return [];
        }
        ({ elements } = await response.json());
    } catch (err) {
        log.warning(`Nearby-town lookup failed (${err.message}); falling back to the input city alone.`);
        return [];
    }

    const towns = (elements ?? [])
        .map((el) => ({
            name: el.tags?.name,
            population: Number(el.tags?.population) || 0,
        }))
        .filter((t) => t.name)
        // Sorted purely by population — it's the best proxy for whether Facebook has a real
        // event index for a place. Deliberately NOT ranking OSM's place=city above
        // place=town: doing so pushed Frýdek-Místek (pop. ~54k, tagged "town", and the actual
        // regional hub for events near Návsí) below several smaller places tagged "city".
        .sort((a, b) => b.population - a.population);

    const names = [...new Set(towns.map((t) => t.name))].slice(0, limit);
    log.info(`Nearby towns within ${radiusKm}km: ${names.join(', ') || '(none found)'}`);
    return names;
}
