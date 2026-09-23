// Gate 5 — combines the real relay publish/fetch (network I/O) with the
// pure decision logic (checks 14-17 of the PRD §14 decision rule) that
// turns a set of fetched Nostr events into a verified/refused verdict with
// a stable reason code. The pure function is exported separately from the
// network calls so its conflict/stale/mismatch logic is unit-testable
// without a live relay connection (same split as Gate 4's acceptFn spy).
import { SimplePool, type NostrEvent } from 'nostr-tools';
import { POL_EVENT_KIND, verifyPolEvidenceEvent, isPolEvidenceFresh, type PolEvidenceContent } from './pol-event.js';

export const POL_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

export interface RelayPublishResult {
  relay: string;
  ok: boolean;
  detail: string;
}

/** Publishes to every relay in parallel and reports each relay's real outcome — never assumed from a single relay's ack. */
export async function publishPolEvidence(event: NostrEvent, relays: string[] = POL_RELAYS): Promise<RelayPublishResult[]> {
  const pool = new SimplePool();
  try {
    const settled = await Promise.allSettled(pool.publish(relays, event));
    return settled.map((r, i) => ({
      relay: relays[i]!,
      ok: r.status === 'fulfilled',
      detail: r.status === 'fulfilled' ? r.value : ((r.reason as Error)?.message ?? String(r.reason)),
    }));
  } finally {
    pool.destroy();
  }
}

/**
 * Fetches every event matching (mint_identity, epoch) from every relay —
 * not just the first relay to answer — so conflicting signed state on
 * different relays is actually observable. This is the fetch-back step:
 * evidence that publish() reporting success actually landed somewhere
 * queryable, not merely that the write call resolved.
 *
 * `relayReachable` exists because `pool.querySync()` itself never rejects
 * on a connection failure — nostr-tools swallows each relay's connect
 * error internally and resolves with whatever it collected (possibly
 * nothing) once `timeoutMs` elapses. That makes "no relay could be
 * reached" indistinguishable from "relays reached, genuinely nothing
 * there" using the return value alone — exactly the distinction
 * src/app/submission.ts's REFUSE_NOSTR_UNAVAILABLE vs
 * REFUSE_NOSTR_EVENT_NOT_FOUND split depends on. `SimplePool` fires
 * `onRelayConnectionSuccess`/`onRelayConnectionFailure` at the exact
 * moment each relay's own connection attempt settles internally (see
 * `ensureRelay` in nostr-tools' `AbstractSimplePool`, which `SimplePool`
 * extends unmodified) — that's the one real signal available, so this
 * listens for it. The public `SimplePool` constructor's .d.ts only types a
 * narrower options subset than it actually accepts at runtime (the full
 * set lives on `AbstractSimplePool`); the cast below reflects real,
 * working runtime behavior, not a hack around an actual restriction.
 */
export async function fetchPolEvidence(
  mintIdentityHex: string,
  epochIndex: number,
  relays: string[] = POL_RELAYS,
  timeoutMs = 5000,
): Promise<{ events: NostrEvent[]; queriedRelays: string[]; relayReachable: boolean }> {
  let relayReachable = false;
  const pool = new SimplePool({
    onRelayConnectionSuccess: () => {
      relayReachable = true;
    },
  } as unknown as ConstructorParameters<typeof SimplePool>[0]);
  try {
    const events = await pool.querySync(relays, { kinds: [POL_EVENT_KIND], '#M': [mintIdentityHex], '#E': [String(epochIndex)] }, { maxWait: timeoutMs });
    return { events, queriedRelays: relays, relayReachable };
  } finally {
    pool.destroy();
  }
}

/** Injectable delay — lives here (not submission.ts) specifically so tests that already mock this module (main.test.ts's `vi.mock('../nostr/pol-evidence.js', ...)`) can override this SAME export to make submission.ts's bounded relay-fetch retry instant, without a separate mocking mechanism. The browser and real CLI scripts always get the real timer (the default). */
export type DelayFn = (ms: number) => Promise<void>;
export const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type NostrEvidenceReasonCode =
  | 'REFUSE_NOSTR_SIGNATURE'
  | 'REFUSE_NOSTR_STATE_MISMATCH'
  | 'REFUSE_NOSTR_STALE'
  | 'REFUSE_NOSTR_CONFLICT'
  | 'REFUSE_NOSTR_UNAVAILABLE';

export interface NostrEvidenceExpectation {
  mintIdentityHex: string;
  epochIndex: number;
  manifestDigestHex: string;
  globalDigestHex: string;
  reserveDigestHex: string;
  nowSeconds: number;
}

export interface NostrEvidenceResult {
  verified: boolean;
  reasonCode?: NostrEvidenceReasonCode;
  detail: string;
  matchedEvent?: NostrEvent;
}

function contentDigestKey(c: PolEvidenceContent): string {
  return `${c.manifest_digest}:${c.global_digest}:${c.reserve_digest}`;
}

/**
 * Pure evaluation of checks 14-17 against an already-fetched event set.
 * Deduplicates by event id first (the same event can arrive from multiple
 * relays), then:
 *   14. every candidate's signature/shape must verify, or REFUSE_NOSTR_SIGNATURE;
 *   17. two+ distinct valid digest combinations for the same identity/epoch -> REFUSE_NOSTR_CONFLICT;
 *   16. the (unique) valid event must be fresh -> REFUSE_NOSTR_STALE;
 *   15. its digests must match what this decision actually used -> REFUSE_NOSTR_STATE_MISMATCH;
 *   otherwise nothing found at all -> REFUSE_NOSTR_UNAVAILABLE.
 */
export function evaluatePolEvidence(events: NostrEvent[], expect: NostrEvidenceExpectation): NostrEvidenceResult {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  const candidates = [...byId.values()];

  if (candidates.length === 0) {
    return { verified: false, reasonCode: 'REFUSE_NOSTR_UNAVAILABLE', detail: 'No relay returned any matching evidence event.' };
  }

  const verifications = candidates.map((e) => ({ event: e, v: verifyPolEvidenceEvent(e) }));
  const shapeValid = verifications.filter((r) => r.v.signatureValid && r.v.contentParses && r.v.content);
  if (shapeValid.length === 0) {
    return { verified: false, reasonCode: 'REFUSE_NOSTR_SIGNATURE', detail: 'Every fetched evidence event failed signature or shape verification.' };
  }

  // Never trust a relay's tag-filtered query results as-is: a relay is free
  // to return anything for any filter, so re-check identity/epoch binding
  // on the verified content itself before it can participate in conflict
  // grouping or matching.
  const validated = shapeValid.filter((r) => r.v.content!.mint_identity === expect.mintIdentityHex && r.v.content!.epoch_index === expect.epochIndex);
  if (validated.length === 0) {
    return { verified: false, reasonCode: 'REFUSE_NOSTR_UNAVAILABLE', detail: 'No fetched event, after independent verification, actually commits to the expected mint identity and epoch.' };
  }

  const distinctDigests = new Map<string, (typeof validated)[number]>();
  for (const r of validated) distinctDigests.set(contentDigestKey(r.v.content!), r);
  if (distinctDigests.size > 1) {
    return {
      verified: false,
      reasonCode: 'REFUSE_NOSTR_CONFLICT',
      detail: `Found ${distinctDigests.size} distinct validly-signed evidence states for the same mint identity/epoch.`,
    };
  }

  const match = [...distinctDigests.values()][0]!;
  const content = match.v.content!;

  if (!isPolEvidenceFresh(content, expect.nowSeconds)) {
    return { verified: false, reasonCode: 'REFUSE_NOSTR_STALE', detail: `Evidence valid_until=${content.valid_until} is not fresh at now=${expect.nowSeconds}.`, matchedEvent: match.event };
  }

  if (
    content.manifest_digest !== expect.manifestDigestHex ||
    content.global_digest !== expect.globalDigestHex ||
    content.reserve_digest !== expect.reserveDigestHex
  ) {
    return {
      verified: false,
      reasonCode: 'REFUSE_NOSTR_STATE_MISMATCH',
      detail: 'The published evidence does not commit to the same manifest/reserve digests used for this decision.',
      matchedEvent: match.event,
    };
  }

  return { verified: true, detail: 'Nostr evidence signature, freshness, and digest binding all verify with no conflicting state.', matchedEvent: match.event };
}

/** End-to-end: real relay fetch, then the pure evaluation above. */
export async function fetchAndEvaluatePolEvidence(
  expect: NostrEvidenceExpectation,
  relays: string[] = POL_RELAYS,
  timeoutMs = 5000,
): Promise<NostrEvidenceResult & { queriedRelays: string[] }> {
  const { events, queriedRelays } = await fetchPolEvidence(expect.mintIdentityHex, expect.epochIndex, relays, timeoutMs);
  return { ...evaluatePolEvidence(events, expect), queriedRelays };
}
