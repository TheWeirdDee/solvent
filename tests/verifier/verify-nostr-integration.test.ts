// Proves the central verify() decision genuinely combines Gate 5's real
// Nostr evidence evaluation, not just a caller-supplied boolean: the
// specific reason code evaluatePolEvidence() computes (stale, conflicting,
// tampered signature, digest mismatch) propagates all the way through to
// verify()'s result, rather than collapsing to a generic refusal.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import {
  globalDigest,
  keysetMerkleRoot,
  manifestDigestHex,
  signManifest,
  sortKeysets,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../../src/pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../../src/pol/mmr.js';
import { signIssuedReceipt } from '../../src/pol/receipt.js';
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../../src/nostr/pol-event.js';
import { evaluatePolEvidence, type NostrEvidenceExpectation } from '../../src/nostr/pol-evidence.js';
import { verify } from '../../src/verifier/verify.js';

const AMOUNT = 30_000;
const EPOCH_INDEX = 12;
const RESERVE_DIGEST = '1'.repeat(64);

function setup() {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `nostr-integration-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');
  const receipt = signIssuedReceipt(recon.bPrimeHex, EPOCH_INDEX, keyset.amounts[AMOUNT]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(recon.bPrimeHex, AMOUNT));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('nostr-integration-spent'), 5_000));
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
  const sortedKeysets = sortKeysets([entry]);
  const keysetRoot = keysetMerkleRoot(sortedKeysets);
  const global = globalDigest(ZERO_DIGEST_HEX, EPOCH_INDEX, sortedKeysets.length, keysetRoot);

  const manifest: ManifestFields = {
    keyset_id: entry.keyset_id,
    unit: entry.unit,
    epoch_index: EPOCH_INDEX,
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
  const manifestDigest = manifestDigestHex(manifest);
  const globalDigestHex = bytesToHex(global);

  const verifyInput = {
    proof,
    mint: 'test-mint',
    keysetId: keyset.keysetId,
    amountPublicKeyHex: keyset.amounts[AMOUNT]!.publicKeyHex,
    receipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: masterPubHex,
    issuedMmrSize: issuedMmr.leaves.length,
    inclusionProof: getInclusionProof(issuedMmr, 0),
    reserve: { verified: true as const, reserveSats: manifest.outstanding_balance + 10_000 },
  };

  const nowSeconds = 1_800_000_000;
  const nostrSecretKey = generateSecretKey();
  const content = buildPolEvidenceContent({
    mint: 'test-mint',
    mintIdentityHex: masterPubHex,
    keysetId: keyset.keysetId,
    epochIndex: EPOCH_INDEX,
    manifestDigestHex: manifestDigest,
    manifestSignature,
    globalDigestHex,
    issuedMmrRootHash: manifest.issued_mmr_root_hash,
    issuedMmrRootSum: manifest.issued_mmr_root_sum,
    spentMmrRootHash: manifest.spent_mmr_root_hash,
    spentMmrRootSum: manifest.spent_mmr_root_sum,
    outstandingBalance: manifest.outstanding_balance,
    reserveDigestHex: RESERVE_DIGEST,
    reserveSats: manifest.outstanding_balance + 10_000,
    reserveNetwork: 'bitcoin-signet',
    validitySeconds: 3600,
    proofUri: 'local://test',
    now: nowSeconds,
  });
  const event = signPolEvidenceEvent(content, nostrSecretKey);

  const expectation: NostrEvidenceExpectation = {
    mintIdentityHex: masterPubHex,
    epochIndex: EPOCH_INDEX,
    manifestDigestHex: manifestDigest,
    globalDigestHex,
    reserveDigestHex: RESERVE_DIGEST,
    nowSeconds,
  };

  return { verifyInput, event, expectation, nostrSecretKey, manifestDigest, globalDigestHex };
}

describe('verify() combined with real Gate 5 Nostr evidence evaluation', () => {
  it('ACCEPT when evaluatePolEvidence verifies a real signed event and feeds nostr.verified=true into verify()', () => {
    const s = setup();
    const nostrResult = evaluatePolEvidence([s.event], s.expectation);
    expect(nostrResult.verified).toBe(true);
    const result = verify({ ...s.verifyInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } });
    expect(result.decision).toBe('ACCEPT');
    expect(result.reasonCode).toBe('ACCEPT_VERIFIED');
  });

  it('REFUSE_NOSTR_STALE propagates through verify() when Gate 5 evidence has expired', () => {
    const s = setup();
    const staleExpectation: NostrEvidenceExpectation = { ...s.expectation, nowSeconds: s.expectation.nowSeconds + 999_999 };
    const nostrResult = evaluatePolEvidence([s.event], staleExpectation);
    expect(nostrResult.reasonCode).toBe('REFUSE_NOSTR_STALE');
    const result = verify({ ...s.verifyInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_NOSTR_STALE');
  });

  it('REFUSE_NOSTR_CONFLICT propagates through verify() when two valid signed states disagree', () => {
    const s = setup();
    const conflicting = signPolEvidenceEvent(
      buildPolEvidenceContent({
        mint: 'test-mint',
        mintIdentityHex: s.verifyInput.masterPublicKeyHex,
        keysetId: s.verifyInput.keysetId,
        epochIndex: EPOCH_INDEX,
        manifestDigestHex: 'ee'.repeat(32),
        manifestSignature: s.verifyInput.manifestSignature,
        globalDigestHex: s.globalDigestHex,
        issuedMmrRootHash: s.verifyInput.manifest.issued_mmr_root_hash,
        issuedMmrRootSum: s.verifyInput.manifest.issued_mmr_root_sum,
        spentMmrRootHash: s.verifyInput.manifest.spent_mmr_root_hash,
        spentMmrRootSum: s.verifyInput.manifest.spent_mmr_root_sum,
        outstandingBalance: s.verifyInput.manifest.outstanding_balance,
        reserveDigestHex: RESERVE_DIGEST,
        reserveSats: s.verifyInput.reserve.reserveSats,
        reserveNetwork: 'bitcoin-signet',
        validitySeconds: 3600,
        proofUri: 'local://test',
        now: s.expectation.nowSeconds,
      }),
      generateSecretKey(),
    );
    const nostrResult = evaluatePolEvidence([s.event, conflicting], s.expectation);
    expect(nostrResult.reasonCode).toBe('REFUSE_NOSTR_CONFLICT');
    const result = verify({ ...s.verifyInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_NOSTR_CONFLICT');
  });

  it('REFUSE_NOSTR_STATE_MISMATCH propagates through verify() when the decision uses different digests than the event commits to', () => {
    const s = setup();
    const wrongExpectation: NostrEvidenceExpectation = { ...s.expectation, manifestDigestHex: 'ff'.repeat(32) };
    const nostrResult = evaluatePolEvidence([s.event], wrongExpectation);
    expect(nostrResult.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
    const result = verify({ ...s.verifyInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('REFUSE_NOSTR_UNAVAILABLE propagates through verify() when no relay returned any evidence', () => {
    const s = setup();
    const nostrResult = evaluatePolEvidence([], s.expectation);
    expect(nostrResult.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
    const result = verify({ ...s.verifyInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
  });
});
