import { Actor, log } from 'apify';
import { CLUB_SITES } from '../sources/seedSources.js';
import { classifyGenres } from '../genreClassifier.js';

const WEBSITE_CONTENT_CRAWLER_ACTOR_ID = 'apify/website-content-crawler';
const MAX_CRAWL_PAGES_PER_SITE = 8; // club sites are small; a handful of pages covers the events/program page

const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DATE_CZ_NUMERIC_RE = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/;
const CZECH_MONTHS = {
    ledna: 1, unora: 2, února: 2, brezna: 3, března: 3, dubna: 4, kvetna: 5, května: 5, cervna: 6, června: 6,
    cervence: 7, července: 7, srpna: 8, zari: 9, září: 9, rijna: 10, října: 10, listopadu: 11, prosince: 12,
};
const DATE_CZ_NAMED_RE = new RegExp(`\\b(\\d{1,2})\\.\\s*(${Object.keys(CZECH_MONTHS).join('|')})\\s*(\\d{4})\\b`, 'i');

function toIsoDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateFromLine(line) {
    const iso = line.match(DATE_ISO_RE);
    if (iso) return toIsoDate(iso[1], iso[2], iso[3]);

    const named = line.match(DATE_CZ_NAMED_RE);
    if (named) {
        const month = CZECH_MONTHS[named[2].toLowerCase()];
        return toIsoDate(named[3], month, named[1]);
    }

    const numeric = line.match(DATE_CZ_NUMERIC_RE);
    if (numeric) return toIsoDate(numeric[3], numeric[2], numeric[1]);

    return null;
}

/**
 * Best-effort line-based heuristic: club program pages are usually a list of "date + event
 * name" lines (as Markdown headings, list items, or plain paragraphs). We look for a date
 * on each line and, if found, use that line (with the date stripped) as the title — falling
 * back to the next non-empty line if the date-bearing line has nothing else on it.
 * This will miss events on sites with unusual layouts (e.g. a calendar grid with dates and
 * titles in separate table cells) — a known limitation of using page text instead of a
 * per-site DOM scraper.
 */
function extractEventsFromMarkdown(text, source) {
    const events = [];
    const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
        const date = parseDateFromLine(lines[i]);
        if (!date) continue;

        let title = lines[i]
            .replace(/^#+\s*/, '')
            .replace(DATE_ISO_RE, '')
            .replace(DATE_CZ_NAMED_RE, '')
            .replace(DATE_CZ_NUMERIC_RE, '')
            .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
            .trim();

        if (!title && lines[i + 1]) title = lines[i + 1].replace(/^#+\s*/, '').trim();
        if (!title) continue;

        const genres = classifyGenres(title);
        if (genres.length === 0) continue; // no genre signal in the title — best-effort skip

        events.push({
            eventName: title,
            date,
            venue: source.name,
            address: '',
            city: source.city,
            description: '',
            genres,
            sourceName: source.name,
            sourceUrl: source.url,
            confidence: source.confidence,
        });
    }

    return events;
}

/**
 * Crawls all seeded club sites via the apify/website-content-crawler Actor (free to run)
 * and heuristically extracts event-like entries from the resulting page text.
 * @returns {Promise<object[]>}
 */
export async function crawlClubSites() {
    const client = Actor.newClient();
    const results = [];

    for (const source of CLUB_SITES) {
        try {
            log.info(`Running website-content-crawler for ${source.name} (${source.url})...`);
            const run = await client.actor(WEBSITE_CONTENT_CRAWLER_ACTOR_ID).call({
                startUrls: [{ url: source.url }],
                maxCrawlPages: MAX_CRAWL_PAGES_PER_SITE,
                crawlerType: 'cheerio',
            });

            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            for (const item of items) {
                // Field name has varied across website-content-crawler versions; check the
                // likely candidates rather than assuming one.
                const text = item.text || item.markdown || item.plainText || '';
                const events = extractEventsFromMarkdown(text, source);
                results.push(...events);
            }

            log.info(`${source.name}: extracted ${results.length} candidate event(s) so far.`);
        } catch (err) {
            log.warning(`Club site crawl failed for ${source.name}: ${err.message}`);
        }
    }

    return results;
}
