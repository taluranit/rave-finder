/**
 * Cross-source dedup: the same party often shows up on a club's own site, an aggregator,
 * and Facebook. We treat two events as duplicates when they're on the same date, at a
 * venue that normalizes to the same string, with a "close enough" title — either high
 * token overlap or a low normalized Levenshtein distance. No fuzzy-matching library
 * needed for this scale of data.
 */

const TITLE_SIMILARITY_THRESHOLD = 0.6; // token-overlap (Jaccard) at/above this counts as a match
const LEVENSHTEIN_RATIO_THRESHOLD = 0.25; // edit-distance / max-length at/below this counts as a match

function normalize(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip diacritics so "Café" ~ "Cafe"
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenOverlap(a, b) {
    const tokensA = new Set(normalize(a).split(' ').filter(Boolean));
    const tokensB = new Set(normalize(b).split(' ').filter(Boolean));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let shared = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) shared += 1;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    return shared / union;
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prevRow = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        const currRow = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow[j] = Math.min(
                prevRow[j] + 1, // deletion
                currRow[j - 1] + 1, // insertion
                prevRow[j - 1] + cost, // substitution
            );
        }
        prevRow = currRow;
    }
    return prevRow[n];
}

function titlesMatch(a, b) {
    const normA = normalize(a);
    const normB = normalize(b);
    if (!normA || !normB) return false;
    if (normA === normB) return true;

    if (tokenOverlap(normA, normB) >= TITLE_SIMILARITY_THRESHOLD) return true;

    const distance = levenshtein(normA, normB);
    const ratio = distance / Math.max(normA.length, normB.length);
    return ratio <= LEVENSHTEIN_RATIO_THRESHOLD;
}

/** Same calendar day, ignoring time-of-day (a club site might list 21:00, an aggregator 22:00). */
function sameDate(a, b) {
    if (!a || !b) return false;
    return a.slice(0, 10) === b.slice(0, 10);
}

/**
 * @param {object[]} events - events with at least { eventName, date, venue }.
 * @returns {object[]} deduped events, keeping the first-seen occurrence of each group
 *  (callers should sort by source confidence beforehand so the "best" copy is kept).
 */
export function dedupeEvents(events) {
    const kept = [];

    for (const event of events) {
        const isDuplicate = kept.some(
            (existing) =>
                sameDate(existing.date, event.date) &&
                normalize(existing.venue) === normalize(event.venue) &&
                titlesMatch(existing.eventName, event.eventName),
        );
        if (!isDuplicate) kept.push(event);
    }

    return kept;
}
