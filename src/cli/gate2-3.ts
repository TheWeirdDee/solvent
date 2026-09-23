// CLI: Gate 2 (issued/spent sum-MMR + signed epoch) and Gate 3 (the hero
// contradiction) together — they share one fixture mint, one keyset, and
// one closed epoch, which is the honest way to build them: the "hero fraud
// case" is not a different mechanism from the "honest case," it is the
// SAME epoch-closing machinery applied to a mint that chose to omit one
// promised issuance. Writes evidence/gate-2/ and evidence/hero/.
//
// Run with: npx tsx src/cli/gate2-3.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateFixtureKeyset, issue } from '../cashu/keys.js';
import { reconstruct, spentY } from '../cashu/reconstruct.js';
import { buildFraudEvidence } from '../pol/fraud.js';
import {
  bytesToHex as manifestBytesToHex,
  globalDigest,
  keysetMerkleRoot,
  manifestMessage,
  signManifest,
  sortKeysets,
  verifyManifest,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf, verifyInclusionProof } from '../pol/mmr.js';
import { issuedReceiptMessage, signIssuedReceipt, verifyIssuedReceipt } from '../pol/receipt.js';

const GATE2_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'gate-2');
const HERO_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'hero');

const MINT_IDENTITY = 'solvent-fixture-mint';
const TARGET_EPOCH = 12;
const AMOUNT_HONEST = 30_000;
const AMOUNT_OMITTED = 70_000;
const AMOUNT_SPENT = 5_000;

function main() {
  mkdirSync(GATE2_DIR, { recursive: true });
  mkdirSync(HERO_DIR, { recursive: true });

  // ---- One coherent mint identity: master key (signs manifests) + per-amount keyset (signs blind sigs + receipts) ----
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const keyset = generateFixtureKeyset([AMOUNT_HONEST, AMOUNT_OMITTED, AMOUNT_SPENT]);

  // ---- Real issuance: the honest item (will be included) and the promised-but-omitted item ----
  const honestSecret = `hero-honest-${Date.now()}`;
  const omittedSecret = `hero-omitted-${Date.now()}`;
  const honestIssued = issue(keyset, AMOUNT_HONEST, honestSecret);
  const omittedIssued = issue(keyset, AMOUNT_OMITTED, omittedSecret);

  // Holder independently reconstructs BOTH — Gate 0's mechanism. The mint
  // never supplies an opaque ID; every leaf below is keyed on this.
  const honestRecon = reconstruct(honestIssued.proof, keyset.keysetId, keyset.amounts[AMOUNT_HONEST]!.publicKeyHex);
  const omittedRecon = reconstruct(omittedIssued.proof, keyset.keysetId, keyset.amounts[AMOUNT_OMITTED]!.publicKeyHex);
  if (!honestRecon.valid || !honestRecon.bPrimeHex || !omittedRecon.valid || !omittedRecon.bPrimeHex) {
    throw new Error('gate2-3: reconstruction failed — cannot proceed');
  }
  const honestBPrime = honestRecon.bPrimeHex;
  const omittedBPrime = omittedRecon.bPrimeHex;

  // ---- Mint signs a PoL receipt for BOTH issuances, promising epoch 12 (PR #388 requires this for every mint/melt/swap output) ----
  const honestReceipt = signIssuedReceipt(honestBPrime, TARGET_EPOCH, keyset.amounts[AMOUNT_HONEST]!.privateKeyHex);
  const omittedReceipt = signIssuedReceipt(omittedBPrime, TARGET_EPOCH, keyset.amounts[AMOUNT_OMITTED]!.privateKeyHex);

  // ---- One real spent record (some unrelated earlier redemption), for the spent MMR ----
  const spentSecret = 'hero-spent-secret';
  const spentAmount = AMOUNT_SPENT;

  // ---- The mint DISHONESTLY closes epoch 12: it includes the honest item
  // in the issued MMR, but leaves the promised omitted item out entirely.
  // Its reported liabilities/outstanding-balance are still internally
  // consistent (they only ever summed what it chose to include) — that is
  // exactly why an aggregate ratio alone cannot catch this.
  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(honestBPrime, AMOUNT_HONEST));
  // omittedBPrime is deliberately NOT appended.

  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY(spentSecret), spentAmount));

  const issuedRoot = root(issuedMmr);
  const spentRoot = root(spentMmr);
  const outstandingBalance = Number(issuedRoot.sum - spentRoot.sum);

  const keysetEntry: KeysetManifestEntry = {
    keyset_id: keyset.keysetId,
    unit: 'sat',
    issued_mmr_size: issuedMmr.leaves.length,
    issued_mmr_root_hash: bytesToHex(issuedRoot.hash),
    issued_mmr_root_sum: Number(issuedRoot.sum),
    spent_mmr_size: spentMmr.leaves.length,
    spent_mmr_root_hash: bytesToHex(spentRoot.hash),
    spent_mmr_root_sum: Number(spentRoot.sum),
    active: true,
    deactivation_epoch: 999,
  };

  const kRoot = keysetMerkleRoot(sortKeysets([keysetEntry]));
  const gDigest = globalDigest(ZERO_DIGEST_HEX, TARGET_EPOCH, 1, kRoot);

  const manifest: ManifestFields = {
    keyset_id: keysetEntry.keyset_id,
    unit: keysetEntry.unit,
    epoch_index: TARGET_EPOCH,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    previous_global_digest: ZERO_DIGEST_HEX,
    issued_mmr_size: keysetEntry.issued_mmr_size,
    issued_mmr_root_hash: keysetEntry.issued_mmr_root_hash,
    issued_mmr_root_sum: keysetEntry.issued_mmr_root_sum,
    spent_mmr_size: keysetEntry.spent_mmr_size,
    spent_mmr_root_hash: keysetEntry.spent_mmr_root_hash,
    spent_mmr_root_sum: keysetEntry.spent_mmr_root_sum,
    outstanding_balance: outstandingBalance,
    active: keysetEntry.active,
    deactivation_epoch: keysetEntry.deactivation_epoch,
  };
  const mintSignature = signManifest(manifest, masterPrivHex);

  // ============ GATE 2 checks ============
  const manifestValid = verifyManifest(manifest, mintSignature, masterPubHex);
  const arithmeticValid = manifest.outstanding_balance === Number(issuedRoot.sum) - Number(spentRoot.sum);

  const honestInclusionProof = getInclusionProof(issuedMmr, 0);
  const honestInclusionValid = verifyInclusionProof(
    issuedLeaf(honestBPrime, AMOUNT_HONEST),
    honestInclusionProof,
    issuedMmr.leaves.length,
    issuedRoot.hash,
    issuedRoot.sum,
  );

  const gate2Pass = manifestValid && arithmeticValid && honestInclusionValid;

  console.log('SOLVENT Gate 2 — issued/spent sum-MMR + signed epoch');
  console.log(`  keyset                 = ${keyset.keysetId}`);
  console.log(`  epoch                  = ${TARGET_EPOCH}`);
  console.log(`  issued_mmr_root_sum    = ${keysetEntry.issued_mmr_root_sum}`);
  console.log(`  spent_mmr_root_sum     = ${keysetEntry.spent_mmr_root_sum}`);
  console.log(`  outstanding_balance    = ${outstandingBalance}`);
  console.log(`  manifest signature valid = ${manifestValid}`);
  console.log(`  liability arithmetic     = ${arithmeticValid}`);
  console.log(`  honest-item inclusion    = ${honestInclusionValid}`);
  console.log(`GATE 2: ${gate2Pass ? 'PASS' : 'BLOCKED'}`);
  console.log('');

  writeFileSync(
    path.join(GATE2_DIR, 'epoch.json'),
    JSON.stringify(
      {
        mint: MINT_IDENTITY,
        master_public_key: masterPubHex,
        keyset: keysetEntry,
        keyset_merkle_root: manifestBytesToHex(kRoot),
        global_digest: manifestBytesToHex(gDigest),
        manifest,
        mint_signature: mintSignature,
        checks: { manifest_signature_valid: manifestValid, liability_arithmetic_valid: arithmeticValid, honest_item_inclusion_valid: honestInclusionValid },
        pass: gate2Pass,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    path.join(GATE2_DIR, 'honest-inclusion-proof.json'),
    JSON.stringify(serializeProof(honestInclusionProof), null, 2) + '\n',
    'utf8',
  );

  // ============ GATE 3 — the hero contradiction ============
  // Holder of the OMITTED item runs the exact same checks the honest
  // holder ran. Everything up to inclusion verifies genuinely — the
  // receipt is real, the epoch is really closed and really signed. Only
  // the inclusion check fails, because the mint truly left it out.
  const omittedReceiptVerifies = verifyIssuedReceipt(omittedReceipt, omittedBPrime, keyset.amounts[AMOUNT_OMITTED]!.publicKeyHex);
  const omittedTargetEpochClosed = manifest.epoch_index >= omittedReceipt.target_epoch; // epoch 12 is closed (this IS epoch 12's manifest)
  const omittedManifestValid = manifestValid; // same signed manifest
  // Attempt to find inclusion for the omitted item — content-based search, exactly what a real mint's
  // /v1/pol/{keyset}/proofs/issued endpoint would (honestly) fail to answer with a valid proof for.
  const omittedIncluded = issuedMmr.leaves.some((l) => bytesToHex(l.hash) === bytesToHex(issuedLeaf(omittedBPrime, AMOUNT_OMITTED).hash) && l.sum === BigInt(AMOUNT_OMITTED));

  const heroDecision = omittedReceiptVerifies && omittedTargetEpochClosed && omittedManifestValid && omittedIncluded ? 'ACCEPT' : 'REFUSE';

  const fraudEvidence = buildFraudEvidence({
    mint: MINT_IDENTITY,
    keysetId: keyset.keysetId,
    amount: AMOUNT_OMITTED,
    reconstructedBPrime: omittedBPrime,
    receipt: omittedReceipt,
    manifest,
    mintSignature,
    included: omittedIncluded,
  });

  console.log('SOLVENT Gate 3 — hero contradiction');
  console.log(`  promised issuance B'         = ${omittedBPrime}`);
  console.log(`  amount                       = ${AMOUNT_OMITTED}`);
  console.log(`  receipt promise: epoch ${omittedReceipt.target_epoch}     -> VALID = ${omittedReceiptVerifies}`);
  console.log(`  epoch ${manifest.epoch_index} signature              -> VALID = ${omittedManifestValid}`);
  console.log(`  epoch ${manifest.epoch_index} closed (>= target)     -> ${omittedTargetEpochClosed}`);
  console.log(`  promised issuance in epoch   -> ${omittedIncluded ? 'INCLUDED' : 'MISSING'}`);
  console.log(`  DECISION                     -> ${heroDecision}`);
  console.log(`  reason_code                  -> ${fraudEvidence.reason_code}`);
  console.log(
    heroDecision === 'REFUSE'
      ? `  "This mint signed a promise to account for this liability in epoch ${TARGET_EPOCH}, but its signed epoch-${TARGET_EPOCH} accounting omits it."`
      : '',
  );

  const gate3Pass = heroDecision === 'REFUSE' && fraudEvidence.reason_code === 'REFUSE_ISSUANCE_OMITTED';
  console.log(`GATE 3: ${gate3Pass ? 'PASS' : 'BLOCKED'}`);

  writeFileSync(path.join(HERO_DIR, 'fraud-evidence.json'), JSON.stringify(fraudEvidence, null, 2) + '\n', 'utf8');
  writeFileSync(
    path.join(HERO_DIR, 'honest-case.json'),
    JSON.stringify(
      buildFraudEvidence({
        mint: MINT_IDENTITY,
        keysetId: keyset.keysetId,
        amount: AMOUNT_HONEST,
        reconstructedBPrime: honestBPrime,
        receipt: honestReceipt,
        manifest,
        mintSignature,
        included: true,
      }),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    path.join(HERO_DIR, 'recompute.txt'),
    [
      'SOLVENT hero evidence — independent recomputation',
      '',
      `mint: ${MINT_IDENTITY}`,
      `keyset: ${keyset.keysetId}`,
      `epoch: ${TARGET_EPOCH}`,
      '',
      `manifest message: ${manifestMessage(manifest)}`,
      `manifest signature valid: ${manifestValid}`,
      '',
      `omitted item receipt message: ${issuedReceiptMessage(omittedBPrime, TARGET_EPOCH)}`,
      `omitted item receipt valid: ${omittedReceiptVerifies}`,
      `omitted item inclusion status: ${omittedIncluded ? 'INCLUDED' : 'MISSING'}`,
      `decision: ${heroDecision}`,
      `reason_code: ${fraudEvidence.reason_code}`,
    ].join('\n') + '\n',
    'utf8',
  );

  process.exit(gate2Pass && gate3Pass ? 0 : 1);
}

function serializeProof(p: ReturnType<typeof getInclusionProof>) {
  return {
    leafIndex: p.leafIndex,
    siblingPath: p.siblingPath.map((s) => ({ hash: manifestBytesToHex(s.hash), sum: s.sum.toString(), isLeft: s.isLeft })),
    peaks: p.peaks.map((pk) => ({ hash: manifestBytesToHex(pk.hash), sum: pk.sum.toString() })),
  };
}

main();
