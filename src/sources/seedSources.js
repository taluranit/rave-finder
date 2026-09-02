/**
 * Seed list of data sources for Czech electronic music events (v1 scope: Czech Republic only).
 *
 * Two kinds of sources:
 *  - CLUB_SITES: individual venue websites. These have no structured API, so they are
 *    fetched via the `apify/website-content-crawler` Actor (page text as Markdown) and
 *    then parsed with date/keyword heuristics in src/crawlers/clubSiteCrawler.js.
 *  - AGGREGATOR_SITES: event listing/ticketing sites that cover many venues. These are
 *    crawled directly (src/crawlers/aggregatorCrawler.js), preferring embedded JSON-LD
 *    Event data where the site provides it, and falling back to HTML heuristics.
 *
 * `confidence` reflects how reliable the source's genre tagging / event data is expected
 * to be, and is carried through to the output `confidence` field unless a later stage
 * (venue distance or genre keyword match) has reason to override it.
 *
 * `forcedGenre`, when set, means every event from that source is assumed to be that
 * genre without needing keyword classification (e.g. a source that is exclusively a
 * drum & bass calendar).
 *
 * `trustedElectronic`, when set, means the source itself is the guarantee that its content
 * is electronic music — so an event doesn't need to name a specific genre in its own text to
 * be included (see classifyForInclusion in genreClassifier.js). Only set on sources that are
 * dedicated to electronic music, not merely electronic-friendly/mixed-programming ones.
 */

export const CLUB_SITES = [
    // Strong genre-focus confidence — dedicated electronic/DJ venues, trusted outright
    { name: 'Cross Club', city: 'Praha', url: 'https://crossclub.cz', genreFocus: ['drum_and_bass', 'techno'], confidence: 'high', trustedElectronic: true },
    { name: 'Roxy', city: 'Praha', url: 'https://www.roxy.cz', genreFocus: ['house'], confidence: 'high', trustedElectronic: true },
    { name: 'Ankali', city: 'Praha', url: 'https://ankali.club', genreFocus: ['techno'], confidence: 'high', trustedElectronic: true },
    { name: 'Chapeau Rouge', city: 'Praha', url: 'https://www.chapeaurouge.cz', genreFocus: ['drum_and_bass'], confidence: 'high', trustedElectronic: true },
    { name: 'Kabinet MUZ', city: 'Brno', url: 'https://www.kabinetmuz.cz', genreFocus: ['house'], confidence: 'high', trustedElectronic: true },
    { name: 'Fabric', city: 'Ostrava', url: 'https://www.fabricat.cz', genreFocus: ['techno'], confidence: 'high', trustedElectronic: true },
    // Confirmed live (self-describes as "LIVE & ELECTRONIC CLUB") while investigating a
    // Jablunkov/Návsí-area gap in coverage.
    // NOT trustedElectronic, despite branding itself "LIVE & ELECTRONIC CLUB". Its actual
    // Facebook programme, read live, is overwhelmingly rock and metal: ONSLAUGHT, WITCH
    // HAMMER, BENEDICTION, a Rammstein tribute, David Koller, Pokáč. Trusting the
    // self-description meant tagging metal gigs, an 80s/90s night and a pizza Sunday as
    // "electronic" — so its events have to show a genre or DJ signal of their own like any
    // other mixed-programming venue. facebookPage is set because the page's events tab does
    // return real dated events with coordinates while the website yields nothing under the
    // free cheerio crawler.
    { name: 'Rokáč (Rock Café Jablunkov)', city: 'Jablunkov', url: 'https://rokac.cz', facebookPage: 'https://www.facebook.com/rokac.cz', genreFocus: [], confidence: 'moderate' },

    // Moderate/low genre-focus confidence — mixed programming, so genre inclusion still
    // requires the broadened keyword/DJ signal rather than being trusted outright.
    { name: 'Pod Lampou', city: 'Plzeň', url: 'https://www.podlampou.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Storm Club', city: 'Praha', url: 'https://stormclub.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'MeetFactory', city: 'Praha', url: 'https://www.meetfactory.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Lucerna Music Bar', city: 'Praha', url: 'https://musicbar.cz', genreFocus: [], confidence: 'low' },
    { name: 'Palác Akropolis', city: 'Praha', url: 'https://www.palacakropolis.cz', genreFocus: [], confidence: 'low' },
    { name: 'Futurum Music Bar', city: 'Praha', url: 'https://www.futurumbar.cz', genreFocus: [], confidence: 'low' },
    { name: 'Fleda', city: 'Brno', url: 'https://www.fleda.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'SONO Centrum', city: 'Brno', url: 'https://www.sonocentrum.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Barrak Music Club', city: 'Ostrava', url: 'https://www.barrak.cz', genreFocus: [], confidence: 'low' },
    // Confirmed live: genuinely mixed programming (comedy, sports, community events) with
    // occasional DJ/house sets (e.g. the Beats for Love Experience satellite series) — not
    // dedicated enough to trust outright, relies on the broadened generic keyword match.
    { name: 'Nová Osmička', city: 'Frýdek-Místek', url: 'https://novaosmicka.cz', genreFocus: [], confidence: 'moderate' },
];

export const AGGREGATOR_SITES = [
    // Prefer structured aggregators as primary sources — generally higher reliability than
    // heuristically-parsed club pages. GoOut's listing here is specifically its electronic
    // music category, and Rave.cz is an electronic-only partylist, so both are trusted outright.
    { name: 'GoOut', url: 'https://goout.net', listingUrl: 'https://goout.net/cs/akce/hudba/elektronicka-hudba/', confidence: 'moderate', trustedElectronic: true },
    { name: 'DnB e-Heard', url: 'https://dnbeheard.cz', listingUrl: 'https://dnbeheard.cz/kalendar-akci', confidence: 'high', forcedGenre: 'drum_and_bass' },
    { name: 'ColosseumTicket', url: 'https://www.colosseumticket.cz', listingUrl: 'https://www.colosseumticket.cz', confidence: 'moderate' },
    { name: 'KdyKde.cz', url: 'https://www.kdykde.cz', listingUrl: 'https://www.kdykde.cz', confidence: 'moderate' },
    { name: 'xTicket', url: 'https://www.xticket.cz', listingUrl: 'https://www.xticket.cz/koncerty-festivaly', confidence: 'moderate' },
    { name: 'KoncertyPraha', url: 'https://www.koncertypraha.cz', listingUrl: 'https://www.koncertypraha.cz', confidence: 'moderate' },
    { name: 'Rave.cz', url: 'https://rave.cz', listingUrl: 'https://rave.cz/partylist', confidence: 'high', trustedElectronic: true },
    // A dedicated D&B/techno party calendar, and the highest-yield free source found: 143
    // upcoming events on the last check, every single one carrying its venue and town after a
    // "▼" marker, which `locationSuffixMarker` below parses out. That matters as much as the
    // count — an event with no location can never clear the radius filter, and it was
    // location-less aggregator output that made 10 of 12 otherwise-good candidates
    // unplaceable on an earlier run. Titles also carry a "PÁ12 » SO12" day/time prefix that
    // `titlePrefixRe` strips.
    { name: 'Jiří Petrák D&B/Techno kalendář', url: 'https://www.jiripetrak.cz', listingUrl: 'https://www.jiripetrak.cz/cs/drum-a-bass-a-techno-parties-kalendar-akci-44/', confidence: 'high', trustedElectronic: true, locationSuffixMarker: '▼', titlePrefixRe: /^[A-ZÁ-Ž]{2}\d{1,2}\s*(»\s*[A-ZÁ-Ž]{0,2}\d{1,2})?\s*✅?\s*/ },
];

/**
 * Genre-specific calendars still needing per-site extraction before they can be enabled.
 *
 * dnbczevents.cz groups its listings under day headers, so the card extractor resolves each
 * event's title to the weekday it sits under — 41 events all named "pátek" or "sobota". The
 * dates are read correctly; only the titles need a site-specific selector. (Its earlier
 * failure was worse: the dated-link heuristic produced 886 "events" that were nav links, city
 * names and DJ names.)
 *
 * Its sibling jiripetrak.cz WAS in this list and is now a live AGGREGATOR_SITES entry — the
 * card extractor reads it correctly. Note it was originally dismissed as a "personal page";
 * that was a misread, it's a genre party calendar and the best free source here.
 */
export const CANDIDATE_AGGREGATORS_NEEDING_CUSTOM_EXTRACTION = [
    { name: 'DNB CZ Events', listingUrl: 'https://dnbczevents.cz/akce.php' },
];

/**
 * Venues that publish their programme to a Facebook page rather than to a crawlable website.
 *
 * Entries have no `url` — there's nothing to web-crawl — so they're only ever used by
 * crawlFacebookVenuePages, and the `city` is what the distance pre-filter uses to decide
 * whether they're worth spending a paid Actor call on.
 *
 * ONLY ADD A PAGE AFTER CONFIRMING IT HOSTS UPCOMING EVENTS. This list previously held four
 * researched-but-unvalidated pages (TESLA Production/Třinec, PartyTime/Frýdek-Místek, Project
 * Bar and DNB pro Ostravaky/Ostrava) and every one returned "No event detail URLs found". The
 * slugs were all real; the pages simply host nothing. Checking two by hand showed why, and
 * it's a regional pattern rather than bad luck: TESLA's events tab reads "No events to show"
 * with only Past entries, and PartyTime's page has no events tab at all. Around here the
 * *promoter* creates the event and merely tags the venue — TESLA's own feed advertises "Future
 * Control Open Air 2026", hosted by a separate Future Control page. So a venue page is worth
 * seeding only once its `/upcoming_hosted_events` tab is seen to list something; promoter
 * pages are the better target, and finding them needs a logged-in Facebook search this Actor
 * can't do.
 */
// Currently empty: the one page validated to host upcoming events (Rokáč) is already a
// CLUB_SITES entry carrying its own `facebookPage`, so it's picked up from there. This list is
// for venues that have a Facebook page and *no* website of their own.
export const FACEBOOK_VENUE_PAGES = [];

// Explicitly excluded per v1 scope decision: too low-signal for reliable event extraction
// (KudyZNudy, Kultura365 are general tourism/culture aggregators; personal pages are
// one-off and not worth a dedicated crawler).
export const EXCLUDED_SOURCES = ['KudyZNudy', 'Kultura365'];
