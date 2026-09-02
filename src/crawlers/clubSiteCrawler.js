import { Actor, log } from 'apify';
import { CLUB_SITES } from '../sources/seedSources.js';
import { classifyForInclusion } from '../genreClassifier.js';
import { mapWithConcurrency } from '../concurrency.js';

const WEBSITE_CONTENT_CRAWLER_ACTOR_ID = 'apify/website-content-crawler';
const MAX_CRAWL_PAGES_PER_SITE = 8; // club sites are small; a handful of pages covers the events/program page
// Confirmed live: Apify's concurrent-Actor-run cap is 5, shared across the whole account
// including this Actor's own run. main.js runs this crawl after Maps discovery/Facebook have
// already finished (not concurrently with them), so the only other slot in use is this
// Actor's own run itself — leaving up to 4 free, but staying at 3 for a margin of safety
// rather than running right at the ceiling.
const CLUB_SITE_CONCURRENCY = 3;

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
export function extractEventsFromMarkdown(text, source) {
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

        const genres = classifyForInclusion(title, { trustedElectronic: source.trustedElectronic });
        if (genres.length === 0) continue; // no genre signal, and source isn't trusted electronic-only

        events.push({
            eventName: title,
            date,
            venue: source.name,
            address: '',
            city: source.city,
            // Carried through when the caller already knows the venue's coordinates (e.g. a
            // Google Maps discovery result) so downstream doesn't need to re-geocode it.
            lat: source.lat,
            lon: source.lon,
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
 * Crawls one site via the apify/website-content-crawler Actor (free `cheerio` mode) and
 * heuristically extracts event-like entries from the resulting page text. Shared between
 * the seeded CLUB_SITES list and dynamically Maps-discovered venues.
 * @param {import('apify').ApifyClient} client
 * @param {{name: string, city?: string, url: string, confidence: string, lat?: number, lon?: number}} source
 * @returns {Promise<object[]>}
 */
export async function crawlOneClubSite(client, source) {
    try {
        log.info(`Running website-content-crawler for ${source.name} (${source.url})...`);
        const run = await client.actor(WEBSITE_CONTENT_CRAWLER_ACTOR_ID).call(
            {
                startUrls: [{ url: source.url }],
                maxCrawlPages: MAX_CRAWL_PAGES_PER_SITE,
                crawlerType: 'cheerio',
                // KNOWN LIMITATION, confirmed via a live test run: 'cheerio' only reads static
                // HTML, so on sites where the event listing is JS-rendered this returns thin or
                // unrelated content (e.g. pulled a static news archive instead of the real
                // upcoming program on one site). The Actor's other crawler modes render JS
                // correctly, but require paying per-call via x402 (a crypto/USDC payment rail,
                // separate from a normal Apify account) rather than the regular account balance —
                // not worth that trade-off here, so this stays on the free 'cheerio' mode.
                // Aggregators and Facebook Events carry more of the real signal as a result.
            },
            {
                // The Actor's own default is 8192MB — confirmed live that requesting that much
                // per concurrent call blows through the account's total 16384MB memory ceiling
                // almost immediately once more than one or two crawls overlap, failing nearly
                // every club site outright. Fetching a handful of static HTML pages needs
                // nowhere near that.
                memory: 512,
            },
        );

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        const events = [];
        for (const item of items) {
            // Field name has varied across website-content-crawler versions; check the
            // likely candidates rather than assuming one.
            const text = item.text || item.markdown || item.plainText || '';
            events.push(...extractEventsFromMarkdown(text, source));
        }

        log.info(`${source.name}: extracted ${events.length} candidate event(s).`);
        return events;
    } catch (err) {
        log.warning(`Club site crawl failed for ${source.name}: ${err.message}`);
        return [];
    }
}

/**
 * Crawls a list of club-like sites (defaults to the seeded CLUB_SITES, but also used for
 * dynamically Maps-discovered venues — see mapsDiscoveryCrawler.js).
 *
 * `deadline` exists because the Actor has a fixed wall-clock timeout and being killed
 * mid-crawl means pushing *nothing* — no dataset, no digest — even though earlier sources
 * already found events. Individual club-site crawls are the slowest and least reliable step
 * (30–150s each, and a JS-rendered program page often yields nothing anyway), so they're the
 * right thing to abandon when time runs short. Stopping early degrades coverage; running out
 * of time loses the whole run.
 *
 * @param {object[]} sources
 * @param {object} [options]
 * @param {number} [options.deadline] - epoch ms after which no new crawls are started.
 * @returns {Promise<object[]>}
 */
export async function crawlClubSites(sources = CLUB_SITES, { deadline } = {}) {
    const client = Actor.newClient();
    let skippedForTime = 0;

    const perSiteEvents = await mapWithConcurrency(sources, CLUB_SITE_CONCURRENCY, (source) => {
        if (deadline && Date.now() > deadline) {
            skippedForTime += 1;
            return [];
        }
        return crawlOneClubSite(client, source);
    });

    if (skippedForTime > 0) {
        log.warning(
            `Ran out of time budget: skipped ${skippedForTime} of ${sources.length} club site(s) so the run can still ` +
                `publish what the other sources found. Raise the Actor's run timeout to crawl them all.`,
        );
    }
    return perSiteEvents.flat();
}
