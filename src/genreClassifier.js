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
// Split into strong and weak because *where* a word appears decides whether it means
// anything. A live run surfaced a Rammstein tribute act as an electronic event: its title
// says "Live Tribute Act To RAMMSTEIN", and it qualified purely because the word "party"
// appeared somewhere in a long Facebook description. Meanwhile an "80s/90s hits" night at the
// same venue qualified on "dj" in its description, which is genuinely what it is.
//
// So: strong words count anywhere, including descriptions. Weak ones only count in the title.
// "bass" is weak for exactly this reason — in a rock band's description it's a guitar.
const STRONG_ELECTRONIC_KEYWORDS = [
    'dj', 'djs', 'djane', 'djs?ka', 'electronic', 'elektronick', 'elektronika', 'edm', 'rave',
    'b2b', 'dj set', 'live set', 'line-?up',
    'dubstep', 'trance', 'hardstyle', 'psytrance', 'breakbeat', 'diskotéka', 'diskoteka',
];
const WEAK_ELECTRONIC_KEYWORDS = [
    'bass', 'beat', 'beats', 'disco', 'party', 'párty', 'mejdan', 'open air', 'openair',
    // "afterparty" and "warm-up" read like electronic vocabulary but aren't: a metal gig's
    // description advertises an after party in the club just as readily, and warm-up is
    // mostly sport. Fine in a title, meaningless buried in prose.
    'afterparty', 'after party', 'warm-?up',
];
// Deliberately absent: a bare "live", which matches "Live Tribute Act To RAMMSTEIN"; and
// "tanečn"/"dance", which match ballroom and folk-dance events.
const STRONG_ELECTRONIC_RE = new RegExp(`\\b(${STRONG_ELECTRONIC_KEYWORDS.join('|')})\\b`, 'i');
const WEAK_ELECTRONIC_RE = new RegExp(`\\b(${WEAK_ELECTRONIC_KEYWORDS.join('|')})\\b`, 'i');

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

function matchesGenericElectronicSignal(title, description) {
    const strongHaystack = `${title || ''} ${description || ''}`;
    // "w/" is checked separately from the word lists because it isn't a word — it's the
    // lineup separator in titles like "EXPERIENCE ♡ w/ KRYDER", and requires a following
    // name so a stray "w/o" or "w/e" doesn't count.
    if (STRONG_ELECTRONIC_RE.test(strongHaystack)) return true;
    if (KNOWN_BRAND_RE.test(strongHaystack)) return true;
    if (/\sw\/\s*\p{L}{2,}/u.test(strongHaystack)) return true;
    return WEAK_ELECTRONIC_RE.test(title || '');
}

/**
 * True if `text` matches a specific genre keyword or the generic electronic/DJ vocabulary.
 * Treats `text` as a title, so weak keywords count — it's used on link text.
 */
export function looksElectronic(text) {
    return classifyGenres(text).length > 0 || matchesGenericElectronicSignal(text, '');
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
 * Title and description are passed separately on purpose — see the keyword lists above for
 * why a word's position changes what it's worth.
 *
 * @param {string} title
 * @param {object} [options]
 * @param {string} [options.description]
 * @param {boolean} [options.trustedElectronic]
 * @param {string[]} [options.knownGenres]
 * @returns {string[]} genres to tag the event with, or [] to drop it.
 */
export function classifyForInclusion(title, { description = '', trustedElectronic = false, knownGenres = [] } = {}) {
    const specific = classifyGenres(`${title || ''} ${description}`, knownGenres);
    if (specific.length > 0) return specific;
    if (trustedElectronic) return ['electronic'];
    if (matchesGenericElectronicSignal(title, description)) return ['electronic'];
    return [];
}

/**
 * Removes a trailing genre label from an event title, for display.
 *
 * Some venues append their own genre tagging to the title — fabric.cz publishes
 * "New Season Rave | House • Techno" and "DGTL: Techno Ladies w/ CARLA ROCA | Techno". That
 * suffix is useful signal and should be classified on, so this is meant to run *after*
 * classifyForInclusion, purely to keep the stored title readable.
 *
 * Only strips a final segment made up entirely of genre words and separators, so a title that
 * genuinely ends in "| Drum and Bass Special w/ Guests" keeps its words.
 */
const GENRE_LABEL_TAIL_RE = new RegExp(
    `\\s*[|·–—]\\s*(?:(?:${[...Object.values(SPECIFIC_GENRE_KEYWORDS).flat(), 'electronic', 'electronica', 'elektronika', 'drum & bass', 'dnb'].map(escapeRegExp).join('|')})[\\s•,/&+·|-]*)+$`,
    'i',
);
export function stripGenreLabel(title) {
    return (title || '').replace(GENRE_LABEL_TAIL_RE, '').trim() || title;
}

export { SPECIFIC_GENRE_KEYWORDS as GENRE_KEYWORDS };
