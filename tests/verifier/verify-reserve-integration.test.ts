// Proves the central verify() decision genuinely combines Gate 6's real
// reserve attestation evaluation, not just a caller-supplied boolean: the
// specific reason code evaluateReserveAttestation() computes (spent UTXO,
// state mismatch, invalid attestation) propagates through to verify()'s
// result, the same way the Gate 5 Nostr integration test proves it for
// Nostr evidence.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { bytesToHex, generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import { keysetMerkleRoot, signManifest, sortKeysets, ZERO_DIGEST_HEX, type KeysetManifestEntry, type ManifestFields } from '../../src/pol/manifest.js';
import { append, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../../src/pol/mmr.js';
import { signIssuedReceipt } from '../../src/pol/receipt.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation } from '../../src/reserve/evaluate.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../../src/reserve/statement.js';
import { generateSignetReserveKey } from '../../src/reserve/taproot.js';
import { verify } from '../../src/verifier/verify.js';

const AMOUNT = 30_000;
const EPOCH_INDEX = 12;

function setup() {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `reserve-integration-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');
  const receipt = signIssuedReceipt(recon.bPrimeHex, EPOCH_INDEX, keyset.amounts[AMOUNT]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(recon.bPrimeHex, AMOUNT));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('reserve-integration-spent'), 5_000));
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
    nostr: { verified: true as const },
  };

  const reserveKey = generateSignetReserveKey();
  const reserveMasterPriv = createRandomSecretKey();
  const reserveMasterPrivHex = bytesToHex(reserveMasterPriv);
  const reserveMasterPubHex = bytesToHex(getPubKeyFromPrivKey(reserveMasterPriv));
  const statement: ReserveStatement = {
    network: 'bitcoin-signet-mutinynet',
    reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: 'cd'.repeat(32), vout: 0, value_sats: 80_000, script_pubkey_hex: reserveKey.scriptPubKeyHex }],
    timestamp: '2026-09-21T00:00:00Z',
    block_height: 500_000,
  };
  const statementSignature = signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
  const digest = reserveStatementDigestHex(statement);
  const bindingSignature = signReserveBinding(statement.reserve_pubkey, digest, reserveMasterPrivHex);
  const attestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: reserveMasterPubHex };
  const honestChainState = new Map<string, ChainStateEntry>([
    ['cd'.repeat(32) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
  ]);

  return { verifyInput, attestation, honestChainState, outstandingBalance: manifest.outstanding_balance };
}

describe('verify() combined with real Gate 6 reserve attestation evaluation', () => {
  it('ACCEPT when evaluateReserveAttestation verifies a real reserve attestation and feeds reserve.verified=true into verify()', () => {
    const s = setup();
    const reserveResult = evaluateReserveAttestation(s.attestation, s.honestChainState, s.outstandingBalance, 500_010);
    expect(reserveResult.verified).toBe(true);
    const result = verify({ ...s.verifyInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } });
    expect(result.decision).toBe('ACCEPT');
    expect(result.reasonCode).toBe('ACCEPT_VERIFIED');
  });

  it('REFUSE_RESERVE_UTXO_SPENT propagates through verify() when the reserve outpoint was spent since attestation', () => {
    const s = setup();
    const spentChainState = new Map<string, ChainStateEntry>(s.honestChainState);
    const key = 'cd'.repeat(32) + ':0';
    spentChainState.set(key, { ...spentChainState.get(key)!, spent: true });
    const reserveResult = evaluateReserveAttestation(s.attestation, spentChainState, s.outstandingBalance, 500_010);
    expect(reserveResult.reasonCode).toBe('REFUSE_RESERVE_UTXO_SPENT');
    const result = verify({ ...s.verifyInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RESERVE_UTXO_SPENT');
  });

  it('REFUSE_RESERVE_STATE_MISMATCH propagates through verify() when the declared outpoint is not found on chain', () => {
    const s = setup();
    const reserveResult = evaluateReserveAttestation(s.attestation, new Map(), s.outstandingBalance, 500_010);
    expect(reserveResult.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
    const result = verify({ ...s.verifyInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('REFUSE_RESERVE_ATTESTATION_INVALID propagates through verify() when the master binding signature is invalid', () => {
    const s = setup();
    const tamperedAttestation: ReserveAttestation = { ...s.attestation, bindingSignature: '11'.repeat(64) };
    const reserveResult = evaluateReserveAttestation(tamperedAttestation, s.honestChainState, s.outstandingBalance, 500_010);
    expect(reserveResult.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    const result = verify({ ...s.verifyInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('REFUSE_RESERVE_SHORT propagates through verify() when verified reserves are below outstanding liabilities', () => {
    const s = setup();
    const reserveResult = evaluateReserveAttestation(s.attestation, s.honestChainState, 999_999, 500_010);
    expect(reserveResult.reasonCode).toBe('REFUSE_RESERVE_SHORT');
    const result = verify({ ...s.verifyInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_RESERVE_SHORT');
  });
});
