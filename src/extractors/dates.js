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
// No trailing \b: JS word boundaries are ASCII-only, so a boundary after a month ending in
// "í" ("září") never matches and "5. září" would fail to parse at all. (?!\d) is what's
// actually wanted here — don't let a 4-digit year be half-consumed.
const DATE_CZ_NAMED_RE = new RegExp(`\\b(\\d{1,2})\\.\\s*(${Object.keys(CZECH_MONTHS).join('|')})(?:\\s*(\\d{4}))?(?!\\d)`, 'i');

/** Every date pattern, for stripping dates out of a string that doubles as a title. */
export const ALL_DATE_PATTERNS = [DATE_ISO_RE, DATE_CZ_NUMERIC_RE, DATE_CZ_NAMED_RE, DATE_CZ_NO_YEAR_RE];

function toIsoDate(year, month, day) {
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Infers the year for a day/month with none given: always the current one.
 *
 * The tempting alternative — roll a month that's already past into next year, on the grounds
 * that a listing shows upcoming events — fabricates events. dnbeheard.cz publishes one
 * chronological calendar per year, so in September its page still opens with "2. 1.", "6. 1.",
 * "9. 1.". Rolling those forward turned 501 past-and-present entries into a wall of
 * confidently-dated January 2027 parties that do not exist.
 *
 * Assuming the current year instead means a past event stays in the past and gets dropped by
 * the date-range filter, which is the right outcome. The cost is missing a genuinely
 * next-January event listed without a year. That trade is deliberate: a miss is a gap in
 * coverage, a phantom is wrong data in the user's digest.
 */
function inferYear() {
    return new Date().getUTCFullYear();
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
        return toIsoDate(named[3] || inferYear(), month, named[1]);
    }

    const numeric = text.match(DATE_CZ_NUMERIC_RE);
    if (numeric) return toIsoDate(numeric[3], numeric[2], numeric[1]);

    const noYear = text.match(DATE_CZ_NO_YEAR_RE);
    if (noYear) return toIsoDate(inferYear(), noYear[2], noYear[1]);

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
