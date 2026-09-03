import { Actor, log } from 'apify';
import { classifyForInclusion } from '../genreClassifier.js';
import { mapWithConcurrency } from '../concurrency.js';

const FACEBOOK_EVENTS_SCRAPER_ACTOR_ID = 'UZBnerCFBo5FgGouO'; // apify/facebook-events-scraper

// One Actor call per venue page, so this shares the account-wide concurrent-run cap of 5 —
// see the phase notes in main.js. Kept below it, and these run after the club-site crawls.
const VENUE_PAGE_CONCURRENCY = 3;

// A venue's own Facebook page publishes its entire programme, not just its club nights, so
// inheriting the venue's "this place is electronic" trust wholesale lets plainly non-musical
// events through — a live Návsí run returned a wine-and-burčák tasting from Rokáč alongside
// its DJ nights. This drops the obvious non-music categories while deliberately keeping
// anything that could be a DJ night: an "80s/90s hits" evening or a themed Sunday with a
// named DJ has no genre keyword but is still a party.
const NON_MUSIC_EVENT_RE =
    /\b(degustac|ochutn[áa]vk|tasting|workshop|kurz|p[řr]edn[áa]šk|semin[áa][řr]|besed|quiz|kv[íi]z|turnaj|z[áa]vod|jarmark|trh\b|bazar|swap|v[ýy]stav|exhibition|divadl|theatre|kino\b|cinema|j[óo]g|yoga|pilates|tr[ée]nink|training|prohl[íi]dk|porod|koj[ée]n[íi]|pro d[ěe]ti|d[ěe]tsk|bl[ée]ší)/i;

// REMOVED: crawlFacebookEvents, the Facebook event *search* path. Kept in git history, and
// not coming back without a different approach, because a live run proved it can only damage
// a run. Enabled for a Návsí search it spent the entire 300-second budget and was aborted by
// the platform, so nothing was pushed at all — every other source's results were thrown away
// too. It also hit Facebook's own "Rate limit exceeded" and looped on pagination retries
// ("Forcing additional scrolling", retryCount climbing past 10).
//
// The yield was three distinct kinds of garbage, none of them near Návsí:
//   - jazz rhythm sections, because the search ORs the words: "drum and bass Karviná"
//     returned "Joan Minor featuring The Uli Geissendoerfer Trio with Peppe on Drums and
//     Derek Jones on the Bass" seven times over under different event ids
//   - the town's unrelated events: a political-party barbecue (GRILOVAČKA ČSSD KARVINÁ), a
//     kids' craft workshop (Lapač slunce), an open day (Den otevřených dveří)
//   - real D&B parties from Budapest Park, Poland and the US — correct genre, wrong continent
//
// Facebook's event search is keyword matching, not a location filter, so the place name in
// the query is advisory at best. crawlFacebookVenuePages below is the approach that works:
// it asks named, already-in-range venues what they have on.

/**
 * Fetches events straight off known venues' Facebook pages, rather than going through
 * Facebook's event search.
 *
 * This is the source that actually works for small towns. Verified live against Rokáč
 * (Jablunkov, ~2km from Návsí):
 *   - `facebook.com/rokac.cz`                        -> one empty record, useless
 *   - `facebook.com/rokac.cz/upcoming_hosted_events` -> 3 real events, with dates AND
 *                                                       venue coordinates
 * So the page's events tab is the URL shape to use. `startUrls` also takes plain strings,
 * not `{ url }` objects — the Actor calls `url.match()` on each entry directly and crashes
 * with "url.match is not a function" otherwise.
 *
 * Unlike the search path, cost here scales with the number of nearby venues rather than with
 * how much unrelated stuff Facebook's index returns, and every event comes pre-attached to a
 * venue we already decided was in range.
 *
 * @param {object} params
 * @param {Array<{name: string, facebookPage: string, confidence?: string, trustedElectronic?: boolean}>} params.venues
 * @param {number} params.maxFacebookEvents
 * @returns {Promise<object[]>}
 */
export async function crawlFacebookVenuePages({ venues, maxFacebookEvents }) {
    if (maxFacebookEvents <= 0 || venues.length === 0) return [];

    // Map each venue page to its events tab, keeping track of which venue each URL came from
    // so the resulting events can inherit that venue's trust level.
    const venueByUrl = new Map();
    for (const venue of venues) {
        const pageUrl = venue.facebookPage.replace(/\/+$/, '');
        venueByUrl.set(`${pageUrl}/upcoming_hosted_events`, venue);
    }
    const startUrls = [...venueByUrl.keys()];

    // One Actor call per page, rather than one call for all of them. The Actor's maxEvents is
    // a whole-run total, so a single call lets whichever page it crawls first swallow the
    // entire budget: a live run with 6 pages and a cap of 20 returned 16 events that were all
    // from one venue, and the other five contributed nothing. Splitting the same total budget
    // per page keeps the cost identical while actually covering every venue.
    const perPageCap = Math.max(2, Math.floor(maxFacebookEvents / startUrls.length));
    log.info(
        `Fetching Facebook events for ${startUrls.length} nearby venue page(s), ` +
            `up to ${perPageCap} each (total budget ${maxFacebookEvents}).`,
    );

    const client = Actor.newClient();
    const perPageItems = await mapWithConcurrency(startUrls, VENUE_PAGE_CONCURRENCY, async (startUrl) => {
        try {
            const run = await client.actor(FACEBOOK_EVENTS_SCRAPER_ACTOR_ID).call({
                startUrls: [startUrl],
                maxEvents: perPageCap,
            });
            const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: perPageCap });
            // Tag each item with the page it came from — the Actor's own inputUrl isn't a
            // reliable join key, and one call per page makes the attribution unambiguous.
            return items.map((item) => ({ item, venue: venueByUrl.get(startUrl) }));
        } catch (err) {
            log.warning(`Facebook venue page failed (${startUrl}): ${err.message}`);
            return [];
        }
    });

    const items = perPageItems.flat();
    const results = [];
    let nonMusicSkipped = 0;
    for (const { item, venue } of items) {
        const eventName = item.name || '';
        if (!eventName) continue; // a page with no upcoming events yields one empty record
        const description = item.description || '';

        if (NON_MUSIC_EVENT_RE.test(eventName)) {
            nonMusicSkipped += 1;
            continue;
        }

        const genres = classifyForInclusion(eventName, {
            description,
            // An event on a known electronic venue's own page inherits that venue's trust —
            // the same reasoning as trustedElectronic for seeded club sites. It's what lets a
            // DJ night whose title names no genre survive. It does also let the venue's
            // non-electronic nights through (Rokáč runs wine tastings and pizza Sundays), which
            // is the accepted trade-off for not missing the actual parties.
            trustedElectronic: Boolean(venue?.trustedElectronic),
        });
        if (genres.length === 0) continue;

        results.push({
            eventName,
            date: item.utcStartDate ? item.utcStartDate.slice(0, 10) : null,
            venue: item.location?.name || venue?.name || '',
            address: item.location?.streetAddress || '',
            city: item.location?.city || '',
            lat: item.location?.latitude,
            lon: item.location?.longitude,
            description,
            genres,
            sourceName: `Facebook — ${venue?.name || item.location?.name || 'venue page'}`,
            sourceUrl: item.url || '',
            confidence: venue?.confidence || 'moderate',
        });
    }

    log.info(`Facebook venue pages: ${results.length} event(s) kept, ${nonMusicSkipped} skipped as clearly non-music.`);
    return keepPlaceableEvents(results);
}

/**
 * Drops events that can't be placed on a map.
 *
 * Requiring real coordinates (not just a date) matters specifically here: Facebook's search
 * isn't location-scoped (see README) and returns plenty of international results, so an event
 * with no location.latitude/longitude would otherwise fall through to main.js's string-based
 * geocode fallback — which for an event with no real city either ends up geocoding just the
 * input city itself, i.e. an unrelated event "passing" the radius filter at ~0km away. Safer
 * to drop it than risk a false-positive location.
 */
function keepPlaceableEvents(results) {
    return results.filter((e) => e.date && typeof e.lat === 'number' && typeof e.lon === 'number');
}
