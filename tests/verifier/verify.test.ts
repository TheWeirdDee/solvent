// The central verifier (src/verifier/verify.ts), exercised end to end:
// real issuance -> real receipt -> real closed epoch -> real inclusion (or
// omission). This is the same composition as tests/pol/hero.test.ts, now
// routed through the single decision function everything else must use.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import { keysetMerkleRoot, signManifest, sortKeysets, ZERO_DIGEST_HEX, type KeysetManifestEntry, type ManifestFields } from '../../src/pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../../src/pol/mmr.js';
import { signIssuedReceipt } from '../../src/pol/receipt.js';
import { verify } from '../../src/verifier/verify.js';

const AMOUNT = 30_000;
const SPENT_AMOUNT = 5_000;

function setup(includeInEpoch: boolean) {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `verify-test-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');

  const receipt = signIssuedReceipt(recon.bPrimeHex, 12, keyset.amounts[AMOUNT]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  if (includeInEpoch) issuedMmr = append(issuedMmr, issuedLeaf(recon.bPrimeHex, AMOUNT));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('unrelated-spent-secret'), SPENT_AMOUNT));

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
  void keysetMerkleRoot(sortKeysets([entry]));

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
  const manifestSignature = signManifest(manifest, masterPrivHex);

  const inclusionProof = includeInEpoch ? getInclusionProof(issuedMmr, 0) : null;

  return { keyset, proof, masterPrivHex, masterPubHex, receipt, manifest, manifestSignature, issuedMmr, inclusionProof };
}

describe('verify() — the central decision function', () => {
  it('ACCEPT when the crypto spine passes and reserve/nostr context is explicitly provided as verified', () => {
    const s = setup(true);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
      reserve: { verified: true, reserveSats: s.manifest.outstanding_balance + 10_000 },
      nostr: { verified: true },
    });
    expect(result.decision).toBe('ACCEPT');
    expect(result.reasonCode).toBe('ACCEPT_VERIFIED');
    expect(Object.values(result.checks).every((v) => v === true)).toBe(true);
  });

  it('REFUSE_ISSUANCE_OMITTED — the hero case — when inclusionProof is null despite everything else verifying', () => {
    const s = setup(false);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
      reserve: { verified: true, reserveSats: 999_999 },
      nostr: { verified: true },
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(result.checks.receiptValid).toBe(true);
    expect(result.checks.manifestValid).toBe(true);
    expect(result.checks.dleqValid).toBe(true);
  });

  it('REFUSE_UNVERIFIABLE when reserve/nostr context is omitted (fails closed, never silently ACCEPT)', () => {
    const s = setup(true);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
      // reserve/nostr omitted
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_UNVERIFIABLE');
  });

  it('REFUSE_RESERVE_SHORT when reserve is verified but below outstanding balance', () => {
    const s = setup(true);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
      reserve: { verified: true, reserveSats: s.manifest.outstanding_balance - 1 },
      nostr: { verified: true },
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RESERVE_SHORT');
  });

  it('REFUSE_MALFORMED_TOKEN on a proof missing required fields', () => {
    const s = setup(true);
    const { secret: _secret, ...malformed } = s.proof;
    const result = verify({
      proof: malformed as typeof s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_MALFORMED_TOKEN');
  });

  it('REFUSE_MISSING_BLINDING_FACTOR when dleq.r is absent (unsupported path)', () => {
    const s = setup(true);
    const tampered = { ...s.proof, dleq: { e: s.proof.dleq!.e, s: s.proof.dleq!.s } };
    const result = verify({
      proof: tampered,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_MISSING_BLINDING_FACTOR');
  });

  it('REFUSE_RECEIPT_INVALID when the receipt does not match the reconstructed B\'', () => {
    const s = setup(true);
    const wrongReceipt = { ...s.receipt, signature: '00'.repeat(64) };
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: wrongReceipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RECEIPT_INVALID');
  });

  it('REFUSE_MANIFEST_INVALID when the manifest signature is tampered', () => {
    const s = setup(true);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: '11'.repeat(64),
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_MANIFEST_INVALID');
  });

  it('REFUSE_LIABILITY_ARITHMETIC when outstanding_balance is inconsistent (re-signed so the signature check itself does not mask it)', () => {
    const s = setup(true);
    const badManifest: ManifestFields = { ...s.manifest, outstanding_balance: s.manifest.outstanding_balance + 1 };
    const badSig = signManifest(badManifest, s.masterPrivHex);
    const result = verify({
      proof: s.proof,
      mint: 'test-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: badManifest,
      manifestSignature: badSig,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
    });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_LIABILITY_ARITHMETIC');
  });
});
