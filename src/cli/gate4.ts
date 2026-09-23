// CLI: Gate 4 — real acceptance side effect. Runs ACCEPT and the four
// required REFUSE cases through runAcceptGate() with a real counting spy,
// and writes evidence/gate-4/enforcement.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRandomSecretKey, getPubKeyFromPrivKey, type Proof } from '@cashu/cashu-ts';
import { generateFixtureKeyset, issue } from '../cashu/keys.js';
import { reconstruct, spentY } from '../cashu/reconstruct.js';
import { acceptProof, createWalletStore, runAcceptGate } from '../enforcement/accept-gate.js';
import { keysetMerkleRoot, signManifest, sortKeysets, ZERO_DIGEST_HEX, type KeysetManifestEntry, type ManifestFields } from '../pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../pol/mmr.js';
import { signIssuedReceipt } from '../pol/receipt.js';
import type { VerifyInput } from '../verifier/verify.js';

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'gate-4');
const AMOUNT = 30_000;

function buildInput(opts: { includeInEpoch?: boolean; reserveSats?: number; omitReserveContext?: boolean; forceBadReceiptSig?: boolean }): VerifyInput {
  const includeInEpoch = opts.includeInEpoch ?? true;
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `gate4-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');

  let receipt = signIssuedReceipt(recon.bPrimeHex, 12, keyset.amounts[AMOUNT]!.privateKeyHex);
  if (opts.forceBadReceiptSig) receipt = { ...receipt, signature: '00'.repeat(64) };

  let issuedMmr = emptyMmr();
  if (includeInEpoch) issuedMmr = append(issuedMmr, issuedLeaf(recon.bPrimeHex, AMOUNT));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('gate4-spent'), 5_000));
  const issuedRoot = root(issuedMmr);
  const spentRoot = root(spentMmr);

  const entry: KeysetManifestEntry = {
    keyset_id: keyset.keysetId, unit: 'sat',
    issued_mmr_size: issuedMmr.leaves.length, issued_mmr_root_hash: bytesToHex(issuedRoot.hash), issued_mmr_root_sum: Number(issuedRoot.sum),
    spent_mmr_size: spentMmr.leaves.length, spent_mmr_root_hash: bytesToHex(spentRoot.hash), spent_mmr_root_sum: Number(spentRoot.sum),
    active: true, deactivation_epoch: 999,
  };
  void keysetMerkleRoot(sortKeysets([entry]));
  const manifest: ManifestFields = {
    keyset_id: entry.keyset_id, unit: entry.unit, epoch_index: 12, timestamp: '2026-09-21T00:00:00Z', previous_global_digest: ZERO_DIGEST_HEX,
    issued_mmr_size: entry.issued_mmr_size, issued_mmr_root_hash: entry.issued_mmr_root_hash, issued_mmr_root_sum: entry.issued_mmr_root_sum,
    spent_mmr_size: entry.spent_mmr_size, spent_mmr_root_hash: entry.spent_mmr_root_hash, spent_mmr_root_sum: entry.spent_mmr_root_sum,
    outstanding_balance: Number(issuedRoot.sum - spentRoot.sum), active: entry.active, deactivation_epoch: entry.deactivation_epoch,
  };
  const manifestSignature = signManifest(manifest, masterPrivHex);

  return {
    proof, mint: 'solvent-fixture-mint', keysetId: keyset.keysetId, amountPublicKeyHex: keyset.amounts[AMOUNT]!.publicKeyHex,
    receipt, manifest, manifestSignature, masterPublicKeyHex: masterPubHex, issuedMmrSize: issuedMmr.leaves.length,
    inclusionProof: includeInEpoch ? getInclusionProof(issuedMmr, 0) : null,
    ...(opts.omitReserveContext ? {} : { reserve: { verified: true, reserveSats: opts.reserveSats ?? 200_000 }, nostr: { verified: true } }),
  };
}

function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const cases: { label: string; expectedReasonCode: string; input: VerifyInput }[] = [
    { label: 'ACCEPT_VERIFIED', expectedReasonCode: 'ACCEPT_VERIFIED', input: buildInput({}) },
    { label: 'REFUSE_ISSUANCE_OMITTED', expectedReasonCode: 'REFUSE_ISSUANCE_OMITTED', input: buildInput({ includeInEpoch: false }) },
    { label: 'REFUSE_RESERVE_SHORT', expectedReasonCode: 'REFUSE_RESERVE_SHORT', input: buildInput({ reserveSats: 1_000 }) },
    { label: 'REFUSE_RECEIPT_INVALID', expectedReasonCode: 'REFUSE_RECEIPT_INVALID', input: buildInput({ forceBadReceiptSig: true }) },
    { label: 'REFUSE_UNVERIFIABLE', expectedReasonCode: 'REFUSE_UNVERIFIABLE', input: buildInput({ omitReserveContext: true }) },
  ];

  console.log('SOLVENT Gate 4 — real acceptance side effect\n');
  console.log('"Acceptance" in this build = real @cashu/cashu-ts getEncodedToken() serialization');
  console.log('committed to a local accepted-proof store (see src/enforcement/accept-gate.ts header).\n');

  const results = cases.map((c) => {
    let callCount = 0;
    const store = createWalletStore();
    const spy = (store_: typeof store, mint: string, proof: Proof) => {
      callCount++;
      return acceptProof(store_, mint, proof);
    };
    const { result, accepted } = runAcceptGate(c.input, store, spy);
    const expectedAccept = c.expectedReasonCode === 'ACCEPT_VERIFIED';
    const pass = result.reasonCode === c.expectedReasonCode && accepted === expectedAccept && callCount === (expectedAccept ? 1 : 0);
    console.log(
      `${c.label.padEnd(26)} decision=${result.decision.padEnd(7)} reasonCode=${result.reasonCode.padEnd(26)} acceptFnCalls=${callCount}  ${pass ? 'PASS' : 'FAIL'}`,
    );
    return {
      label: c.label,
      expected_reason_code: c.expectedReasonCode,
      actual_reason_code: result.reasonCode,
      decision: result.decision,
      accept_function_call_count: callCount,
      accepted_store_length: store.accepted.length,
      pass,
    };
  });

  const allPass = results.every((r) => r.pass);
  console.log(`\nGATE 4: ${allPass ? 'PASS' : 'BLOCKED'}`);

  writeFileSync(
    path.join(EVIDENCE_DIR, 'enforcement.json'),
    JSON.stringify(
      {
        acceptance_definition:
          'A verified proof is serialized via the real @cashu/cashu-ts getEncodedToken() and committed to a local accepted-proof store. Not a live mint-swap network call — see docs/trust-boundaries.md.',
        cases: results,
        pass: allPass,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  process.exit(allPass ? 0 : 1);
}

main();
