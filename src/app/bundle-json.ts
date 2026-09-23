// Converts SOLVENT's canonical verification bundle (VerifyInput — exactly
// what verify() consumes, unmodified) to and from plain JSON text, for the
// "Create test ecash" / "Verify your evidence" UI (viewing, copying, and
// pasting a bundle).
//
// This exists because VerifyInput is not JSON-native as-is: `proof.amount`
// is a `cashu-ts` `Amount` class instance (private constructor — a plain
// object with the same shape is NOT a valid Amount and will not behave
// like one), and `inclusionProof.{siblingPath,peaks}[].hash`/`.sum` are
// real `Uint8Array`/`bigint` values that `JSON.stringify` cannot represent
// and a naive `JSON.parse` cannot reconstruct (they'd come back as a plain
// number array and a bigint respectively — the array would silently
// produce a WRONG hash once passed back through the sum-MMR hashing code,
// not an obvious error). This was caught by actually round-tripping a
// real bundle through `verify()` end to end, not assumed.
//
// verify() itself, and the VerifyInput type, are untouched — this is a
// dedicated boundary, not a second decision implementation.
import { Amount, type Proof } from '@cashu/cashu-ts';
import { bytesToHex, hexToBytes } from '../pol/mmr.js';
import type { InclusionProof, SiblingStep, SumNode } from '../pol/mmr.js';
import type { VerifyInput } from '../verifier/verify.js';
import type { SubmissionBundle } from './submission.js';

interface JsonSumNode {
  hash: string;
  sum: string;
}

interface JsonSiblingStep extends JsonSumNode {
  isLeft: boolean;
}

interface JsonInclusionProof {
  leafIndex: number;
  siblingPath: JsonSiblingStep[];
  peaks: JsonSumNode[];
}

function sumNodeToJson(n: SumNode): JsonSumNode {
  return { hash: bytesToHex(n.hash), sum: n.sum.toString() };
}

function sumNodeFromJson(n: JsonSumNode): SumNode {
  return { hash: hexToBytes(n.hash), sum: BigInt(n.sum) };
}

function siblingStepToJson(s: SiblingStep): JsonSiblingStep {
  return { ...sumNodeToJson(s), isLeft: s.isLeft };
}

function siblingStepFromJson(s: JsonSiblingStep): SiblingStep {
  return { ...sumNodeFromJson(s), isLeft: s.isLeft };
}

function inclusionProofToJson(p: InclusionProof | null): JsonInclusionProof | null {
  if (!p) return null;
  return { leafIndex: p.leafIndex, siblingPath: p.siblingPath.map(siblingStepToJson), peaks: p.peaks.map(sumNodeToJson) };
}

function inclusionProofFromJson(p: JsonInclusionProof | null | undefined): InclusionProof | null {
  if (!p) return null;
  return { leafIndex: p.leafIndex, siblingPath: p.siblingPath.map(siblingStepFromJson), peaks: p.peaks.map(sumNodeFromJson) };
}

function proofToJson(proof: Proof): Record<string, unknown> {
  return { ...proof, amount: proof.amount.toNumber() };
}

function proofFromJson(proof: Record<string, unknown>): Proof {
  return { ...proof, amount: Amount.from(proof.amount as number) } as Proof;
}

/** Exactly what verify() consumes, rendered as plain, re-parseable JSON text. */
export function bundleToJson(bundle: VerifyInput, space = 2): string {
  const plain = { ...bundle, proof: proofToJson(bundle.proof), inclusionProof: inclusionProofToJson(bundle.inclusionProof) };
  return JSON.stringify(plain, null, space);
}

/** The exact inverse of bundleToJson — parses text produced by it (or hand-written to the same schema) back into a real VerifyInput. */
export function bundleFromJson(json: string): VerifyInput {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || !parsed.proof || !parsed.receipt || !parsed.manifest) {
    throw new Error('bundle is missing required fields (proof, receipt, manifest, manifestSignature, masterPublicKeyHex, ...)');
  }
  return {
    ...parsed,
    proof: proofFromJson(parsed.proof as Record<string, unknown>),
    inclusionProof: inclusionProofFromJson(parsed.inclusionProof as JsonInclusionProof | null | undefined),
  } as VerifyInput;
}

/**
 * The required top-level SubmissionBundle fields — used both to classify
 * "INCOMPLETE BUNDLE" (a field is entirely absent) as distinct from
 * "INVALID BUNDLE" (every field is present, but one is malformed) in the
 * manual "Verify your evidence" flow. `reserveAttestation`/`nostrEvent`
 * must be present as keys (an honest mint may set either to `null` to mean
 * "no evidence of this kind"), but a missing KEY means the bundle doesn't
 * even claim the shape SOLVENT expects.
 */
export const SUBMISSION_BUNDLE_REQUIRED_FIELDS = [
  'proof', 'mint', 'keysetId', 'amountPublicKeyHex', 'receipt', 'manifest',
  'manifestSignature', 'masterPublicKeyHex', 'issuedMmrSize', 'inclusionProof',
  'reserveAttestation', 'nostrEvent',
] as const;

/** Exactly what verifySubmission() consumes, rendered as plain, re-parseable JSON text — no `verified` booleans anywhere (see submission.ts). */
export function submissionBundleToJson(bundle: SubmissionBundle, space = 2): string {
  const plain = { ...bundle, proof: proofToJson(bundle.proof), inclusionProof: inclusionProofToJson(bundle.inclusionProof) };
  return JSON.stringify(plain, null, space);
}

/** The exact inverse of submissionBundleToJson. Throws with a specific message on any structural problem so callers can distinguish "missing field" from "malformed field" (see the manual-mode error taxonomy in verifier-panel.ts). */
export function submissionBundleFromJson(json: string): SubmissionBundle {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Parsed JSON is not an object.');
  }
  const missing = SUBMISSION_BUNDLE_REQUIRED_FIELDS.filter((k) => !(k in parsed));
  if (missing.length > 0) {
    throw new Error(`INCOMPLETE_BUNDLE: missing field(s): ${missing.join(', ')}`);
  }
  let proof: Proof;
  try {
    proof = proofFromJson(parsed.proof as Record<string, unknown>);
  } catch (err) {
    throw new Error(`INVALID_BUNDLE: proof is malformed (${(err as Error).message})`);
  }
  let inclusionProof: InclusionProof | null;
  try {
    inclusionProof = inclusionProofFromJson(parsed.inclusionProof as JsonInclusionProof | null | undefined);
  } catch (err) {
    throw new Error(`INVALID_BUNDLE: inclusionProof is malformed (${(err as Error).message})`);
  }
  return { ...parsed, proof, inclusionProof } as SubmissionBundle;
}
