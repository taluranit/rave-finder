/**
 * Keyword-based genre classification for event titles/descriptions (CZ + EN).
 * Structural tags from a source (e.g. DnB e-Heard's forcedGenre, or a GoOut category)
 * should be trusted over this and passed in via `knownGenres` — this only fills in
 * genres that aren't already known.
 */

const GENRE_KEYWORDS = {
    techno: ['techno'],
    house: ['house', 'deep house', 'tech house'],
    drum_and_bass: ["drum and bass", "drum'n'bass", 'drum n bass', 'dnb', 'd&b', 'jungle'],
};

/**
 * @param {string} text - title + description to scan, any case.
 * @param {string[]} [knownGenres] - genres already established structurally (trusted as-is).
 * @returns {string[]} deduped list of matched genres, e.g. ['techno', 'house'].
 */
export function classifyGenres(text, knownGenres = []) {
    const genres = new Set(knownGenres);
    const haystack = (text || '').toLowerCase();

    for (const [genre, keywords] of Object.entries(GENRE_KEYWORDS)) {
        if (genres.has(genre)) continue;
        if (keywords.some((kw) => haystack.includes(kw))) {
            genres.add(genre);
        }
    }

    return [...genres];
}

/** True if `text` matches any electronic-music keyword at all, across all genres. */
export function looksElectronic(text) {
    return classifyGenres(text).length > 0;
}

export { GENRE_KEYWORDS };
