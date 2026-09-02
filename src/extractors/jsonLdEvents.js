/**
 * schema.org Event extraction from a page's JSON-LD.
 *
 * This is the highest-quality signal available without writing a scraper per site: name,
 * exact start date, venue name and often a full postal address, straight from the publisher.
 *
 * The important detail is that Event objects are *nested arbitrarily deep*. An earlier
 * version only looked at the top level and at `@graph`, and so reported "no JSON-LD events"
 * for barrak.cz — whose single block is a `LocalBusiness` with all 67 of its upcoming events
 * hanging off an `events` property. Walking the whole object tree instead found every one of
 * them, correctly dated and with venue names attached. So: recurse, don't guess the shape.
 */

/** Collects every Event/MusicEvent object anywhere in a parsed JSON-LD value. */
function collectEvents(node, found, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return found;

    if (Array.isArray(node)) {
        for (const child of node) collectEvents(child, found, depth + 1);
        return found;
    }

    const types = [].concat(node['@type'] || []);
    if (types.includes('Event') || types.includes('MusicEvent')) found.push(node);

    for (const key of Object.keys(node)) {
        if (key === '@type') continue;
        collectEvents(node[key], found, depth + 1);
    }
    return found;
}

function readAddress(location) {
    const address = location?.address;
    if (typeof address === 'string') return { address, city: '' };
    return {
        address: [address?.streetAddress, address?.postalCode, address?.addressLocality]
            .filter(Boolean)
            .join(', '),
        city: address?.addressLocality || '',
    };
}

/**
 * Extracts normalised candidate events from every JSON-LD block on a page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {{name: string, listingUrl?: string, url?: string, city?: string}} source
 * @returns {Array<{eventName: string, date: string, venue: string, address: string, city: string, description: string, sourceUrl: string}>}
 */
export function extractJsonLdEvents($, source) {
    const fallbackUrl = source.listingUrl || source.url || '';
    const found = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        let data;
        try {
            data = JSON.parse($(el).contents().text());
        } catch {
            return; // malformed JSON-LD on the page — skip it, not our problem to fix
        }
        collectEvents(data, found);
    });

    return found
        .map((item) => {
            const { address, city } = readAddress(item.location);
            return {
                eventName: item.name || source.name,
                date: typeof item.startDate === 'string' ? item.startDate.slice(0, 10) : null,
                venue: item.location?.name || source.name,
                address,
                city: city || source.city || '',
                description: typeof item.description === 'string' ? item.description : '',
                sourceUrl: item.url || fallbackUrl,
            };
        })
        .filter((event) => event.date); // discard anything we couldn't date
}
