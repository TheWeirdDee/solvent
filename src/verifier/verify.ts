// The one deterministic central verifier (PRD §18). UI/CLI/enforcement all
// consume this; no acceptance policy is scattered elsewhere.
//
// This deterministic core checks the cryptographic chain and consumes the
// reserve (Gate 6) and Nostr (Gate 5) evaluations performed by the submission
// pipeline. It never performs network I/O itself. Missing reserve or Nostr
// evaluations fail closed with REFUSE_UNVERIFIABLE. See docs/draft-alignment.md.
import type { Proof } from '@cashu/cashu-ts';
import { reconstruct } from '../cashu/reconstruct.js';
import { hexToBytes as mHexToBytes, verifyManifest, type ManifestFields } from '../pol/manifest.js';
import { issuedLeaf, verifyInclusionProof, type InclusionProof } from '../pol/mmr.js';
import { verifyIssuedReceipt, type PolReceipt } from '../pol/receipt.js';
import { verifyManifestKeyDelegation, type DelegationFailure, type ManifestKeyDelegation } from '../epoch/delegation.js';
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
  /** Gate 6's reserve evaluation. Optional at the type boundary; omitting it fails closed. */
  reserve?: {
    verified: boolean;
    reserveSats: number;
    /** Specific reason when verified=false, e.g. from a real Gate 6 chain-state check. Defaults to REFUSE_RESERVE_SHORT when omitted and coverage is insufficient. */
    reasonCode?: Extract<ReasonCode, 'REFUSE_RESERVE_ATTESTATION_INVALID' | 'REFUSE_RESERVE_UTXO_SPENT' | 'REFUSE_RESERVE_STATE_MISMATCH' | 'REFUSE_RESERVE_SHORT' | 'REFUSE_RESERVE_BINDING_INVALID'>;
  };
  /** Optional — Gate 5 (Nostr evidence). Omitting it fails closed. Set by src/nostr/pol-evidence.ts's real fetch+verify (checks 14-17). */
  nostr?: {
    verified: boolean;
    /** Specific reason when verified=false, from evaluatePolEvidence(). Defaults to REFUSE_NOSTR_UNAVAILABLE when omitted. */
    reasonCode?: Extract<ReasonCode, 'REFUSE_NOSTR_SIGNATURE' | 'REFUSE_NOSTR_STATE_MISMATCH' | 'REFUSE_NOSTR_STALE' | 'REFUSE_NOSTR_CONFLICT' | 'REFUSE_NOSTR_UNAVAILABLE' | 'REFUSE_NOSTR_EVENT_NOT_FOUND'>;
  };
  /**
   * Phase 3B — REQUIRED whenever `mint` is an http(s) mint URL (a real Cashu
   * mint): the mint's NUT-06 identity pubkey as independently observed from
   * that mint (never taken from the evidence being verified), the mint
   * identity's delegation of `masterPublicKeyHex`, and how many keysets the
   * epoch spans. See docs/manifest-key-delegation.md.
   */
  mintIdentityPubkey?: string;
  delegation?: ManifestKeyDelegation | null;
  epochKeysetCount?: number;
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
  /** Phase 3B: mint identity -> manifest key delegation. Present only for a real (URL) mint. */
  delegationValid?: boolean;
  /** null = no reserve evaluation supplied; verification fails closed. */
  reserveCoverage: boolean | null;
  /** null = no Nostr evaluation supplied; verification fails closed. */
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

/** A real Cashu mint is addressed by URL; SOLVENT's reference fixtures use plain labels. */
export function isMintUrl(mint: string): boolean {
  return /^https?:\/\//i.test(mint);
}

const DELEGATION_REFUSAL: Record<DelegationFailure, ReasonCode> = {
  DELEGATION_MALFORMED: 'REFUSE_DELEGATION_MALFORMED',
  DELEGATION_SCHEMA: 'REFUSE_DELEGATION_MALFORMED',
  DELEGATION_BAD_IDENTITY_KEY: 'REFUSE_DELEGATION_MALFORMED',
  DELEGATION_BAD_MANIFEST_KEY: 'REFUSE_DELEGATION_MALFORMED',
  DELEGATION_XONLY_MISMATCH: 'REFUSE_DELEGATION_MALFORMED',
  DELEGATION_MINT_MISMATCH: 'REFUSE_DELEGATION_MINT_IDENTITY_MISMATCH',
  DELEGATION_IDENTITY_MISMATCH: 'REFUSE_DELEGATION_MINT_IDENTITY_MISMATCH',
  DELEGATION_SIGNATURE_INVALID: 'REFUSE_DELEGATION_INVALID_SIGNATURE',
  DELEGATION_MANIFEST_KEY_MISMATCH: 'REFUSE_DELEGATION_MANIFEST_KEY_MISMATCH',
  DELEGATION_EPOCH_OUT_OF_SCOPE: 'REFUSE_DELEGATION_EPOCH_OUT_OF_SCOPE',
  MANIFEST_SIGNATURE_INVALID: 'REFUSE_MANIFEST_INVALID',
};

function delegationRefusal(input: VerifyInput): ReasonCode | null {
  if (!input.delegation) return 'REFUSE_DELEGATION_MISSING';
  // Without an independently observed NUT-06 identity there is nothing to
  // check the delegation against; never fall back to the delegation's own claim.
  if (!input.mintIdentityPubkey) return 'REFUSE_UNVERIFIABLE';
  const r = verifyManifestKeyDelegation(input.delegation, {
    mintUrl: input.mint,
    mintIdentityPubkey: input.mintIdentityPubkey,
    manifestPubkey: input.masterPublicKeyHex,
    epochIndex: input.manifest.epoch_index,
  });
  return r.ok ? null : DELEGATION_REFUSAL[r.reason];
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
    ...(isMintUrl(input.mint) ? { delegationValid: false } : {}),
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

  // Phase 3B: a real mint's manifest is only authoritative if the mint's own
  // NUT-06 identity delegated the key that signed it. A valid manifest
  // signature alone proves nothing about which mint stands behind it.
  if (isMintUrl(input.mint)) {
    if (input.epochKeysetCount === undefined) return reject(checks, input, amount, 'REFUSE_UNVERIFIABLE', bPrime);
    if (input.epochKeysetCount !== 1) return reject(checks, input, amount, 'REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE', bPrime);
    const refusal = delegationRefusal(input);
    checks.delegationValid = refusal === null;
    if (refusal) return reject(checks, input, amount, refusal, bPrime);
  } else if (input.epochKeysetCount !== undefined && input.epochKeysetCount !== 1) {
    return reject(checks, input, amount, 'REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE', bPrime);
  }

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
