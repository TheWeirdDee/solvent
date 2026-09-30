// SOLVENT sidecar — publish one epoch's evidence event and prove it is
// publicly retrievable: bounded retries, at least one relay ACK, and an
// independent exact-id fetch-back whose signature and content bindings
// verify. Never satisfied by a local copy of the event.
import type { NostrEvent } from 'nostr-tools';
import { verifyPolEvidenceEvent } from '../nostr/pol-event.js';
import { fetchPolEventById, publishPolEvidence, type RelayPublishResult } from '../nostr/pol-evidence.js';

export interface PublicationResult {
  eventId: string;
  acked: string[];
  relays: RelayPublishResult[];
  fetchedFrom: string[];
  verified: boolean;
  detail: string;
}

export type PublishFn = typeof publishPolEvidence;
export type FetchByIdFn = typeof fetchPolEventById;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publishVerified(
  event: NostrEvent,
  relays: string[],
  expect: { manifestDigest: string; globalDigest: string; delegationDigest: string; reserveBindingDigest: string },
  deps: {
    publish?: PublishFn;
    fetchById?: FetchByIdFn;
    delayMs?: number;
    /** Progress for display: which round, which relays have ACKed, when fetch-back starts. */
    onProgress?: (p: { stage: 'publishing' | 'fetching-back'; attempt: number; acked: string[] }) => void;
  } = {},
): Promise<PublicationResult> {
  const publish = deps.publish ?? publishPolEvidence;
  const fetchById = deps.fetchById ?? fetchPolEventById;
  const delay = deps.delayMs ?? 2000;

  const acked = new Set<string>();
  let last: RelayPublishResult[] = [];
  for (let round = 1; round <= 3 && acked.size < relays.length; round++) {
    const pending = relays.filter((r) => !acked.has(r));
    deps.onProgress?.({ stage: 'publishing', attempt: round, acked: [...acked] });
    last = await publish(event, pending);
    for (const r of last) if (r.ok) acked.add(r.relay);
    deps.onProgress?.({ stage: 'publishing', attempt: round, acked: [...acked] });
    if (acked.size < relays.length && round < 3) await sleep(delay * round);
  }
  const results = relays.map((relay) => (acked.has(relay) ? { relay, ok: true, detail: '' } : (last.find((r) => r.relay === relay) ?? { relay, ok: false, detail: 'no response' })));
  if (acked.size === 0) {
    return { eventId: event.id, acked: [], relays: results, fetchedFrom: [], verified: false, detail: 'no relay acknowledged the event' };
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    deps.onProgress?.({ stage: 'fetching-back', attempt, acked: [...acked] });
    const r = await fetchById(event.id, relays);
    const fetched = r.events.find((e) => e.id === event.id);
    if (fetched) {
      const v = verifyPolEvidenceEvent(fetched);
      const c = v.content;
      const bound =
        !!c &&
        c.manifest_digest === expect.manifestDigest &&
        c.global_digest === expect.globalDigest &&
        c.manifest_key_delegation_digest === expect.delegationDigest &&
        c.reserve_binding_digest === expect.reserveBindingDigest;
      const ok = v.signatureValid && v.contentParses && bound;
      return {
        eventId: event.id,
        acked: [...acked],
        relays: results,
        fetchedFrom: r.perRelay.filter((p) => p.found).map((p) => p.relay),
        verified: ok,
        detail: ok ? 'published, acknowledged and fetched back by id' : 'fetched event failed signature or content-binding verification',
      };
    }
    if (attempt < 5) await sleep(delay);
  }
  return { eventId: event.id, acked: [...acked], relays: results, fetchedFrom: [], verified: false, detail: 'acknowledged, but the exact event could not be fetched back' };
}
