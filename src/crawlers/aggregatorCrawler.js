import { CheerioCrawler, log } from 'crawlee';
import { AGGREGATOR_SITES } from '../sources/seedSources.js';
import { classifyForInclusion, looksElectronic } from '../genreClassifier.js';
import { extractJsonLdEvents } from '../extractors/jsonLdEvents.js';
import { extractEventCards } from '../extractors/eventCards.js';
import { parseDate, stripDates } from '../extractors/dates.js';

// Any single listing page producing more than this is misreading the page — see the check in
// the request handler. Sized to fit the genuinely large genre calendars: jiripetrak.cz lists
// ~143 upcoming parties nationwide and dnbeheard.cz publishes a full year at ~501, so the
// original 120 discarded both as misextraction. The cap exists to stop junk from swamping the
// run's geocoding budget, and that concern is now handled better upstream — the city-level
// pre-filter geocodes each distinct city once and caches it, so cost scales with towns, not
// events.
const MAX_EVENTS_PER_AGGREGATOR = 600;

/**
 * Splits a trailing "▼ Venue, Town" location off an event title, for sources that append one.
 *
 * Worth a per-source rule because location is what decides whether an event survives at all:
 * a candidate with no place can never clear the radius filter, and location-less aggregator
 * output is exactly what left 10 of 12 candidates unplaceable on an earlier run. Every one of
 * jiripetrak.cz's 143 events carries this suffix, so parsing it turns the whole feed from
 * undroppable-but-useless into fully filterable.
 *
 * The last comma-separated part is the town and the rest is the venue ("Vítkovice, Ostrava",
 * "Německé delikatesy u Philipa, Radotín, Praha"); with no comma it's a venue name on its own
 * ("BrickHouse DOV"), left for the geocoder to resolve by name.
 */
/**
 * Splits a leading "#Town Title, Venue ~ trailing junk" into its parts.
 *
 * dnbeheard.cz writes every entry this way ("#Ostrava DNB 90's, Fabric ~ FB event link"), and
 * it's worth a rule for the same reason as the suffix format: it's a year-round national D&B
 * calendar, and the hashtag is a clean town name for the radius filter.
 */
function splitHashPrefix(title) {
    // Searched anywhere rather than anchored at the start: a multi-day entry keeps a leading
    // date fragment ("4. &  #Krucemburk Spring BassJam"), and anchoring dropped the town for
    // every one of those. Requires an uppercase-initial word so the "#6" in "brickHOUSE #6"
    // isn't mistaken for a town tag.
    const match = title.match(/#(\p{Lu}\p{L}+)\s+([\s\S]+)$/u);
    if (!match) return { eventName: title, venue: '', city: '' };

    // The town is written as one CamelCase word ("#ČeskáLípa", "#FrýdekMístek"); split it back
    // into words so Nominatim can resolve it.
    const city = match[1].replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
    const rest = match[2].replace(/\s*~.*$/, '').trim();
    const parts = rest.split(',').map((part) => part.trim()).filter(Boolean);
    return {
        eventName: parts[0] || rest,
        venue: parts.length > 1 ? parts.slice(1).join(', ') : '',
        city,
    };
}

function splitLocationSuffix(title, source) {
    if (source.cityFromHashPrefix) return splitHashPrefix(title);
    const marker = source.locationSuffixMarker;
    const cleanTitle = source.titlePrefixRe ? title.replace(source.titlePrefixRe, '').trim() : title;
    if (!marker) return { eventName: cleanTitle, venue: '', city: '' };

    const at = cleanTitle.lastIndexOf(marker);
    if (at === -1) return { eventName: cleanTitle, venue: '', city: '' };

    const location = cleanTitle.slice(at + marker.length).trim();
    const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
    return {
        eventName: cleanTitle.slice(0, at).trim() || cleanTitle,
        venue: parts.length > 1 ? parts.slice(0, -1).join(', ') : location,
        city: parts.length > 1 ? parts[parts.length - 1] : '',
    };
}

/**
 * Best-effort fallback for aggregators without JSON-LD: scan link text for a date pattern
 * and use the link itself as the event title/URL. This is noisy by nature (any dated link
 * on the page matches), so we only keep hits that also look electronic-music-related,
 * unless the source is one we already know is dedicated to electronic music (forcedGenre
 * or trustedElectronic).
 */
function extractHeuristicEvents($, source) {
    const events = [];

    $('a').each((_, el) => {
        const $el = $(el);
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (text.length < 3) return;

        const date = parseDate(text) || parseDate($el.parent().text().replace(/\s+/g, ' '));
        if (!date) return;

        if (!source.forcedGenre && !source.trustedElectronic && !looksElectronic(text)) return;

        const title = stripDates(text) || source.name;
        const href = $el.attr('href');

        events.push({
            eventName: title,
            date,
            venue: source.name,
            address: '',
            city: '',
            description: '',
            sourceUrl: href ? new URL(href, source.listingUrl).toString() : source.listingUrl,
        });
    });

    return events;
}

/**
 * Crawls all seeded aggregator sites and returns raw candidate events (not yet geocoded,
 * distance-filtered, or deduped against other sources).
 * @returns {Promise<object[]>}
 */
export async function crawlAggregators() {
    const results = [];

    const crawler = new CheerioCrawler({
        maxConcurrency: 3,
        requestHandlerTimeoutSecs: 60,
        failedRequestHandler({ request, error }) {
            log.warning(`Aggregator crawl failed for ${request.url}: ${error?.message}`);
        },
        async requestHandler({ request, $ }) {
            const source = request.userData.source;

            // Three tiers, best signal first: publisher-provided JSON-LD, then the card
            // extractor (which reads date+title off a page's event cards), then the dated-link
            // heuristic as a last resort. The card tier was added because it reads sources the
            // link heuristic could not: 143 events off jiripetrak.cz where the heuristic found
            // only nav furniture.
            let events = extractJsonLdEvents($, source);
            let via = 'JSON-LD';
            if (events.length === 0) {
                events = extractEventCards($, source).map((event) => ({
                    ...event,
                    ...splitLocationSuffix(event.eventName, source),
                    address: '',
                    description: '',
                }));
                via = 'DOM cards';
            }
            if (events.length === 0) {
                events = extractHeuristicEvents($, source);
                via = 'dated links';
            }

            // Collected per source rather than pushed straight into `results`: handlers run
            // concurrently, so the cap below has to be able to discard this page's events
            // without touching anything another source has already contributed.
            const kept = [];
            for (const event of events) {
                const genres = source.forcedGenre
                    ? [source.forcedGenre]
                    : classifyForInclusion(event.eventName, { description: event.description, trustedElectronic: source.trustedElectronic });
                if (genres.length === 0) continue; // not an electronic-music event we can tag

                kept.push({
                    ...event,
                    venue: event.venue || source.name,
                    genres,
                    sourceName: source.name,
                    confidence: source.confidence,
                });
            }

            // A single listing page yielding more than this is misextraction, not a bumper
            // month: the heuristic extractor scans every dated <a>, and one source produced
            // 886 "events" that were nav links, city names and DJ names. Junk candidates cost
            // a geocoding call each at Nominatim's 1 req/sec, so left unchecked a single
            // misread page exhausts the whole run's time budget.
            if (kept.length > MAX_EVENTS_PER_AGGREGATOR) {
                log.warning(
                    `${source.name}: extracted ${kept.length} events, over the ${MAX_EVENTS_PER_AGGREGATOR} ` +
                        `sanity cap — treating this as misextraction and dropping them all. Needs per-site parsing.`,
                );
                return;
            }

            results.push(...kept);
            log.info(`${source.name}: ${events.length} raw event(s) via ${via}, kept ${kept.length}; ${results.length} total so far.`);
        },
    });

    await crawler.run(
        AGGREGATOR_SITES.map((source) => ({
            url: source.listingUrl,
            userData: { source },
        })),
    );

    return results;
}
