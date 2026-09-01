# Rave Finder

Finds upcoming **techno**, **house**, and **drum & bass** events near a Czech city, within a
radius you choose. Searches club websites, event aggregators (GoOut, DnB e-Heard,
ColosseumTicket, KdyKde, xTicket, KoncertyPraha, Rave.cz), and Facebook Events. Optionally
sends you a periodic email digest of newly found events.

**v1 scope: Czech Republic only.**

## How it works

1. Geocodes the city you give it (OpenStreetMap Nominatim, no API key needed).
2. Crawls three kinds of sources in parallel:
   - **Aggregators** — listing sites, preferring their embedded JSON-LD event data where
     available, with a heuristic HTML fallback otherwise.
   - **Club sites** — no structured data, so pages are fetched via the
     [`apify/website-content-crawler`](https://apify.com/apify/website-content-crawler)
     Actor and parsed with date/keyword heuristics. Best-effort by nature — see comments in
     `src/crawlers/clubSiteCrawler.js`.
   - **Facebook Events** — via
     [`apify/facebook-events-scraper`](https://apify.com/apify/facebook-events-scraper),
     searched by genre + city (no hardcoded page list). Skipped if `includeFacebookEvents`
     is false, since it has a real per-event cost (~$0.013/event).
3. Classifies each event's genre(s) by keyword (CZ + EN), trusting structural tags (e.g.
   DnB e-Heard is always drum & bass) over keyword matches where available.
4. Geocodes each venue (cached in the key-value store) and filters by distance from the
   city center.
5. Filters by requested genres and date range, then dedupes events that show up on more
   than one source.
6. Pushes the results to the default dataset.
7. If you gave a `subscriberEmail`, sends an email digest of newly found events (see below).

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `city` | string | *(required)* | Czech city to search near, e.g. `"Brno"`. |
| `radiusKm` | integer | `30` | Max distance from the city center, in km (1–300). |
| `genres` | array | all three | `techno`, `house`, `drum_and_bass`. |
| `dateRangeDays` | integer | `30` | Only include events within this many days from now (1–180). |
| `includeFacebookEvents` | boolean | `true` | Also search Facebook Events. |
| `maxFacebookEvents` | integer | `50` | Caps Facebook events fetched, to control cost. |
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
src/geocode.js              Nominatim geocoding + Haversine distance, KV-cached
src/genreClassifier.js      Keyword-based genre classification
src/dedupe.js               Cross-source duplicate detection
src/email.js                Resend digest sending + per-subscriber throttling
Dockerfile                  apify/actor-node base image
```

## Known limitations (v1)

- Club-site and non-JSON-LD aggregator extraction is heuristic (date-pattern + keyword
  matching over page text), not a real per-site scraper — it will miss events on
  unusually-structured pages and occasionally misfire. This is a documented, accepted
  trade-off for v1 rather than building and maintaining ~20 bespoke site scrapers.
- Scope is Czech Republic only.
- The Facebook Events search relies on `apify/facebook-events-scraper`'s own search
  behavior; there's no guarantee of full coverage for a given city/genre.
