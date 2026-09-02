import { log } from 'apify';
import { classifyForInclusion } from '../genreClassifier.js';

/**
 * Resident Advisor (ra.co) — the primary source, and the only one that is simultaneously
 * free, genre-tagged at the source, and geographically scoped by the API itself.
 *
 * RA's GraphQL API needs no authentication or API key, so this is a plain HTTPS call from
 * the Actor (like Nominatim) rather than a paid Actor call: no per-event cost, and it does
 * not consume one of the account's concurrent-Actor-run slots.
 *
 * Verified live: a single country-wide query returned 114 upcoming Czech events with real
 * venue street addresses (better geocoding input than a bare venue name) and RA's own genre
 * taxonomy, e.g. "Techno", "Progressive House", "Garage", "Electronica".
 */

const RA_GRAPHQL_URL = 'https://ra.co/graphql';

const RA_HEADERS = {
    'Content-Type': 'application/json',
    // RA's API rejects requests without a plausible browser Referer/User-Agent.
    Referer: 'https://ra.co/events',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
};

const AREAS_QUERY = `query($term: String!) {
    areas(searchTerm: $term, limit: 10) { id name country { name } }
}`;

const EVENTS_QUERY = `query($filters: FilterInputDtoInput, $page: Int, $pageSize: Int) {
    eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
        data {
            event {
                id
                title
                date
                contentUrl
                venue { name address area { name } }
                artists { name }
                genres { name }
            }
        }
        totalResults
    }
}`;

// RA areas are city/region level: Prague and Brno have their own, but smaller Czech towns
// (Ostrava, Frýdek-Místek — both verified absent) do not. Rather than trying to map a small
// town onto the "nearest" area, query the country-wide "All" area and let this Actor's own
// radius filter do the geography — the country-wide result set is small enough (~114 events
// for a 30-day window) that there's no benefit to narrowing it server-side.
const COUNTRY_SEARCH_TERM = 'Czech Republic';
const COUNTRY_WIDE_AREA_NAME = 'All';
const FALLBACK_CZECH_AREA_ID = 97; // verified live; used only if the area lookup itself fails

const PAGE_SIZE = 100;
const MAX_PAGES = 10; // hard stop; 10 pages x 100 is far above any realistic Czech result set

// RA's genre names mapped onto this Actor's genre values. Anything electronic that doesn't
// match one of the three specific genres (Disco, Garage, Dubstep, Electronica, Ambient…)
// falls through to the generic 'electronic' tag via classifyForInclusion, since RA is by
// definition an electronic music listing — see trustedElectronic in seedSources.js.
const RA_GENRE_PATTERNS = [
    [/techno/i, 'techno'],
    [/house/i, 'house'],
    [/drum\s*&?\s*n?'?\s*bass|\bd&b\b|\bdnb\b|jungle/i, 'drum_and_bass'],
];

function mapRaGenres(raGenreNames) {
    const mapped = new Set();
    for (const name of raGenreNames) {
        for (const [pattern, genre] of RA_GENRE_PATTERNS) {
            if (pattern.test(name)) mapped.add(genre);
        }
    }
    return [...mapped];
}

async function raGraphql(query, variables) {
    const response = await fetch(RA_GRAPHQL_URL, {
        method: 'POST',
        headers: RA_HEADERS,
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`RA GraphQL returned ${response.status}`);
    const body = await response.json();
    if (body.errors) throw new Error(`RA GraphQL error: ${JSON.stringify(body.errors).slice(0, 200)}`);
    return body.data;
}

/** Resolves the country-wide RA area id, falling back to the verified literal if lookup fails. */
async function resolveCountryAreaId() {
    try {
        const data = await raGraphql(AREAS_QUERY, { term: COUNTRY_SEARCH_TERM });
        const areas = data?.areas ?? [];
        const countryWide = areas.find((a) => a.name === COUNTRY_WIDE_AREA_NAME);
        if (countryWide) return Number(countryWide.id);
        log.warning(`RA area lookup found no "${COUNTRY_WIDE_AREA_NAME}" area; falling back to ${FALLBACK_CZECH_AREA_ID}.`);
    } catch (err) {
        log.warning(`RA area lookup failed (${err.message}); falling back to area ${FALLBACK_CZECH_AREA_ID}.`);
    }
    return FALLBACK_CZECH_AREA_ID;
}

/**
 * @param {object} params
 * @param {number} params.dateRangeDays
 * @returns {Promise<object[]>} raw candidate events (not yet distance-filtered or deduped)
 */
export async function crawlResidentAdvisor({ dateRangeDays }) {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = new Date(from.getTime() + dateRangeDays * 24 * 60 * 60 * 1000);

    let areaId;
    try {
        areaId = await resolveCountryAreaId();
    } catch (err) {
        log.warning(`Resident Advisor skipped: ${err.message}`);
        return [];
    }

    const filters = {
        areas: { eq: areaId },
        listingDate: { gte: from.toISOString(), lte: to.toISOString() },
    };

    const results = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        let listings;
        try {
            const data = await raGraphql(EVENTS_QUERY, { filters, page, pageSize: PAGE_SIZE });
            listings = data?.eventListings;
        } catch (err) {
            log.warning(`Resident Advisor page ${page} failed: ${err.message}`);
            break;
        }

        const entries = listings?.data ?? [];
        if (entries.length === 0) break;

        for (const entry of entries) {
            const event = entry?.event;
            if (!event?.date) continue;

            const raGenreNames = (event.genres ?? []).map((g) => g.name).filter(Boolean);
            const artistNames = (event.artists ?? []).map((a) => a.name).filter(Boolean);
            // RA's own genre labels are structural metadata, not prose, so they're joined to
            // the title rather than passed as a description — a weak keyword in them is meant.
            const genres = classifyForInclusion(`${event.title} ${raGenreNames.join(' ')}`, {
                trustedElectronic: true,
                knownGenres: mapRaGenres(raGenreNames),
            });

            results.push({
                eventName: event.title,
                date: event.date.slice(0, 10),
                venue: event.venue?.name || '',
                address: event.venue?.address || '',
                // RA's area name is a real city for Prague/Brno, but country-wide events come
                // back with the area literally named "All" — which is not a place. Emitting it
                // as a city is actively harmful: geocoding "All, Czech Republic" resolves to
                // somewhere ~9,700km away, so a city-level distance filter would discard every
                // one of those events. Leave the city blank so they're placed by their own
                // street address instead — and they're exactly the non-Prague events (České
                // Budějovice, regional clubs) most likely to be near a smaller town.
                city: event.venue?.area?.name === COUNTRY_WIDE_AREA_NAME ? '' : event.venue?.area?.name || '',
                description: [raGenreNames.join(', '), artistNames.join(', ')].filter(Boolean).join(' — '),
                genres,
                sourceName: 'Resident Advisor',
                sourceUrl: event.contentUrl ? `https://ra.co${event.contentUrl}` : 'https://ra.co/events',
                confidence: 'high',
            });
        }

        const total = listings?.totalResults ?? 0;
        if (results.length >= total || entries.length < PAGE_SIZE) break;
    }

    log.info(`Resident Advisor: ${results.length} event(s) in the next ${dateRangeDays} day(s) (area ${areaId}).`);
    return results;
}
