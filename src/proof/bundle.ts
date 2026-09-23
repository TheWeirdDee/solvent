// Proof bundle: the small JSON-serializable object a verifier needs to
// check that ONE presented issuance is included in a mint's committed
// state. PRD section 9 — kept intentionally small, JSON is fine for Phase 1.
//
// The bundle's roots must match the roots signed in the Nostr event exactly
// (Section 10.4, check #4). A mismatch is RED even if the inclusion path
// inside the bundle verifies fine on its own — otherwise a mint could show
// you a valid-looking proof against a root it never actually published.
import type { InclusionProof, InclusionStep } from './merkle-sum.js';
import { bytesToHex, hexToBytes } from '../encode/canonical.js';

export interface SerializedInclusionStep {
  sibling_hash: string;
  sibling_sum: string;
  position: 'left' | 'right';
}

export interface SerializedInclusionProof {
  leaf_hash: string;
  leaf_sum: string;
  steps: SerializedInclusionStep[];
}

export const LEAF_ENCODING_VERSION = 'SOLVENT_LEAF_MINT_V1';

export interface ProofBundle {
  schema: 'solvent-bundle/v1';
  mint_identity: string;
  keyset_id: string;
  epoch: number;
  leaf_encoding_version: string;
  mint_root: { hash: string; sum_sats: number };
  burn_root: { hash: string; sum_sats: number };
  mint_inclusion: SerializedInclusionProof;
}

export function serializeInclusionProof(proof: InclusionProof): SerializedInclusionProof {
  return {
    leaf_hash: bytesToHex(proof.leaf.hash),
    leaf_sum: proof.leaf.sum.toString(10),
    steps: proof.steps.map((s) => ({
      sibling_hash: bytesToHex(s.siblingHash),
      sibling_sum: s.siblingSum.toString(10),
      position: s.position,
    })),
  };
}

export function deserializeInclusionProof(s: SerializedInclusionProof): InclusionProof {
  const steps: InclusionStep[] = s.steps.map((step) => ({
    siblingHash: hexToBytes(step.sibling_hash),
    siblingSum: BigInt(step.sibling_sum),
    position: step.position,
  }));
  return { leaf: { hash: hexToBytes(s.leaf_hash), sum: BigInt(s.leaf_sum) }, index: -1, steps };
}

export function buildProofBundle(params: {
  mintIdentity: string;
  keysetId: string;
  epoch: number;
  mintRoot: { hashHex: string; sumSats: number };
  burnRoot: { hashHex: string; sumSats: number };
  inclusion: InclusionProof;
}): ProofBundle {
  return {
    schema: 'solvent-bundle/v1',
    mint_identity: params.mintIdentity,
    keyset_id: params.keysetId,
    epoch: params.epoch,
    leaf_encoding_version: LEAF_ENCODING_VERSION,
    mint_root: { hash: params.mintRoot.hashHex, sum_sats: params.mintRoot.sumSats },
    burn_root: { hash: params.burnRoot.hashHex, sum_sats: params.burnRoot.sumSats },
    mint_inclusion: serializeInclusionProof(params.inclusion),
  };
}

/** Roots in the bundle must equal the roots the mint actually signed in its Nostr event, exactly. */
export function bundleRootsMatchSignedRoots(
  bundle: ProofBundle,
  signed: { mintRootHash: string; mintRootSum: number; burnRootHash: string; burnRootSum: number },
): boolean {
  return (
    bundle.mint_root.hash === signed.mintRootHash &&
    bundle.mint_root.sum_sats === signed.mintRootSum &&
    bundle.burn_root.hash === signed.burnRootHash &&
    bundle.burn_root.sum_sats === signed.burnRootSum
  );
}
