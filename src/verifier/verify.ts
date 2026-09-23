// The one deterministic central verifier (PRD §18). UI/CLI/enforcement all
// consume this; no acceptance policy is scattered elsewhere.
//
// HONESTY NOTE (read before wiring this into a UI): this build implements
// checks 1-9 of the PRD's 17-check decision rule — the full Gate 0-3
// cryptographic spine (parse -> DLEQ -> B' reconstruction -> signed
// receipt -> closed epoch -> signed manifest -> inclusion -> liability
// arithmetic). Reserve attestation (Gate 6) and Nostr evidence (Gate 5)
// are NOT implemented in this build. `reserve` and `nostr` are optional
// inputs; when omitted, verify() fails closed with REFUSE_UNVERIFIABLE
// rather than silently treating them as passed. See
// docs/draft-alignment.md.
import type { Proof } from '@cashu/cashu-ts';
import { reconstruct } from '../cashu/reconstruct.js';
import { hexToBytes as mHexToBytes, verifyManifest, type ManifestFields } from '../pol/manifest.js';
import { issuedLeaf, verifyInclusionProof, type InclusionProof } from '../pol/mmr.js';
import { verifyIssuedReceipt, type PolReceipt } from '../pol/receipt.js';
import { REASON_TEXT, type ReasonCode } from './reasons.js';

export interface VerifyInput {
  proof: Proof;
  mint: string;
  keysetId: string;
  amountPublicKeyHex: string;
  receipt: PolReceipt;
  manifest: ManifestFields;
  manifestSignature: string;
  masterPublicKeyHex: string;
  issuedMmrSize: number;
  /** null when the mint could not/did not supply a valid inclusion proof — this is the omission case. */
  inclusionProof: InclusionProof | null;
  /** Optional — Gate 6 (real Signet reserves) is not implemented in this build. Omitting it fails closed. */
  reserve?: {
    verified: boolean;
    reserveSats: number;
    /** Specific reason when verified=false, e.g. from a real Gate 6 chain-state check. Defaults to REFUSE_RESERVE_SHORT when omitted and coverage is insufficient. */
    reasonCode?: Extract<ReasonCode, 'REFUSE_RESERVE_ATTESTATION_INVALID' | 'REFUSE_RESERVE_UTXO_SPENT' | 'REFUSE_RESERVE_STATE_MISMATCH' | 'REFUSE_RESERVE_SHORT'>;
  };
  /** Optional — Gate 5 (Nostr evidence). Omitting it fails closed. Set by src/nostr/pol-evidence.ts's real fetch+verify (checks 14-17). */
  nostr?: {
    verified: boolean;
    /** Specific reason when verified=false, from evaluatePolEvidence(). Defaults to REFUSE_NOSTR_UNAVAILABLE when omitted. */
    reasonCode?: Extract<ReasonCode, 'REFUSE_NOSTR_SIGNATURE' | 'REFUSE_NOSTR_STATE_MISMATCH' | 'REFUSE_NOSTR_STALE' | 'REFUSE_NOSTR_CONFLICT' | 'REFUSE_NOSTR_UNAVAILABLE' | 'REFUSE_NOSTR_EVENT_NOT_FOUND'>;
  };
}

export interface VerifyChecks {
  parses: boolean;
  supportedKeyset: boolean;
  dleqPresent: boolean;
  dleqValid: boolean;
  bPrimeReconstructed: boolean;
  receiptValid: boolean;
  targetEpochClosed: boolean;
  manifestValid: boolean;
  inclusionValid: boolean;
  liabilityArithmeticValid: boolean;
  /** null = not evaluated in this build (Gate 6 not implemented). */
  reserveCoverage: boolean | null;
  /** null = not evaluated in this build (Gate 5 not implemented). */
  nostrEvidence: boolean | null;
}

export interface VerifyResult {
  decision: 'ACCEPT' | 'REFUSE';
  reasonCode: ReasonCode;
  reason: string;
  checks: VerifyChecks;
  mint: string;
  amount: number;
  keyset: string;
  reconstructedBPrime?: string;
}

function amountOf(proof: Proof): number {
  return Number(proof.amount);
}

export function verify(input: VerifyInput): VerifyResult {
  const checks: VerifyChecks = {
    parses: false,
    supportedKeyset: false,
    dleqPresent: false,
    dleqValid: false,
    bPrimeReconstructed: false,
    receiptValid: false,
    targetEpochClosed: false,
    manifestValid: false,
    inclusionValid: false,
    liabilityArithmeticValid: false,
    reserveCoverage: input.reserve ? input.reserve.verified && input.reserve.reserveSats >= input.manifest.outstanding_balance : null,
    nostrEvidence: input.nostr ? input.nostr.verified : null,
  };

  const amount = amountOf(input.proof);
  checks.parses = !!input.proof.id && !!input.proof.secret && !!input.proof.C && Number.isSafeInteger(amount) && amount >= 0;
  checks.supportedKeyset = input.proof.id === input.keysetId;

  if (!checks.parses) return reject(checks, input, amount, 'REFUSE_MALFORMED_TOKEN');
  if (!checks.supportedKeyset) return reject(checks, input, amount, 'REFUSE_UNSUPPORTED_KEYSET');

  checks.dleqPresent = !!input.proof.dleq && input.proof.dleq.r !== undefined;
  if (!checks.dleqPresent) return reject(checks, input, amount, 'REFUSE_MISSING_BLINDING_FACTOR');

  const recon = reconstruct(input.proof, input.keysetId, input.amountPublicKeyHex);
  checks.dleqValid = recon.valid;
  checks.bPrimeReconstructed = recon.valid && !!recon.bPrimeHex;
  if (!checks.dleqValid || !recon.bPrimeHex) return reject(checks, input, amount, 'REFUSE_INVALID_DLEQ');

  const bPrime = recon.bPrimeHex;
  checks.receiptValid = verifyIssuedReceipt(input.receipt, bPrime, input.amountPublicKeyHex);
  if (!checks.receiptValid) return reject(checks, input, amount, 'REFUSE_RECEIPT_INVALID', bPrime);

  checks.targetEpochClosed = input.manifest.epoch_index >= input.receipt.target_epoch;
  if (!checks.targetEpochClosed) return reject(checks, input, amount, 'REFUSE_TARGET_EPOCH_OPEN', bPrime);

  checks.manifestValid = verifyManifest(input.manifest, input.manifestSignature, input.masterPublicKeyHex);
  if (!checks.manifestValid) return reject(checks, input, amount, 'REFUSE_MANIFEST_INVALID', bPrime);

  checks.liabilityArithmeticValid = input.manifest.outstanding_balance === input.manifest.issued_mmr_root_sum - input.manifest.spent_mmr_root_sum;
  if (!checks.liabilityArithmeticValid) return reject(checks, input, amount, 'REFUSE_LIABILITY_ARITHMETIC', bPrime);

  if (!input.inclusionProof) {
    // The mint could not produce a valid inclusion proof for the promised issuance — the hero case.
    return reject(checks, input, amount, 'REFUSE_ISSUANCE_OMITTED', bPrime);
  }
  const leaf = issuedLeaf(bPrime, amount);
  checks.inclusionValid = verifyInclusionProof(
    leaf,
    input.inclusionProof,
    input.issuedMmrSize,
    mHexToBytes(input.manifest.issued_mmr_root_hash),
    BigInt(input.manifest.issued_mmr_root_sum),
  );
  if (!checks.inclusionValid) return reject(checks, input, amount, 'REFUSE_MMR_PROOF_INVALID', bPrime);

  if (checks.reserveCoverage === null || checks.nostrEvidence === null) {
    return reject(checks, input, amount, 'REFUSE_UNVERIFIABLE', bPrime);
  }
  if (!checks.reserveCoverage) return reject(checks, input, amount, input.reserve?.reasonCode ?? 'REFUSE_RESERVE_SHORT', bPrime);
  if (!checks.nostrEvidence) return reject(checks, input, amount, input.nostr?.reasonCode ?? 'REFUSE_NOSTR_UNAVAILABLE', bPrime);

  return {
    decision: 'ACCEPT',
    reasonCode: 'ACCEPT_VERIFIED',
    reason: REASON_TEXT.ACCEPT_VERIFIED,
    checks,
    mint: input.mint,
    amount,
    keyset: input.keysetId,
    reconstructedBPrime: bPrime,
  };
}

function reject(checks: VerifyChecks, input: VerifyInput, amount: number, code: ReasonCode, bPrime?: string): VerifyResult {
  return {
    decision: 'REFUSE',
    reasonCode: code,
    reason: REASON_TEXT[code],
    checks,
    mint: input.mint,
    amount,
    keyset: input.keysetId,
    reconstructedBPrime: bPrime,
  };
}
