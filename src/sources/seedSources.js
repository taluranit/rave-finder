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
 */

export const CLUB_SITES = [
    // Strong genre-focus confidence
    { name: 'Cross Club', city: 'Praha', url: 'https://crossclub.cz', genreFocus: ['drum_and_bass', 'techno'], confidence: 'high' },
    { name: 'Roxy', city: 'Praha', url: 'https://www.roxy.cz', genreFocus: ['house'], confidence: 'high' },
    { name: 'Ankali', city: 'Praha', url: 'https://ankali.club', genreFocus: ['techno'], confidence: 'high' },
    { name: 'Chapeau Rouge', city: 'Praha', url: 'https://www.chapeaurouge.cz', genreFocus: ['drum_and_bass'], confidence: 'high' },
    { name: 'Kabinet MUZ', city: 'Brno', url: 'https://www.kabinetmuz.cz', genreFocus: ['house'], confidence: 'high' },
    { name: 'Fabric', city: 'Ostrava', url: 'https://www.fabricat.cz', genreFocus: ['techno'], confidence: 'high' },

    // Moderate/low genre-focus confidence — still electronic-adjacent but more mixed programming
    { name: 'Pod Lampou', city: 'Plzeň', url: 'https://www.podlampou.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Storm Club', city: 'Praha', url: 'https://stormclub.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'MeetFactory', city: 'Praha', url: 'https://www.meetfactory.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Lucerna Music Bar', city: 'Praha', url: 'https://musicbar.cz', genreFocus: [], confidence: 'low' },
    { name: 'Palác Akropolis', city: 'Praha', url: 'https://www.palacakropolis.cz', genreFocus: [], confidence: 'low' },
    { name: 'Futurum Music Bar', city: 'Praha', url: 'https://www.futurumbar.cz', genreFocus: [], confidence: 'low' },
    { name: 'Fleda', city: 'Brno', url: 'https://www.fleda.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'SONO Centrum', city: 'Brno', url: 'https://www.sonocentrum.cz', genreFocus: [], confidence: 'moderate' },
    { name: 'Barrak Music Club', city: 'Ostrava', url: 'https://www.barrak.cz', genreFocus: [], confidence: 'low' },
];

export const AGGREGATOR_SITES = [
    // Prefer structured aggregators as primary sources — generally higher reliability than
    // heuristically-parsed club pages.
    { name: 'GoOut', url: 'https://goout.net', listingUrl: 'https://goout.net/cs/akce/hudba/elektronicka-hudba/', confidence: 'moderate' },
    { name: 'DnB e-Heard', url: 'https://dnbeheard.cz', listingUrl: 'https://dnbeheard.cz/kalendar-akci', confidence: 'high', forcedGenre: 'drum_and_bass' },
    { name: 'ColosseumTicket', url: 'https://www.colosseumticket.cz', listingUrl: 'https://www.colosseumticket.cz', confidence: 'moderate' },
    { name: 'KdyKde.cz', url: 'https://www.kdykde.cz', listingUrl: 'https://www.kdykde.cz', confidence: 'moderate' },
    { name: 'xTicket', url: 'https://www.xticket.cz', listingUrl: 'https://www.xticket.cz/koncerty-festivaly', confidence: 'moderate' },
    { name: 'KoncertyPraha', url: 'https://www.koncertypraha.cz', listingUrl: 'https://www.koncertypraha.cz', confidence: 'moderate' },
    { name: 'Rave.cz', url: 'https://rave.cz', listingUrl: 'https://rave.cz/partylist', confidence: 'high' },
];

// Explicitly excluded per v1 scope decision: too low-signal for reliable event extraction
// (KudyZNudy, Kultura365 are general tourism/culture aggregators; personal pages are
// one-off and not worth a dedicated crawler).
export const EXCLUDED_SOURCES = ['KudyZNudy', 'Kultura365'];
