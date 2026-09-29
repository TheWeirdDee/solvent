// npm run verify:pol-epoch -- <path-to-cdk-mintd.sqlite>
// npm run verify:pol-epoch -- <path-to-cdk-mintd.sqlite> --audit-only [--evidence-out <file>]
// npm run verify:pol-epoch -- <path-to-cdk-mintd.sqlite> --snapshot [--evidence-out <file>]
//
// SOLVENT Phase 3A — the real epoch lifecycle, end to end, against a running
// patched cdk-mintd (patches/cdk/0001-0007 + migrations 0001-0003):
//
//   HONEST   real NUT-04 issuance -> signed receipt promising the OPEN epoch N
//            -> real NUT-03 swap in N -> close N from the real database ->
//            signed manifest -> inclusion proof -> central verifier
//   BROKEN   real issuance promised to N+1 -> operator omission mode closes
//   PROMISE  N+1 without it -> valid signed manifest -> central verifier
//            refuses REFUSE_ISSUANCE_OMITTED
//
// Nostr publication and the live reserve are Phase 3B, so they are not
// supplied to verify(): the honest case is expected to pass every PoL check
// and still fail closed with REFUSE_UNVERIFIABLE — never a fabricated
// ACCEPT. The omission is caught before those gates.
//
// --audit-only re-derives and re-checks every closed epoch and its digest
// chain (used after a real mint restart); --snapshot prints the epoch
// state only (used around the SIGKILL drill). Either writes JSON to
// --evidence-out <file> when given.
//
// Environment:
//   CDK_MINT_URL               the running mint
//   SOLVENT_MANIFEST_PRIVKEY   32-byte hex manifest key
//   SOLVENT_MANIFEST_DELEGATION
//                              path to the `cdk-mintd solvent delegate-manifest-key`
//                              output for that key. Required: the central verifier
//                              only treats a real (URL) mint's manifest as
//                              authoritative with the mint identity's delegation,
//                              checked against the mint's live NUT-06 pubkey.
//   SOLVENT_RUN_ID             evidence directory name (default local-<time>)
//   LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX
//                              when set, invoices are paid over real
//                              Lightning (CI regtest). When unset the mint
//                              must run the fakewallet backend, which
//                              self-settles its invoices — recorded as such.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getEncodedToken, Mint, Wallet, type Proof } from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrVerifyDigest } from '@cashu/cashu-ts';
import { reconstruct } from '../../cashu/reconstruct.js';
import { fetchMintIdentity } from '../../app/submission.js';
import type { ManifestKeyDelegation } from '../../epoch/delegation.js';
import { auditClosedEpoch, closeEpoch, issuanceEvidence, loadClosedEpoch, openEpoch, type ClosedEpoch } from '../../epoch/closer.js';
import { ZERO_DIGEST_HEX } from '../../pol/manifest.js';
import { issuedLeaf, verifyInclusionProof, hexToBytes } from '../../pol/mmr.js';
import { issuedReceiptMessage } from '../../pol/receipt.js';
import { verify, type VerifyInput, type VerifyResult } from '../../verifier/verify.js';
import { bundleToJson } from '../../app/bundle-json.js';
import { LndClient } from './lnd-client.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${label.padEnd(76)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
}

function toJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v),
      2,
    ) + '\n'
  );
}

interface Ctx {
  mintUrl: string;
  db: DatabaseSync;
  key: string;
  wallet: Wallet;
  keys: Record<string, string>;
  keysetId: string;
  lnd: LndClient | null;
  evidenceDir: string;
  /** The mint's NUT-06 identity, fetched live from /v1/info. */
  mintIdentityPubkey: string;
  delegation: ManifestKeyDelegation;
}

function writeEvidence(ctx: Ctx, name: string, body: unknown): void {
  writeFileSync(path.join(ctx.evidenceDir, name), typeof body === 'string' ? body : toJson(body));
}

async function payAndMint(ctx: Ctx, amount: number): Promise<{ quote: string; proofs: Proof[]; settlement: string }> {
  const quote = await ctx.wallet.createMintQuoteBolt11(amount);
  let settlement: string;
  if (ctx.lnd) {
    const payment = await ctx.lnd.payInvoiceSync(quote.request);
    if (!payment.ok) throw new Error(`real Lightning payment failed: ${payment.paymentError}`);
    settlement = 'lnd';
  } else {
    settlement = 'fakewallet (self-settled by the mint backend; no real Lightning payment)';
  }
  for (let i = 0; i < 60; i++) {
    const state = await ctx.wallet.checkMintQuoteBolt11(quote.quote);
    if (state.state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const proofs = await ctx.wallet.mintProofsBolt11(amount, quote.quote);
  return { quote: quote.quote, proofs, settlement };
}

/** The holder's own view: reconstruct B_ from the proof (NUT-12), never trusting a mint-supplied identifier. */
function blindedMessageOf(ctx: Ctx, proof: Proof): string {
  const key = ctx.keys[String(proof.amount)];
  if (!key) throw new Error(`no public key for amount ${proof.amount}`);
  const recon = reconstruct(proof, proof.id, key);
  if (!recon.valid || !recon.bPrimeHex) throw new Error('DLEQ reconstruction failed — the mint must return DLEQ proofs');
  return recon.bPrimeHex;
}

async function fetchReceipt(ctx: Ctx, bm: string): Promise<{ status: string; target_epoch?: number; signature?: string }> {
  const res = await fetch(`${ctx.mintUrl}/v1/solvent/pol-receipt/${bm}`);
  if (!res.ok) throw new Error(`receipt endpoint HTTP ${res.status}`);
  return (await res.json()) as { status: string; target_epoch?: number; signature?: string };
}

function receiptVerifies(ctx: Ctx, bm: string, amount: number, targetEpoch: number, signature: string): boolean {
  const pub = ctx.keys[String(amount)];
  if (!pub) return false;
  try {
    return schnorrVerifyDigest(signature, sha256(new TextEncoder().encode(issuedReceiptMessage(bm, targetEpoch))), pub, false);
  } catch {
    return false;
  }
}

function verifierInput(ctx: Ctx, proof: Proof, bm: string): VerifyInput {
  const ev = issuanceEvidence(ctx.db, bm);
  if (ev.state !== 'EPOCH_CLOSED') throw new Error(`epoch ${ev.receipt.target_epoch} is still open`);
  return {
    proof,
    mint: ctx.mintUrl,
    keysetId: ctx.keysetId,
    amountPublicKeyHex: ctx.keys[String(proof.amount)]!,
    receipt: ev.receipt,
    manifest: ev.manifest,
    manifestSignature: ev.manifestSignature,
    masterPublicKeyHex: ev.masterPublicKeyHex,
    issuedMmrSize: ev.issuedMmrSize,
    inclusionProof: ev.inclusionProof,
    // Authority chain (required for a URL mint): live NUT-06 identity, the
    // real delegation, and the closed epoch's actual keyset count.
    mintIdentityPubkey: ctx.mintIdentityPubkey,
    delegation: ctx.delegation,
    epochKeysetCount: loadClosedEpoch(ctx.db, ev.receipt.target_epoch)!.keysets.length,
    // reserve and nostr deliberately omitted — Phase 3B.
  };
}

async function honestCase(ctx: Ctx): Promise<ClosedEpoch> {
  console.log('\n— HONEST CASE —');
  const epochN = openEpoch(ctx.db).epochIndex;
  check('An OPEN epoch exists before issuance', epochN >= 1, `epoch ${epochN}`);

  const minted = await payAndMint(ctx, 1000);
  check('Real NUT-04 issuance', minted.proofs.length > 0, `${minted.proofs.length} proofs, settlement: ${minted.settlement}`);

  const receipts = [];
  for (const p of minted.proofs) {
    const bm = blindedMessageOf(ctx, p);
    const r = await fetchReceipt(ctx, bm);
    receipts.push({ amount: Number(p.amount), blinded_message: bm, ...r });
  }
  check('Every output has a signed receipt from the real endpoint', receipts.every((r) => r.status === 'signed' && !!r.signature));
  check(`Every receipt promises the open epoch ${epochN} (not 0)`, receipts.every((r) => r.target_epoch === epochN), receipts.map((r) => r.target_epoch).join(','));
  check(
    'Every receipt signature verifies against the mint\'s per-amount key',
    receipts.every((r) => receiptVerifies(ctx, r.blinded_message, r.amount, r.target_epoch!, r.signature!)),
  );

  // A real NUT-03 swap inside the same epoch: replacement outputs are new
  // issued liabilities, the inputs become consumed liabilities.
  const swapInputs = minted.proofs.slice(0, 2);
  const keep = minted.proofs.slice(2);
  // Measured as a delta: on a mint with history (e.g. after the Phase 2 CI
  // suite) the open epoch may already hold other consumed rows.
  const consumedIn = () =>
    ctx.db.prepare(`SELECT count(*) AS n, COALESCE(SUM(amount),0) AS s FROM solvent_consumed_liability WHERE target_epoch = ?`).get(epochN) as { n: number; s: number };
  const consumedBefore = consumedIn();
  const receiver = new Wallet(ctx.mintUrl);
  await receiver.loadMint();
  const preview = await receiver.ops.receive(getEncodedToken({ mint: ctx.mintUrl, proofs: swapInputs })).prepare();
  const swapped = await receiver.completeSwap(preview);
  const swappedOutputs = (swapped as { keep?: Proof[] }).keep ?? (swapped as unknown as Proof[]);
  const swapReceipts = [];
  for (const p of swappedOutputs) {
    const bm = blindedMessageOf(ctx, p);
    swapReceipts.push({ amount: Number(p.amount), blinded_message: bm, ...(await fetchReceipt(ctx, bm)) });
  }
  check(`NUT-03 replacement outputs promise epoch ${epochN}`, swapReceipts.length > 0 && swapReceipts.every((r) => r.status === 'signed' && r.target_epoch === epochN));
  const consumedAfter = consumedIn();
  const consumed = { rows: consumedAfter.n - consumedBefore.n, sats: consumedAfter.s - consumedBefore.s };
  const swapInSum = swapInputs.reduce((s, p) => s + Number(p.amount), 0);
  check(`NUT-03 consumed inputs recorded in epoch ${epochN}`, consumed.rows === swapInputs.length && consumed.sats === swapInSum, `${consumed.rows} rows, ${consumed.sats} sat`);

  const closed = closeEpoch(ctx.db, { manifestPrivateKeyHex: ctx.key });
  const m = closed.keysets.find((k) => k.manifest.keyset_id === ctx.keysetId)!.manifest;
  check(`Epoch ${epochN} closed, epoch ${closed.nextOpenEpoch} opened`, closed.epochIndex === epochN && openEpoch(ctx.db).epochIndex === epochN + 1);
  const audit = auditClosedEpoch(ctx.db, epochN);
  check('Closed epoch re-derives from the real liability rows and signatures verify', audit.ok, audit.failures.join('; '));
  check('Outstanding = issued - spent', m.outstanding_balance === m.issued_mmr_root_sum - m.spent_mmr_root_sum, `${m.issued_mmr_root_sum} - ${m.spent_mmr_root_sum} = ${m.outstanding_balance} sat`);

  // The hero invariant, honest direction: pick a proof the holder still owns.
  const held = keep[0]!;
  const heldBm = blindedMessageOf(ctx, held);
  const input = verifierInput(ctx, held, heldBm);
  check('Inclusion proof exists for the promised issuance', input.inclusionProof !== null);
  check(
    'Inclusion proof verifies against the signed issued root',
    !!input.inclusionProof &&
      verifyInclusionProof(issuedLeaf(heldBm, Number(held.amount)), input.inclusionProof, input.issuedMmrSize, hexToBytes(input.manifest.issued_mmr_root_hash), BigInt(input.manifest.issued_mmr_root_sum)),
  );
  const result = verify(input);
  const polPassed =
    result.checks.receiptValid && result.checks.targetEpochClosed && result.checks.manifestValid && result.checks.delegationValid === true &&
    result.checks.liabilityArithmeticValid && result.checks.inclusionValid;
  check('Central verifier: every PoL and authority check passes (incl. delegation)', polPassed);
  check('Central verifier fails closed without Phase 3B evidence (REFUSE_UNVERIFIABLE)', result.reasonCode === 'REFUSE_UNVERIFIABLE', result.reasonCode);

  const next = await payAndMint(ctx, 8);
  const nextR = await fetchReceipt(ctx, blindedMessageOf(ctx, next.proofs[0]!));
  check(`An issuance after the close promises epoch ${epochN + 1}`, nextR.target_epoch === epochN + 1, String(nextR.target_epoch));

  writeEvidence(ctx, 'phase3-honest-issuance.json', { mint: ctx.mintUrl, keysetId: ctx.keysetId, quote: minted.quote, settlement: minted.settlement, openEpochBeforeIssuance: epochN, outputs: receipts.map(({ amount, blinded_message }) => ({ amount, blinded_message })) });
  writeEvidence(ctx, 'phase3-receipt.json', { endpoint: `${ctx.mintUrl}/v1/solvent/pol-receipt/{blinded_message}`, receipts, swapReceipts });
  writeEvidence(ctx, 'phase3-swap.json', { inputs: swapInputs.map((p) => ({ amount: Number(p.amount) })), consumedRowsInEpoch: consumed, replacementOutputs: swapReceipts.map(({ amount, blinded_message, target_epoch }) => ({ amount, blinded_message, target_epoch })) });
  writeEvidence(ctx, 'phase3-epoch.json', { closed, audit });
  writeEvidence(ctx, 'phase3-mmr.json', { keysetId: ctx.keysetId, epoch: epochN, heldIssuance: { blindedMessage: heldBm, amount: Number(held.amount) }, issuedMmrSize: input.issuedMmrSize, inclusionProof: input.inclusionProof, manifest: input.manifest });
  writeEvidence(ctx, 'phase3-honest-verify-input.json', bundleToJson(input));
  writeEvidence(ctx, 'phase3-honest-verify.json', result);
  return closed;
}

async function brokenPromiseCase(ctx: Ctx): Promise<void> {
  console.log('\n— BROKEN PROMISE (explicit operator omission mode) —');
  const epochN = openEpoch(ctx.db).epochIndex;
  const minted = await payAndMint(ctx, 96);
  const victim = minted.proofs[0]!;
  const victimBm = blindedMessageOf(ctx, victim);
  const receipt = await fetchReceipt(ctx, victimBm);
  check(`Real issuance; receipt promises epoch ${epochN}`, receipt.status === 'signed' && receipt.target_epoch === epochN);
  check('Receipt signature verifies', receiptVerifies(ctx, victimBm, Number(victim.amount), receipt.target_epoch!, receipt.signature!));

  const closed = closeEpoch(ctx.db, { manifestPrivateKeyHex: ctx.key, omitPromisedIssuance: victimBm });
  const m = closed.keysets.find((k) => k.manifest.keyset_id === ctx.keysetId)!;
  check('Omission mode left out exactly the promised issuance', closed.omitted?.blindedMessageHex === victimBm);
  const audit = auditClosedEpoch(ctx.db, epochN);
  check('The adversarial epoch is internally consistent and validly signed', audit.ok, audit.failures.join('; '));
  const receiptAfter = await fetchReceipt(ctx, victimBm);
  check('The holder\'s receipt is unchanged by the omission', receiptAfter.signature === receipt.signature && receiptAfter.target_epoch === receipt.target_epoch);

  const input = verifierInput(ctx, victim, victimBm);
  check('No inclusion proof can be produced for the promised issuance', input.inclusionProof === null);
  const result = verify(input);
  check(
    'Receipt, epoch closure, manifest, delegation and arithmetic all verify',
    result.checks.receiptValid && result.checks.targetEpochClosed && result.checks.manifestValid && result.checks.delegationValid === true && result.checks.liabilityArithmeticValid,
  );
  check('Central verifier: REFUSE_ISSUANCE_OMITTED', result.reasonCode === 'REFUSE_ISSUANCE_OMITTED', result.reasonCode);

  const sibling = minted.proofs[1];
  let siblingResult: VerifyResult | null = null;
  if (sibling) {
    siblingResult = verify(verifierInput(ctx, sibling, blindedMessageOf(ctx, sibling)));
    check('A sibling output of the same request is still included', siblingResult.checks.inclusionValid && siblingResult.reasonCode === 'REFUSE_UNVERIFIABLE', siblingResult.reasonCode);
  }

  writeEvidence(ctx, 'phase3-omission-issuance.json', { quote: minted.quote, settlement: minted.settlement, victim: { blindedMessage: victimBm, amount: Number(victim.amount) }, receipt, receiptAfterClose: receiptAfter });
  writeEvidence(ctx, 'phase3-omission-epoch.json', { closed, audit, manifest: m });
  writeEvidence(ctx, 'phase3-omission-verify-input.json', bundleToJson(input));
  writeEvidence(ctx, 'phase3-omission-refuse.json', { victim: result, sibling: siblingResult });
}

interface AuditReport {
  openEpoch: number;
  closedEpochs: number[];
  audits: { epochIndex: number; ok: boolean; failures: string[] }[];
  /** previous_global_digest of each closed epoch against the global digest of the one before it. */
  digestChain: { epochIndex: number; previousGlobalDigest: string; globalDigest: string; chainsToPrevious: boolean }[];
  ok: boolean;
}

function auditAll(db: DatabaseSync): AuditReport {
  const closedEpochs = (db.prepare(`SELECT epoch_index FROM solvent_pol_epoch WHERE state = 'CLOSED' ORDER BY epoch_index`).all() as { epoch_index: number }[]).map((r) => r.epoch_index);
  const open = openEpoch(db).epochIndex;
  let ok = check('Exactly one OPEN epoch, directly after the last closed one', open === (closedEpochs.at(-1) ?? 0) + 1, `open ${open}, closed [${closedEpochs.join(',')}]`);
  const audits = [];
  const digestChain = [];
  let prevGlobal = ZERO_DIGEST_HEX;
  for (const e of closedEpochs) {
    const a = auditClosedEpoch(db, e);
    audits.push(a);
    ok = check(`Epoch ${e} re-derives, signatures verify, digest chain holds`, a.ok, a.failures.join('; ')) && ok;
    const closed = loadClosedEpoch(db, e)!;
    digestChain.push({ epochIndex: e, previousGlobalDigest: closed.previousGlobalDigest, globalDigest: closed.globalDigest, chainsToPrevious: closed.previousGlobalDigest === prevGlobal });
    prevGlobal = closed.globalDigest;
  }
  ok = check('previous_global_digest chains through every closed epoch', digestChain.every((d) => d.chainsToPrevious), `${digestChain.length} epochs`) && ok;
  return { openEpoch: open, closedEpochs, audits, digestChain, ok: ok && closedEpochs.length > 0 };
}

/** Epoch state only — no timestamps — so two snapshots compare byte for byte. */
function snapshot(db: DatabaseSync) {
  return {
    epochs: db.prepare(`SELECT epoch_index, state, global_digest FROM solvent_pol_epoch ORDER BY epoch_index`).all(),
    keysetManifests: (db.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_keyset`).get() as { n: number }).n,
    omissions: (db.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_omission`).get() as { n: number }).n,
  };
}

async function main() {
  const dbPath = process.argv[2];
  const auditOnly = process.argv.includes('--audit-only');
  const snapshotOnly = process.argv.includes('--snapshot');
  const outIdx = process.argv.indexOf('--evidence-out');
  const evidenceOut = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const mintUrl = process.env.CDK_MINT_URL;
  const key = process.env.SOLVENT_MANIFEST_PRIVKEY;
  if (!dbPath || dbPath.startsWith('--')) throw new Error('usage: pol-epoch-e2e.ts <path-to-cdk-mintd.sqlite> [--audit-only | --snapshot] [--evidence-out <file>]');

  console.log('SOLVENT — PHASE 3A REAL EPOCH LIFECYCLE\n');
  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  try {
    if (snapshotOnly) {
      const snap = snapshot(db);
      if (evidenceOut) writeFileSync(evidenceOut, toJson(snap));
      console.log(JSON.stringify(snap));
      return;
    } else if (auditOnly) {
      const report = auditAll(db);
      if (evidenceOut) writeFileSync(evidenceOut, toJson({ ...report, generatedAt: new Date().toISOString() }));
    } else {
      if (!mintUrl || !key) throw new Error('CDK_MINT_URL and SOLVENT_MANIFEST_PRIVKEY are required');
      const wallet = new Wallet(mintUrl);
      await wallet.loadMint();
      const keysets = await new Mint(mintUrl).getKeys();
      const active = keysets.keysets.find((k) => k.unit === 'sat') ?? keysets.keysets[0]!;
      const runId = process.env.SOLVENT_RUN_ID ?? `local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const evidenceDir = path.join('evidence', 'real-pol', runId);
      mkdirSync(evidenceDir, { recursive: true });
      const lnd =
        process.env.LND_SOURCE_REST_URL && process.env.LND_SOURCE_MACAROON_HEX
          ? new LndClient({ restUrl: process.env.LND_SOURCE_REST_URL, macaroonHex: process.env.LND_SOURCE_MACAROON_HEX })
          : null;
      const delegationFile = process.env.SOLVENT_MANIFEST_DELEGATION;
      if (!delegationFile) throw new Error('SOLVENT_MANIFEST_DELEGATION is required (output of `cdk-mintd solvent delegate-manifest-key` for this manifest key)');
      const delegation = JSON.parse(readFileSync(delegationFile, 'utf8')) as ManifestKeyDelegation;
      const identity = await fetchMintIdentity(mintUrl);
      if (!identity.ok) throw new Error(`could not observe the mint's NUT-06 identity: ${identity.detail}`);
      check("Delegation signer is the mint's live NUT-06 identity", delegation.mint_identity_pubkey === identity.pubkey, identity.pubkey);
      const ctx: Ctx = { mintUrl, db, key, wallet, keys: active.keys, keysetId: active.id, lnd, evidenceDir, mintIdentityPubkey: identity.pubkey, delegation };
      await honestCase(ctx);
      await brokenPromiseCase(ctx);
      console.log('\n— ALL CLOSED EPOCHS —');
      auditAll(db);
      writeEvidence(ctx, 'phase3-summary.json', {
        runId,
        mint: mintUrl,
        lightning: lnd ? 'lnd' : 'fakewallet (self-settled invoices)',
        failures,
        phase3bNotYetSupplied: ['nostr publication', 'live reserve'],
        generatedAt: new Date().toISOString(),
      });
      console.log(`\nEvidence written to ${evidenceDir}`);
    }
  } finally {
    db.close();
  }
  console.log('');
  if (failures === 0) {
    console.log(auditOnly ? 'PHASE 3A EPOCH STATE VERIFIED' : 'PHASE 3A REAL EPOCH LIFECYCLE VERIFIED');
  } else {
    console.log(`PHASE 3A NOT VERIFIED — ${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-epoch-e2e crashed:', err);
  process.exitCode = 1;
});
