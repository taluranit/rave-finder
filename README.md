# Rave Finder

Finds upcoming **electronic music and DJ events** — techno, house, drum & bass, and
generally-electronic events that don't name a specific genre — near a Czech city, within a
radius you choose. Searches club websites, event aggregators (GoOut, DnB e-Heard,
ColosseumTicket, KdyKde, xTicket, KoncertyPraha, Rave.cz), and Facebook Events. Optionally
sends you a periodic email digest of newly found events.

**v1 scope: Czech Republic only.**

## How it works

1. Geocodes the city you give it (OpenStreetMap Nominatim, no API key needed).
2. Crawls four kinds of sources in parallel:
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
     searched by genre + city (no hardcoded page list). Skipped if `includeFacebookEvents`
     is false, since it has a real per-event cost (~$0.013/event).
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
   key-value store, except Maps-discovered venues, which already carry their own
   coordinates from Google Maps and skip this step.
5. Filters by requested genres and date range, then dedupes events that show up on more
   than one source.
6. Pushes the results to the default dataset.
7. If you gave a `subscriberEmail`, sends an email digest of newly found events (see below).

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `city` | string | *(required)* | Czech city to search near, e.g. `"Brno"`. |
| `radiusKm` | integer | `30` | Max distance from the city center, in km (1–300). |
| `genres` | array | all four | `techno`, `house`, `drum_and_bass`, `electronic` (generic — electronic/DJ events with no specific genre named). |
| `dateRangeDays` | integer | `30` | Only include events within this many days from now (1–180). |
| `includeFacebookEvents` | boolean | `true` | Also search Facebook Events. |
| `maxFacebookEvents` | integer | `50` | Caps Facebook events fetched, to control cost. |
| `maxMapsVenues` | integer | `20` | Caps Maps-discovered venues per search term, to control cost; `0` disables Maps discovery. |
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
- The Facebook Events search relies on `apify/facebook-events-scraper`'s own search
  behavior; there's no guarantee of full coverage for a given city/genre. Confirmed via a
  live test that its search isn't reliably location-scoped — a query like "drum and bass
  Brno" can return matching events from anywhere in the world. The radius filter later in
  the pipeline drops these once venues are geocoded, so it's a wasted API call rather than
  a wrong result, but coverage for the requested city is weaker than the query suggests.
