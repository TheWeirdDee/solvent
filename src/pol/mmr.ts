// Append-only sum-MMR (Merkle Mountain Range with Sums), byte-exact to the
// pinned Cashu PR #388 draft
// (github.com/a1denvalu3/nuts/blob/pol-spec/pol.md, "sum-MMR
// Specifications"). Validated against the draft's own test vectors in
// tests/pol/mmr.test.ts (2-leaf, 3-leaf, and a 3->4 consistency vector).
//
// A sum-MMR is a forest of perfect binary Merkle-sum trees ("peaks") with
// strictly decreasing height. Every peak corresponds to a contiguous,
// size-aligned, power-of-two range of leaves — the same set bits that
// describe the leaf count in binary. Peaks are bagged right-to-left into
// one (root_hash, root_sum).
import { sha256 } from '@noble/hashes/sha2.js';

export interface SumNode {
  hash: Uint8Array;
  sum: bigint;
}

const UINT64_MAX = (1n << 64n) - 1n;

function u8(n: bigint): Uint8Array {
  if (n < 0n || n > UINT64_MAX) throw new RangeError(`sum ${n} out of uint64 range`);
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, n, false); // big-endian
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Leaf_issued: hash = SHA256(bytes(B_)); sum = token amount. */
export function issuedLeaf(bPrimeHex: string, amountSats: number | bigint): SumNode {
  return { hash: sha256(hexToBytes(bPrimeHex)), sum: BigInt(amountSats) };
}

/** Leaf_spent: hash = SHA256(bytes(Y)); sum = spent amount. */
export function spentLeaf(yHex: string, amountSats: number | bigint): SumNode {
  return { hash: sha256(hexToBytes(yHex)), sum: BigInt(amountSats) };
}

/** Parent(L, R): sum_P = sum_L + sum_R; hash_P = SHA256(hash_L || hash_R || bytes_8(sum_L) || bytes_8(sum_R)). Fails (throws) if sum overflows uint64. */
export function parent(left: SumNode, right: SumNode): SumNode {
  const sum = left.sum + right.sum;
  if (sum > UINT64_MAX) throw new RangeError('sum-MMR parent: sum_L + sum_R overflows uint64');
  const hash = sha256(concat(left.hash, right.hash, u8(left.sum), u8(right.sum)));
  return { hash, sum };
}

/** Empty MMR root per spec: hash = SHA256(b""), sum = 0. */
export function emptyRoot(): SumNode {
  return { hash: sha256(new Uint8Array(0)), sum: 0n };
}

/** Bag peaks right-to-left into one (root_hash, root_sum). `peaks` must be ordered left-to-right (decreasing height, i.e. P_1..P_k). */
export function bagPeaks(peaks: SumNode[]): SumNode {
  if (peaks.length === 0) return emptyRoot();
  let acc = peaks[peaks.length - 1]!;
  for (let i = peaks.length - 2; i >= 0; i--) {
    acc = parent(peaks[i]!, acc);
  }
  return acc;
}

interface StackPeak extends SumNode {
  height: number;
}

export interface Mmr {
  leaves: SumNode[];
  /** Current peak forest, left to right, strictly decreasing height. */
  peaks: StackPeak[];
}

export function emptyMmr(): Mmr {
  return { leaves: [], peaks: [] };
}

/** Stack-based append: push the leaf at height 0, then merge equal-height top-of-stack pairs. */
export function append(mmr: Mmr, leaf: SumNode): Mmr {
  const stack: StackPeak[] = [...mmr.peaks, { ...leaf, height: 0 }];
  while (stack.length >= 2 && stack[stack.length - 1]!.height === stack[stack.length - 2]!.height) {
    const right = stack.pop()!;
    const left = stack.pop()!;
    const merged = parent(left, right);
    stack.push({ ...merged, height: left.height + 1 });
  }
  return { leaves: [...mmr.leaves, leaf], peaks: stack };
}

export function root(mmr: Mmr): SumNode {
  return bagPeaks(mmr.peaks);
}

export function size(mmr: Mmr): number {
  return mmr.leaves.length;
}

export interface SiblingStep {
  hash: Uint8Array;
  sum: bigint;
  isLeft: boolean; // true: sibling is the LEFT child (current node is the right child)
}

export interface InclusionProof {
  leafIndex: number;
  siblingPath: SiblingStep[];
  peaks: SumNode[]; // all peaks of the MMR at the epoch this proof was drawn from, left to right
}

/**
 * Decompose leaf count `n` into descending powers of two (peak heights,
 * highest first) with each chunk's leaf-index start. Uses division/modulo
 * rather than bitwise shifts, which in JS silently wrap at 32 bits — this
 * stays correct up to Number.MAX_SAFE_INTEGER (2^53), far beyond any
 * realistic fixture/demo MMR size.
 */
function peakChunks(n: number): { start: number; size: number; height: number }[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`peakChunks: ${n} is not a valid non-negative safe integer`);
  const chunks: { start: number; size: number; height: number }[] = [];
  let start = 0;
  for (let h = 52; h >= 0; h--) {
    const bitValue = 2 ** h;
    if (Math.floor(n / bitValue) % 2 === 1) {
      chunks.push({ start, size: bitValue, height: h });
      start += bitValue;
    }
  }
  return chunks;
}

/** Builds the perfect binary Merkle-sum tree over one contiguous power-of-two leaf range, returning every layer (layer 0 = leaves). */
function buildPerfectSubtree(leaves: SumNode[]): SumNode[][] {
  const layers: SumNode[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: SumNode[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(parent(current[i]!, current[i + 1]!));
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

export function getInclusionProof(mmr: Mmr, leafIndex: number): InclusionProof {
  const n = mmr.leaves.length;
  if (leafIndex < 0 || leafIndex >= n) throw new RangeError(`getInclusionProof: index ${leafIndex} out of range for ${n} leaves`);

  const chunks = peakChunks(n);
  const chunk = chunks.find((c) => leafIndex >= c.start && leafIndex < c.start + c.size)!;
  const chunkLeaves = mmr.leaves.slice(chunk.start, chunk.start + chunk.size);
  const layers = chunk.size === 1 ? [chunkLeaves] : buildPerfectSubtree(chunkLeaves);

  const siblingPath: SiblingStep[] = [];
  let idx = leafIndex - chunk.start;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx]!;
    siblingPath.push({ hash: sibling.hash, sum: sibling.sum, isLeft: isRight });
    idx = Math.floor(idx / 2);
  }

  const peaks = mmr.peaks.map((p) => ({ hash: p.hash, sum: p.sum }));
  return { leafIndex, siblingPath, peaks };
}

/**
 * Derive (never trust) the leaf's global position implied by a sibling
 * path and the peak it resolves to, given the MMR's committed size.
 * Returns -1 if the path is inconsistent with `mmrSize` (wrong length, or
 * resolves to a peak/height that size's bit-decomposition doesn't have).
 */
export function derivePosition(pathLength: number, resolvedPeak: SumNode, mmrSize: number, localOffset: number): number {
  const chunks = peakChunks(mmrSize);
  const chunkIndex = chunks.findIndex((c) => c.height === pathLength);
  if (chunkIndex === -1) return -1;
  const chunk = chunks[chunkIndex]!;
  if (localOffset < 0 || localOffset >= chunk.size) return -1;
  return chunk.start + localOffset;
}

/**
 * Verify an inclusion proof against a committed MMR size and root.
 *
 * 1. Walk the leaf up its sibling path (never trusting `proof.leafIndex`).
 * 2. Derive the expected peak heights from `mmrSize`'s bit decomposition
 *    and require the path to end at the unique matching-height peak.
 * 3. Require that resolved peak to equal the corresponding entry of
 *    `proof.peaks` exactly.
 * 4. Bag `proof.peaks` right-to-left and require the result to equal the
 *    signed root hash and sum.
 */
export function verifyInclusionProof(leaf: SumNode, proof: InclusionProof, mmrSize: number, expectedRootHash: Uint8Array, expectedRootSum: bigint): boolean {
  let node: SumNode = leaf;
  let localOffset = 0;
  for (let j = 0; j < proof.siblingPath.length; j++) {
    const step = proof.siblingPath[j]!;
    const sibling: SumNode = { hash: step.hash, sum: step.sum };
    node = step.isLeft ? parent(sibling, node) : parent(node, sibling);
    if (step.isLeft) localOffset += 2 ** j; // sibling-is-left implies the proven node was the right child at level j
  }

  const chunks = peakChunks(mmrSize);
  if (proof.peaks.length !== chunks.length) return false;

  const chunkIndex = chunks.findIndex((c) => c.height === proof.siblingPath.length);
  if (chunkIndex === -1) return false;
  if (localOffset < 0 || localOffset >= chunks[chunkIndex]!.size) return false;

  const claimedPeak = proof.peaks[chunkIndex]!;
  if (!bytesEqual(claimedPeak.hash, node.hash) || claimedPeak.sum !== node.sum) return false;

  const bagged = bagPeaks(proof.peaks);
  return bytesEqual(bagged.hash, expectedRootHash) && bagged.sum === expectedRootSum;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
