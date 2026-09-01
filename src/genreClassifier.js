/**
 * Genre classification for event titles/descriptions (CZ + EN).
 * Structural tags from a source (e.g. DnB e-Heard's forcedGenre, or a GoOut category)
 * should be trusted over this and passed in via `knownGenres` — this only fills in
 * genres that aren't already known.
 */

const SPECIFIC_GENRE_KEYWORDS = {
    techno: ['techno'],
    house: ['house', 'deep house', 'tech house'],
    drum_and_bass: ["drum and bass", "drum'n'bass", 'drum n bass', 'dnb', 'd&b', 'jungle'],
};

// Generic electronic/DJ signal, for events that are clearly electronic music but don't name
// a specific genre — e.g. "Beats for Love Experience w/ KANINE" or a branded local party name.
// Matched as whole words: a plain substring check on e.g. "rave" would false-positive on
// "Morava"/"Moravec"/"Moravský" (extremely common Czech place/surnames), which literally
// contain that substring.
const GENERIC_ELECTRONIC_KEYWORDS = ['dj', 'electronic', 'elektronika', 'edm', 'rave'];
const GENERIC_ELECTRONIC_RE = new RegExp(`\\b(${GENERIC_ELECTRONIC_KEYWORDS.join('|')})\\b`, 'i');

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matched, not a plain substring check — 'techno' as a substring would
// false-positive on ordinary Czech words like "technologie"/"technické"/"technika".
const SPECIFIC_GENRE_RES = Object.fromEntries(
    Object.entries(SPECIFIC_GENRE_KEYWORDS).map(([genre, keywords]) => [
        genre,
        new RegExp(`\\b(${keywords.map(escapeRegExp).join('|')})\\b`, 'i'),
    ]),
);

/**
 * @param {string} text - title + description to scan, any case.
 * @param {string[]} [knownGenres] - genres already established structurally (trusted as-is).
 * @returns {string[]} deduped list of matched *specific* genres, e.g. ['techno', 'house'].
 *  Does not include the generic 'electronic' catch-all — see classifyForInclusion for that.
 */
export function classifyGenres(text, knownGenres = []) {
    const genres = new Set(knownGenres);
    const haystack = text || '';

    for (const [genre, re] of Object.entries(SPECIFIC_GENRE_RES)) {
        if (genres.has(genre)) continue;
        if (re.test(haystack)) genres.add(genre);
    }

    return [...genres];
}

function matchesGenericElectronicSignal(text) {
    return GENERIC_ELECTRONIC_RE.test(text || '');
}

/** True if `text` matches a specific genre keyword or the generic electronic/DJ vocabulary. */
export function looksElectronic(text) {
    return classifyGenres(text).length > 0 || matchesGenericElectronicSignal(text);
}

/**
 * The actual inclusion gate crawlers should use: decides both *whether* an event counts as
 * electronic music at all, and which genre tag(s) to give it.
 *
 * - A specific genre keyword match always wins (e.g. ['techno']).
 * - Otherwise, if the source is already known to be dedicated to electronic music
 *   (`trustedElectronic`, e.g. Rave.cz, DnB e-Heard, or a seed club branded as an
 *   electronic-only venue), the event is kept with a generic ['electronic'] tag — the
 *   source itself is the guarantee, not the event's own wording.
 * - Otherwise, only kept if the text itself carries a generic electronic/DJ signal — this
 *   is what a general-purpose ticketing aggregator or mixed-programming venue needs, so a
 *   rock/jazz/theater listing there doesn't get pulled in.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.trustedElectronic]
 * @param {string[]} [options.knownGenres]
 * @returns {string[]} genres to tag the event with, or [] to drop it.
 */
export function classifyForInclusion(text, { trustedElectronic = false, knownGenres = [] } = {}) {
    const specific = classifyGenres(text, knownGenres);
    if (specific.length > 0) return specific;
    if (trustedElectronic) return ['electronic'];
    if (matchesGenericElectronicSignal(text)) return ['electronic'];
    return [];
}

export { SPECIFIC_GENRE_KEYWORDS as GENRE_KEYWORDS };
