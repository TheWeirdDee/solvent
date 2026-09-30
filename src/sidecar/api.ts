// SOLVENT sidecar — the read-only evidence API a wallet (or the SOLVENT web
// app) uses next to the mint, plus one explicitly opt-in demo control.
//
//   GET  /healthz
//   GET  /v1/solvent/status
//   GET  /v1/solvent/issuance/<blinded message hex>
//   GET  /v1/solvent/nostr/event/<event id hex>
//        Read-only relay fetch: queries this service's FIXED public relay list
//        for that exact event id, right now, and returns the raw signed events
//        with per-relay results. Never answers from its own records. Browsers
//        that cannot open relay WebSockets use it as transport; they verify
//        the event themselves (docs/trust-boundaries.md).
//   POST /v1/solvent/demo/omit   { "blinded_message": "<hex>" }
//        Only when SOLVENT_DEMO_ALLOW_OMISSION=1. Registers a request that the
//        REAL epoch closer break the mint's signed promise for exactly that
//        issuance, in the epoch it is promised to (docs/epoch-lifecycle.md's
//        broken-promise mode). A wallet registers its B_ before minting, so
//        the request always precedes the issuance. This is the hero demo; it
//        is never enabled on a mint that claims to be honest.
//
// Everything served here is either the mint's own signed claim or public
// evidence; a verifier re-checks all of it (verifySubmission) and fetches
// the NUT-06 identity, the Nostr event and the reserve independently.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { inclusionProofToJson } from '../app/bundle-json.js';
import { issuanceEvidence, loadClosedEpoch, openEpoch } from '../epoch/closer.js';
import type { ManifestKeyDelegation } from '../epoch/delegation.js';
import { fetchPolEventById } from '../nostr/pol-evidence.js';
import type { OmissionQueue } from './omissions.js';
import type { PublicationStore } from './store.js';

/** What the sidecar is doing with the epoch it is currently publishing, for progress display. */
export interface PublishingProgress {
  epoch_index: number;
  stage: 'observing-reserve' | 'publishing' | 'fetching-back';
  started_at: number;
  relays: string[];
  acked: string[];
  attempt: number;
}

export interface SidecarState {
  db: DatabaseSync;
  store: PublicationStore;
  mintUrl: string;
  delegation: ManifestKeyDelegation;
  lightningBackend: 'lnd' | 'fakewallet';
  epochIntervalSeconds: number;
  demoOmissionEnabled: boolean;
  /** Broken-promise requests, one per exact issuance (src/sidecar/omissions.ts). */
  omissions: OmissionQueue;
  /** The public relays this service publishes to, and the only ones its relay fetch will query. */
  relays: string[];
  /** Set while an epoch is being published. */
  publishing: PublishingProgress | null;
  /** The public reserve outpoint (txid:vout) this mint's evidence binds. */
  reserveOutpoint?: string;
  /** Unix seconds of the next scheduled close attempt. */
  nextCloseAt: () => number;
  /** Injectable for tests; defaults to the real relay fetch. */
  fetchEventById?: typeof fetchPolEventById;
}

const EVENT_ID = /^[0-9a-f]{64}$/;
let relayFetchesInFlight = 0;
const MAX_RELAY_FETCHES_IN_FLIGHT = 8;

const HEX = /^[0-9a-f]{66}$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('request body too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export function status(s: SidecarState) {
  const open = openEpoch(s.db);
  const latest = s.store.latest();
  return {
    mint_url: s.mintUrl,
    mint_identity_pubkey: s.delegation.mint_identity_pubkey,
    manifest_pubkey: s.delegation.manifest_pubkey,
    lightning_backend: s.lightningBackend,
    open_epoch: open.epochIndex,
    open_epoch_opened_at: open.openedAt,
    epoch_interval_seconds: s.epochIntervalSeconds,
    next_close_at: s.nextCloseAt(),
    last_publication: latest
      ? {
          epoch_index: latest.epoch_index, status: latest.status, event_id: latest.event_id, published_at: latest.published_at,
          acked: latest.relays.filter((r) => r.ok).map((r) => r.relay), fetched_from: latest.fetched_from,
          outstanding_balance: latest.outstanding_balance ?? null,
        }
      : null,
    publishing: s.publishing,
    relays: s.relays,
    reserve_outpoint: s.reserveOutpoint ?? null,
    reserve_network: 'bitcoin-signet-mutinynet',
    demo_omission_enabled: s.demoOmissionEnabled,
    pending_omissions: s.omissions.pending().length,
  };
}

/** Everything a holder needs besides their own proof and the mint's public keys. */
export function issuance(s: SidecarState, blindedMessageHex: string) {
  const ev = issuanceEvidence(s.db, blindedMessageHex);
  const omission = s.omissions.get(blindedMessageHex) ?? null;
  if (ev.state === 'EPOCH_OPEN') {
    return { state: 'EPOCH_OPEN', target_epoch: ev.receipt.target_epoch, receipt: ev.receipt, next_close_at: s.nextCloseAt(), omission };
  }
  const closed = loadClosedEpoch(s.db, ev.receipt.target_epoch)!;
  const pub = s.store.get(ev.receipt.target_epoch);
  return {
    state: 'EPOCH_CLOSED',
    target_epoch: ev.receipt.target_epoch,
    omission,
    publishing: !pub && s.publishing?.epoch_index === ev.receipt.target_epoch ? s.publishing : null,
    publication_status: pub?.status ?? 'pending',
    publication_detail: pub?.detail ?? 'the closed epoch has not been published yet',
    published_at: pub?.published_at ?? null,
    publication_relays: pub ? { acked: pub.relays.filter((r) => r.ok).map((r) => r.relay), fetched_from: pub.fetched_from } : null,
    evidence: {
      mint: s.mintUrl,
      keysetId: ev.keysetId,
      receipt: ev.receipt,
      manifest: ev.manifest,
      manifestSignature: ev.manifestSignature,
      masterPublicKeyHex: ev.masterPublicKeyHex,
      issuedMmrSize: ev.issuedMmrSize,
      inclusionProof: inclusionProofToJson(ev.inclusionProof),
      reserveAttestation: pub?.reserve_attestation ?? null,
      nostrEvent: pub?.event ?? null,
      delegation: s.delegation,
      reserveBinding: pub?.reserve_binding ?? null,
      epochKeysetCount: closed.keysets.length,
    },
  };
}

export function scheduleOmission(s: SidecarState, blindedMessageHex: string, nowSeconds = Math.floor(Date.now() / 1000)): { status: number; body: unknown } {
  if (!s.demoOmissionEnabled) return { status: 403, body: { error: 'demo omission is disabled on this mint' } };
  if (!HEX.test(blindedMessageHex)) return { status: 400, body: { error: 'blinded_message must be 33-byte compressed hex' } };
  let promisedEpoch: number | null = null;
  try {
    const ev = issuanceEvidence(s.db, blindedMessageHex);
    // A request made after issuance can only apply while the promised epoch is still open.
    if (ev.state !== 'EPOCH_OPEN' && !s.omissions.get(blindedMessageHex)) {
      return { status: 409, body: { error: `epoch ${ev.receipt.target_epoch} already closed; register the omission before minting` } };
    }
    promisedEpoch = ev.receipt.target_epoch;
  } catch {
    // Not issued yet: the normal case. The wallet registers its B_ before minting.
  }
  const r = s.omissions.register(blindedMessageHex, nowSeconds);
  if (!r) return { status: 503, body: { error: 'too many pending broken-promise requests; try again in a minute' } };
  return { status: 202, body: { scheduled: true, blinded_message: blindedMessageHex, state: r.state, promised_epoch: r.epoch ?? promisedEpoch, next_close_at: s.nextCloseAt() } };
}

/** Read-only public relay fetch by exact event id (see the header). */
export async function relayFetch(s: SidecarState, eventId: string): Promise<{ status: number; body: unknown }> {
  if (!EVENT_ID.test(eventId)) return { status: 400, body: { error: 'event id must be 32-byte lowercase hex' } };
  if (relayFetchesInFlight >= MAX_RELAY_FETCHES_IN_FLIGHT) return { status: 503, body: { error: 'relay fetch busy; retry shortly' } };
  relayFetchesInFlight++;
  try {
    const r = await (s.fetchEventById ?? fetchPolEventById)(eventId, s.relays, 6000);
    return {
      status: 200,
      body: {
        requested_event_id: eventId,
        relays_attempted: s.relays,
        per_relay: r.perRelay.map((p) => ({ relay: p.relay, result: p.found ? 'found' : p.result, ms: p.ms })),
        fetched_from: r.perRelay.filter((p) => p.found).map((p) => p.relay),
        fetched_at: new Date().toISOString(),
        events: r.events.filter((e) => e.id === eventId),
      },
    };
  } finally {
    relayFetchesInFlight--;
  }
}

export function createHandler(s: SidecarState) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://sidecar');
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const st = status(s);
        return send(res, 200, { ok: true, open_epoch: st.open_epoch, last_publication: st.last_publication });
      }
      if (req.method === 'GET' && url.pathname === '/v1/solvent/status') return send(res, 200, status(s));
      const m = url.pathname.match(/^\/v1\/solvent\/issuance\/([0-9a-f]{66})$/);
      if (req.method === 'GET' && m) {
        try {
          return send(res, 200, issuance(s, m[1]!));
        } catch (err) {
          return send(res, 404, { error: (err as Error).message });
        }
      }
      const ne = url.pathname.match(/^\/v1\/solvent\/nostr\/event\/([^/]+)$/);
      if (req.method === 'GET' && ne) {
        const r = await relayFetch(s, ne[1]!);
        return send(res, r.status, r.body);
      }
      if (req.method === 'POST' && url.pathname === '/v1/solvent/demo/omit') {
        const body = await readJson(req);
        const r = scheduleOmission(s, String(body.blinded_message ?? '').toLowerCase());
        return send(res, r.status, r.body);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  };
}
