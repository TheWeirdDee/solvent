// Generates evidence/attacks/Axx-*/{input.json,result.json,verify.txt} for
// every attack currently implemented (see ATTACKS.md for the full A01-A25
// status). Each attack reuses the same real closed-epoch fixture as
// verify-submission.ts, mutating exactly one thing per attack and running
// it through the real verify()/receipt/manifest/mmr primitives — no
// attack's outcome is asserted without actually exercising the code.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRandomSecretKey, getPubKeyFromPrivKey, type Proof } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools';
import { generateFixtureKeyset, issue } from '../cashu/keys.js';
import { reconstruct, spentY } from '../cashu/reconstruct.js';
import { createWalletStore, runAcceptGate } from '../enforcement/accept-gate.js';
import {
  globalDigest,
  keysetMerkleRoot,
  manifestDigestHex,
  signManifest,
  sortKeysets,
  verifyManifest,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf, verifyInclusionProof, type InclusionProof } from '../pol/mmr.js';
import { signIssuedReceipt, verifyIssuedReceipt, type PolReceipt } from '../pol/receipt.js';
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../nostr/pol-event.js';
import { evaluatePolEvidence, type NostrEvidenceExpectation } from '../nostr/pol-evidence.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation } from '../reserve/evaluate.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../reserve/statement.js';
import { generateSignetReserveKey } from '../reserve/taproot.js';
import { verify, type VerifyInput, type VerifyResult } from '../verifier/verify.js';
import { verifySubmission, type ChainStateFetchFn, type RelayFetchFn, type SubmissionBundle } from '../app/submission.js';

const EVIDENCE_ROOT = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'attacks');

interface AttackOutcome {
  id: string;
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const outcomes: AttackOutcome[] = [];

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  return value;
}

function writeAttack(id: string, name: string, input: unknown, result: VerifyResult | { note: string }, expectedReasonCode: string, actualReasonCode: string) {
  const dir = path.join(EVIDENCE_ROOT, `${id}-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, jsonReplacer, 2) + '\n', 'utf8');
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ attack_id: id, ...result, timestamp: new Date().toISOString() }, jsonReplacer, 2) + '\n', 'utf8');
  const pass = actualReasonCode === expectedReasonCode;
  writeFileSync(path.join(dir, 'verify.txt'), `${id} ${name}\nexpected: ${expectedReasonCode}\nactual:   ${actualReasonCode}\n${pass ? 'PASS' : 'FAIL'}\n`, 'utf8');
  outcomes.push({ id, name, expected: expectedReasonCode, actual: actualReasonCode, pass });
}

function setupHonestEpoch() {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
  const AMOUNT = 30_000;
  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `attack-${Math.random()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reconstruction failed');
  const bPrime = recon.bPrimeHex;
  const receipt = signIssuedReceipt(bPrime, 12, keyset.amounts[AMOUNT]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(bPrime, AMOUNT));
  // A second, unrelated issued leaf so leaf 0 has a real sibling path —
  // otherwise (single-leaf MMR) the leaf IS the peak and A10-A12's
  // "tamper the sibling path" attacks would be tampering an empty array.
  issuedMmr = append(issuedMmr, issuedLeaf(bytesToHex(createRandomSecretKey()).padStart(66, '02'), 15_000));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('attack-spent-secret'), 5_000));
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
  const inclusionProof = getInclusionProof(issuedMmr, 0);
  const manifestDigest = manifestDigestHex(manifest);
  const globalDigestHex = bytesToHex(globalDigest(ZERO_DIGEST_HEX, manifest.epoch_index, sortedKeysets.length, keysetRoot));

  const baseInput: VerifyInput = {
    proof,
    mint: 'solvent-fixture-mint',
    keysetId: keyset.keysetId,
    amountPublicKeyHex: keyset.amounts[AMOUNT]!.publicKeyHex,
    receipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: masterPubHex,
    issuedMmrSize: issuedMmr.leaves.length,
    inclusionProof,
    reserve: { verified: true, reserveSats: 200_000 },
    nostr: { verified: true },
  };

  return { keyset, proof, bPrime, receipt, manifest, manifestSignature, masterPrivHex, masterPubHex, issuedMmr, issuedRoot, inclusionProof, baseInput, AMOUNT, manifestDigest, globalDigestHex };
}

async function main() {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const s = setupHonestEpoch();

  // A01
  {
    const result = verify(s.baseInput);
    writeAttack('A01', 'honest-accept', s.baseInput, result, 'ACCEPT_VERIFIED', result.reasonCode);
  }

  // A02 — omission (separate epoch closed without the promised item)
  {
    const masterPriv = createRandomSecretKey();
    const masterPrivHex = bytesToHex(masterPriv);
    const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
    const keyset = generateFixtureKeyset([70_000]);
    const { proof } = issue(keyset, 70_000, `a02-${Math.random()}`);
    const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[70_000]!.publicKeyHex);
    const bPrime = recon.bPrimeHex!;
    const receipt = signIssuedReceipt(bPrime, 12, keyset.amounts[70_000]!.privateKeyHex);
    const issuedMmr = emptyMmr(); // promised item never appended
    const spentMmr = emptyMmr();
    const issuedRoot = root(issuedMmr);
    const spentRoot = root(spentMmr);
    const entry: KeysetManifestEntry = {
      keyset_id: keyset.keysetId, unit: 'sat', issued_mmr_size: 0, issued_mmr_root_hash: bytesToHex(issuedRoot.hash), issued_mmr_root_sum: 0,
      spent_mmr_size: 0, spent_mmr_root_hash: bytesToHex(spentRoot.hash), spent_mmr_root_sum: 0, active: true, deactivation_epoch: 999,
    };
    void keysetMerkleRoot(sortKeysets([entry]));
    const manifest: ManifestFields = { keyset_id: entry.keyset_id, unit: entry.unit, epoch_index: 12, timestamp: '2026-09-21T00:00:00Z', previous_global_digest: ZERO_DIGEST_HEX, issued_mmr_size: 0, issued_mmr_root_hash: entry.issued_mmr_root_hash, issued_mmr_root_sum: 0, spent_mmr_size: 0, spent_mmr_root_hash: entry.spent_mmr_root_hash, spent_mmr_root_sum: 0, outstanding_balance: 0, active: true, deactivation_epoch: 999 };
    const manifestSignature = signManifest(manifest, masterPrivHex);
    const input: VerifyInput = { proof, mint: 'solvent-fixture-mint', keysetId: keyset.keysetId, amountPublicKeyHex: keyset.amounts[70_000]!.publicKeyHex, receipt, manifest, manifestSignature, masterPublicKeyHex: masterPubHex, issuedMmrSize: 0, inclusionProof: null, reserve: { verified: true, reserveSats: 999_999 }, nostr: { verified: true } };
    const result = verify(input);
    writeAttack('A02', 'promised-issuance-omitted', input, result, 'REFUSE_ISSUANCE_OMITTED', result.reasonCode);
  }

  // A04 — forged receipt signature
  {
    const input: VerifyInput = { ...s.baseInput, receipt: { ...s.receipt, signature: '00'.repeat(64) } };
    const result = verify(input);
    writeAttack('A04', 'forged-receipt-signature', input, result, 'REFUSE_RECEIPT_INVALID', result.reasonCode);
  }

  // A05 — receipt epoch modified after signing
  {
    const input: VerifyInput = { ...s.baseInput, receipt: { ...s.receipt, target_epoch: s.receipt.target_epoch + 1 } as PolReceipt };
    const result = verify(input);
    writeAttack('A05', 'receipt-epoch-modified', input, result, 'REFUSE_RECEIPT_INVALID', result.reasonCode);
  }

  // A06 — reconstructed B' tampered (simulate via a proof whose DLEQ was tampered, which changes reconstruction)
  {
    const tamperedProof: Proof = { ...s.proof, dleq: { ...s.proof.dleq!, r: (s.proof.dleq!.r![0] === '0' ? '1' : '0') + s.proof.dleq!.r!.slice(1) } };
    const input: VerifyInput = { ...s.baseInput, proof: tamperedProof };
    const result = verify(input);
    writeAttack('A06', 'reconstructed-b-prime-tampered', input, result, 'REFUSE_INVALID_DLEQ', result.reasonCode);
  }

  // A07 — invalid DLEQ (flip e)
  {
    const tamperedProof: Proof = { ...s.proof, dleq: { ...s.proof.dleq!, e: (s.proof.dleq!.e[0] === '0' ? '1' : '0') + s.proof.dleq!.e.slice(1) } };
    const input: VerifyInput = { ...s.baseInput, proof: tamperedProof };
    const result = verify(input);
    writeAttack('A07', 'invalid-dleq', input, result, 'REFUSE_INVALID_DLEQ', result.reasonCode);
  }

  // A08 — missing r
  {
    const { r: _r, ...dleqNoR } = s.proof.dleq!;
    const tamperedProof: Proof = { ...s.proof, dleq: dleqNoR };
    const input: VerifyInput = { ...s.baseInput, proof: tamperedProof };
    const result = verify(input);
    writeAttack('A08', 'missing-blinding-factor', input, result, 'REFUSE_MISSING_BLINDING_FACTOR', result.reasonCode);
  }

  // A09 — wrong mint/keyset public key
  {
    const otherKeyset = generateFixtureKeyset([s.AMOUNT]);
    const input: VerifyInput = { ...s.baseInput, amountPublicKeyHex: otherKeyset.amounts[s.AMOUNT]!.publicKeyHex };
    const result = verify(input);
    writeAttack('A09', 'wrong-amount-public-key', input, result, 'REFUSE_INVALID_DLEQ', result.reasonCode);
  }

  // A10/A11/A12 — MMR proof tampering
  {
    const tampered: InclusionProof = { ...s.inclusionProof, siblingPath: s.inclusionProof.siblingPath.map((st) => ({ ...st, hash: new Uint8Array(32).fill(0x11) })) };
    const input: VerifyInput = { ...s.baseInput, inclusionProof: tampered };
    const result = verify(input);
    writeAttack('A10', 'tampered-mmr-sibling-hash', input, result, 'REFUSE_MMR_PROOF_INVALID', result.reasonCode);
  }
  {
    const tampered: InclusionProof = { ...s.inclusionProof, siblingPath: s.inclusionProof.siblingPath.map((st) => ({ ...st, sum: st.sum + 1n })) };
    const input: VerifyInput = { ...s.baseInput, inclusionProof: tampered };
    const result = verify(input);
    writeAttack('A11', 'tampered-mmr-sibling-sum', input, result, 'REFUSE_MMR_PROOF_INVALID', result.reasonCode);
  }
  {
    const tampered: InclusionProof = { ...s.inclusionProof, siblingPath: s.inclusionProof.siblingPath.map((st) => ({ ...st, isLeft: !st.isLeft })) };
    const input: VerifyInput = { ...s.baseInput, inclusionProof: tampered };
    const result = verify(input);
    writeAttack('A12', 'reordered-positional-proof', input, result, 'REFUSE_MMR_PROOF_INVALID', result.reasonCode);
  }

  // A13 — manifest signature flipped
  {
    const input: VerifyInput = { ...s.baseInput, manifestSignature: '22'.repeat(64) };
    const result = verify(input);
    writeAttack('A13', 'manifest-signature-flipped', input, result, 'REFUSE_MANIFEST_INVALID', result.reasonCode);
  }

  // A14 — liability arithmetic inconsistent (re-signed so signature check doesn't mask it)
  {
    const masterPriv = createRandomSecretKey();
    // Re-derive a signature over a bad manifest using a throwaway key consistent with masterPublicKeyHex swap:
    const badManifest: ManifestFields = { ...s.manifest, outstanding_balance: s.manifest.outstanding_balance + 1 };
    // Sign with a fresh key and pass its pubkey too, isolating arithmetic from signature validity.
    const freshPub = bytesToHex(getPubKeyFromPrivKey(masterPriv));
    const freshSig = signManifest(badManifest, bytesToHex(masterPriv));
    const input: VerifyInput = { ...s.baseInput, manifest: badManifest, manifestSignature: freshSig, masterPublicKeyHex: freshPub };
    const result = verify(input);
    writeAttack('A14', 'liability-arithmetic-inconsistent', input, result, 'REFUSE_LIABILITY_ARITHMETIC', result.reasonCode);
  }

  // A03 — issuance included, but the epoch's own issued tree committed a
  // different (wrong) value for this exact bPrime than what was actually
  // issued/received. Built as its own mini-epoch (like A02) so the tree
  // genuinely contains leaf(bPrime, WRONG_AMOUNT) at the proven position;
  // verify() recomputes the leaf from the RECEIVED proof's true amount, so
  // the leaf hashes disagree at the first step of inclusion verification —
  // there is no separate "value mismatch" code path (see ATTACKS.md);
  // it surfaces exactly like any other tampered/incorrect inclusion proof.
  {
    const wrongAmount = s.AMOUNT + 1;
    let wrongValueMmr = emptyMmr();
    wrongValueMmr = append(wrongValueMmr, issuedLeaf(s.bPrime, wrongAmount));
    const wrongRoot = root(wrongValueMmr);
    const badManifest: ManifestFields = {
      ...s.manifest,
      issued_mmr_size: wrongValueMmr.leaves.length,
      issued_mmr_root_hash: bytesToHex(wrongRoot.hash),
      issued_mmr_root_sum: Number(wrongRoot.sum),
      outstanding_balance: Number(wrongRoot.sum - BigInt(s.manifest.spent_mmr_root_sum)),
    };
    const badSig = signManifest(badManifest, s.masterPrivHex);
    const input: VerifyInput = {
      ...s.baseInput,
      manifest: badManifest,
      manifestSignature: badSig,
      issuedMmrSize: wrongValueMmr.leaves.length,
      inclusionProof: getInclusionProof(wrongValueMmr, 0),
    };
    const result = verify(input);
    writeAttack('A03', 'issuance-included-wrong-value', input, result, 'REFUSE_MMR_PROOF_INVALID', result.reasonCode);
  }

  // Shared real Nostr evidence context for A15/A16/A17/A18/A19 — bound to
  // the SAME real manifest digests as the honest epoch above, signed with
  // a real Nostr identity keypair, evaluated by the exact evaluatePolEvidence()
  // used by src/cli/gate5.ts.
  const nostrNow = Math.floor(Date.now() / 1000);
  const mintIdentityHex = s.masterPubHex;
  const nostrExpectation: NostrEvidenceExpectation = {
    mintIdentityHex,
    epochIndex: s.manifest.epoch_index,
    manifestDigestHex: s.manifestDigest,
    globalDigestHex: s.globalDigestHex,
    reserveDigestHex: '1'.repeat(64),
    nowSeconds: nostrNow,
  };
  function buildNostrEvent(overrides: Partial<Parameters<typeof buildPolEvidenceContent>[0]> = {}, signerKey = generateSecretKey()) {
    const content = buildPolEvidenceContent({
      mint: 'solvent-fixture-mint',
      mintIdentityHex,
      keysetId: s.manifest.keyset_id,
      epochIndex: s.manifest.epoch_index,
      manifestDigestHex: s.manifestDigest,
      manifestSignature: s.manifestSignature,
      globalDigestHex: s.globalDigestHex,
      issuedMmrRootHash: s.manifest.issued_mmr_root_hash,
      issuedMmrRootSum: s.manifest.issued_mmr_root_sum,
      spentMmrRootHash: s.manifest.spent_mmr_root_hash,
      spentMmrRootSum: s.manifest.spent_mmr_root_sum,
      outstandingBalance: s.manifest.outstanding_balance,
      reserveDigestHex: '1'.repeat(64),
      reserveSats: 200_000,
      reserveNetwork: 'bitcoin-signet-mutinynet',
      validitySeconds: 3600,
      proofUri: 'local://evidence/attacks',
      now: nostrNow,
      ...overrides,
    });
    return signPolEvidenceEvent(content, signerKey);
  }
  const honestNostrEvent = buildNostrEvent();

  // A15 — conflicting validly-signed evidence states for the same epoch
  {
    const conflicting = buildNostrEvent({ manifestDigestHex: 'ee'.repeat(32) });
    const nostrResult = evaluatePolEvidence([honestNostrEvent, conflicting], nostrExpectation);
    const input: VerifyInput = { ...s.baseInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } };
    const result = verify(input);
    writeAttack('A15', 'conflicting-signed-manifests-same-epoch', { nostrResult, events: [honestNostrEvent, conflicting] }, result, 'REFUSE_NOSTR_CONFLICT', result.reasonCode);
  }

  // A16 — stale Nostr state
  {
    const staleEvent = buildNostrEvent({ validitySeconds: 1, now: nostrNow - 3600 });
    const nostrResult = evaluatePolEvidence([staleEvent], nostrExpectation);
    const input: VerifyInput = { ...s.baseInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } };
    const result = verify(input);
    writeAttack('A16', 'stale-nostr-state', { nostrResult, event: staleEvent }, result, 'REFUSE_NOSTR_STALE', result.reasonCode);
  }

  // A17 — one relay unavailable, the other has valid state: fetchPolEvidence
  // merges events from every relay into a single array (see
  // src/nostr/pol-evidence.ts), so "relay A returned nothing" is
  // indistinguishable from "only relay B's event made it into this array" —
  // exactly what's passed here. Deterministic success path: ACCEPT.
  {
    const nostrResult = evaluatePolEvidence([honestNostrEvent], nostrExpectation);
    const input: VerifyInput = { ...s.baseInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } };
    const result = verify(input);
    writeAttack('A17', 'one-relay-down-other-has-valid-state', { nostrResult, event: honestNostrEvent }, result, 'ACCEPT_VERIFIED', result.reasonCode);
  }

  // A18 — both relays unavailable: zero events fetched -> REFUSE_NOSTR_UNAVAILABLE
  // through the real evaluator (upgraded from the earlier "context omitted
  // entirely" partial version now that Gate 5's live query mechanism exists).
  {
    const nostrResult = evaluatePolEvidence([], nostrExpectation);
    const input: VerifyInput = { ...s.baseInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } };
    const result = verify(input);
    writeAttack('A18', 'both-relays-unavailable', { nostrResult }, result, 'REFUSE_NOSTR_UNAVAILABLE', result.reasonCode);
  }

  // A19 — Nostr event digest differs from the proof bundle actually used for this decision
  {
    const wrongDigestExpectation: NostrEvidenceExpectation = { ...nostrExpectation, manifestDigestHex: 'ff'.repeat(32) };
    const nostrResult = evaluatePolEvidence([honestNostrEvent], wrongDigestExpectation);
    const input: VerifyInput = { ...s.baseInput, nostr: { verified: nostrResult.verified, reasonCode: nostrResult.reasonCode } };
    const result = verify(input);
    writeAttack('A19', 'nostr-event-digest-differs-from-proof-bundle', { nostrResult, event: honestNostrEvent }, result, 'REFUSE_NOSTR_STATE_MISMATCH', result.reasonCode);
  }

  // A20/A21/A22 — Gate 6 reserve attacks, real Taproot key + real BIP-340
  // signatures throughout, evaluated by the exact evaluateReserveAttestation()
  // used by src/cli/gate6.ts.
  const reserveKey = generateSignetReserveKey();
  const reserveMasterPriv = createRandomSecretKey();
  const reserveMasterPrivHex = bytesToHex(reserveMasterPriv);
  const reserveMasterPubHex = bytesToHex(getPubKeyFromPrivKey(reserveMasterPriv));
  const reserveStatement: ReserveStatement = {
    network: 'bitcoin-signet-mutinynet',
    reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: 'ab'.repeat(32), vout: 0, value_sats: 200_000, script_pubkey_hex: reserveKey.scriptPubKeyHex }],
    timestamp: '2026-09-21T00:00:00Z',
    block_height: 500_000,
  };
  const honestStatementSig = signReserveStatement(reserveStatement, reserveKey.tweakedPrivateKeyHex);
  const reserveDigest = reserveStatementDigestHex(reserveStatement);
  const honestBindingSig = signReserveBinding(reserveStatement.reserve_pubkey, reserveDigest, reserveMasterPrivHex);
  const honestReserveChainState = new Map<string, ChainStateEntry>([
    ['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 200_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
  ]);

  // A20 — reserve (binding) signature invalid
  {
    const attestation: ReserveAttestation = { statement: reserveStatement, statementSignature: honestStatementSig, bindingSignature: '22'.repeat(64), masterPublicKeyHex: reserveMasterPubHex };
    const reserveResult = evaluateReserveAttestation(attestation, honestReserveChainState, s.manifest.outstanding_balance, 500_010);
    const input: VerifyInput = { ...s.baseInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } };
    const result = verify(input);
    writeAttack('A20', 'reserve-signature-invalid', { attestation, reserveResult }, result, 'REFUSE_RESERVE_ATTESTATION_INVALID', result.reasonCode);
  }

  // A21 — reserve outpoint spent after attestation
  {
    const attestation: ReserveAttestation = { statement: reserveStatement, statementSignature: honestStatementSig, bindingSignature: honestBindingSig, masterPublicKeyHex: reserveMasterPubHex };
    const spentChainState = new Map<string, ChainStateEntry>([
      ['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 200_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: true }],
    ]);
    const reserveResult = evaluateReserveAttestation(attestation, spentChainState, s.manifest.outstanding_balance, 500_010);
    const input: VerifyInput = { ...s.baseInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } };
    const result = verify(input);
    writeAttack('A21', 'reserve-outpoint-spent-after-attestation', { attestation, reserveResult }, result, 'REFUSE_RESERVE_UTXO_SPENT', result.reasonCode);
  }

  // A22 — reserve outpoint value/script mismatch
  {
    const attestation: ReserveAttestation = { statement: reserveStatement, statementSignature: honestStatementSig, bindingSignature: honestBindingSig, masterPublicKeyHex: reserveMasterPubHex };
    const mismatchedChainState = new Map<string, ChainStateEntry>([
      ['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 1, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
    ]);
    const reserveResult = evaluateReserveAttestation(attestation, mismatchedChainState, s.manifest.outstanding_balance, 500_010);
    const input: VerifyInput = { ...s.baseInput, reserve: { verified: reserveResult.verified, reserveSats: reserveResult.verifiedReserveSats, reasonCode: reserveResult.reasonCode } };
    const result = verify(input);
    writeAttack('A22', 'reserve-outpoint-value-script-mismatch', { attestation, reserveResult }, result, 'REFUSE_RESERVE_STATE_MISMATCH', result.reasonCode);
  }

  // A23 — reserves below liabilities
  {
    const input: VerifyInput = { ...s.baseInput, reserve: { verified: true, reserveSats: s.manifest.outstanding_balance - 1 } };
    const result = verify(input);
    writeAttack('A23', 'reserve-below-liabilities', input, result, 'REFUSE_RESERVE_SHORT', result.reasonCode);
  }

  // A24 — a REFUSE-decision token must never reach the real acceptance side effect
  {
    const badInput: VerifyInput = { ...s.baseInput, receipt: { ...s.receipt, signature: '00'.repeat(64) } };
    const spyStore = createWalletStore();
    let callCount = 0;
    const { result, accepted } = runAcceptGate(badInput, spyStore, (store, mint, proof) => {
      callCount++;
      return { proof, encodedToken: '', acceptedAt: new Date().toISOString() };
    });
    writeAttack(
      'A24',
      'refused-token-never-reaches-acceptance',
      { badInput, accept_function_call_count: callCount, accepted },
      result,
      'REFUSE_RECEIPT_INVALID',
      callCount === 0 ? result.reasonCode : 'ACCEPT_FUNCTION_WAS_CALLED',
    );
  }

  // A25 — a mint cannot satisfy SOLVENT by privately handing the receiver
  // a correctly signed accounting event that was never publicly published.
  // Every real gate here is genuinely valid (proof, DLEQ, receipt, manifest,
  // inclusion, liability arithmetic, reserve) — the bundle carries a real,
  // validly signed Nostr event — but the (deterministically mocked, never
  // real-internet) public relay layer is reached successfully and returns
  // nothing for this mint/epoch. This exercises the exact
  // src/app/submission.ts orchestration boundary the browser uses
  // (verifySubmission()), with the relay/chain-state fetches injected so
  // this stays fully deterministic and offline — see RelayFetchFn/
  // ChainStateFetchFn in submission.ts.
  {
    const a25ReserveAttestation: ReserveAttestation = { statement: reserveStatement, statementSignature: honestStatementSig, bindingSignature: honestBindingSig, masterPublicKeyHex: reserveMasterPubHex };
    // The event's own content genuinely, correctly commits to this
    // statement's real digest — it is a real, validly signed artifact the
    // sender possesses. That is exactly the point: possession alone must
    // not be enough.
    const a25NostrEvent = buildNostrEvent({ reserveDigestHex: reserveStatementDigestHex(reserveStatement) });
    const bundle: SubmissionBundle = {
      proof: s.proof,
      mint: 'solvent-fixture-mint',
      keysetId: s.keyset.keysetId,
      amountPublicKeyHex: s.keyset.amounts[s.AMOUNT]!.publicKeyHex,
      receipt: s.receipt,
      manifest: s.manifest,
      manifestSignature: s.manifestSignature,
      masterPublicKeyHex: s.masterPubHex,
      issuedMmrSize: s.issuedMmr.leaves.length,
      inclusionProof: s.inclusionProof,
      reserveAttestation: a25ReserveAttestation,
      nostrEvent: a25NostrEvent,
    };
    // Deterministic, offline stand-ins for the real network calls
    // verifySubmission() would otherwise make — "relay reached
    // successfully, nothing for this identity/epoch" and "chain queried
    // successfully, declared outpoint exists/unspent/matches" — never the
    // real public internet.
    const mockRelayFetch: RelayFetchFn = (async () => ({ events: [], queriedRelays: ['wss://mock-relay.invalid'], relayReachable: true })) as RelayFetchFn;
    const mockChainStateFetch: ChainStateFetchFn = async (outpoints: { txid: string; vout: number }[]) => {
      const chainState = new Map(
        outpoints.map((o) => [`${o.txid}:${o.vout}`, { exists: true, confirmed: true, value: 200_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }] as const),
      );
      return { ok: true, chainState, tipHeight: reserveStatement.block_height + 1, detail: 'mocked chain-state fetch for A25 (deterministic, no real internet)' };
    };
    const { result, verifyInput } = await verifySubmission(bundle, mockRelayFetch, mockChainStateFetch);
    const spyStore = createWalletStore();
    let a25CallCount = 0;
    const { accepted } = runAcceptGate(verifyInput, spyStore, (store, mint, proof) => {
      a25CallCount++;
      return { proof, encodedToken: '', acceptedAt: new Date().toISOString() };
    });
    writeAttack(
      'A25',
      'signed-state-never-published',
      { bundle, accept_function_call_count: a25CallCount, accepted },
      result,
      'REFUSE_NOSTR_EVENT_NOT_FOUND',
      a25CallCount === 0 ? result.reasonCode : 'ACCEPT_FUNCTION_WAS_CALLED',
    );
  }

  console.log('SOLVENT attack corpus\n');
  for (const o of outcomes) {
    console.log(`${o.id.padEnd(5)} ${o.name.padEnd(40)} ${o.pass ? 'PASS' : 'FAIL'}  (expected ${o.expected}, got ${o.actual})`);
  }
  const passCount = outcomes.filter((o) => o.pass).length;
  console.log(`\n${passCount}/${outcomes.length} attacks produced the expected outcome.`);
  console.log(`Evidence written to evidence/attacks/`);

  process.exit(passCount === outcomes.length ? 0 : 1);
}

main().catch((err) => {
  console.error('attacks.ts crashed:', err);
  process.exit(1);
});
