import { CheerioCrawler, log } from 'crawlee';
import { CLUB_SITES } from '../sources/seedSources.js';
import { classifyForInclusion } from '../genreClassifier.js';
import { extractJsonLdEvents } from '../extractors/jsonLdEvents.js';
import { extractEventCards } from '../extractors/eventCards.js';

// A single misread listing page must not be able to swamp the run: every candidate costs a
// geocoding call at Nominatim's 1 req/sec, so unbounded junk exhausts the time budget rather
// than merely looking untidy.
const MAX_EVENTS_PER_SITE = 80;
const CONCURRENCY = 5;

/**
 * Crawls club/venue websites directly with Crawlee, rather than through the
 * apify/website-content-crawler Actor.
 *
 * The Actor-based version was replaced because it found nothing at all: two live Návsí runs
 * extracted 0 events across 13 sites. Three separate causes, all fixed by crawling directly:
 *
 *  1. It flattened pages to Markdown, which destroys the card structure that ties a date to
 *     its title. rokac.cz has 9 upcoming events in plain server-rendered HTML; the Markdown
 *     line heuristic saw none of them.
 *  2. It never looked at JSON-LD, so barrak.cz's 67 fully-structured events were invisible.
 *  3. It cost a paid Actor call and a concurrent-run slot per site, with 30–150s of container
 *     startup each — the single largest consumer of a 300s run budget, for zero return.
 *
 * Crawling directly is free, needs no concurrency slot, and completed all 13 sites in about a
 * second and a half in testing. These sites are ordinary server-rendered HTML; the JS-rendering
 * that the Actor offered (and charged for) was never what was missing.
 *
 * Structured JSON-LD is preferred where a site publishes it, with the DOM card heuristic as
 * the fallback — same two-tier approach as the aggregator crawler.
 *
 * @param {Array<{name: string, city?: string, url: string, confidence: string, lat?: number, lon?: number, trustedElectronic?: boolean}>} sources
 * @returns {Promise<object[]>}
 */
export async function crawlClubSites(sources = CLUB_SITES) {
    const crawlable = sources.filter((source) => source.url);
    if (crawlable.length === 0) return [];

    const results = [];

    const crawler = new CheerioCrawler({
        maxConcurrency: CONCURRENCY,
        requestHandlerTimeoutSecs: 45,
        maxRequestRetries: 1,
        failedRequestHandler({ request, error }) {
            log.warning(`Club site crawl failed for ${request.url}: ${error?.message}`);
        },
        async requestHandler({ request, $ }) {
            const source = request.userData.source;

            let extracted = extractJsonLdEvents($, source);
            const via = extracted.length > 0 ? 'JSON-LD' : 'DOM cards';
            if (extracted.length === 0) extracted = extractEventCards($, source);

            // Built up per source before being appended: request handlers run concurrently,
            // so the cap below has to be able to discard this site's events without touching
            // what another site already contributed.
            const kept = [];
            for (const event of extracted) {
                const genres = classifyForInclusion(event.eventName, {
                    description: event.description || '',
                    trustedElectronic: source.trustedElectronic,
                    knownGenres: source.genreFocus,
                });
                if (genres.length === 0) continue; // no genre signal, and the venue isn't trusted electronic-only

                kept.push({
                    eventName: event.eventName,
                    date: event.date,
                    venue: event.venue || source.name,
                    address: event.address || '',
                    city: event.city || source.city || '',
                    // Carried through when the caller already knows the venue's coordinates
                    // (e.g. a Google Maps discovery result) so downstream needn't re-geocode.
                    lat: source.lat,
                    lon: source.lon,
                    description: event.description || '',
                    genres,
                    sourceName: source.name,
                    sourceUrl: event.sourceUrl || source.url,
                    confidence: source.confidence,
                });
            }

            if (kept.length > MAX_EVENTS_PER_SITE) {
                log.warning(
                    `${source.name}: extracted ${kept.length} events, over the ${MAX_EVENTS_PER_SITE} sanity ` +
                        `cap — treating this as misextraction and dropping them all.`,
                );
                return;
            }

            results.push(...kept);
            log.info(`${source.name}: ${extracted.length} raw event(s) via ${via}, kept ${kept.length}.`);
        },
    });

    await crawler.run(
        crawlable.map((source) => ({
            url: source.url,
            userData: { source },
            // Two venues can share a URL only by mistake, but Maps discovery can genuinely
            // return a site already in the seed list — keep both so neither is silently lost.
            uniqueKey: `${source.name}|${source.url}`,
        })),
    );

    return results;
}
