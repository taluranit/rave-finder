# Rave Finder

Finds upcoming **electronic music and DJ events** — techno, house, drum & bass, and
generally-electronic events that don't name a specific genre — near a Czech city, within a
radius you choose. Searches Resident Advisor, event aggregators (GoOut, DnB e-Heard,
ColosseumTicket, KdyKde, xTicket, KoncertyPraha, Rave.cz), club websites, and Facebook
Events. Optionally sends you a periodic email digest of newly found events.

**v1 scope: Czech Republic only.**

## How it works

1. Geocodes the city you give it (OpenStreetMap Nominatim, no API key needed).
2. Crawls several kinds of sources, in phases (see "Actor-run budget" below):
   - **Resident Advisor** — the primary source, and the only one that's simultaneously free,
     genre-tagged at the source, and geographically scoped by the API itself. RA's GraphQL
     API needs no authentication, so `src/crawlers/residentAdvisorCrawler.js` calls it
     directly rather than paying for a scraper Actor: no per-event cost, and it doesn't
     consume a concurrent-Actor-run slot. Verified live: one country-wide query returns ~114
     upcoming Czech events, 111 of them with real street addresses, carrying RA's own genre
     taxonomy ("Techno", "Progressive House", "Garage", "Electronica"…).
     RA areas are city/region level — Prague and Brno have their own, smaller towns like
     Ostrava and Frýdek-Místek don't — so this queries the country-wide "All Czech Republic"
     area and lets the radius filter do the geography.
   - **Aggregators and club sites** — both crawled directly with Crawlee (free, no Actor
     call) through the shared extractors in `src/extractors/`, in three tiers: schema.org
     JSON-LD where a site publishes it, then DOM event cards, then dated links.

     This replaced an earlier pipeline that ran each club site through
     [`apify/website-content-crawler`](https://apify.com/apify/website-content-crawler) and
     parsed the resulting Markdown. That version found **0 events across 13 sites** on two
     separate runs, and the sites were never the problem:

     - Markdown flattening destroyed the card structure tying a date to its title. rokac.cz
       has 9 upcoming events in plain server-rendered HTML; the line heuristic saw none.
     - Nothing walked *nested* JSON-LD, so barrak.cz's 67 fully-structured events were
       invisible — they hang off a `LocalBusiness` object's `events` property.
     - It cost a paid Actor call and a concurrent-run slot per site, with 30–150s of
       container startup each, for no return.

     Crawling directly is free, needs no concurrency slot, and covers all 13 sites in about
     1.5 seconds. The JS rendering the Actor charged for was never what was missing; these
     are ordinary server-rendered pages. Two per-source title rules
     (`locationSuffixMarker`, `cityFromHashPrefix`) parse the venue and town out of titles
     on the two national genre calendars, which is what makes their events placeable at all.
   - **Club sites (Maps-discovered)** — the seeded list only covers ~17 venues in a handful
     of cities, so it contributes nothing for a city outside that list. To cover any Czech
     city/radius, `src/crawlers/mapsDiscoveryCrawler.js` searches Google Maps
     ([`compass/crawler-google-places`](https://apify.com/compass/crawler-google-places),
     ~$1.50 per 1,000 places — billed through the normal Apify account, not x402) for
     club-like venues near the geocoded city center, then crawls each discovered venue's
     website the same way as the seeded list. Capped by `maxMapsVenues`; set to `0` to
     disable.
   - **Facebook venue pages** — the source that actually works for small towns, and **on by
     default** (`includeFacebookVenuePages`). Rather than searching, it reads the events tab
     of venues already established to be in range. Verified live against Rokáč: its own
     website yielded nothing under the free `cheerio` crawler, while
     `facebook.com/rokac.cz/upcoming_hosted_events` returned 15 events with dates *and*
     coordinates. The plain page URL returns one empty record — the `/upcoming_hosted_events`
     tab is the URL shape that works, and `startUrls` takes plain strings, not `{ url }`
     objects (the Actor calls `url.match()` on each entry and crashes otherwise).
     Cost scales with the number of nearby venues instead of with search noise.
     Because a venue page publishes the venue's *whole* programme, events inherit the venue's
     `trustedElectronic` (so a DJ night naming no genre survives) but are screened by a
     non-music filter — a live run otherwise surfaced a wine-and-burčák tasting. The filter
     drops tastings, workshops, yoga, tournaments and markets while deliberately keeping
     anything that might be a DJ night.
   - **Facebook Events search** — via
     [`apify/facebook-events-scraper`](https://apify.com/apify/facebook-events-scraper),
     searched by genre + the **towns Facebook actually indexes** near your search point (no
     hardcoded page list). **Off by default** (`includeFacebookEvents: false`) — see
     "Why Facebook search is off" below. It costs ~$0.013/event when enabled.
     Searching the literal input city was a mistake worth documenting: Facebook's event
     search is keyword matching, *not* a location filter. Verified live for "Návsí" —
     techno/house/electronic each returned "No events found", while "drum and bass Návsí"
     silently ignored the place and returned ~150 global D&B events from Coventry, Budapest
     and Brooklyn, all of which the radius filter then correctly discarded. So the whole
     paid call was spent on noise. `src/nearbyTowns.js` now resolves real towns within the
     radius via OpenStreetMap's Overpass API (free, keyless) — for Návsí+50km that's
     Ostrava, Žilina, Havířov, Frýdek-Místek and so on — and those get searched instead.
3. Classifies each event's genre(s) — see `src/genreClassifier.js`:
   - Structural tags win outright (e.g. DnB e-Heard's `forcedGenre: 'drum_and_bass'`).
   - A specific genre keyword (techno/house/drum & bass, CZ + EN, word-boundary matched —
     not a plain substring check, since e.g. "techno" as a substring would false-positive on
     "technologie"/"technické") wins next.
   - Otherwise, sources already known to be dedicated to electronic music
     (`trustedElectronic: true` in `seedSources.js` — Rave.cz, GoOut's electronic-music
     category, and the seed clubs branded as electronic-only venues) still keep the event,
     tagged generically as `electronic`. This is what makes a branded event like "Beats for
     Love Experience w/ KANINE" or a local party name survive even though its title names no
     genre — the source itself is the guarantee.
   - Everywhere else (general ticketing aggregators, mixed-programming clubs, Facebook
     search results), an event only survives if its own text carries a generic
     electronic/DJ signal ("dj", "electronic", "elektronika", "edm", "rave") — this is what
     keeps rock/jazz/theater listings on those same sources from flooding the output.
4. Geocodes each venue and filters by distance from the city center — cached in the
   key-value store, except Maps-discovered venues and Resident Advisor events, which already
   carry their own coordinates or a street address.

   Club sites are also **distance-pre-filtered before being crawled**, not just after:
   every seeded venue has a known city, so geocoding that city (cached, free) rules out the
   ones that can't possibly be in range. Searching Návsí used to spend one Actor call each on
   Cross Club, Roxy, Ankali, MeetFactory, Lucerna and the rest of the Prague/Brno list — all
   ~350km away, every resulting event discarded by the radius filter anyway.
5. Filters by requested genres and date range, then dedupes events that show up on more
   than one source.
6. Pushes the results to the default dataset.
7. If you gave a `subscriberEmail`, sends an email digest of newly found events (see below).

## Why Facebook search is off

Facebook's event search OR-matches instead of filtering, and both failure modes were hit in
live testing:

- Searching the literal input city ignored the *place*: "drum and bass Návsí" returned ~150
  global D&B events from Coventry, Budapest and Brooklyn.
- Searching real nearby towns ignored the *genre*: "drum and bass Havířov" returned every
  unrelated event in Havířov — maternity-ward tours, yoga classes, a dog-school race,
  board-game nights.

Either way the events are billed at ~$0.013 each *before* this Actor's genre and radius
filters discard them, and one run spent its entire 300-second budget on Facebook while
surfacing no electronic events for the searched region at all.

This is a limitation of the *search* index, not of Facebook as a source — small promoters
genuinely do publish there, but on venue and promoter **pages** rather than anywhere the
event search reaches. The promising direction is therefore to feed known venue pages to the
scraper as `startUrls`; Maps discovery already surfaces venue Facebook pages (currently
skipped, since `cheerio` can't read facebook.com). That Actor documents `startUrls` as
event/search/explore URLs rather than page URLs, so it needs a cheap live test first.

The search path is kept in the code and can be re-enabled with `includeFacebookEvents: true`.

## Actor-run budget

Apify caps **concurrent Actor runs per account** (5 on the plan this was built against,
*including this Actor's own run*), and a called Actor's default memory counts against a
shared ceiling too. Both limits were hit hard in testing, and failed silently-ish: every
club-site crawl in a run aborted with "you will exceed your limit of 5 concurrent Actor runs"
while the run itself still reported success and zero results.

Moving the club and aggregator crawls in-process removed most of that pressure — they now
cost zero Actor slots. What remains is phased rather than maximally parallel:

| Phase | What runs | Actor calls |
|---|---|---|
| 1 | Resident Advisor, aggregators, nearby-town lookup, Maps discovery | 1 (Maps only) |
| 2 | Facebook Events search (off by default) | 1 |
| 3 | Club sites (in-process), then Facebook venue pages | 1 per venue page, 3 at a time |

Facebook venue pages take **one Actor call per page**. Batching them into a single call looks
cheaper but isn't: the scraper's `maxEvents` is a whole-run total, so whichever page it
crawls first swallows the entire budget — a run with 6 pages and a cap of 20 returned 16
events all from one venue, and the other five contributed nothing. One call per page with
`maxEvents / pages` each costs the same and actually covers every venue.

Free/keyless sources (Resident Advisor, Nominatim, Overpass) and the in-process Crawlee
crawls cost **zero** Actor slots.

**The 300-second default run timeout is now the design constraint, not a problem to raise.**
Note that `defaultRunOptions` is *not* a valid `actor.json` property (see Apify's actor.json
reference) — putting it there is silently ignored, which cost one early run an abort. It can
only be changed in Apify Console under Settings → Run options. Since the paid per-site crawls
are gone, a full run finishes well inside the default, and the earlier deadline-and-skip
machinery has been removed. The remaining slow step is geocoding, rate-limited to 1 request
per second by Nominatim's usage policy — which is why events are filtered by city first
(geocoding each distinct town once, cached) before any venue is geocoded individually.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `city` | string | *(required)* | Czech city to search near, e.g. `"Brno"`. |
| `radiusKm` | integer | `30` | Max distance from the city center, in km (1–300). |
| `genres` | array | all four | `techno`, `house`, `drum_and_bass`, `electronic` (generic — electronic/DJ events with no specific genre named). |
| `dateRangeDays` | integer | `30` | Only include events within this many days from now (1–180). |
| `includeFacebookEvents` | boolean | `false` | Also search Facebook Events — off by default, see below. |
| `maxFacebookEvents` | integer | `20` | Caps Facebook events fetched, to control cost. |
| `maxMapsVenues` | integer | `5` | Caps Maps-discovered venues per search term, to control cost; `0` disables Maps discovery. Low by default — each discovered venue costs an Actor call, and most Maps hits are dance schools and bars, not electronic venues. |
| `subscriberEmail` | string | *(none)* | If set, enables the email digest (see below). |
| `digestFrequency` | enum | `weekly` | `daily` / `weekly` / `biweekly` / `monthly`. |
| `resendApiKey` | string (secret) | *(none)* | Required only if `subscriberEmail` is set. |

See `.actor/input_schema.json` for the full schema.

## Email digest setup

The digest uses the [Resend](https://resend.com) REST API directly (no SDK). To enable it:

1. Create a free Resend account and grab an API key.
2. Set `subscriberEmail` to your address and `resendApiKey` to the key, as Actor input.
   **Never commit the key** — pass it as a secret input field (it's already marked
   `isSecret: true` in the input schema) or as an environment variable on the platform.
3. Emails are sent from Resend's shared sandbox sender (`onboarding@resend.dev`). This
   works out of the box but looks like a sandbox sender to recipients — **verify your own
   domain in Resend and update `SANDBOX_SENDER` in `src/email.js`** before using this for
   anything beyond personal use.

The Actor can run on a frequent schedule (e.g. daily) — it tracks the last-sent time and
already-seen events per subscriber in the key-value store, and only actually sends once
enough time has passed for the chosen `digestFrequency`. If nothing new was found since
the last send, it skips sending (and doesn't reset the timer).

If `subscriberEmail` or `resendApiKey` is missing, the digest step is skipped silently —
it's an optional feature, not a required one.

## Running locally

```bash
npm install
apify run
```

(Or `npm start`, which just runs `node src/main.js` directly — `apify run` additionally
sets up local Actor storage under `./storage`, which is the more realistic way to test.)

Provide input either by editing `storage/key_value_stores/default/INPUT.json` after a
first `apify run`, or by running `apify run --input '{"city": "Brno"}'` (see the
[Apify CLI docs](https://docs.apify.com/cli) for details).

## Project structure

```
.actor/actor.json          Actor metadata
.actor/input_schema.json   Input schema
src/main.js                Pipeline orchestration
src/sources/seedSources.js Seed list of club sites and aggregators
src/crawlers/               One crawler module per source type
src/extractors/dates.js     Czech date formats (ISO, numeric, named month, year-less)
src/extractors/jsonLdEvents.js  Recursive schema.org Event extraction, any nesting depth
src/extractors/eventCards.js    DOM event-card extraction, for pages without JSON-LD
src/nearbyTowns.js          Real towns within the radius (Overpass), for Facebook search
src/concurrency.js          Bounded-concurrency helper for crawling many sites in parallel
src/geocode.js              Nominatim geocoding + Haversine distance, KV-cached
src/genreClassifier.js      Genre classification: specific keywords, trusted-source fallback
src/dedupe.js               Cross-source duplicate detection
src/email.js                Resend digest sending + per-subscriber throttling
Dockerfile                  apify/actor-node base image
```

## Known limitations (v1)

- Non-JSON-LD extraction is generic (event cards keyed off a date, plus a dated-link
  fallback), not a per-site scraper, so it will miss events on unusually-structured pages.
  This is an accepted trade-off rather than maintaining ~20 bespoke scrapers, but it does
  fail visibly on some sites: dnbczevents.cz groups listings under day headers, so every
  event resolves to the weekday above it ("pátek", "sobota"). Dates are read correctly; only
  the titles need a site-specific selector.
- Dates written without a year are assumed to be the **current** year, which means a
  genuinely next-January event listed as "9. 1." will be dated this January and dropped.
  Deliberate: the alternative (rolling past months forward) turned dnbeheard.cz's 501
  entries into a wall of January-2027 parties that don't exist. A miss is a gap in coverage;
  a phantom is wrong data in the digest.
- Genre/electronic-music detection is keyword-based for anything not from a
  `trustedElectronic` source. The vocabulary covers genre names, lineup notation (`w/`, `b2b`,
  `dj set`, `DJane`), the bass/beat/trance word family, and a short list of named brands
  (Beats for Love, Let It Roll). A listing that names none of those — just a bare artist name
  — is still missed. The gate is tested against 29 real titles from these sources: all 10
  electronic ones match and all 19 rock/metal/community ones don't ("Live Tribute Act To
  RAMMSTEIN", "Moravský ples", "Taneční kurz pro dospělé").
- Scope is Czech Republic only.
- **The two national D&B/techno calendars are now the highest-yield sources**, both read by
  the card extractor with a small per-source title rule:
  [jiripetrak.cz](https://www.jiripetrak.cz/cs/drum-a-bass-a-techno-parties-kalendar-akci-44/)
  (143 upcoming events, all carrying "▼ Venue, Town") and
  [dnbeheard.cz](https://dnbeheard.cz/kalendar-akci) (a full year at ~501, written
  "#Town Title, Venue", 500 of which parse to a town). Only
  [dnbczevents.cz](https://dnbczevents.cz/akce.php) remains parked in
  `CANDIDATE_AGGREGATORS_NEEDING_CUSTOM_EXTRACTION`.
- **Resident Advisor doesn't help outside Prague/Brno.** Its Czech coverage is
  Prague-centric: of ~115 upcoming events, 105 are Prague, 3 Brno. For a search near a
  smaller town it contributes candidates but no results — the nearest listing to Návsí was
  Olomouc, ~100km out. Excellent for Prague or Brno searches, irrelevant for a village.
- **GoOut is underused.** It's the largest Czech event source, and it does have a real public
  API — `https://goout.net/services/entities/v1/schedules` responds with structured schedules
  (dates, pricing, ticketing state) once you pass the required `languages[]` parameter. But
  its filter parameter names still need reverse-engineering: `tag` and `city` were both
  silently ignored in testing, and venue/performer data appears to need an `include=`
  parameter. Until that's worked out, GoOut is still just being HTML-scraped like the other
  aggregators. Worth doing — it's probably the biggest remaining coverage win.
- **A Facebook venue page is only worth seeding once it's confirmed to host events, and most
  don't.** Four researched-but-unvalidated pages (TESLA Production/Třinec, PartyTime and
  Project Bar, DNB pro Ostravaky) were seeded and every one returned "No event detail URLs
  found". The slugs were all real; the pages simply host nothing. Checking two by hand showed
  why, and it's a regional pattern: TESLA's events tab reads "No events to show" with only
  past entries, and PartyTime's page has no events tab at all. Around here the **promoter**
  creates the event and merely tags the venue — TESLA's own feed advertises "Future Control
  Open Air 2026", hosted by a separate Future Control page. Promoter pages are the better
  target, but finding them needs a logged-in Facebook search this Actor can't perform, so
  they have to be added by hand.
- **Slovak and Polish events near the eastern border are dropped**, because scope is
  Czech-only and every place name is geocoded with ", Czech Republic" appended. That's a real
  gap for a border town rather than a theoretical one: from Návsí, Žilina (SK) is 40km and
  Cieszyn (PL) 20km, while Prague is 316km — and dnbeheard.cz does list Žilina D&B nights.
  They fail to geocode and are discarded as unplaceable.
- The Facebook Events search relies on `apify/facebook-events-scraper`'s own search
  behavior; there's no guarantee of full coverage for a given city/genre. Confirmed via a
  live test that its search isn't reliably location-scoped — a query like "drum and bass
  Brno" can return matching events from anywhere in the world. The radius filter later in
  the pipeline drops these once venues are geocoded, so it's a wasted API call rather than
  a wrong result, but coverage for the requested city is weaker than the query suggests.
