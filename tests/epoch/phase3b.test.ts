// Phase 3B — the full public-evidence chain through the ONE central path
// (verifySubmission -> verify), built from real Phase 3A epochs.
//
// Network boundaries (NUT-06 /v1/info, Esplora chain state, Nostr relays)
// are injected so `npm test` never touches public infrastructure; every
// signature, digest, MMR and binding is real. The live equivalents run only
// from `npm run phase3b:live`.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateSecretKey, type NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { verifySubmission, type SubmissionBundle } from '../../src/app/submission.js';
import { closeEpoch } from '../../src/epoch/closer.js';
import { delegationMessage, MANIFEST_KEY_DELEGATION_SCHEMA, type ManifestKeyDelegation } from '../../src/epoch/delegation.js';
import { buildPhase3bEvidence, UnsupportedMultiKeysetState, type ReserveObservation } from '../../src/epoch/public-evidence.js';
import { signPolEvidenceEvent, type PolEvidenceContent } from '../../src/nostr/pol-event.js';
import { signReserveBinding } from '../../src/reserve/binding.js';
import type { ChainStateEntry } from '../../src/reserve/evaluate.js';
import { signReserveStatement } from '../../src/reserve/statement.js';
import { generateSignetReserveKey } from '../../src/reserve/taproot.js';
import { verify } from '../../src/verifier/verify.js';
import { CdkSim, createMintDb, type Issued } from './cdk-sim.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const MINT_URL = 'http://127.0.0.1:8085';
const NOW = 1_790_700_000;
const RESERVE_TIP = 3_500_000;

function identity(seed: string) {
  const m = HDKey.fromMasterSeed(new TextEncoder().encode(seed.padEnd(32, '0')));
  return { priv: m.privateKey!, pub: hex(m.publicKey!) };
}

const MINT_ID = identity('solvent-phase3b-test-mint');
const OTHER_ID = identity('solvent-phase3b-unrelated-mint');

function delegate(signer: Uint8Array, fields: Omit<ManifestKeyDelegation, 'schema' | 'signature'>): ManifestKeyDelegation {
  const d = { schema: MANIFEST_KEY_DELEGATION_SCHEMA, ...fields, signature: '' };
  d.signature = hex(schnorr.sign(sha256(delegationMessage(d)), signer));
  return d;
}

interface World {
  cdk: CdkSim;
  issued: Issued[];
  manifestPrivHex: string;
  manifestPub: string;
  delegation: ManifestKeyDelegation;
  reserveKey: ReturnType<typeof generateSignetReserveKey>;
  observation: ReserveObservation;
  nostrSecret: Uint8Array;
  epoch: number;
}

function world(opts: { omitFirst?: boolean; reserveSats?: number } = {}): World {
  const cdk = new CdkSim(createMintDb());
  const manifestPriv = createRandomSecretKey();
  const manifestPrivHex = hex(manifestPriv);
  const manifestPub = hex(getPubKeyFromPrivKey(manifestPriv));
  const issued = cdk.mint([64, 32]);
  const closed = closeEpoch(cdk.db, { manifestPrivateKeyHex: manifestPrivHex, omitPromisedIssuance: opts.omitFirst ? issued[0]!.blindedMessageHex : undefined });
  const delegation = delegate(MINT_ID.priv, { mint_url: MINT_URL, mint_identity_pubkey: MINT_ID.pub, manifest_pubkey: manifestPub, valid_from_epoch: 1, created_at: NOW - 100 });
  const reserveKey = generateSignetReserveKey();
  const observation: ReserveObservation = {
    txid: hex(sha256(new TextEncoder().encode(`reserve-${Math.random()}`))),
    vout: 0,
    valueSats: opts.reserveSats ?? 1_000_000,
    scriptPubKeyHex: reserveKey.scriptPubKeyHex,
    spent: false,
    tipHeight: RESERVE_TIP,
  };
  return { cdk, issued, manifestPrivHex, manifestPub, delegation, reserveKey, observation, nostrSecret: generateSecretKey(), epoch: closed.epochIndex };
}

function build(w: World, overrides: Partial<Parameters<typeof buildPhase3bEvidence>[0]> = {}) {
  const i = w.issued[0]!;
  return buildPhase3bEvidence({
    db: w.cdk.db,
    proof: i.proof,
    blindedMessageHex: i.blindedMessageHex,
    mintUrl: MINT_URL,
    amountPublicKeyHex: w.cdk.keyset.amounts[i.amount]!.publicKeyHex,
    manifestPrivateKeyHex: w.manifestPrivHex,
    delegation: w.delegation,
    reserveKey: w.reserveKey,
    reserve: w.observation,
    nostrSecretKey: w.nostrSecret,
    validitySeconds: 3600,
    proofUri: 'test://phase3b',
    now: new Date(NOW * 1000),
    ...overrides,
  });
}

interface Net {
  /** Events the relays return; default: exactly the bundle's event. */
  events?: NostrEvent[];
  relayReachable?: boolean;
  /** Chain state per outpoint; default: exactly what was observed, unspent. */
  chain?: Map<string, ChainStateEntry>;
  tipHeight?: number;
  nut06?: string | null;
  now?: number;
}

function run(w: World, bundle: SubmissionBundle, net: Net = {}) {
  const o = w.observation;
  const chain = net.chain ?? new Map([[`${o.txid}:${o.vout}`, { exists: true, confirmed: true, value: o.valueSats, scriptPubKeyHex: o.scriptPubKeyHex, spent: false }]]);
  return verifySubmission(
    bundle,
    async () => ({ events: net.events ?? (bundle.nostrEvent ? [bundle.nostrEvent] : []), queriedRelays: [], relayReachable: net.relayReachable ?? true }),
    async () => ({ ok: true, chainState: chain, tipHeight: net.tipHeight ?? RESERVE_TIP, detail: 'injected' }),
    async () => {},
    {
      mintInfoFetchFn: async () => (net.nut06 === null ? { ok: false as const, detail: 'unreachable' } : { ok: true as const, pubkey: net.nut06 ?? MINT_ID.pub }),
      nowSeconds: () => net.now ?? NOW + 60,
    },
  );
}

function resign(w: World, content: PolEvidenceContent): NostrEvent {
  return signPolEvidenceEvent(content, w.nostrSecret);
}

describe('Phase 3B — honest and broken-promise cases through the central verifier', () => {
  it('honest: real epoch + delegation + reserve binding + fetched event -> ACCEPT_VERIFIED, every check true', async () => {
    const w = world();
    const e = build(w);
    const r = await run(w, e.bundle);
    expect(r.result.reasonCode).toBe('ACCEPT_VERIFIED');
    expect(r.result.checks.delegationValid).toBe(true);
    expect(Object.values(r.result.checks).every((v) => v === true)).toBe(true);
    expect(r.reserveLive.verified && r.nostrLive.verified && r.nostrLive.eventFetched).toBe(true);
    expect(r.mintIdentityLive).toMatchObject({ ok: true, pubkey: MINT_ID.pub });
  });

  it('broken promise: everything else valid and public, promised issuance omitted -> REFUSE_ISSUANCE_OMITTED', async () => {
    const w = world({ omitFirst: true });
    const e = build(w);
    const r = await run(w, e.bundle);
    expect(r.result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(r.result.checks).toMatchObject({ receiptValid: true, targetEpochClosed: true, manifestValid: true, liabilityArithmeticValid: true, delegationValid: true });
    expect(r.reserveLive.verified).toBe(true);
    expect(r.nostrLive.verified).toBe(true);
  });
});

describe('Phase 3B — delegation is required for a real mint', () => {
  it('missing delegation -> REFUSE_DELEGATION_MISSING', async () => {
    const w = world();
    const e = build(w);
    expect((await run(w, { ...e.bundle, delegation: null })).result.reasonCode).toBe('REFUSE_DELEGATION_MISSING');
  });

  it('delegation not signed by the mint identity -> REFUSE_DELEGATION_INVALID_SIGNATURE', async () => {
    const w = world();
    const e = build(w);
    const forged = delegate(OTHER_ID.priv, { ...w.delegation });
    expect((await run(w, { ...e.bundle, delegation: forged })).result.reasonCode).toBe('REFUSE_DELEGATION_INVALID_SIGNATURE');
  });

  it("the mint's live NUT-06 identity differs from the delegation's -> REFUSE_DELEGATION_MINT_IDENTITY_MISMATCH", async () => {
    const w = world();
    const e = build(w);
    expect((await run(w, e.bundle, { nut06: OTHER_ID.pub })).result.reasonCode).toBe('REFUSE_DELEGATION_MINT_IDENTITY_MISMATCH');
  });

  it('L. manifest key not delegated by the mint -> REFUSE_DELEGATION_MANIFEST_KEY_MISMATCH', async () => {
    const w = world();
    const e = build(w);
    const otherKey = hex(getPubKeyFromPrivKey(createRandomSecretKey()));
    const wrong = delegate(MINT_ID.priv, { ...w.delegation, manifest_pubkey: otherKey });
    expect((await run(w, { ...e.bundle, delegation: wrong })).result.reasonCode).toBe('REFUSE_DELEGATION_MANIFEST_KEY_MISMATCH');
  });

  it('epoch before valid_from_epoch -> REFUSE_DELEGATION_EPOCH_OUT_OF_SCOPE', async () => {
    const w = world();
    const e = build(w);
    const later = delegate(MINT_ID.priv, { ...w.delegation, valid_from_epoch: w.epoch + 1 });
    expect((await run(w, { ...e.bundle, delegation: later })).result.reasonCode).toBe('REFUSE_DELEGATION_EPOCH_OUT_OF_SCOPE');
  });

  it('NUT-06 identity unobservable -> REFUSE_UNVERIFIABLE (never falls back to the delegation\'s own claim)', async () => {
    const w = world();
    const e = build(w);
    expect((await run(w, e.bundle, { nut06: null })).result.reasonCode).toBe('REFUSE_UNVERIFIABLE');
  });

  it('a manifest with a valid signature but no delegation is never enough', () => {
    const w = world();
    const e = build(w);
    const v = verify({ ...e.bundle, reserve: { verified: true, reserveSats: 1_000_000 }, nostr: { verified: true }, mintIdentityPubkey: MINT_ID.pub, delegation: undefined, epochKeysetCount: 1 });
    expect(v.checks.manifestValid).toBe(true);
    expect(v.reasonCode).toBe('REFUSE_DELEGATION_MISSING');
  });
});

describe('Phase 3B — reserve evidence (A-K)', () => {
  const key = (w: World) => `${w.observation.txid}:${w.observation.vout}`;
  const entry = (w: World, patch: Partial<ChainStateEntry>) =>
    new Map([[key(w), { exists: true, confirmed: true, value: w.observation.valueSats, scriptPubKeyHex: w.observation.scriptPubKeyHex, spent: false, ...patch }]]);

  it('A. spent UTXO -> REFUSE_RESERVE_UTXO_SPENT', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { chain: entry(w, { spent: true }) })).result.reasonCode).toBe('REFUSE_RESERVE_UTXO_SPENT');
  });

  it('B. wrong txid/vout (not on chain) -> REFUSE_RESERVE_STATE_MISMATCH', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { chain: new Map() })).result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('C. wrong scriptPubKey on chain -> REFUSE_RESERVE_STATE_MISMATCH', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { chain: entry(w, { scriptPubKeyHex: '5120' + '11'.repeat(32) }) })).result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('D. wrong observed amount -> REFUSE_RESERVE_STATE_MISMATCH', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { chain: entry(w, { value: w.observation.valueSats - 1 }) })).result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('E. forged reserve-control signature -> REFUSE_RESERVE_ATTESTATION_INVALID', async () => {
    const w = world();
    const b = build(w).bundle;
    const att = { ...b.reserveAttestation!, statementSignature: '00'.repeat(64) };
    expect((await run(w, { ...b, reserveAttestation: att })).result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('F. a different reserve-control key cannot attest to this UTXO -> REFUSE_RESERVE_ATTESTATION_INVALID', async () => {
    const w = world();
    const b = build(w, { reserveKey: generateSignetReserveKey() }).bundle; // signs a statement about w's real outpoint with an unrelated key
    expect((await run(w, b)).result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('G. statement from another network -> REFUSE_RESERVE_ATTESTATION_INVALID', async () => {
    const w = world();
    const b = build(w).bundle;
    const statement = { ...b.reserveAttestation!.statement, network: 'bitcoin-mainnet' };
    const att = { ...b.reserveAttestation!, statement, statementSignature: signReserveStatement(statement, w.reserveKey.tweakedPrivateKeyHex) };
    expect((await run(w, { ...b, reserveAttestation: att })).result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('H. stale statement (far behind the chain tip) -> REFUSE_RESERVE_ATTESTATION_INVALID; expired binding -> REFUSE_RESERVE_BINDING_INVALID', async () => {
    const w = world();
    const b = build(w).bundle;
    expect((await run(w, b, { tipHeight: RESERVE_TIP + 1_000_000 })).result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    expect((await run(w, b, { now: NOW + 3601 })).result.reasonCode).toBe('REFUSE_RESERVE_BINDING_INVALID');
  });

  it('I/J. reserve binding for another epoch or another manifest digest -> REFUSE_RESERVE_BINDING_INVALID', async () => {
    const w = world();
    const b = build(w).bundle;
    const { schema: _s, signature: _sig, ...fields } = b.reserveBinding!;
    const otherEpoch = signReserveBinding({ ...fields, epoch_index: fields.epoch_index + 1 }, w.manifestPrivHex);
    const otherManifest = signReserveBinding({ ...fields, manifest_digest: 'ab'.repeat(32) }, w.manifestPrivHex);
    expect((await run(w, { ...b, reserveBinding: otherEpoch })).result.reasonCode).toBe('REFUSE_RESERVE_BINDING_INVALID');
    expect((await run(w, { ...b, reserveBinding: otherManifest })).result.reasonCode).toBe('REFUSE_RESERVE_BINDING_INVALID');
    expect((await run(w, { ...b, reserveBinding: null })).result.reasonCode).toBe('REFUSE_RESERVE_BINDING_INVALID');
  });

  it('K. reserve below outstanding liability -> REFUSE_RESERVE_SHORT (coverage recomputed, never read from evidence)', async () => {
    const w = world({ reserveSats: 50 });
    const r = await run(w, build(w).bundle);
    expect(r.result.reasonCode).toBe('REFUSE_RESERVE_SHORT');
    expect(r.result.checks.reserveCoverage).toBe(false);
  });
});

describe('Phase 3B — Nostr publication (A-G)', () => {
  it('A. relays reachable, event absent -> REFUSE_NOSTR_EVENT_NOT_FOUND', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { events: [] })).result.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
  });

  it('B. no relay reachable -> REFUSE_NOSTR_UNAVAILABLE', async () => {
    const w = world();
    expect((await run(w, build(w).bundle, { events: [], relayReachable: false })).result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
  });

  it('C. fetched event signature invalid -> REFUSE_NOSTR_SIGNATURE', async () => {
    const w = world();
    const b = build(w).bundle;
    const bad = { ...b.nostrEvent!, sig: 'ff'.repeat(64) };
    expect((await run(w, b, { events: [bad] })).result.reasonCode).toBe('REFUSE_NOSTR_SIGNATURE');
  });

  it('D. relays return a different event id with the same state -> REFUSE_NOSTR_STATE_MISMATCH', async () => {
    const w = world();
    const e = build(w);
    const other = signPolEvidenceEvent({ ...e.content, issued_at: e.content.issued_at + 1 }, w.nostrSecret);
    expect(other.id).not.toBe(e.event.id);
    expect((await run(w, e.bundle, { events: [other] })).result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('E. event commits to a different manifest digest -> REFUSE_NOSTR_STATE_MISMATCH', async () => {
    const w = world();
    const e = build(w);
    const tampered = resign(w, { ...e.content, manifest_digest: 'cd'.repeat(32) });
    expect((await run(w, { ...e.bundle, nostrEvent: tampered })).result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('F. event commits to a different delegation -> REFUSE_NOSTR_STATE_MISMATCH', async () => {
    const w = world();
    const e = build(w);
    const tampered = resign(w, { ...e.content, manifest_key_delegation_digest: 'ef'.repeat(32) });
    expect((await run(w, { ...e.bundle, nostrEvent: tampered })).result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('G. stale valid_until -> REFUSE_NOSTR_STALE', async () => {
    const w = world();
    const e = build(w);
    const stale = resign(w, { ...e.content, issued_at: NOW - 7200, valid_until: NOW - 3600 });
    expect((await run(w, { ...e.bundle, nostrEvent: stale })).result.reasonCode).toBe('REFUSE_NOSTR_STALE');
  });
});

describe('Phase 3B — single-keyset guard', () => {
  it('the evidence builder refuses an epoch spanning two keysets', () => {
    const cdk = new CdkSim(createMintDb());
    new CdkSim(cdk.db); // a second active sat keyset in the same mint
    const manifestPrivHex = hex(createRandomSecretKey());
    const [i] = cdk.mint([8]);
    closeEpoch(cdk.db, { manifestPrivateKeyHex: manifestPrivHex });
    const w = world();
    expect(() =>
      buildPhase3bEvidence({
        db: cdk.db, proof: i!.proof, blindedMessageHex: i!.blindedMessageHex, mintUrl: MINT_URL,
        amountPublicKeyHex: cdk.keyset.amounts[8]!.publicKeyHex, manifestPrivateKeyHex: manifestPrivHex, delegation: w.delegation,
        reserveKey: w.reserveKey, reserve: w.observation, nostrSecretKey: w.nostrSecret, validitySeconds: 3600, proofUri: 'test://', now: new Date(NOW * 1000),
      }),
    ).toThrow(UnsupportedMultiKeysetState);
  });

  it('the central verifier refuses evidence declaring more than one keyset', async () => {
    const w = world();
    const b = build(w).bundle;
    expect((await run(w, { ...b, epochKeysetCount: 2 })).result.reasonCode).toBe('REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE');
  });
});
