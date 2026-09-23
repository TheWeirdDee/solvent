// Merkle-sum tree: every node commits to BOTH a hash and a sum, and the
// hash cryptographically binds the child hashes AND child sums (so a
// verifier never has to separately "trust" a sum from surrounding JSON —
// the sum is part of what's hashed at every level).
//
// Domain separation follows the RFC 6962 (Certificate Transparency) leaf
// vs. internal-node pattern: a leaf-domain tag and a node-domain tag are
// hashed into every node, so an attacker cannot pass off a leaf as an
// internal node (or vice versa) to forge an inclusion path.
//
// Odd leaf counts: the Bitcoin Merkle tree historically duplicated the last
// leaf to pad odd levels, which enabled a tree-malformation bug
// (CVE-2012-2459). SOLVENT avoids that entirely: an unpaired node at any
// level is promoted to the next level UNCHANGED (not duplicated, not
// re-hashed) rather than paired with a copy of itself.
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, field, fieldStr, u64BEFromSats } from '../encode/canonical.js';

export interface SumNode {
  hash: Uint8Array;
  sum: bigint;
}

const LEAF_DOMAIN = 'SOLVENT_MERKLE_SUM_LEAF_V1';
const NODE_DOMAIN = 'SOLVENT_MERKLE_SUM_NODE_V1';
const EMPTY_DOMAIN = 'SOLVENT_MERKLE_SUM_EMPTY_V1';

/** Wraps a caller-computed leaf hash (e.g. a mint-leaf or burn-leaf hash) into a tree leaf node. */
export function wrapLeaf(leafHash: Uint8Array, sum: bigint): SumNode {
  if (sum < 0n) throw new RangeError('leaf sum must be non-negative');
  const hash = sha256(concatBytes(fieldStr(LEAF_DOMAIN), field(leafHash), u64BEFromSats(sum)));
  return { hash, sum };
}

function combine(left: SumNode, right: SumNode): SumNode {
  const sum = left.sum + right.sum;
  const hash = sha256(
    concatBytes(
      fieldStr(NODE_DOMAIN),
      field(left.hash),
      u64BEFromSats(left.sum),
      field(right.hash),
      u64BEFromSats(right.sum),
    ),
  );
  return { hash, sum };
}

/** The defined root for a tree with zero leaves: a domain-separated empty marker, sum 0. */
export function emptyRoot(): SumNode {
  return { hash: sha256(fieldStr(EMPTY_DOMAIN)), sum: 0n };
}

export interface MerkleSumTree {
  root: SumNode;
  /** Wrapped leaves, in the order they were supplied (== inclusion-proof index order). */
  leaves: SumNode[];
  /** layers[0] is the leaves layer; the last layer is [root]. Empty-tree case: [[root]]. */
  layers: SumNode[][];
}

export function buildTree(leaves: SumNode[]): MerkleSumTree {
  if (leaves.length === 0) {
    const root = emptyRoot();
    return { root, leaves: [], layers: [[root]] };
  }
  const layers: SumNode[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: SumNode[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      next.push(right === undefined ? left : combine(left, right));
    }
    layers.push(next);
    current = next;
  }
  return { root: current[0]!, leaves, layers };
}

export interface InclusionStep {
  siblingHash: Uint8Array;
  siblingSum: bigint;
  /** Where the SIBLING sits relative to the node being carried up. */
  position: 'left' | 'right';
}

export interface InclusionProof {
  leaf: SumNode;
  index: number;
  steps: InclusionStep[];
}

export function getInclusionProof(tree: MerkleSumTree, index: number): InclusionProof {
  if (index < 0 || index >= tree.leaves.length) {
    throw new RangeError(`getInclusionProof: index ${index} out of range for ${tree.leaves.length} leaves`);
  }
  const steps: InclusionStep[] = [];
  let idx = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level]!;
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx];
    if (sibling !== undefined) {
      steps.push({ siblingHash: sibling.hash, siblingSum: sibling.sum, position: isRight ? 'left' : 'right' });
    }
    idx = Math.floor(idx / 2);
  }
  return { leaf: tree.leaves[index]!, index, steps };
}

/**
 * Recomputes the root hash AND root sum from the leaf and inclusion path,
 * and checks both against the signed root. Checking the hash alone is not
 * enough — see PRD 10.1: the sum must be bound into what's verified, not
 * merely read from surrounding JSON.
 */
export function verifyInclusionProof(proof: InclusionProof, rootHash: Uint8Array, rootSum: bigint): boolean {
  let node = proof.leaf;
  for (const step of proof.steps) {
    const sibling: SumNode = { hash: step.siblingHash, sum: step.siblingSum };
    node = step.position === 'left' ? combine(sibling, node) : combine(node, sibling);
  }
  return bytesEqual(node.hash, rootHash) && node.sum === rootSum;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
