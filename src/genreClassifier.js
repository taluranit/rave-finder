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
// a specific genre. This is the gate that mixed-programming venues and general ticketing
// aggregators depend on, so its recall matters: with only the genre words plus "dj", a live
// run read all 14 of Nová Osmička's events correctly and then dropped every one — including
// "BEATS FOR LOVE: EXPERIENCE ♡ w/ KRYDER", the house night that prompted this Actor. The
// title names no genre and no DJ, but "beats"/"w/ <artist>" say exactly what it is.
//
// Matched as whole words, never as substrings: "rave" inside "Morava"/"Moravec"/"Moravský"
// and "techno" inside "technologie"/"technika" are all common Czech words, and substring
// matching on them produced confident nonsense.
const GENERIC_ELECTRONIC_KEYWORDS = [
    'dj', 'djs', 'djane', 'djs?ka', 'electronic', 'elektronick', 'elektronika', 'edm', 'rave',
    // Lineup/set vocabulary — how a DJ night is written when it names no genre.
    'b2b', 'dj set', 'live set', 'line-?up', 'afterparty', 'after party', 'warm-?up',
    // "bass"/"beat(s)" are strong electronic markers in event titles ("BASS'N'KEBAB",
    // "Spring BassJam", "FUNKY BEAT DAY") and don't collide with the rock/metal and
    // community-event titles these sources are otherwise full of.
    'bass', 'beat', 'beats', 'breakbeat', 'dubstep', 'trance', 'hardstyle', 'psytrance',
    'disco', 'diskotéka', 'diskoteka', 'party', 'párty', 'mejdan', 'open air', 'openair',
];
// Deliberately not on the list: a bare "live", which would match "Live Tribute Act To
// RAMMSTEIN"; and "tanečn"/"dance", which match ballroom and folk-dance events.
const GENERIC_ELECTRONIC_RE = new RegExp(`\\b(${GENERIC_ELECTRONIC_KEYWORDS.join('|')})\\b`, 'i');

// Named electronic events/promoters whose titles carry no genre word at all. Kept short and
// specific — a brand list is a maintenance burden, justified only for events big enough that
// missing them defeats the point (Beats for Love is the Czech Republic's largest D&B festival
// and runs satellite "Experience" nights in the region).
const KNOWN_ELECTRONIC_BRANDS = ['beats for love', 'b4l', 'let it roll', 'tancuj'];
const KNOWN_BRAND_RE = new RegExp(`(${KNOWN_ELECTRONIC_BRANDS.join('|')})`, 'i');

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
    const haystack = text || '';
    // "w/" is checked separately from the word list because it isn't a word — it's the
    // lineup separator in titles like "EXPERIENCE ♡ w/ KRYDER", and requires a following
    // name so a stray "w/o" or "w/e" doesn't count.
    return GENERIC_ELECTRONIC_RE.test(haystack) || KNOWN_BRAND_RE.test(haystack) || /\sw\/\s*\p{L}{2,}/u.test(haystack);
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
