// npm run phase3b:live -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT Phase 3B — the ONLY command that publishes to public Nostr relays.
// Drives a running patched cdk-mintd (patches 0001-0008, migrations 0001-
// 0003) through real epochs and produces real public solvency evidence:
//
//   HONEST        real issuance -> receipt promises N -> close N -> manifest
//                 -> mint-identity delegation -> live Mutinynet reserve ->
//                 reserve-control signature -> manifest-key reserve binding
//                 -> kind 8181 event -> publish (relay ACK) -> discard local
//                 event -> fetch the exact event back -> verifySubmission()
//                 -> ACCEPT_VERIFIED
//   BROKEN        same, with the explicit omission mode -> REFUSE_ISSUANCE_OMITTED
//   NOT FOUND     a valid event that is never published -> REFUSE_NOSTR_EVENT_NOT_FOUND
//   UNAVAILABLE   the honest bundle checked against unreachable relays -> REFUSE_NOSTR_UNAVAILABLE
//
// Every network observation a decision used (NUT-06 identity, chain state,
// relay responses, clock) is recorded into the evidence so
// `npm run verify:phase3b-evidence` can replay the identical decision
// offline through the same verifySubmission() path.
//
// Environment:
//   CDK_MINT_URL                    the running mint (its configured URL)
//   SOLVENT_MANIFEST_PRIVKEY        the Phase 3A manifest key (32-byte hex)
//   SOLVENT_MANIFEST_DELEGATION     path to `cdk-mintd solvent delegate-manifest-key` output
//   SOLVENT_RUN_ID                  evidence directory name
//   LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX
//                                   when set, every mint invoice is paid over real
//                                   Lightning (lightning_backend = "lnd"); otherwise the
//                                   mint must run fakewallet (lightning_backend = "fakewallet")
//   SOLVENT_LIGHTNING_BACKEND       optional; must agree with the above or the run aborts
//   SOLVENT_NOSTR_RELAYS            optional comma-separated relay override (default: documented POL_RELAYS)
//   SOLVENT_EVIDENCE_VALIDITY_SECONDS  default 3600 — independent of the epoch cadence
//   SOLVENT_RESERVE_KEY_FILE        default evidence/reserves/reserve-key.json (Signet-only test key)
//   SOLVENT_RESERVE_OUTPOINT        default: the documented live reserve outpoint (txid:vout)
// The Nostr signing key is generated fresh for each run and never written.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Mint, Wallet, getEncodedToken, getPubKeyFromPrivKey, type Proof } from '@cashu/cashu-ts';
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools';
import liveAttestation from '../../../evidence/reserves/live-attestation.json' with { type: 'json' };
import { submissionBundleToJson } from '../../app/bundle-json.js';
import { fetchMintIdentity, queryLiveChainState, verifySubmission, type MintInfoFetchFn, type SubmissionBundle, type SubmissionVerification } from '../../app/submission.js';
import { reconstruct } from '../../cashu/reconstruct.js';
import { auditClosedEpoch, closeEpoch, openEpoch } from '../../epoch/closer.js';
import { verifyManifestKeyDelegation, type ManifestKeyDelegation } from '../../epoch/delegation.js';
import { buildPhase3bEvidence, evidenceValiditySeconds, type Phase3bEvidence, type ReserveObservation } from '../../epoch/public-evidence.js';
import { verifyPolEvidenceEvent } from '../../nostr/pol-event.js';
import { configuredRelays, fetchPolEventById, fetchPolEvidence, publishPolEvidence, type RelayPublishResult } from '../../nostr/pol-evidence.js';
import { bytesToHex } from '../../pol/manifest.js';
import { fetchOutspend, fetchTipHeight, fetchTxOutScript, RESERVE_NETWORK_LABEL } from '../../reserve/esplora.js';
import type { ChainStateEntry } from '../../reserve/evaluate.js';
import { LndClient } from './lnd-client.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${label.padEnd(72)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x), 2) + '\n';
const nowIso = () => new Date().toISOString();

interface Ctx {
  runId: string;
  dir: string;
  mintUrl: string;
  db: DatabaseSync;
  wallet: Wallet;
  keys: Record<string, string>;
  keysetId: string;
  manifestPrivHex: string;
  delegation: ManifestKeyDelegation;
  reserveKey: { outputPublicKeyXOnlyHex: string; tweakedPrivateKeyHex: string };
  outpoint: { txid: string; vout: number };
  nostrSecret: Uint8Array;
  relays: string[];
  validitySeconds: number;
  lightningBackend: 'lnd' | 'fakewallet';
  lnd: LndClient | null;
  /** Every proof whose secret appears in a verify-input bundle — spent before the run ends. */
  evidenceProofs: Proof[];
  settlements: { quote: string; amount: number; settlement: string }[];
}

function write(ctx: Ctx, name: string, pass: boolean, body: Record<string, unknown>): void {
  writeFileSync(
    path.join(ctx.dir, name),
    toJson({ run_id: ctx.runId, generated_at: nowIso(), lightning_backend: ctx.lightningBackend, pass, ...body }),
  );
}

/** A verify-input bundle, labelled; the bundle parser passes the extra `_evidence` key through untouched. */
function writeBundle(ctx: Ctx, name: string, bundle: SubmissionBundle): void {
  const labelled = {
    _evidence: {
      run_id: ctx.runId,
      generated_at: nowIso(),
      lightning_backend: ctx.lightningBackend,
      note: `Holder bundle for offline replay. Its Cashu proof is spent at the end of this run (see phase3-proofs-spent.json)${ctx.lightningBackend === 'fakewallet' ? ' and is worthless fakewallet ecash from a local test mint' : ''}.`,
    },
    ...JSON.parse(submissionBundleToJson(bundle)),
  };
  writeFileSync(path.join(ctx.dir, name), JSON.stringify(labelled, null, 2) + '\n');
}

async function mintProofs(ctx: Ctx, amount: number): Promise<Proof[]> {
  const quote = await ctx.wallet.createMintQuoteBolt11(amount);
  let settlement = 'fakewallet (self-settled by the mint backend; no Lightning payment)';
  if (ctx.lnd) {
    const payment = await ctx.lnd.payInvoiceSync(quote.request);
    if (!payment.ok) throw new Error(`real Lightning payment failed: ${payment.paymentError}`);
    settlement = 'lnd (invoice paid over a real Lightning channel)';
  }
  ctx.settlements.push({ quote: quote.quote, amount, settlement });
  for (let i = 0; i < 60; i++) {
    if ((await ctx.wallet.checkMintQuoteBolt11(quote.quote)).state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return ctx.wallet.mintProofsBolt11(amount, quote.quote);
}

function blindedMessageOf(ctx: Ctx, p: Proof): string {
  const r = reconstruct(p, p.id, ctx.keys[String(p.amount)]!);
  if (!r.valid || !r.bPrimeHex) throw new Error('DLEQ reconstruction failed');
  return r.bPrimeHex;
}

/** A live, recorded observation of the reserve outpoint. */
async function observeReserve(ctx: Ctx): Promise<ReserveObservation> {
  const [out, spend, tip] = await Promise.all([fetchTxOutScript(ctx.outpoint.txid, ctx.outpoint.vout), fetchOutspend(ctx.outpoint.txid, ctx.outpoint.vout), fetchTipHeight()]);
  if (!out) throw new Error(`reserve outpoint ${ctx.outpoint.txid}:${ctx.outpoint.vout} not found on ${RESERVE_NETWORK_LABEL}`);
  return { txid: ctx.outpoint.txid, vout: ctx.outpoint.vout, valueSats: out.value, scriptPubKeyHex: out.scriptPubKeyHex, spent: outspend(spend), tipHeight: tip };
}
const outspend = (s: { spent: boolean }) => s.spent;

/** Wraps the live network functions so the exact observations a decision used are recorded. */
function recordingVerifier(ctx: Ctx, relays: string[]) {
  const observed: {
    nut06?: Awaited<ReturnType<MintInfoFetchFn>>;
    chain?: { ok: boolean; tipHeight: number; chainState: [string, ChainStateEntry][]; detail: string };
    relayQueries: { relayReachable: boolean; events: NostrEvent[] }[];
    now?: number;
  } = { relayQueries: [] };
  const run = async (bundle: SubmissionBundle): Promise<SubmissionVerification> => {
    const now = Math.floor(Date.now() / 1000);
    observed.now = now;
    return verifySubmission(
      bundle,
      async (identity, epoch) => {
        const r = await fetchPolEvidence(identity, epoch, relays);
        observed.relayQueries.push({ relayReachable: r.relayReachable, events: r.events });
        return r;
      },
      async (outpoints, delay) => {
        const r = await queryLiveChainState(outpoints, delay);
        observed.chain = { ok: r.ok, tipHeight: r.tipHeight, chainState: [...r.chainState.entries()], detail: r.detail };
        return r;
      },
      undefined,
      {
        mintInfoFetchFn: async (url) => {
          const r = await fetchMintIdentity(url);
          observed.nut06 = r;
          return r;
        },
        nowSeconds: () => now,
      },
    );
  };
  return { run, observed };
}

async function publishAndFetchBack(ctx: Ctx, evidence: Phase3bEvidence, prefix: string): Promise<NostrEvent | null> {
  const nostrPubkey = getPublicKey(ctx.nostrSecret);
  // Bounded retries: up to 3 rounds, re-sending only to relays that have not
  // ACKed, with a short backoff. Success still requires a real relay ACK and,
  // below, an exact fetch-back — never a local copy.
  const attempts: { round: number; results: RelayPublishResult[] }[] = [];
  const acked = new Set<string>();
  for (let round = 1; round <= 3; round++) {
    const pending = ctx.relays.filter((r) => !acked.has(r));
    if (pending.length === 0) break;
    const roundResults = await publishPolEvidence(evidence.event, pending);
    attempts.push({ round, results: roundResults });
    for (const r of roundResults) if (r.ok) acked.add(r.relay);
    if (acked.size === ctx.relays.length) break;
    if (round < 3) await new Promise((res) => setTimeout(res, 2000 * round));
  }
  const results: RelayPublishResult[] = ctx.relays.map((relay) => {
    const last = [...attempts].reverse().flatMap((a) => a.results).find((r) => r.relay === relay);
    return acked.has(relay) ? { relay, ok: true, detail: '' } : (last ?? { relay, ok: false, detail: 'not attempted' });
  });
  const acks = results.filter((r) => r.ok);
  const publishedId = evidence.event.id;
  check(`${prefix}: at least one relay ACKed the event`, acks.length > 0, `${acks.length}/${results.length} (${acks.map((a) => a.relay).join(', ')})`);
  write(ctx, `${prefix}-nostr-publication.json`, acks.length > 0, {
    kind: evidence.event.kind,
    schema: evidence.content.schema,
    event_id: publishedId,
    nostr_pubkey: nostrPubkey,
    relays: results,
    attempts,
    acks: acks.length,
  });

  // The locally built event is NOT used again: the bundle is re-assembled
  // from what a public relay independently returns for this exact id.
  let fetched: NostrEvent | undefined;
  let perRelay: { relay: string; found: boolean }[] = [];
  for (let attempt = 1; attempt <= 5 && !fetched; attempt++) {
    const r = await fetchPolEventById(publishedId, ctx.relays);
    perRelay = r.perRelay;
    fetched = r.events.find((e) => e.id === publishedId);
    if (!fetched) await new Promise((res) => setTimeout(res, 2000));
  }
  const v = fetched ? verifyPolEvidenceEvent(fetched) : null;
  const content = v?.content;
  const bindingsOk =
    !!content &&
    content.manifest_digest === evidence.content.manifest_digest &&
    content.global_digest === evidence.content.global_digest &&
    content.reserve_digest === evidence.content.reserve_digest &&
    content.manifest_key_delegation_digest === evidence.delegationDigest &&
    content.reserve_binding_digest === evidence.reserveBindingDigest;
  const ok = !!fetched && fetched.id === publishedId && !!v?.signatureValid && !!v?.contentParses && bindingsOk;
  check(`${prefix}: exact event fetched back, id + signature + content bindings verify`, ok, fetched ? `found on ${perRelay.filter((p) => p.found).map((p) => p.relay).join(', ')}` : 'not found');
  write(ctx, `${prefix}-nostr-fetchback.json`, ok, {
    event_id: publishedId,
    fetched_event: fetched ?? null,
    per_relay: perRelay,
    id_matches: fetched?.id === publishedId,
    signature_valid: v?.signatureValid ?? false,
    content_bindings_valid: bindingsOk,
  });
  return ok ? fetched! : null;
}

function manifestArtifact(evidence: Phase3bEvidence, db: DatabaseSync) {
  const b = evidence.bundle;
  return {
    epoch_index: evidence.epochIndex,
    keyset_count: b.epochKeysetCount,
    manifest: b.manifest,
    manifest_signature: b.manifestSignature,
    manifest_pubkey: b.masterPublicKeyHex,
    manifest_digest: evidence.content.manifest_digest,
    global_digest: evidence.content.global_digest,
    previous_global_digest: evidence.content.previous_global_digest,
    audit: auditClosedEpoch(db, evidence.epochIndex),
    receipt: b.receipt,
    inclusion_proof_present: b.inclusionProof !== null,
  };
}

async function honestOrOmission(ctx: Ctx, omit: boolean) {
  const label = omit ? 'BROKEN PROMISE' : 'HONEST';
  const prefix = omit ? 'phase3-omission' : 'phase3';
  console.log(`\n— ${label} —`);
  const epochN = openEpoch(ctx.db).epochIndex;
  const proofs = await mintProofs(ctx, 96);
  const target = proofs[0]!;
  const bm = blindedMessageOf(ctx, target);
  const receipt = (await (await fetch(`${ctx.mintUrl}/v1/solvent/pol-receipt/${bm}`)).json()) as { status: string; target_epoch?: number };
  check(`${label}: real issuance, signed receipt promises open epoch ${epochN}`, receipt.status === 'signed' && receipt.target_epoch === epochN, `target_epoch ${receipt.target_epoch}`);

  const closed = closeEpoch(ctx.db, { manifestPrivateKeyHex: ctx.manifestPrivHex, omitPromisedIssuance: omit ? bm : undefined });
  check(`${label}: epoch ${epochN} closed${omit ? ' with the promised issuance deliberately omitted' : ''}`, closed.epochIndex === epochN && (!omit || closed.omitted?.blindedMessageHex === bm));

  const reserve = await observeReserve(ctx);
  const evidence = buildPhase3bEvidence({
    db: ctx.db, proof: target, blindedMessageHex: bm, mintUrl: ctx.mintUrl, amountPublicKeyHex: ctx.keys[String(target.amount)]!,
    manifestPrivateKeyHex: ctx.manifestPrivHex, delegation: ctx.delegation, reserveKey: ctx.reserveKey, reserve,
    nostrSecretKey: ctx.nostrSecret, validitySeconds: ctx.validitySeconds, proofUri: `solvent-phase3b://${ctx.runId}/${prefix}`,
  });
  write(ctx, `${prefix}-manifest.json`, true, manifestArtifact(evidence, ctx.db));
  if (!omit) {
    write(ctx, 'phase3-reserve.json', !reserve.spent, {
      network: RESERVE_NETWORK_LABEL,
      observation: reserve,
      statement: evidence.reserveStatement,
      statement_signature: evidence.bundle.reserveAttestation!.statementSignature,
      reserve_control_pubkey: evidence.reserveStatement.reserve_pubkey,
      outstanding_balance: evidence.bundle.manifest.outstanding_balance,
      covers_outstanding: reserve.valueSats >= evidence.bundle.manifest.outstanding_balance,
    });
    write(ctx, 'phase3-reserve-binding.json', true, { binding: evidence.reserveBinding, binding_digest: evidence.reserveBindingDigest, signer: evidence.bundle.masterPublicKeyHex });
  }

  ctx.evidenceProofs.push(target);
  const fetched = await publishAndFetchBack(ctx, evidence, prefix);
  if (!fetched) return { evidence, result: null };
  const bundle: SubmissionBundle = { ...evidence.bundle, nostrEvent: fetched };
  const verifier = recordingVerifier(ctx, ctx.relays);
  const result = await verifier.run(bundle);
  const expected = omit ? 'REFUSE_ISSUANCE_OMITTED' : 'ACCEPT_VERIFIED';
  const pass = result.result.reasonCode === expected;
  check(`${label}: central verify() -> ${expected}`, pass, result.result.reasonCode);
  if (omit) {
    check(`${label}: delegation, reserve and Nostr all independently valid`, result.result.checks.delegationValid === true && result.reserveLive.verified && result.nostrLive.verified);
  } else {
    check(`${label}: every check true`, Object.values(result.result.checks).every((v) => v === true));
  }
  writeBundle(ctx, `${omit ? 'phase3-omission' : 'phase3-honest'}-verify-input.json`, bundle);
  write(ctx, omit ? 'phase3-omission-refuse.json' : 'phase3-accept.json', pass, {
    expected,
    decision: result.result.decision,
    reason_code: result.result.reasonCode,
    checks: result.result.checks,
    reserve_live: result.reserveLive,
    nostr_live: result.nostrLive,
    mint_identity_live: result.mintIdentityLive,
    observed: verifier.observed,
  });
  return { evidence, result, bundle };
}

async function notFound(ctx: Ctx) {
  console.log('\n— NOT FOUND (valid evidence, never published) —');
  const proofs = await mintProofs(ctx, 8);
  const bm = blindedMessageOf(ctx, proofs[0]!);
  closeEpoch(ctx.db, { manifestPrivateKeyHex: ctx.manifestPrivHex });
  const evidence = buildPhase3bEvidence({
    db: ctx.db, proof: proofs[0]!, blindedMessageHex: bm, mintUrl: ctx.mintUrl, amountPublicKeyHex: ctx.keys[String(proofs[0]!.amount)]!,
    manifestPrivateKeyHex: ctx.manifestPrivHex, delegation: ctx.delegation, reserveKey: ctx.reserveKey, reserve: await observeReserve(ctx),
    nostrSecretKey: ctx.nostrSecret, validitySeconds: ctx.validitySeconds, proofUri: `solvent-phase3b://${ctx.runId}/not-found`,
  });
  ctx.evidenceProofs.push(proofs[0]!);
  const verifier = recordingVerifier(ctx, ctx.relays);
  const result = await verifier.run(evidence.bundle);
  const pass = result.result.reasonCode === 'REFUSE_NOSTR_EVENT_NOT_FOUND';
  check('NOT FOUND: central verify() -> REFUSE_NOSTR_EVENT_NOT_FOUND', pass, result.result.reasonCode);
  writeBundle(ctx, 'phase3-nostr-not-found-verify-input.json', evidence.bundle);
  write(ctx, 'phase3-nostr-not-found.json', pass, {
    expected: 'REFUSE_NOSTR_EVENT_NOT_FOUND', decision: result.result.decision, reason_code: result.result.reasonCode,
    event_id_never_published: evidence.event.id, nostr_live: result.nostrLive, observed: verifier.observed,
  });
}

async function unavailable(ctx: Ctx, honestBundle: SubmissionBundle) {
  console.log('\n— UNAVAILABLE (every relay unreachable) —');
  // Real connection attempts to ports with no listener — never a mocked response.
  const deadRelays = ['ws://127.0.0.1:1', 'ws://127.0.0.1:2'];
  const verifier = recordingVerifier(ctx, deadRelays);
  const result = await verifier.run(honestBundle);
  const pass = result.result.reasonCode === 'REFUSE_NOSTR_UNAVAILABLE';
  check('UNAVAILABLE: central verify() -> REFUSE_NOSTR_UNAVAILABLE', pass, result.result.reasonCode);
  write(ctx, 'phase3-nostr-unavailable.json', pass, {
    expected: 'REFUSE_NOSTR_UNAVAILABLE', decision: result.result.decision, reason_code: result.result.reasonCode,
    relays_attempted: deadRelays, verify_input_file: 'phase3-honest-verify-input.json', nostr_live: result.nostrLive, observed: verifier.observed,
  });
}

/**
 * Every proof whose secret sits in a verify-input bundle is spent (swapped
 * away into outputs this run then discards) before the run ends, and NUT-07
 * confirms SPENT — so no artifact ever carries live, spendable ecash.
 */
async function spendEvidenceProofs(ctx: Ctx): Promise<void> {
  console.log('\n— SPEND EVIDENCE PROOFS —');
  const receiver = new Wallet(ctx.mintUrl);
  await receiver.loadMint();
  const preview = await receiver.ops.receive(getEncodedToken({ mint: ctx.mintUrl, proofs: ctx.evidenceProofs })).prepare();
  await receiver.completeSwap(preview);
  const states = await ctx.wallet.checkProofsStates(ctx.evidenceProofs);
  const allSpent = states.length === ctx.evidenceProofs.length && states.every((s) => s.state === 'SPENT');
  check('Every proof included in evidence is SPENT (NUT-07)', allSpent, states.map((s) => s.state).join(','));
  write(ctx, 'phase3-proofs-spent.json', allSpent, {
    proofs: states.map((s, i) => ({ Y: s.Y, amount: Number(ctx.evidenceProofs[i]!.amount), state: s.state })),
    note: 'The holder proofs inside the verify-input bundles were swapped away after verification; their secrets no longer control any ecash.',
  });
}

/** Scans every artifact for the exact secret values this run held, plus generic secret markers. */
function secretScan(ctx: Ctx, secrets: string[]): boolean {
  const generic = [/\bxprv[1-9A-HJ-NP-Za-km-z]{20,}/, /\bnsec1[0-9a-z]{20,}/, /abandon abandon/, /macaroon/i, /tweakedPrivateKeyHex|internalPrivateKeyHex|privateKeyHex/];
  let clean = true;
  for (const f of readdirSync(ctx.dir)) {
    const text = readFileSync(path.join(ctx.dir, f), 'utf8');
    for (const s of secrets) if (s && text.includes(s)) { console.log(`  SECRET VALUE FOUND in ${f}`); clean = false; }
    for (const g of generic) if (g.test(text)) { console.log(`  secret marker ${g} in ${f}`); clean = false; }
  }
  return clean;
}

async function main() {
  const dbPath = process.argv[2];
  const mintUrl = process.env.CDK_MINT_URL;
  const manifestPrivHex = process.env.SOLVENT_MANIFEST_PRIVKEY;
  const delegationFile = process.env.SOLVENT_MANIFEST_DELEGATION;
  if (!dbPath || !mintUrl || !manifestPrivHex || !delegationFile) {
    throw new Error('usage: CDK_MINT_URL=… SOLVENT_MANIFEST_PRIVKEY=… SOLVENT_MANIFEST_DELEGATION=<file> phase3b-live.ts <path-to-cdk-mintd.sqlite>');
  }
  const runId = process.env.SOLVENT_RUN_ID ?? `phase3b-local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = path.join('evidence', 'real-pol', runId);
  mkdirSync(dir, { recursive: true });
  const reserveKeyFile = JSON.parse(readFileSync(process.env.SOLVENT_RESERVE_KEY_FILE ?? 'evidence/reserves/reserve-key.json', 'utf8')) as { outputPublicKeyXOnlyHex: string; tweakedPrivateKeyHex: string; internalPrivateKeyHex: string };
  const [txid, vout] = (process.env.SOLVENT_RESERVE_OUTPOINT ?? `${liveAttestation.attestation.statement.outpoints[0]!.txid}:${liveAttestation.attestation.statement.outpoints[0]!.vout}`).split(':');

  console.log('SOLVENT — PHASE 3B LIVE PUBLIC SOLVENCY EVIDENCE\n');
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();
  const keysets = await new Mint(mintUrl).getKeys();
  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  const lnd =
    process.env.LND_SOURCE_REST_URL && process.env.LND_SOURCE_MACAROON_HEX
      ? new LndClient({ restUrl: process.env.LND_SOURCE_REST_URL, macaroonHex: process.env.LND_SOURCE_MACAROON_HEX })
      : null;
  const ctx: Ctx = {
    runId, dir, mintUrl, db, wallet,
    keys: keysets.keysets.find((k) => k.unit === 'sat')!.keys,
    keysetId: keysets.keysets.find((k) => k.unit === 'sat')!.id,
    manifestPrivHex,
    delegation: JSON.parse(readFileSync(delegationFile, 'utf8')) as ManifestKeyDelegation,
    reserveKey: { outputPublicKeyXOnlyHex: reserveKeyFile.outputPublicKeyXOnlyHex, tweakedPrivateKeyHex: reserveKeyFile.tweakedPrivateKeyHex },
    outpoint: { txid: txid!, vout: Number(vout) },
    nostrSecret: generateSecretKey(),
    relays: configuredRelays(),
    validitySeconds: evidenceValiditySeconds(),
    lightningBackend: lnd ? 'lnd' : 'fakewallet',
    lnd,
    evidenceProofs: [],
    settlements: [],
  };
  if (process.env.SOLVENT_LIGHTNING_BACKEND && process.env.SOLVENT_LIGHTNING_BACKEND !== ctx.lightningBackend) {
    throw new Error(`SOLVENT_LIGHTNING_BACKEND=${process.env.SOLVENT_LIGHTNING_BACKEND} but invoices would be settled by ${ctx.lightningBackend} — refusing to mislabel evidence`);
  }
  console.log(`Lightning backend: ${ctx.lightningBackend}   relays: ${ctx.relays.join(', ')}   evidence validity: ${ctx.validitySeconds}s\n`);

  try {
    // Single-keyset guard, checked at the source of truth: the mint itself.
    const activeSat = (await new Mint(mintUrl).getKeySets()).keysets.filter((k) => k.unit === 'sat' && k.active);
    if (!check('Mint exposes exactly one active sat keyset', activeSat.length === 1, `${activeSat.length}`)) {
      console.log('REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE — multi-keyset aggregation is not implemented');
      return;
    }

    // Trust root: the mint's live NUT-06 identity must have delegated the manifest key.
    const nut06 = await fetchMintIdentity(mintUrl);
    const manifestPub = bytesToHex(getPubKeyFromPrivKey(Buffer.from(manifestPrivHex, 'hex')));
    const firstEpoch = (db.prepare(`SELECT MIN(epoch_index) AS e FROM solvent_pol_epoch WHERE state = 'CLOSED' AND manifest_pubkey = ?`).get(manifestPub) as { e: number | null }).e;
    const delegationCheck = nut06.ok
      ? verifyManifestKeyDelegation(ctx.delegation, { mintUrl, mintIdentityPubkey: nut06.pubkey, manifestPubkey: manifestPub, epochIndex: firstEpoch ?? openEpoch(db).epochIndex })
      : { ok: false as const, reason: 'DELEGATION_IDENTITY_MISMATCH' as const, detail: nut06.detail };
    check('Delegation from the live NUT-06 identity authorizes the Phase 3A manifest key', delegationCheck.ok, nut06.ok ? nut06.pubkey : nut06.detail);
    check('Delegation valid_from_epoch is the first epoch this key signed', ctx.delegation.valid_from_epoch === (firstEpoch ?? ctx.delegation.valid_from_epoch), `${ctx.delegation.valid_from_epoch} (first signed: ${firstEpoch ?? 'none yet'})`);
    write(ctx, 'phase3-delegation.json', delegationCheck.ok, {
      delegation: ctx.delegation,
      nut06_observed: nut06,
      manifest_pubkey: manifestPub,
      first_epoch_signed_by_key: firstEpoch,
      verification: delegationCheck,
      produced_by: 'cdk-mintd solvent delegate-manifest-key (patches/cdk/0008)',
    });
    if (!delegationCheck.ok) return;

    const honest = await honestOrOmission(ctx, false);
    await honestOrOmission(ctx, true);
    await notFound(ctx);
    if (honest.bundle) await unavailable(ctx, honest.bundle);
    write(ctx, 'phase3-lightning-settlement.json', true, { settlements: ctx.settlements });
    await spendEvidenceProofs(ctx);
  } finally {
    db.close();
  }

  console.log('\n— SECRET SCAN —');
  check('No secret material in any evidence file', secretScan(ctx, [manifestPrivHex, reserveKeyFile.tweakedPrivateKeyHex, reserveKeyFile.internalPrivateKeyHex, Buffer.from(ctx.nostrSecret).toString('hex'), process.env.LND_SOURCE_MACAROON_HEX ?? '']));
  console.log(`\nEvidence written to ${dir}\n`);
  if (failures === 0) console.log('PHASE 3B LIVE PUBLIC EVIDENCE VERIFIED (lightning_backend=' + ctx.lightningBackend + ')');
  else {
    console.log(`PHASE 3B NOT VERIFIED — ${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('phase3b-live crashed:', err);
  process.exitCode = 1;
});
