// The SOLVENT sidecar: real epochs on the real CDK schema, real delegation,
// real evidence; relays, the chain and NUT-06 are injected so `npm test`
// stays offline. Each case is verified exactly as a browser would: fetch the
// evidence over HTTP, add its own proof, parse with the app's bundle codec,
// then verifySubmission().
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, type NostrEvent } from 'nostr-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { proofToJson, submissionBundleFromJson } from '../../src/app/bundle-json.js';
import { verifySubmission } from '../../src/app/submission.js';
import { delegationMessage, MANIFEST_KEY_DELEGATION_SCHEMA, type ManifestKeyDelegation } from '../../src/epoch/delegation.js';
import type { ReserveObservation } from '../../src/epoch/public-evidence.js';
import { generateSignetReserveKey } from '../../src/reserve/taproot.js';
import { createHandler, relayFetch, scheduleOmission, type SidecarState } from '../../src/sidecar/api.js';
import { OmissionQueue, OMISSION_REQUEST_TTL_SECONDS } from '../../src/sidecar/omissions.js';
import { closeAndPublish, type CycleDeps } from '../../src/sidecar/service.js';
import { PublicationStore } from '../../src/sidecar/store.js';
import type { PublicationResult } from '../../src/sidecar/publisher.js';
import { CdkSim, createMintDb, type Issued } from '../epoch/cdk-sim.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const MINT_URL = 'http://127.0.0.1:8085';
const ID = (() => {
  const m = HDKey.fromMasterSeed(new TextEncoder().encode('solvent-sidecar-test-mint-seed00'));
  return { priv: m.privateKey!, pub: hex(m.publicKey!) };
})();

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { demo?: boolean; publishOk?: boolean; cdk?: CdkSim; omissionPath?: string } = {}) {
  const cdk = opts.cdk ?? new CdkSim(createMintDb());
  const manifestPriv = createRandomSecretKey();
  const manifestPrivHex = hex(manifestPriv);
  const d = { schema: MANIFEST_KEY_DELEGATION_SCHEMA, mint_url: MINT_URL, mint_identity_pubkey: ID.pub, manifest_pubkey: hex(getPubKeyFromPrivKey(manifestPriv)), valid_from_epoch: 1, created_at: 1_790_000_000, signature: '' } as ManifestKeyDelegation;
  d.signature = hex(schnorr.sign(sha256(delegationMessage(d)), ID.priv));
  const dir = mkdtempSync(join(tmpdir(), 'solvent-sidecar-'));
  dirs.push(dir);
  const state: SidecarState = {
    db: cdk.db, store: new PublicationStore(join(dir, 'pubs.json')), mintUrl: MINT_URL, delegation: d, lightningBackend: 'fakewallet',
    epochIntervalSeconds: 30, demoOmissionEnabled: opts.demo ?? true, omissions: new OmissionQueue(opts.omissionPath ?? join(dir, 'omissions.json')),
    relays: ['wss://relay.example'], publishing: null, nextCloseAt: () => 0,
  };
  const reserveKey = generateSignetReserveKey();
  const observation: ReserveObservation = { txid: hex(sha256(new TextEncoder().encode(String(Math.random())))), vout: 0, valueSats: 1_000_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false, tipHeight: 3_500_000 };
  const published: NostrEvent[] = [];
  const deps: CycleDeps = {
    manifestPrivateKeyHex: manifestPrivHex,
    reserveKey,
    outpoint: { txid: observation.txid, vout: 0 },
    nostrSecretKey: generateSecretKey(),
    relays: ['wss://relay.example'],
    validitySeconds: 3600,
    observeReserve: async () => observation,
    publish: async (event): Promise<PublicationResult> => {
      if (opts.publishOk !== false) published.push(event);
      return { eventId: event.id, acked: opts.publishOk === false ? [] : ['wss://relay.example'], relays: [], fetchedFrom: [], verified: opts.publishOk !== false, detail: opts.publishOk === false ? 'no relay acknowledged the event' : 'ok' };
    },
  };
  return { cdk, state, deps, observation, published };
}

async function serve(state: SidecarState): Promise<string> {
  const server = createServer(createHandler(state));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The browser path: evidence over HTTP + own proof -> app codec -> verifySubmission with independent (injected) network. */
async function browserVerify(base: string, env: ReturnType<typeof setup>, i: Issued) {
  const r = await (await fetch(`${base}/v1/solvent/issuance/${i.blindedMessageHex}`)).json();
  expect(r.state).toBe('EPOCH_CLOSED');
  const bundle = submissionBundleFromJson(JSON.stringify({ ...r.evidence, proof: proofToJson(i.proof), amountPublicKeyHex: env.cdk.keyset.amounts[i.amount]!.publicKeyHex }));
  const o = env.observation;
  return verifySubmission(
    bundle,
    async () => ({ events: env.published, queriedRelays: [], relayReachable: true }),
    async () => ({ ok: true, chainState: new Map([[`${o.txid}:${o.vout}`, { exists: true, confirmed: true, value: o.valueSats, scriptPubKeyHex: o.scriptPubKeyHex, spent: false }]]), tipHeight: o.tipHeight, detail: '' }),
    async () => {},
    { mintInfoFetchFn: async () => ({ ok: true, pubkey: ID.pub }) },
  );
}

describe('SOLVENT sidecar', () => {
  it('does not close an empty epoch', async () => {
    const env = setup();
    expect(await closeAndPublish(env.state, env.deps)).toBeNull();
  });

  it('honest: close + publish, then the browser path reaches ACCEPT_VERIFIED', async () => {
    const env = setup();
    const [i] = env.cdk.mint([64]);
    const base = await serve(env.state);
    const open = await (await fetch(`${base}/v1/solvent/issuance/${i!.blindedMessageHex}`)).json();
    expect(open).toMatchObject({ state: 'EPOCH_OPEN', target_epoch: 1 });
    expect(await closeAndPublish(env.state, env.deps)).toBe(1);
    expect(env.state.store.get(1)).toMatchObject({ status: 'published', omitted_issuance: null });
    const v = await browserVerify(base, env, i!);
    expect(v.result.reasonCode).toBe('ACCEPT_VERIFIED');
    expect(Object.values(v.result.checks).every((c) => c === true)).toBe(true);
  });

  it('demo omission: the real closer breaks the promise -> REFUSE_ISSUANCE_OMITTED with everything else valid', async () => {
    const env = setup();
    const [i] = env.cdk.mint([32]);
    const base = await serve(env.state);
    const res = await fetch(`${base}/v1/solvent/demo/omit`, { method: 'POST', body: JSON.stringify({ blinded_message: i!.blindedMessageHex }) });
    expect(res.status).toBe(202);
    await closeAndPublish(env.state, env.deps);
    expect(env.state.store.get(1)!.omitted_issuance).toBe(i!.blindedMessageHex);
    expect(env.state.omissions.get(i!.blindedMessageHex)).toMatchObject({ state: 'applied', epoch: 1 });
    const v = await browserVerify(base, env, i!);
    expect(v.result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(v.result.checks).toMatchObject({ receiptValid: true, manifestValid: true, delegationValid: true });
    expect(v.reserveLive.verified && v.nostrLive.verified).toBe(true);
  });

  it('an unpublished epoch is reported honestly and the browser path refuses NOT FOUND', async () => {
    const env = setup({ publishOk: false });
    const [i] = env.cdk.mint([16]);
    const base = await serve(env.state);
    await closeAndPublish(env.state, env.deps);
    expect(env.state.store.get(1)!.status).toBe('unpublished');
    const r = await (await fetch(`${base}/v1/solvent/issuance/${i!.blindedMessageHex}`)).json();
    expect(r.publication_status).toBe('unpublished');
    expect((await browserVerify(base, env, i!)).result.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
  });

  it('omission scheduling rules: disabled, malformed, pre-registration, idempotent, already closed', async () => {
    const off = setup({ demo: false });
    const [a] = off.cdk.mint([8]);
    expect(scheduleOmission(off.state, a!.blindedMessageHex).status).toBe(403);
    const env = setup();
    const [b, c] = env.cdk.mint([8, 4]);
    expect(scheduleOmission(env.state, 'zz').status).toBe(400);
    // Not issued yet: accepted as a pre-registration (the normal browser path).
    const pre = scheduleOmission(env.state, '02' + '11'.repeat(32));
    expect(pre.status).toBe(202);
    expect(pre.body).toMatchObject({ state: 'pending', promised_epoch: null });
    expect(scheduleOmission(env.state, b!.blindedMessageHex).body).toMatchObject({ state: 'pending', promised_epoch: 1 });
    expect(scheduleOmission(env.state, b!.blindedMessageHex).status).toBe(202); // idempotent
    await closeAndPublish(env.state, env.deps);
    // c was never registered and its epoch is closed: a late request is refused, never silently honest.
    expect(scheduleOmission(env.state, c!.blindedMessageHex).status).toBe(409);
  });

  it('two simultaneous broken-promise requests in one epoch: each gets its OWN REFUSE; an honest issuance beside them ACCEPTs', async () => {
    const env = setup();
    const base = await serve(env.state);
    const [pa, pb] = [env.cdk.prepare(32), env.cdk.prepare(16)];
    const regs = await Promise.all(
      [pa, pb].map((p) => fetch(`${base}/v1/solvent/demo/omit`, { method: 'POST', body: JSON.stringify({ blinded_message: p.item.bPrimeHex }) })),
    );
    expect(regs.map((r) => r.status)).toEqual([202, 202]);
    const [a, b] = env.cdk.mintPrepared([pa, pb]);
    const [honest] = env.cdk.mint([8]);
    expect(await closeAndPublish(env.state, env.deps)).toBe(1);
    expect(new Set(env.state.store.get(1)!.omitted_issuances)).toEqual(new Set([a!.blindedMessageHex, b!.blindedMessageHex]));
    for (const i of [a!, b!]) {
      const v = await browserVerify(base, env, i);
      expect(v.result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
      expect(v.result.checks).toMatchObject({ receiptValid: true, manifestValid: true, delegationValid: true });
      expect(v.reserveLive.verified && v.nostrLive.verified).toBe(true);
      expect((await (await fetch(`${base}/v1/solvent/issuance/${i.blindedMessageHex}`)).json()).omission).toMatchObject({ state: 'applied', epoch: 1 });
    }
    expect((await browserVerify(base, env, honest!)).result.reasonCode).toBe('ACCEPT_VERIFIED');
  });

  it('three overlapping requests across epochs: each applied in exactly the epoch its issuance was promised to', async () => {
    const env = setup();
    const base = await serve(env.state);
    const [p1, p2, p3] = [env.cdk.prepare(4), env.cdk.prepare(8), env.cdk.prepare(16)];
    for (const p of [p1, p2, p3]) expect(scheduleOmission(env.state, p.item.bPrimeHex).status).toBe(202);
    const [i1] = env.cdk.mintPrepared([p1]); // promised to epoch 1
    const [h1] = env.cdk.mint([2]);
    expect(await closeAndPublish(env.state, env.deps)).toBe(1);
    // p2/p3 are not issued yet: they stay queued, untouched by epoch 1.
    expect(env.state.omissions.pending().sort()).toEqual([p2.item.bPrimeHex, p3.item.bPrimeHex].sort());
    const [i2] = env.cdk.mintPrepared([p2]); // promised to epoch 2
    expect(await closeAndPublish(env.state, env.deps)).toBe(2);
    const [i3] = env.cdk.mintPrepared([p3]); // promised to epoch 3
    const [h3] = env.cdk.mint([1]);
    expect(await closeAndPublish(env.state, env.deps)).toBe(3);
    expect([1, 2, 3].map((e) => env.state.store.get(e)!.omitted_issuances)).toEqual([[i1!.blindedMessageHex], [i2!.blindedMessageHex], [i3!.blindedMessageHex]]);
    for (const i of [i1!, i2!, i3!]) expect((await browserVerify(base, env, i)).result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
    for (const h of [h1!, h3!]) expect((await browserVerify(base, env, h)).result.reasonCode).toBe('ACCEPT_VERIFIED');
    expect(env.state.omissions.pending()).toEqual([]);
  });

  it('a queued request survives a sidecar restart and is still applied', async () => {
    const first = setup();
    const path = join(dirs[dirs.length - 1]!, 'omissions.json');
    const p = first.cdk.prepare(64);
    expect(scheduleOmission(first.state, p.item.bPrimeHex).status).toBe(202);
    // Restart: a new sidecar process over the same database and the same queue file.
    const second = setup({ cdk: first.cdk, omissionPath: path });
    expect(second.state.omissions.pending()).toEqual([p.item.bPrimeHex]);
    const [i] = second.cdk.mintPrepared([p]);
    await closeAndPublish(second.state, second.deps);
    expect(second.state.store.get(1)!.omitted_issuances).toEqual([i!.blindedMessageHex]);
  });

  it('a request whose issuance never appears expires visibly', async () => {
    const env = setup();
    const bm = '03' + '22'.repeat(32);
    scheduleOmission(env.state, bm, 1_000);
    env.cdk.mint([2]);
    env.deps.now = () => new Date((1_000 + OMISSION_REQUEST_TTL_SECONDS + 1) * 1000);
    await closeAndPublish(env.state, env.deps);
    expect(env.state.omissions.get(bm)).toMatchObject({ state: 'expired' });
  });

  it('publishing progress is reported while an epoch is published, and cleared after', async () => {
    const env = setup();
    env.cdk.mint([2]);
    const seen: unknown[] = [];
    const inner = env.deps.publish!;
    env.deps.publish = async (event, relays, expected, deps) => {
      deps?.onProgress?.({ stage: 'publishing', attempt: 1, acked: [] });
      seen.push(structuredClone(env.state.publishing));
      return inner(event, relays, expected, deps);
    };
    await closeAndPublish(env.state, env.deps);
    expect(seen[0]).toMatchObject({ epoch_index: 1, stage: 'publishing', relays: ['wss://relay.example'] });
    expect(env.state.publishing).toBeNull();
  });

  it('relay fetch: exact id only, fixed relay list, raw events with per-relay provenance, never the local record', async () => {
    const env = setup();
    env.cdk.mint([2]);
    await closeAndPublish(env.state, env.deps);
    const ev = env.published[0]!;
    const asked: string[][] = [];
    env.state.fetchEventById = async (id, relays) => {
      asked.push(relays ?? []);
      return { events: id === ev.id ? [ev] : [], relayReachable: true, perRelay: (relays ?? []).map((relay) => ({ relay, found: id === ev.id, result: id === ev.id ? ('found' as const) : ('no-match' as const), ms: 5 })) };
    };
    expect((await relayFetch(env.state, 'not-an-id')).status).toBe(400);
    const ok = await relayFetch(env.state, ev.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ requested_event_id: ev.id, relays_attempted: ['wss://relay.example'], fetched_from: ['wss://relay.example'], events: [ev] });
    expect(asked).toEqual([['wss://relay.example']]);
    // An event the relays do not return is not served from the sidecar's own store.
    env.state.fetchEventById = async (_id, relays) => ({ events: [], relayReachable: true, perRelay: (relays ?? []).map((relay) => ({ relay, found: false, result: 'no-match' as const, ms: 5 })) });
    expect((await relayFetch(env.state, ev.id)).body).toMatchObject({ events: [], fetched_from: [] });
  });

  it('status, health and CORS', async () => {
    const env = setup();
    const base = await serve(env.state);
    const res = await fetch(`${base}/v1/solvent/status`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ mint_url: MINT_URL, mint_identity_pubkey: ID.pub, open_epoch: 1, lightning_backend: 'fakewallet', demo_omission_enabled: true });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/solvent/demo/omit`, { method: 'OPTIONS' })).status).toBe(204);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
