import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  bytesEqual,
  emptyRoot,
  getInclusionProof,
  verifyInclusionProof,
  wrapLeaf,
  type SumNode,
} from './merkle-sum.js';

function leaf(label: string, sum: number): SumNode {
  return wrapLeaf(sha256(new TextEncoder().encode(label)), BigInt(sum));
}

describe('merkle-sum tree — structure', () => {
  it('empty tree has a defined root with sum 0', () => {
    const tree = buildTree([]);
    const empty = emptyRoot();
    expect(bytesEqual(tree.root.hash, empty.hash)).toBe(true);
    expect(tree.root.sum).toBe(0n);
  });

  it('single-leaf tree: root equals the wrapped leaf', () => {
    const l = leaf('only', 10);
    const tree = buildTree([l]);
    expect(bytesEqual(tree.root.hash, l.hash)).toBe(true);
    expect(tree.root.sum).toBe(10n);
  });

  it('root sum equals the sum of all leaf sums for even counts', () => {
    const leaves = [leaf('a', 10), leaf('b', 20), leaf('c', 30), leaf('d', 40)];
    const tree = buildTree(leaves);
    expect(tree.root.sum).toBe(100n);
  });

  it('root sum equals the sum of all leaf sums for odd counts (no duplication)', () => {
    const leaves = [leaf('a', 5), leaf('b', 7), leaf('c', 11)];
    const tree = buildTree(leaves);
    expect(tree.root.sum).toBe(23n);
  });

  it('odd leaf count does not duplicate the last leaf (root differs from padding with a copy)', () => {
    const leaves = [leaf('a', 5), leaf('b', 7), leaf('c', 11)];
    const tree = buildTree(leaves);
    // A naive duplicate-last-leaf tree of [a,b,c,c] would produce a different root.
    const duplicated = buildTree([leaf('a', 5), leaf('b', 7), leaf('c', 11), leaf('c', 11)]);
    expect(bytesEqual(tree.root.hash, duplicated.root.hash)).toBe(false);
  });

  it('duplicate leaf content is handled fine (position-based pairing, not content-based)', () => {
    const leaves = [leaf('same', 5), leaf('same', 5)];
    const tree = buildTree(leaves);
    expect(tree.root.sum).toBe(10n);
    const proof0 = getInclusionProof(tree, 0);
    const proof1 = getInclusionProof(tree, 1);
    expect(verifyInclusionProof(proof0, tree.root.hash, tree.root.sum)).toBe(true);
    expect(verifyInclusionProof(proof1, tree.root.hash, tree.root.sum)).toBe(true);
  });

  it('leaf and internal node hashes are domain-separated (no leaf/node confusion)', () => {
    // A 2-leaf tree's root must not equal a "leaf" wrapping the raw concatenation
    // of the two leaf hashes+sums; domain separation prevents second-preimage
    // style leaf/node confusion attacks.
    const l1 = leaf('x', 1);
    const l2 = leaf('y', 2);
    const tree = buildTree([l1, l2]);
    const fakeLeafOfSameContent = wrapLeaf(
      // deliberately NOT the same formula as combine() — just proving root
      // isn't trivially reproducible via wrapLeaf on arbitrary bytes.
      sha256(new Uint8Array([...l1.hash, ...l2.hash])),
      3n,
    );
    expect(bytesEqual(tree.root.hash, fakeLeafOfSameContent.hash)).toBe(false);
  });
});

describe('merkle-sum tree — inclusion proofs', () => {
  const leaves = [leaf('a', 10), leaf('b', 20), leaf('c', 30), leaf('d', 40), leaf('e', 50)];
  const tree = buildTree(leaves);

  it('valid inclusion proof verifies for every leaf', () => {
    for (let i = 0; i < leaves.length; i++) {
      const proof = getInclusionProof(tree, i);
      expect(verifyInclusionProof(proof, tree.root.hash, tree.root.sum)).toBe(true);
    }
  });

  it('mutated leaf data fails verification', () => {
    const proof = getInclusionProof(tree, 1);
    const mutated = { ...proof, leaf: leaf('b-tampered', 20) };
    expect(verifyInclusionProof(mutated, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('mutated leaf amount fails verification', () => {
    const proof = getInclusionProof(tree, 1);
    const mutated = { ...proof, leaf: { ...proof.leaf, sum: 21n } };
    expect(verifyInclusionProof(mutated, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('mutated sibling hash fails verification', () => {
    const proof = getInclusionProof(tree, 1);
    const mutated = {
      ...proof,
      steps: proof.steps.map((s, i) => (i === 0 ? { ...s, siblingHash: sha256(new Uint8Array([9, 9, 9])) } : s)),
    };
    expect(verifyInclusionProof(mutated, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('mutated sibling sum fails verification', () => {
    const proof = getInclusionProof(tree, 1);
    const mutated = { ...proof, steps: proof.steps.map((s, i) => (i === 0 ? { ...s, siblingSum: s.siblingSum + 1n } : s)) };
    expect(verifyInclusionProof(mutated, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('flipped sibling position (path order) fails verification', () => {
    const proof = getInclusionProof(tree, 1);
    const flip = (p: 'left' | 'right'): 'left' | 'right' => (p === 'left' ? 'right' : 'left');
    const mutated = {
      ...proof,
      steps: proof.steps.map((s, i) => (i === 0 ? { ...s, position: flip(s.position) } : s)),
    };
    expect(verifyInclusionProof(mutated, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('a proof for one leaf does not verify against another leaf position (no cross-splicing)', () => {
    const proofA = getInclusionProof(tree, 0);
    const proofB = getInclusionProof(tree, 3);
    const spliced = { ...proofA, steps: proofB.steps };
    expect(verifyInclusionProof(spliced, tree.root.hash, tree.root.sum)).toBe(false);
  });

  it('wrong root sum fails verification even if hash matches', () => {
    const proof = getInclusionProof(tree, 2);
    expect(verifyInclusionProof(proof, tree.root.hash, tree.root.sum + 1n)).toBe(false);
  });
});
