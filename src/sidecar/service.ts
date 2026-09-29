// npm run solvent:sidecar
//
// The SOLVENT process that runs next to a patched cdk-mintd (patches
// 0001-0009) on the same SQLite file:
//
//   every SOLVENT_EPOCH_INTERVAL_SECONDS (demo default 30s):
//     if the OPEN epoch holds any liability -> close it (the real closer,
//       honouring a demo omission request when enabled) -> observe the live
//       Mutinynet reserve -> build the epoch's public evidence -> publish to
//       Nostr (ACK + exact fetch-back) -> record the publication
//   serve the evidence API (src/sidecar/api.ts) on SOLVENT_SIDECAR_PORT
//
// Empty epochs are not closed, so relays are not sent an event every 30s.
// See docs/DEPLOY-REAL-MINT.md for the full runtime and configuration.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateSecretKey } from 'nostr-tools';
import { closeEpoch, openEpoch } from '../epoch/closer.js';
import type { ManifestKeyDelegation } from '../epoch/delegation.js';
import { buildEpochPublicEvidence, evidenceValiditySeconds, type ReserveControlKey, type ReserveObservation } from '../epoch/public-evidence.js';
import { configuredRelays } from '../nostr/pol-evidence.js';
import { manifestDigestHex } from '../pol/manifest.js';
import { fetchOutspend, fetchTipHeight, fetchTxOutScript } from '../reserve/esplora.js';
import { createHandler, type SidecarState } from './api.js';
import { publishVerified } from './publisher.js';
import { PublicationStore } from './store.js';

export interface CycleDeps {
  manifestPrivateKeyHex: string;
  reserveKey: ReserveControlKey;
  outpoint: { txid: string; vout: number };
  nostrSecretKey: Uint8Array;
  relays: string[];
  validitySeconds: number;
  observeReserve?: (outpoint: { txid: string; vout: number }) => Promise<ReserveObservation>;
  publish?: typeof publishVerified;
  now?: () => Date;
}

export async function observeReserveLive(outpoint: { txid: string; vout: number }): Promise<ReserveObservation> {
  const [out, spend, tip] = await Promise.all([fetchTxOutScript(outpoint.txid, outpoint.vout), fetchOutspend(outpoint.txid, outpoint.vout), fetchTipHeight()]);
  if (!out) throw new Error(`reserve outpoint ${outpoint.txid}:${outpoint.vout} not found`);
  return { txid: outpoint.txid, vout: outpoint.vout, valueSats: out.value, scriptPubKeyHex: out.scriptPubKeyHex, spent: spend.spent, tipHeight: tip };
}

function openEpochHasLiabilities(db: DatabaseSync, epoch: number): boolean {
  const q = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE target_epoch = ?`).get(epoch) as { n: number }).n;
  return q('solvent_issued_liability') + q('solvent_consumed_liability') > 0;
}

/** One cycle: close the open epoch if it holds liabilities, then publish it. Returns the closed epoch index, or null. */
export async function closeAndPublish(s: SidecarState, d: CycleDeps): Promise<number | null> {
  const open = openEpoch(s.db).epochIndex;
  if (!openEpochHasLiabilities(s.db, open)) return null;
  const omit = s.pendingOmissions.get(open);
  const closed = closeEpoch(s.db, { manifestPrivateKeyHex: d.manifestPrivateKeyHex, omitPromisedIssuance: omit, now: d.now?.() });
  s.pendingOmissions.delete(open);
  const base = { epoch_index: closed.epochIndex, published_at: new Date().toISOString(), omitted_issuance: omit ?? null };
  try {
    const reserve = await (d.observeReserve ?? observeReserveLive)(d.outpoint);
    const ev = buildEpochPublicEvidence({
      db: s.db, epochIndex: closed.epochIndex, mintUrl: s.mintUrl, manifestPrivateKeyHex: d.manifestPrivateKeyHex, delegation: s.delegation,
      reserveKey: d.reserveKey, reserve, nostrSecretKey: d.nostrSecretKey, validitySeconds: d.validitySeconds,
      proofUri: `${s.mintUrl}#solvent-epoch-${closed.epochIndex}`, now: d.now?.(),
    });
    const pub = await (d.publish ?? publishVerified)(ev.event, d.relays, {
      manifestDigest: manifestDigestHex(ev.manifest), globalDigest: ev.content.global_digest,
      delegationDigest: ev.delegationDigest, reserveBindingDigest: ev.reserveBindingDigest,
    });
    s.store.put({
      ...base, status: pub.verified ? 'published' : 'unpublished', event: ev.event, event_id: ev.event.id, relays: pub.relays,
      fetched_from: pub.fetchedFrom, reserve_attestation: ev.reserveAttestation, reserve_binding: ev.reserveBinding,
      valid_until: ev.content.valid_until, detail: pub.detail,
    });
  } catch (err) {
    s.store.put({ ...base, status: 'failed', event: null, event_id: null, relays: [], fetched_from: [], reserve_attestation: null, reserve_binding: null, valid_until: null, detail: (err as Error).message });
  }
  return closed.epochIndex;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see docs/DEPLOY-REAL-MINT.md)`);
  return v;
}

/** On a fresh deployment the mint may still be applying SOLVENT's migrations / writing its delegation. */
async function waitForMint(dbPath: string, delegationPath: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if (existsSync(delegationPath) && existsSync(dbPath)) {
        const probe = new DatabaseSync(dbPath, { readOnly: true });
        try {
          probe.prepare(`SELECT 1 FROM solvent_pol_epoch LIMIT 1`).get();
          return;
        } finally {
          probe.close();
        }
      }
    } catch {
      /* not ready yet */
    }
    if (i === 0) console.log('SOLVENT sidecar: waiting for the mint to finish initializing…');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('the mint never finished initializing (no SOLVENT schema or delegation)');
}

async function main() {
  const dbPath = required('SOLVENT_MINT_DB');
  await waitForMint(dbPath, required('SOLVENT_MANIFEST_DELEGATION'));
  const mintUrl = required('SOLVENT_MINT_URL');
  const manifestKey = required('SOLVENT_MANIFEST_PRIVKEY');
  const delegation = JSON.parse(readFileSync(required('SOLVENT_MANIFEST_DELEGATION'), 'utf8')) as ManifestKeyDelegation;
  const reserveKeyFile = JSON.parse(readFileSync(required('SOLVENT_RESERVE_KEY_FILE'), 'utf8')) as ReserveControlKey;
  const [txid, vout] = required('SOLVENT_RESERVE_OUTPOINT').split(':');
  const interval = Number(process.env.SOLVENT_EPOCH_INTERVAL_SECONDS ?? '30');
  const port = Number(process.env.SOLVENT_SIDECAR_PORT ?? '8086');
  const backend = (process.env.SOLVENT_LIGHTNING_BACKEND ?? 'fakewallet') as 'lnd' | 'fakewallet';
  if (backend !== 'lnd' && backend !== 'fakewallet') throw new Error('SOLVENT_LIGHTNING_BACKEND must be lnd or fakewallet');
  if (delegation.mint_url !== mintUrl) throw new Error(`delegation is for ${delegation.mint_url}, not ${mintUrl}`);

  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  let nextCloseAt = Math.floor(Date.now() / 1000) + interval;
  const state: SidecarState = {
    db,
    store: new PublicationStore(process.env.SOLVENT_PUBLICATION_STORE ?? `${dbPath}.solvent-publications.json`),
    mintUrl,
    delegation,
    lightningBackend: backend,
    epochIntervalSeconds: interval,
    demoOmissionEnabled: process.env.SOLVENT_DEMO_ALLOW_OMISSION === '1',
    pendingOmissions: new Map(),
    nextCloseAt: () => nextCloseAt,
  };
  const deps: CycleDeps = {
    manifestPrivateKeyHex: manifestKey,
    reserveKey: { outputPublicKeyXOnlyHex: reserveKeyFile.outputPublicKeyXOnlyHex, tweakedPrivateKeyHex: reserveKeyFile.tweakedPrivateKeyHex },
    outpoint: { txid: txid!, vout: Number(vout) },
    nostrSecretKey: process.env.SOLVENT_NOSTR_SECRET_HEX ? Buffer.from(process.env.SOLVENT_NOSTR_SECRET_HEX, 'hex') : generateSecretKey(),
    relays: configuredRelays(),
    validitySeconds: evidenceValiditySeconds(),
  };

  createServer(createHandler(state)).listen(port, () => {
    console.log(`SOLVENT sidecar: evidence API on :${port}, epoch interval ${interval}s, lightning_backend=${backend}, demo omission ${state.demoOmissionEnabled ? 'ENABLED' : 'disabled'}`);
  });

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const closed = await closeAndPublish(state, deps);
      if (closed !== null) {
        const p = state.store.get(closed)!;
        console.log(`epoch ${closed} closed -> ${p.status} ${p.event_id ?? ''} ${p.detail}`);
      }
    } catch (err) {
      console.error('cycle failed:', (err as Error).message);
    } finally {
      nextCloseAt = Math.floor(Date.now() / 1000) + interval;
      running = false;
    }
  }, interval * 1000);
}

if (process.argv[1] && /service\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('sidecar failed to start:', err);
    process.exitCode = 1;
  });
}
