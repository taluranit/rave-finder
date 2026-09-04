import { Actor, log } from 'apify';

const MAPS_SCRAPER_ACTOR_ID = 'compass/crawler-google-places';

// Broad enough to catch venues the seed list doesn't know about, in any Czech city/radius.
// Downstream genre-keyword matching on each venue's actual program filters out the noise
// (a "night club" or generic "klub" match that never mentions techno/house/D&B just yields
// zero events for that venue, which is harmless — it costs a wasted crawl, not a bad result).
const SEARCH_TERMS = ['night club', 'hudební klub', 'taneční klub'];

// "klub" in Czech/Slovak/Polish is used generically for all sorts of clubs, not just
// nightlife — a live run's raw results included a Lions Club, a tennis club, a paragliding
// club, several ballroom/folk dance schools and studios, and plain restaurants. This is a
// cost/efficiency filter, not a correctness one: genre-keyword matching downstream (these
// venues aren't trustedElectronic) already drops non-electronic events from anything that
// slips through, but there's no reason to spend a website-content-crawler call and memory
// finding that out for a tennis club.
// Stems, not whole words: Czech/Slovak/Polish declension means a whole-word match like
// \bakadem\b never matches "Akademia" — the suffix continues straight after the stem with no
// boundary transition. So each entry matches from a left boundary onward and lets the ending
// run on ("taneční", "tanečního", "tanečná").
//
// That left boundary is a Unicode-aware lookbehind, NOT \b. JavaScript's \b is defined on
// ASCII word characters only, so between a space and "š" there is no boundary at all and
// /\bškol/ can never match "Základní umělecká škola" — that entry sat in this list doing
// nothing, and art schools kept reaching the crawler (Orlová, Karolinka, Rožnov, Bedřicha
// Smetany). Any future entry starting with a diacritic would have failed the same silent way.
//
// Deliberately excludes "café"/"kavárna": a live run showed that's too common a naming
// pattern for genuine live-music venues (our own confirmed "Rock Café Jablunkov") to treat as
// a coffee-shop signal. "school" carries an "old school" guard for the same reason — it's a
// plausible club name.
//
// The dance entries earn their place: Maps returns ballroom and competitive dance clubs in
// numbers for a "dance/club" search and none of them publish a DJ programme. A live Návsí run
// spent 4 of its 13 crawl slots on Dance School Chlopčík, TK Trend Ostrava, Taneční klub
// AKCENT and Taneční skupina Aktiv, all yielding nothing.
const EXCLUDED_NAME_STEMS = [
    'tenis', 'tennis', 'paraglid', 'lions', 'rotary', 'kiwanis', 'skaut', 'scout', 'hasič', 'hasic',
    // Schools of every stripe. Czech "škol" covers "škola"/"školy"/"Základní umělecká škola";
    // the English form appeared as "Secondary Technical School Karvina".
    'škol', 'skol', 'szkoł', '(?<!old )school', 'zuš', 'akadem', 'studi', 'kurz', 'gymnázi', 'gymnazi',
    'restaurac', 'jídeln', 'jidelni', 'grill', 'bistro', 'hotel',
    // Guesthouses in three languages: Třinec is 15km from the Polish border, so Maps
    // returns Polish results too and the Czech-only 'penzion' missed "Pensjonat Pod
    // Piramida".
    'penzion', 'pensjonat', 'pension',
    'kostel', 'church', 'muzeum', 'museum', 'galeri', 'gallery', 'divadl', 'kino', 'cinema',
    // Gambling venues, which Maps returns for "night club" searches — a Třinec run crawled
    // KASINO KAJOT INTACTO for nothing.
    'kasino', 'casino', 'herna',
    'fotbal', 'football', 'hokej', 'hockey', 'volejbal', 'golf', 'fitness', 'jóg', 'jog', 'yog', 'smak',
    'tanečn', 'tanecn', 'tanec(?![\\p{L}\\p{N}])', 'dance (school|studio|academy)', 'zumba', 'balet', 'ballet',
];
const EXCLUDED_NAME_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${EXCLUDED_NAME_STEMS.join('|')})`, 'iu');


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
    let excludedCount = 0;
    for (const item of items) {
        const url = item.website?.trim();
        if (!url || seenUrls.has(url)) continue; // no site to crawl, or same place matched >1 search term
        seenUrls.add(url);

        if (EXCLUDED_NAME_RE.test(item.title || '') || EXCLUDED_NAME_RE.test(item.categoryName || '')) {
            excludedCount += 1;
            continue;
        }

        venues.push({
            name: item.title || url,
            city: '',
            url,
            confidence: 'low', // genre focus isn't manually verified the way the seed list is
            lat: item.location?.lat,
            lon: item.location?.lng,
        });
    }

    log.info(`Maps discovery found ${venues.length} venue(s) with a website near the search center (excluded ${excludedCount} as clearly non-nightlife).`);
    return venues;
}
