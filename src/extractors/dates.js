/**
 * Date parsing shared by every extractor.
 *
 * Czech sites write dates three ways — ISO (`2026-09-05`), numeric (`5. 9. 2026`) and named
 * month (`5. září 2026`) — and quite often with no year at all (`5. 9.`), because a club
 * programme is implicitly "this season".
 */

const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const DATE_CZ_NUMERIC_RE = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/;
// Same shape but with no trailing year. The negative lookahead keeps it from stealing the
// first two components of a full `5. 9. 2026`, which must be parsed by the rule above.
const DATE_CZ_NO_YEAR_RE = /\b(\d{1,2})\.\s?(\d{1,2})\.(?!\s?\d{4})/;

const CZECH_MONTHS = {
    ledna: 1, unora: 2, února: 2, brezna: 3, března: 3, dubna: 4, kvetna: 5, května: 5, cervna: 6, června: 6,
    cervence: 7, července: 7, srpna: 8, zari: 9, září: 9, rijna: 10, října: 10, listopadu: 11, prosince: 12,
};
const DATE_CZ_NAMED_RE = new RegExp(`\\b(\\d{1,2})\\.\\s*(${Object.keys(CZECH_MONTHS).join('|')})\\s*(\\d{4})?\\b`, 'i');

/** Every date pattern, for stripping dates out of a string that doubles as a title. */
export const ALL_DATE_PATTERNS = [DATE_ISO_RE, DATE_CZ_NUMERIC_RE, DATE_CZ_NAMED_RE, DATE_CZ_NO_YEAR_RE];

function toIsoDate(year, month, day) {
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Infers the year for a day/month with none given, assuming the date is upcoming: a month
 * earlier than the current one means next year. Wrong for a page listing past events, but
 * those are discarded by the date-range filter either way, so erring toward "upcoming" only
 * risks keeping a stale event — never dropping a real one.
 */
function inferYear(month) {
    const now = new Date();
    const year = now.getUTCFullYear();
    return Number(month) < now.getUTCMonth() + 1 ? year + 1 : year;
}

/**
 * Parses the first date found in a string, as `YYYY-MM-DD`, or null if there isn't one.
 * @param {string} text
 * @returns {string | null}
 */
export function parseDate(text) {
    if (!text) return null;

    const iso = text.match(DATE_ISO_RE);
    if (iso) return toIsoDate(iso[1], iso[2], iso[3]);

    const named = text.match(DATE_CZ_NAMED_RE);
    if (named) {
        const month = CZECH_MONTHS[named[2].toLowerCase()];
        return toIsoDate(named[3] || inferYear(month), month, named[1]);
    }

    const numeric = text.match(DATE_CZ_NUMERIC_RE);
    if (numeric) return toIsoDate(numeric[3], numeric[2], numeric[1]);

    const noYear = text.match(DATE_CZ_NO_YEAR_RE);
    if (noYear) return toIsoDate(inferYear(noYear[2]), noYear[2], noYear[1]);

    return null;
}

/** Removes any date from a string, for turning a "5.9. EVENT NAME" line into a title. */
export function stripDates(text) {
    return ALL_DATE_PATTERNS.reduce((acc, re) => acc.replace(re, ''), text)
        .replace(/^[\s\-–—:|.]+|[\s\-–—:|.]+$/g, '')
        .trim();
}

/**
 * Counts the dates in a string, stopping at `limit`.
 *
 * Used to tell an event card apart from the list that contains it: a card holds one date, a
 * listing container holds many. Repeatedly strips the leading date rather than using a global
 * regex, so it stays consistent with parseDate's precedence rules across the three formats.
 */
export function countDates(text, limit = 2) {
    let rest = text || '';
    let count = 0;
    while (count < limit) {
        const found = ALL_DATE_PATTERNS.map((re) => rest.match(re)).filter(Boolean).sort((a, b) => a.index - b.index)[0];
        if (!found) break;
        count += 1;
        rest = rest.slice(found.index + found[0].length);
    }
    return count;
}
