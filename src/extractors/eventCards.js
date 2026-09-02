import { countDates, parseDate, stripDates } from './dates.js';

/**
 * DOM fallback for pages with no JSON-LD: find "event cards".
 *
 * The obvious approach — scan every `<a>` whose text contains a date — does not work on club
 * sites, and two live checks show why. On rokac.cz every programme entry is a dated card whose
 * link text is the single word "detail", so link-text scanning returned ten events all titled
 * "detail". On novaosmicka.cz the date isn't inside the `<a>` at all. Meanwhile that same
 * approach applied to listing portals happily matched nav links, city names and DJ names — one
 * source yielded 886 "events" that way.
 *
 * So the unit here is the card, not the link: find the leaf element that holds the date, walk
 * up a few levels to the enclosing card, and take that card's heading as the title. Requiring
 * a real heading is what filters out the nav-link noise. Verified live: 9 correct events off
 * rokac.cz and 12 off novaosmicka.cz, including the Beats for Love w/ KRYDER night that every
 * previous extractor missed.
 */

const MAX_CARD_DEPTH = 6;
// Long enough for a real event title, short enough that a whole card's text used as a
// fallback title stays readable rather than dumping a paragraph into the dataset.
const MAX_TITLE_LENGTH = 120;
const TITLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,strong,b,[class*=title],[class*=name],[class*=nazev],[class*=headline]';
const NOISE_TITLE_RE = /^(detail|více|vice|more|info|přejít|prejit|menu|zpět|zpet|back|program|akce|events?)$/i;

function normalise(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {{name: string, url?: string, listingUrl?: string}} source
 * @returns {Array<{eventName: string, date: string, sourceUrl: string}>}
 */
export function extractEventCards($, source) {
    const baseUrl = source.url || source.listingUrl || '';
    // Chrome-only furniture is pure noise here, and dropping it up front stops a footer's
    // copyright year or a cookie banner from being read as an event date.
    $('script, style, nav, footer, header, noscript').remove();

    const byKey = new Map();

    $('*').each((_, el) => {
        const $el = $(el);
        if ($el.children().length > 0) return; // leaf text nodes only — the date lives in one

        const date = parseDate(normalise($el.text()));
        if (!date) return;

        // Grow the card outward while it still describes a single event, i.e. while it holds
        // exactly one date. Overshooting into the surrounding list is not a harmless
        // approximation: `find()` searches the whole subtree, so once the ancestor is the page
        // wrapper the "title" becomes the first heading anywhere on the page. That produced 27
        // events from a D&B calendar all titled "Zaslat událost" (its submit-an-event link) and
        // 41 from another all titled "Filtry akcí" (its filter bar) — the dates were right and
        // every title was page furniture.
        let $card = $el;
        for (let depth = 0; depth < MAX_CARD_DEPTH; depth += 1) {
            const $parent = $card.parent();
            if ($parent.length === 0) break;
            if (countDates(normalise($parent.text())) > 1) break; // this is the list, not the card
            $card = $parent;
        }

        // A heading that is itself just a date is the card's date label, not its title.
        const heading = normalise($card.find(TITLE_SELECTOR).first().text());
        const whole = stripDates(normalise($card.text()));
        const candidate = heading.length > 2 && !parseDate(heading) ? heading : whole;
        if (candidate.length <= 2 || NOISE_TITLE_RE.test(candidate)) return;
        const title = (stripDates(candidate) || candidate).slice(0, MAX_TITLE_LENGTH);

        const href = $card.find('a[href]').first().attr('href');
        let sourceUrl = baseUrl;
        if (href && baseUrl) {
            try {
                sourceUrl = new URL(href, baseUrl).toString();
            } catch {
                // a malformed href on the page — keep the listing URL rather than dropping the event
            }
        }

        // The same card is reachable from several leaves (date, time, price), so dedupe as
        // we go rather than emitting one copy per text node.
        byKey.set(`${date}|${title.toLowerCase()}`, { eventName: title, date, sourceUrl });
    });

    return [...byKey.values()];
}
