import { createHash } from 'node:crypto';
import { Actor, log } from 'apify';

const RESEND_URL = 'https://api.resend.com/emails';
const SANDBOX_SENDER = 'onboarding@resend.dev'; // resend.com sandbox sender; see README for custom domain setup
const STATE_KEY = 'DIGEST_STATE';
const MAX_FINGERPRINTS_PER_SUBSCRIBER = 500; // cap so the state object can't grow unbounded

const FREQUENCY_MS = {
    daily: 1 * 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    biweekly: 14 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
};

function subscriberHash(email) {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function eventFingerprint(event) {
    return createHash('sha256').update(`${event.eventName}|${event.date}|${event.venue}`).digest('hex');
}

async function loadState() {
    const store = await Actor.openKeyValueStore();
    return (await store.getValue(STATE_KEY)) || {};
}

async function saveState(state) {
    const store = await Actor.openKeyValueStore();
    await store.setValue(STATE_KEY, state);
}

function renderHtml(events) {
    const rows = events
        .map(
            (e) => `<li><strong>${e.eventName}</strong> — ${e.date} @ ${e.venue}, ${e.city}
                (${e.distanceKm != null ? `${e.distanceKm.toFixed(1)} km` : 'distance unknown'})
                — ${e.genres.join(', ')} — <a href="${e.sourceUrl}">${e.sourceName}</a></li>`,
        )
        .join('\n');
    return `<h2>New events for you</h2><ul>${rows}</ul>`;
}

/**
 * Sends a digest email of `events` to `subscriberEmail` via the Resend REST API, but only
 * if enough time has passed since the last send for the given `digestFrequency`, and only
 * for events not already sent before (tracked by a fingerprint per subscriber in the
 * key-value store). No-ops quietly if `subscriberEmail` or `resendApiKey` is missing —
 * the email digest is an optional feature.
 *
 * @param {object} params
 * @param {string} [params.subscriberEmail]
 * @param {string} [params.resendApiKey]
 * @param {'daily'|'weekly'|'biweekly'|'monthly'} params.digestFrequency
 * @param {object[]} params.events - full deduped event list for this run.
 */
export async function maybeSendDigest({ subscriberEmail, resendApiKey, digestFrequency, events }) {
    if (!subscriberEmail || !resendApiKey) {
        log.info('Skipping email digest: subscriberEmail or resendApiKey not set.');
        return;
    }

    const state = await loadState();
    const key = subscriberHash(subscriberEmail);
    const subscriberState = state[key] || { lastSentAt: null, sentFingerprints: [] };

    const intervalMs = FREQUENCY_MS[digestFrequency] ?? FREQUENCY_MS.weekly;
    const dueAt = subscriberState.lastSentAt ? subscriberState.lastSentAt + intervalMs : 0;
    if (Date.now() < dueAt) {
        log.info(`Digest for ${digestFrequency} frequency not due yet for this subscriber, skipping.`);
        return;
    }

    const sentSet = new Set(subscriberState.sentFingerprints);
    const newEvents = events.filter((e) => !sentSet.has(eventFingerprint(e)));

    if (newEvents.length === 0) {
        log.info('Digest is due, but there are no new events since the last send — skipping and not resetting the timer.');
        return;
    }

    try {
        const response = await fetch(RESEND_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: SANDBOX_SENDER,
                to: [subscriberEmail],
                subject: `Rave Finder: ${newEvents.length} new event${newEvents.length === 1 ? '' : 's'}`,
                html: renderHtml(newEvents),
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            log.warning(`Resend API returned ${response.status}: ${body}`);
            return;
        }

        log.info(`Sent digest with ${newEvents.length} new event(s) to subscriber.`);

        const updatedFingerprints = [...sentSet, ...newEvents.map(eventFingerprint)].slice(-MAX_FINGERPRINTS_PER_SUBSCRIBER);
        state[key] = { lastSentAt: Date.now(), sentFingerprints: updatedFingerprints };
        await saveState(state);
    } catch (err) {
        log.warning(`Failed to send digest email: ${err.message}`);
    }
}
