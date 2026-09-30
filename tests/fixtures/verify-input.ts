// A complete VerifyInput from real primitives (the Gate 4 fixture): a real
// issuance, a signed receipt, a signed epoch manifest with or without the
// issuance, and pre-evaluated reserve/Nostr context.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import { keysetMerkleRoot, signManifest, sortKeysets, ZERO_DIGEST_HEX, type KeysetManifestEntry, type ManifestFields } from '../../src/pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../../src/pol/mmr.js';
import { signIssuedReceipt } from '../../src/pol/receipt.js';
import type { VerifyInput } from '../../src/verifier/verify.js';

const AMOUNT = 30_000;

export function verifyInputFixture(opts: { includeInEpoch?: boolean; reserveSats?: number; omitReserveContext?: boolean; forceBadReceiptSig?: boolean } = {}) {
  const includeInEpoch = opts.includeInEpoch ?? true;
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `accept-gate-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');

  let receipt = signIssuedReceipt(recon.bPrimeHex, 12, keyset.amounts[AMOUNT]!.privateKeyHex);
  if (opts.forceBadReceiptSig) receipt = { ...receipt, signature: '00'.repeat(64) };

  let issuedMmr = emptyMmr();
  if (includeInEpoch) issuedMmr = append(issuedMmr, issuedLeaf(recon.bPrimeHex, AMOUNT));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('accept-gate-spent'), 5_000));
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

  const input: VerifyInput = {
    proof,
    mint: 'solvent-fixture-mint',
    keysetId: keyset.keysetId,
    amountPublicKeyHex: keyset.amounts[AMOUNT]!.publicKeyHex,
    receipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: masterPubHex,
    issuedMmrSize: issuedMmr.leaves.length,
    inclusionProof: includeInEpoch ? getInclusionProof(issuedMmr, 0) : null,
    ...(opts.omitReserveContext
      ? {}
      : { reserve: { verified: true, reserveSats: opts.reserveSats ?? 200_000 }, nostr: { verified: true } }),
  };
  return input;
}
