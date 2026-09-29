// SOLVENT sidecar — the read-only evidence API a wallet (or the SOLVENT web
// app) uses next to the mint, plus one explicitly opt-in demo control.
//
//   GET  /healthz
//   GET  /v1/solvent/status
//   GET  /v1/solvent/issuance/<blinded message hex>
//   POST /v1/solvent/demo/omit   { "blinded_message": "<hex>" }
//        Only when SOLVENT_DEMO_ALLOW_OMISSION=1. Asks the REAL epoch closer
//        to break the mint's signed promise for that issuance at the next
//        close (docs/epoch-lifecycle.md's broken-promise mode). This is the
//        hero demo; it is never enabled on a mint that claims to be honest.
//
// Everything served here is either the mint's own signed claim or public
// evidence; a verifier re-checks all of it (verifySubmission) and fetches
// the NUT-06 identity, the Nostr event and the reserve independently.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { inclusionProofToJson } from '../app/bundle-json.js';
import { issuanceEvidence, loadClosedEpoch, openEpoch } from '../epoch/closer.js';
import type { ManifestKeyDelegation } from '../epoch/delegation.js';
import type { PublicationStore } from './store.js';

export interface SidecarState {
  db: DatabaseSync;
  store: PublicationStore;
  mintUrl: string;
  delegation: ManifestKeyDelegation;
  lightningBackend: 'lnd' | 'fakewallet';
  epochIntervalSeconds: number;
  demoOmissionEnabled: boolean;
  /** Epoch index -> blinded message the next close of that epoch will omit. */
  pendingOmissions: Map<number, string>;
  /** Unix seconds of the next scheduled close attempt. */
  nextCloseAt: () => number;
}

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
    last_publication: latest ? { epoch_index: latest.epoch_index, status: latest.status, event_id: latest.event_id, published_at: latest.published_at } : null,
    demo_omission_enabled: s.demoOmissionEnabled,
  };
}

/** Everything a holder needs besides their own proof and the mint's public keys. */
export function issuance(s: SidecarState, blindedMessageHex: string) {
  const ev = issuanceEvidence(s.db, blindedMessageHex);
  if (ev.state === 'EPOCH_OPEN') {
    return { state: 'EPOCH_OPEN', target_epoch: ev.receipt.target_epoch, receipt: ev.receipt, next_close_at: s.nextCloseAt() };
  }
  const closed = loadClosedEpoch(s.db, ev.receipt.target_epoch)!;
  const pub = s.store.get(ev.receipt.target_epoch);
  return {
    state: 'EPOCH_CLOSED',
    target_epoch: ev.receipt.target_epoch,
    publication_status: pub?.status ?? 'pending',
    publication_detail: pub?.detail ?? 'the closed epoch has not been published yet',
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

export function scheduleOmission(s: SidecarState, blindedMessageHex: string): { status: number; body: unknown } {
  if (!s.demoOmissionEnabled) return { status: 403, body: { error: 'demo omission is disabled on this mint' } };
  if (!HEX.test(blindedMessageHex)) return { status: 400, body: { error: 'blinded_message must be 33-byte compressed hex' } };
  let ev;
  try {
    ev = issuanceEvidence(s.db, blindedMessageHex);
  } catch {
    return { status: 404, body: { error: 'no issuance with that blinded message' } };
  }
  if (ev.state !== 'EPOCH_OPEN') return { status: 409, body: { error: `epoch ${ev.receipt.target_epoch} already closed; mint new ecash and try again` } };
  const epoch = ev.receipt.target_epoch;
  const already = s.pendingOmissions.get(epoch);
  if (already && already !== blindedMessageHex) return { status: 409, body: { error: `an omission is already scheduled for epoch ${epoch}; try again in the next epoch` } };
  s.pendingOmissions.set(epoch, blindedMessageHex);
  return { status: 202, body: { scheduled: true, epoch, close_at: s.nextCloseAt() } };
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
