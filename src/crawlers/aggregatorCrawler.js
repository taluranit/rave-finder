import { CheerioCrawler, log } from 'crawlee';
import { AGGREGATOR_SITES } from '../sources/seedSources.js';
import { classifyGenres, looksElectronic } from '../genreClassifier.js';

const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DATE_CZ_RE = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/; // e.g. "12. 4. 2026" or "12.4.2026"

function toIsoDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateFromText(text) {
    if (!text) return null;
    const iso = text.match(DATE_ISO_RE);
    if (iso) return toIsoDate(iso[1], iso[2], iso[3]);
    const cz = text.match(DATE_CZ_RE);
    if (cz) return toIsoDate(cz[3], cz[2], cz[1]);
    return null;
}

/**
 * Many ticketing/listing sites (GoOut, ColosseumTicket, xTicket, etc.) embed schema.org
 * Event/MusicEvent data as JSON-LD for SEO. This is the most reliable signal available
 * without a per-site scraper, so we always try it first.
 */
function extractJsonLdEvents($, source) {
    const events = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        let data;
        try {
            data = JSON.parse($(el).contents().text());
        } catch {
            return; // malformed JSON-LD on the page — skip it, not our problem to fix
        }

        const roots = Array.isArray(data) ? data : [data];
        for (const root of roots) {
            const candidates = root?.['@graph'] ? root['@graph'] : [root];
            for (const item of candidates) {
                const types = item?.['@type'] ? (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]) : [];
                if (!types.includes('Event') && !types.includes('MusicEvent')) continue;

                const address = item.location?.address;
                events.push({
                    eventName: item.name || source.name,
                    date: item.startDate ? item.startDate.slice(0, 10) : null,
                    venue: item.location?.name || source.name,
                    address: typeof address === 'string' ? address : address?.streetAddress || '',
                    city: typeof address === 'object' ? address?.addressLocality || '' : '',
                    description: item.description || '',
                    sourceUrl: item.url || source.listingUrl,
                });
            }
        }
    });

    return events.filter((e) => e.date); // discard anything we couldn't date
}

/**
 * Best-effort fallback for aggregators without JSON-LD: scan link text for a date pattern
 * and use the link itself as the event title/URL. This is noisy by nature (any dated link
 * on the page matches), so we only keep hits that also look electronic-music-related,
 * unless the source is one we already know is exclusively electronic (forcedGenre).
 */
function extractHeuristicEvents($, source) {
    const events = [];

    $('a').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (text.length < 3) return;

        const date = parseDateFromText(text) || parseDateFromText($el.parent().text());
        if (!date) return;

        if (!source.forcedGenre && !looksElectronic(text)) return;

        const title = text.replace(DATE_ISO_RE, '').replace(DATE_CZ_RE, '').trim() || source.name;
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
            let events = extractJsonLdEvents($, source);
            if (events.length === 0) {
                events = extractHeuristicEvents($, source);
            }

            for (const event of events) {
                const genres = source.forcedGenre ? [source.forcedGenre] : classifyGenres(`${event.eventName} ${event.description}`);
                if (genres.length === 0) continue; // not an electronic-music event we can tag

                results.push({
                    ...event,
                    genres,
                    sourceName: source.name,
                    confidence: source.confidence,
                });
            }

            log.info(`${source.name}: found ${events.length} raw event(s), ${results.length} total electronic so far.`);
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
