import { Actor, log } from 'apify';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'RaveFinder/0.1 (Apify Actor; contact via apify.com store page)';
const THROTTLE_MS = 1000; // Nominatim usage policy: max 1 request/sec.
const CACHE_KEY = 'GEOCODE_CACHE';

let cache = null;
let lastRequestAt = 0;

async function loadCache() {
    if (cache) return cache;
    const store = await Actor.openKeyValueStore();
    cache = (await store.getValue(CACHE_KEY)) || {};
    return cache;
}

async function persistCache() {
    const store = await Actor.openKeyValueStore();
    await store.setValue(CACHE_KEY, cache);
}

async function throttle() {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < THROTTLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed));
    }
    lastRequestAt = Date.now();
}

/**
 * Geocode a free-text place query (e.g. "Brno, Czech Republic" or a venue address),
 * caching results in the Actor's key-value store so repeated runs don't re-hit Nominatim
 * for the same place. Returns null if nothing was found.
 * @param {string} query
 * @returns {Promise<{lat: number, lon: number} | null>}
 */
export async function geocode(query) {
    const store = await loadCache();
    const cacheKey = query.trim().toLowerCase();

    if (store[cacheKey] !== undefined) {
        return store[cacheKey];
    }

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');

    let result = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts && !result; attempt++) {
        await throttle();
        try {
            const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
            if (response.ok) {
                const results = await response.json();
                if (results.length > 0) {
                    result = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
                } else {
                    break; // a clean "no results" response — retrying won't change that
                }
            } else {
                log.warning(`Nominatim returned ${response.status} for query "${query}" (attempt ${attempt}/${maxAttempts})`);
            }
        } catch (err) {
            log.warning(`Geocoding failed for "${query}": ${err.message} (attempt ${attempt}/${maxAttempts})`);
        }
        if (!result && attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 1000)); // back off before retrying
        }
    }

    // Only cache successes. A failed lookup might just be a transient network/rate-limit
    // issue — caching it would replay that failure on every future run forever.
    if (result) {
        store[cacheKey] = result;
        await persistCache();
    }

    return result;
}

/** Great-circle distance between two lat/lon points, in kilometers. */
export function haversineDistanceKm(a, b) {
    const R = 6371;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);

    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
