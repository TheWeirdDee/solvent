// The HTTPS relay fetch as a verification fallback (docs/trust-boundaries.md):
// an evidence service's GET /v1/solvent/nostr/event/<id> queries its fixed
// public relay list for that exact event id. The browser uses it only when its
// own relay WebSockets returned nothing, and verifies what comes back itself.
import type { AssistedRelayFetchFn, AssistedRelayFetchResult } from './submission.js';

export function relayAssistFor(evidenceUrl: string): AssistedRelayFetchFn {
  const base = evidenceUrl.replace(/\/+$/, '');
  return async (eventId: string): Promise<AssistedRelayFetchResult> => {
    const res = await fetch(`${base}/v1/solvent/nostr/event/${eventId}`);
    if (!res.ok) throw new Error(`HTTPS relay fetch unavailable (HTTP ${res.status})`);
    const body = (await res.json()) as { events: AssistedRelayFetchResult['events']; per_relay: AssistedRelayFetchResult['perRelay']; fetched_at: string };
    return { events: body.events, perRelay: body.per_relay, fetchedAt: body.fetched_at, source: new URL(base).host };
  };
}
