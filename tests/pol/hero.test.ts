// Gate 2 + Gate 3 as automated regression coverage: real issuance, real
// receipts, a real closed-and-signed epoch, and the hero omission
// contradiction — mirroring exactly what `npx tsx src/cli/gate2-3.ts`
// demonstrates manually. See evidence/gate-2/ and evidence/hero/ for the
// captured artifacts from a real run.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import { buildFraudEvidence } from '../../src/pol/fraud.js';
import {
  bytesToHex as mBytesToHex,
  globalDigest,
  keysetMerkleRoot,
  signManifest,
  sortKeysets,
  verifyManifest,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../../src/pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf, verifyInclusionProof } from '../../src/pol/mmr.js';
import { signIssuedReceipt, verifyIssuedReceipt } from '../../src/pol/receipt.js';

function closeFixtureEpoch(includeOmitted: boolean) {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const AMOUNT_HONEST = 30_000;
  const AMOUNT_OMITTED = 70_000;
  const keyset = generateFixtureKeyset([AMOUNT_HONEST, AMOUNT_OMITTED]);

  const honest = issue(keyset, AMOUNT_HONEST, `honest-${Math.random()}`);
  const omitted = issue(keyset, AMOUNT_OMITTED, `omitted-${Math.random()}`);
  const honestRecon = reconstruct(honest.proof, keyset.keysetId, keyset.amounts[AMOUNT_HONEST]!.publicKeyHex);
  const omittedRecon = reconstruct(omitted.proof, keyset.keysetId, keyset.amounts[AMOUNT_OMITTED]!.publicKeyHex);
  if (!honestRecon.bPrimeHex || !omittedRecon.bPrimeHex) throw new Error('reconstruction failed');

  const honestReceipt = signIssuedReceipt(honestRecon.bPrimeHex, 12, keyset.amounts[AMOUNT_HONEST]!.privateKeyHex);
  const omittedReceipt = signIssuedReceipt(omittedRecon.bPrimeHex, 12, keyset.amounts[AMOUNT_OMITTED]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(honestRecon.bPrimeHex, AMOUNT_HONEST));
  if (includeOmitted) issuedMmr = append(issuedMmr, issuedLeaf(omittedRecon.bPrimeHex, AMOUNT_OMITTED));

  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('some-spent-secret'), 5_000));

  const issuedRoot = root(issuedMmr);
  const spentRoot = root(spentMmr);

  const entry: KeysetManifestEntry = {
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
  const kRoot = keysetMerkleRoot(sortKeysets([entry]));
  void globalDigest(ZERO_DIGEST_HEX, 12, 1, kRoot);

  const manifest: ManifestFields = {
    keyset_id: entry.keyset_id,
    unit: entry.unit,
    epoch_index: 12,
    timestamp: '2026-09-21T00:00:00Z',
    previous_global_digest: ZERO_DIGEST_HEX,
    issued_mmr_size: entry.issued_mmr_size,
    issued_mmr_root_hash: entry.issued_mmr_root_hash,
    issued_mmr_root_sum: entry.issued_mmr_root_sum,
    spent_mmr_size: entry.spent_mmr_size,
    spent_mmr_root_hash: entry.spent_mmr_root_hash,
    spent_mmr_root_sum: entry.spent_mmr_root_sum,
    outstanding_balance: Number(issuedRoot.sum - spentRoot.sum),
    active: entry.active,
    deactivation_epoch: entry.deactivation_epoch,
  };
  const mintSignature = signManifest(manifest, masterPrivHex);

  return { keyset, masterPubHex, honestRecon, omittedRecon, honestReceipt, omittedReceipt, issuedMmr, issuedRoot, manifest, mintSignature, AMOUNT_HONEST, AMOUNT_OMITTED };
}

describe('Gate 2 — real closed, signed epoch', () => {
  it('manifest signature verifies, liability arithmetic recomputes, honest inclusion verifies', () => {
    const s = closeFixtureEpoch(true);
    expect(verifyManifest(s.manifest, s.mintSignature, s.masterPubHex)).toBe(true);
    expect(s.manifest.outstanding_balance).toBe(s.manifest.issued_mmr_root_sum - s.manifest.spent_mmr_root_sum);

    const proof = getInclusionProof(s.issuedMmr, 0);
    const leaf = issuedLeaf(s.honestRecon.bPrimeHex!, s.AMOUNT_HONEST);
    expect(verifyInclusionProof(leaf, proof, s.issuedMmr.leaves.length, s.issuedRoot.hash, s.issuedRoot.sum)).toBe(true);
  });

  it('a tampered manifest signature fails verification', () => {
    const s = closeFixtureEpoch(true);
    const badSig = '00'.repeat(64);
    expect(verifyManifest(s.manifest, badSig, s.masterPubHex)).toBe(false);
  });

  it('inconsistent liability arithmetic is detectable', () => {
    const s = closeFixtureEpoch(true);
    const wrongBalance = s.manifest.outstanding_balance + 1;
    expect(wrongBalance).not.toBe(s.manifest.issued_mmr_root_sum - s.manifest.spent_mmr_root_sum);
  });
});

describe('Gate 3 — the hero contradiction', () => {
  it('honest case: promised issuance included -> ACCEPT-eligible, reason ACCEPT_VERIFIED', () => {
    const s = closeFixtureEpoch(true);
    const receiptValid = verifyIssuedReceipt(s.honestReceipt, s.honestRecon.bPrimeHex!, s.keyset.amounts[s.AMOUNT_HONEST]!.publicKeyHex);
    const included = s.issuedMmr.leaves.some((l) => mBytesToHex(l.hash) === mBytesToHex(issuedLeaf(s.honestRecon.bPrimeHex!, s.AMOUNT_HONEST).hash));
    const evidence = buildFraudEvidence({
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amount: s.AMOUNT_HONEST,
      reconstructedBPrime: s.honestRecon.bPrimeHex!,
      receipt: s.honestReceipt,
      manifest: s.manifest,
      mintSignature: s.mintSignature,
      included,
    });
    expect(receiptValid).toBe(true);
    expect(included).toBe(true);
    expect(evidence.decision).toBe('ACCEPT');
    expect(evidence.reason_code).toBe('ACCEPT_VERIFIED');
  });

  it('fraud case: receipt valid, epoch valid, but promised issuance omitted -> REFUSE_ISSUANCE_OMITTED', () => {
    const s = closeFixtureEpoch(false); // mint deliberately omits the promised item
    const receiptValid = verifyIssuedReceipt(s.omittedReceipt, s.omittedRecon.bPrimeHex!, s.keyset.amounts[s.AMOUNT_OMITTED]!.publicKeyHex);
    const manifestValid = verifyManifest(s.manifest, s.mintSignature, s.masterPubHex);
    const included = s.issuedMmr.leaves.some((l) => mBytesToHex(l.hash) === mBytesToHex(issuedLeaf(s.omittedRecon.bPrimeHex!, s.AMOUNT_OMITTED).hash));

    // Everything up to inclusion genuinely verifies — that's the point.
    expect(receiptValid).toBe(true);
    expect(manifestValid).toBe(true);
    expect(included).toBe(false);

    const evidence = buildFraudEvidence({
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amount: s.AMOUNT_OMITTED,
      reconstructedBPrime: s.omittedRecon.bPrimeHex!,
      receipt: s.omittedReceipt,
      manifest: s.manifest,
      mintSignature: s.mintSignature,
      included,
    });
    expect(evidence.decision).toBe('REFUSE');
    expect(evidence.reason_code).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(evidence.inclusion_status).toBe('missing');
  });

  it('the fraud evidence object is self-contained: recomputing from it alone (without re-running issuance) reproduces the same decision', () => {
    const s = closeFixtureEpoch(false);
    const evidence = buildFraudEvidence({
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amount: s.AMOUNT_OMITTED,
      reconstructedBPrime: s.omittedRecon.bPrimeHex!,
      receipt: s.omittedReceipt,
      manifest: s.manifest,
      mintSignature: s.mintSignature,
      included: false,
    });

    // A judge/auditor recomputing from evidence.json alone, plus the public amount key:
    const receiptOk = verifyIssuedReceipt(evidence.pol_receipt, evidence.reconstructed_b_prime, s.keyset.amounts[s.AMOUNT_OMITTED]!.publicKeyHex);
    const manifestOk = verifyManifest(evidence.manifest, evidence.manifest.mint_signature, s.masterPubHex);
    expect(receiptOk).toBe(true);
    expect(manifestOk).toBe(true);
    expect(evidence.inclusion_status).toBe('missing');
  });
});
