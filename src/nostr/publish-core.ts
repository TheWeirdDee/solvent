// Shared Nostr publish/fetch logic used by BOTH the CLI (src/nostr/publish.ts,
// src/cli/verify-fixture.ts) and the browser UI (src/app/*). No Node-only
// APIs here (no `fs`/`process`) so this module works unmodified in the
// browser bundle. File caching for the CLI stays in publish.ts.
import { SimplePool, type NostrEvent } from 'nostr-tools';
import { hexToBytes } from '../encode/canonical.js';
import type { MintFixture } from '../mint/types.js';
import { buildEventContent, signSolvencyEvent, SOLVENT_EVENT_KIND } from './event.js';

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

/** Signs a fresh solvency event (issued_at = now) from the mint's static fixture data. Real Schnorr signing, no simulation. */
export function signFreshEvent(fixture: MintFixture, mintIdentity: string, now: number): NostrEvent {
  const content = buildEventContent({
    mintPubkeyHex: fixture.nostrPubkeyHex,
    keysetId: fixture.keysetId,
    epoch: fixture.epoch,
    mintRoot: fixture.mintRoot,
    burnRoot: fixture.burnRoot,
    liabilitiesSats: fixture.liabilitiesSats,
    reserveSats: fixture.reserveSats,
    validitySeconds: fixture.validitySeconds,
    proofUri: `local://fixtures/${mintIdentity}.json`,
    notes: 'Phase 1 fixture mint',
    now,
  });
  return signSolvencyEvent(content, mintIdentity, hexToBytes(fixture.nostrSecretKeyHexDemoOnly));
}

export interface RelayPublishResult {
  relay: string;
  ok: boolean;
  detail: string;
}

/** Publishes a signed event to every relay in parallel and reports each relay's real outcome — never assumed. */
export async function publishToRelays(event: NostrEvent, relays: string[] = RELAYS): Promise<RelayPublishResult[]> {
  const pool = new SimplePool();
  const results = pool.publish(relays, event);
  const settled = await Promise.allSettled(results);
  pool.destroy();
  return settled.map((r, i) => ({
    relay: relays[i]!,
    ok: r.status === 'fulfilled',
    detail: r.status === 'fulfilled' ? r.value : ((r.reason as Error)?.message ?? String(r.reason)),
  }));
}

export interface LiveFetchResult {
  event: NostrEvent | null;
  /** Which relays actually responded with the event, if any. */
  respondedRelays: string[];
}

/**
 * Tries to fetch the mint's latest solvency event from public relays, racing
 * against a timeout so the UI never hangs on an unreachable relay. Returns
 * null (not a thrown error) when nothing is found in time — callers decide
 * how to label that (e.g. "local development fallback").
 */
export async function fetchLatestEvent(
  fixture: MintFixture,
  mintIdentity: string,
  relays: string[] = RELAYS,
  timeoutMs = 5000,
): Promise<LiveFetchResult> {
  const pool = new SimplePool();
  try {
    const event = await Promise.race([
      pool.get(relays, { kinds: [SOLVENT_EVENT_KIND], authors: [fixture.nostrPubkeyHex], '#d': [mintIdentity] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return { event, respondedRelays: event ? relays : [] };
  } catch {
    return { event: null, respondedRelays: [] };
  } finally {
    pool.destroy();
  }
}
