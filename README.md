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
   - **Aggregators** — listing sites, preferring their embedded JSON-LD event data where
     available, with a heuristic HTML fallback otherwise.
   - **Club sites (seeded list)** — no structured data, so pages are fetched via the
     [`apify/website-content-crawler`](https://apify.com/apify/website-content-crawler)
     Actor (free `cheerio` mode) and parsed with date/keyword heuristics. Best-effort by
     nature — see comments in `src/crawlers/clubSiteCrawler.js`. A live test confirmed some
     club program pages are JS-rendered and return thin/unrelated content under the free
     `cheerio` mode (e.g. a static news archive instead of the real upcoming program). The
     Actor's other crawler modes render JS correctly, but are billed via
     [x402](https://blog.apify.com/introducing-x402-agentic-payments/) — a crypto/USDC
     payment rail separate from a normal Apify account — which isn't worth the trade-off
     here, so this stays on `cheerio`. Aggregators and Facebook Events carry more of the
     real signal as a result.
   - **Club sites (Maps-discovered)** — the seeded list only covers ~17 venues in a handful
     of cities, so it contributes nothing for a city outside that list. To cover any Czech
     city/radius, `src/crawlers/mapsDiscoveryCrawler.js` searches Google Maps
     ([`compass/crawler-google-places`](https://apify.com/compass/crawler-google-places),
     ~$1.50 per 1,000 places — billed through the normal Apify account, not x402) for
     club-like venues near the geocoded city center, then crawls each discovered venue's
     website the same way as the seeded list. Capped by `maxMapsVenues`; set to `0` to
     disable.
   - **Facebook Events** — via
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
*including this Actor's own run*), and `apify/website-content-crawler` defaults to 8192MB of
memory per call — which also counts against a shared memory ceiling. Both limits were hit
hard in testing, and failed silently-ish: every club-site crawl in a run aborted with
"you will exceed your limit of 5 concurrent Actor runs" while the run itself still reported
success with zero results.

So the pipeline is deliberately phased rather than maximally parallel:

| Phase | What runs | Actor calls |
|---|---|---|
| 1 | Resident Advisor, aggregators, nearby-town lookup, Maps discovery | 1 (Maps only) |
| 2 | Facebook Events (needs phase 1's town list) | 1 |
| 3 | Club sites, in-range only, concurrency 3 | up to 3 at a time |

Free/keyless sources (Resident Advisor, Nominatim, Overpass) and the in-process Crawlee
aggregator crawl cost **zero** Actor slots, which is a large part of why RA is the primary
source. Each `website-content-crawler` call is also pinned to 512MB rather than its 8192MB
default.

**Run timeout must be set on the Actor, not here.** `defaultRunOptions` is *not* a valid
`actor.json` property (see Apify's actor.json reference) — putting it there is silently
ignored, which cost one run an abort at the platform default of 300 seconds. Set the timeout
in Apify Console under the Actor's Settings → Run options, or per-run under Input → Run
options. A full run needs well over 300s: Facebook alone can spend several minutes, and
geocoding is rate-limited to 1 request/second by Nominatim's usage policy.

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
src/nearbyTowns.js          Real towns within the radius (Overpass), for Facebook search
src/concurrency.js          Bounded-concurrency helper for crawling many sites in parallel
src/geocode.js              Nominatim geocoding + Haversine distance, KV-cached
src/genreClassifier.js      Genre classification: specific keywords, trusted-source fallback
src/dedupe.js               Cross-source duplicate detection
src/email.js                Resend digest sending + per-subscriber throttling
Dockerfile                  apify/actor-node base image
```

## Known limitations (v1)

- Club-site and non-JSON-LD aggregator extraction is heuristic (date-pattern + keyword
  matching over page text), not a real per-site scraper — it will miss events on
  unusually-structured pages and occasionally misfire. This is a documented, accepted
  trade-off for v1 rather than building and maintaining ~20 bespoke site scrapers.
- Genre/electronic-music detection is still keyword-based for anything not from a
  `trustedElectronic` source — a branded event on a mixed-programming venue or general
  ticketing aggregator that names neither a genre nor "DJ" anywhere in its listing (e.g. just
  an artist name) will still be missed. Found while investigating a real gap: Beats for Love
  Experience (a satellite series at Nová Osmička in Frýdek-Místek) only survives because its
  listings mention specific DJs/genres — a bare artist-only listing wouldn't.
- Scope is Czech Republic only.
- **GoOut is underused.** It's the largest Czech event source, and it does have a real public
  API — `https://goout.net/services/entities/v1/schedules` responds with structured schedules
  (dates, pricing, ticketing state) once you pass the required `languages[]` parameter. But
  its filter parameter names still need reverse-engineering: `tag` and `city` were both
  silently ignored in testing, and venue/performer data appears to need an `include=`
  parameter. Until that's worked out, GoOut is still just being HTML-scraped like the other
  aggregators. Worth doing — it's probably the biggest remaining coverage win.
- **Facebook venue pages aren't used directly.** Maps discovery often returns a venue's
  Facebook page as its website; those are now skipped rather than crawled (cheerio can't read
  facebook.com anyway). Feeding them to `facebook-events-scraper` as `startUrls` would likely
  be the single best data path for small venues that publish only to Facebook — but that
  Actor documents `startUrls` as event/search/explore URLs, not venue page URLs, so it needs
  a cheap live test before being relied on.
- The Facebook Events search relies on `apify/facebook-events-scraper`'s own search
  behavior; there's no guarantee of full coverage for a given city/genre. Confirmed via a
  live test that its search isn't reliably location-scoped — a query like "drum and bass
  Brno" can return matching events from anywhere in the world. The radius filter later in
  the pipeline drops these once venues are geocoded, so it's a wasted API call rather than
  a wrong result, but coverage for the requested city is weaker than the query suggests.
