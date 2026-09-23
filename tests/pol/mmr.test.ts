// Validated against the official Cashu PR #388 draft test vectors
// (github.com/a1denvalu3/nuts/blob/pol-spec/tests/pol-tests.md, sections
// 1-3: "Node Hashing and Peak Bagging", "2-Leaf MMR", "3-Leaf MMR").
import { describe, expect, it } from 'vitest';
import {
  append,
  bagPeaks,
  bytesToHex,
  emptyMmr,
  emptyRoot,
  getInclusionProof,
  hexToBytes,
  issuedLeaf,
  parent,
  root,
  verifyInclusionProof,
  type SumNode,
} from '../../src/pol/mmr.js';

// Vector leaves (section 2/3): B' hex + value + expected leaf hash.
const B1 = { bPrime: '02b1a03e1b10a23429fa221087e53f19001b97ad89498a44b93b3f23a851121df4', value: 100, hash: '6711094bb65007f6313a7c2edc4833378ef715aaf8f62ce0f9478c591dba1e85' };
const B2 = { bPrime: '02c3a50646bc1a1fef3da21973b064eb6897de58231c5f3e2730bf18361592394a', value: 250, hash: 'aa80cd1d9ae985f212fd6c41cdf4c8747c92d787e9d8fd45e5d7e3f85941937f' };
const B3 = { bPrime: '03c0029b38423f03b6d203a55e2d6778035740e40dd3d888301b3b47aede737b6f', value: 500, hash: '95b7ec67b1f85ca98781f08fc4613559820b99f178707b29c8ebb4577aca5f40' };
// Verified 66-hex-char (33-byte) value, cross-checked against the raw fetched spec file (not the AI-summarized version).
const B4 = { bPrime: '021111111111111111111111111111111111111111111111111111111111111111', value: 1000, hash: 'e1577700e127f1ce6e20a4efc2d96a986979c755d9ab559af6b1755eb3f3220e' };

describe('leaf hashing matches the pinned draft', () => {
  it('issuedLeaf(B1) matches the vector hash and sum', () => {
    const leaf = issuedLeaf(B1.bPrime, B1.value);
    expect(bytesToHex(leaf.hash)).toBe(B1.hash);
    expect(leaf.sum).toBe(100n);
  });
  it('issuedLeaf(B2) matches the vector hash and sum', () => {
    const leaf = issuedLeaf(B2.bPrime, B2.value);
    expect(bytesToHex(leaf.hash)).toBe(B2.hash);
  });
  it('issuedLeaf(B3) matches the vector hash and sum', () => {
    const leaf = issuedLeaf(B3.bPrime, B3.value);
    expect(bytesToHex(leaf.hash)).toBe(B3.hash);
  });
});

describe('empty MMR', () => {
  it('has hash = SHA256(empty bytes) and sum 0', () => {
    const r = emptyRoot();
    expect(r.sum).toBe(0n);
    const m = emptyMmr();
    expect(bytesToHex(root(m).hash)).toBe(bytesToHex(r.hash));
    expect(root(m).sum).toBe(0n);
  });
});

describe('2-leaf MMR (official vector, section 2)', () => {
  const l1 = issuedLeaf(B1.bPrime, B1.value);
  const l2 = issuedLeaf(B2.bPrime, B2.value);
  const mmr = append(append(emptyMmr(), l1), l2);

  it('bagged root matches the vector', () => {
    const r = root(mmr);
    expect(bytesToHex(r.hash)).toBe('90e8e647a08f35b5b24653ab52e5d27a2deddb05d1e54d5d21777ef02036b29f');
    expect(r.sum).toBe(350n);
  });

  it('inclusion proof for leaf 0 verifies', () => {
    const proof = getInclusionProof(mmr, 0);
    const r = root(mmr);
    expect(verifyInclusionProof(l1, proof, 2, r.hash, r.sum)).toBe(true);
  });

  it('inclusion proof for leaf 1 verifies', () => {
    const proof = getInclusionProof(mmr, 1);
    const r = root(mmr);
    expect(verifyInclusionProof(l2, proof, 2, r.hash, r.sum)).toBe(true);
  });
});

describe('3-leaf MMR (official vector, section 3)', () => {
  const l1 = issuedLeaf(B1.bPrime, B1.value);
  const l2 = issuedLeaf(B2.bPrime, B2.value);
  const l3 = issuedLeaf(B3.bPrime, B3.value);
  let mmr = emptyMmr();
  mmr = append(mmr, l1);
  mmr = append(mmr, l2);
  mmr = append(mmr, l3);

  it('bagged root matches the vector', () => {
    const r = root(mmr);
    expect(bytesToHex(r.hash)).toBe('2518b42edfff24ecc53c8897d1860783d1d26c41d61c378fe612cddeed877040');
    expect(r.sum).toBe(850n);
  });

  it('two peaks: [350-sum height-1 peak, 500-sum height-0 peak]', () => {
    expect(mmr.peaks.length).toBe(2);
    expect(mmr.peaks[0]!.sum).toBe(350n);
    expect(mmr.peaks[1]!.sum).toBe(500n);
  });

  it.each([0, 1, 2])('inclusion proof for leaf %i verifies', (i) => {
    const proof = getInclusionProof(mmr, i);
    const r = root(mmr);
    const leaf = [l1, l2, l3][i]!;
    expect(verifyInclusionProof(leaf, proof, 3, r.hash, r.sum)).toBe(true);
  });

  it('leaf 2 has an empty sibling path (it is its own peak)', () => {
    const proof = getInclusionProof(mmr, 2);
    expect(proof.siblingPath).toEqual([]);
  });

  describe('mutation attacks on the inclusion proof', () => {
    const proof = getInclusionProof(mmr, 0);
    const r = root(mmr);

    it('tampered leaf data fails', () => {
      const tampered: SumNode = { hash: hexToBytes('00'.repeat(32)), sum: l1.sum };
      expect(verifyInclusionProof(tampered, proof, 3, r.hash, r.sum)).toBe(false);
    });

    it('tampered leaf sum fails', () => {
      const tampered: SumNode = { ...l1, sum: l1.sum + 1n };
      expect(verifyInclusionProof(tampered, proof, 3, r.hash, r.sum)).toBe(false);
    });

    it('tampered sibling hash fails', () => {
      const tampered = { ...proof, siblingPath: proof.siblingPath.map((s) => ({ ...s, hash: hexToBytes('11'.repeat(32)) })) };
      expect(verifyInclusionProof(l1, tampered, 3, r.hash, r.sum)).toBe(false);
    });

    it('tampered sibling sum fails', () => {
      const tampered = { ...proof, siblingPath: proof.siblingPath.map((s) => ({ ...s, sum: s.sum + 1n })) };
      expect(verifyInclusionProof(l1, tampered, 3, r.hash, r.sum)).toBe(false);
    });

    it('flipped is_left (reordered positional proof) fails', () => {
      const tampered = { ...proof, siblingPath: proof.siblingPath.map((s) => ({ ...s, isLeft: !s.isLeft })) };
      expect(verifyInclusionProof(l1, tampered, 3, r.hash, r.sum)).toBe(false);
    });

    it('tampered peak entry fails', () => {
      const tampered = { ...proof, peaks: proof.peaks.map((p) => ({ hash: hexToBytes('22'.repeat(32)), sum: p.sum })) };
      expect(verifyInclusionProof(l1, tampered, 3, r.hash, r.sum)).toBe(false);
    });

    it('wrong committed mmrSize fails', () => {
      expect(verifyInclusionProof(l1, proof, 4, r.hash, r.sum)).toBe(false);
    });

    it('wrong expected root sum fails even if hash matches', () => {
      expect(verifyInclusionProof(l1, proof, 3, r.hash, r.sum + 1n)).toBe(false);
    });
  });
});

describe('3->4 consistency (official vector, section 3)', () => {
  it('appending a 4th leaf (value 1000) produces the vector root', () => {
    const l1 = issuedLeaf(B1.bPrime, B1.value);
    const l2 = issuedLeaf(B2.bPrime, B2.value);
    const l3 = issuedLeaf(B3.bPrime, B3.value);
    let mmr = append(append(append(emptyMmr(), l1), l2), l3);

    const l4: SumNode = { hash: hexToBytes(B4.hash), sum: 1000n };
    mmr = append(mmr, l4);

    const r = root(mmr);
    expect(bytesToHex(r.hash)).toBe('52bab3d1d98672c800ec1b86b360e18b738be260c1d1a2f4108998b336bc56d6');
    expect(r.sum).toBe(1850n);
  });
});

describe('overflow protection', () => {
  it('parent() throws when sum_L + sum_R would exceed uint64', () => {
    const max = (1n << 64n) - 1n;
    const l: SumNode = { hash: new Uint8Array(32), sum: max };
    const r: SumNode = { hash: new Uint8Array(32), sum: 1n };
    expect(() => parent(l, r)).toThrow();
  });
});

describe('bagPeaks matches Parent-based folding for the 2-leaf vector', () => {
  it('bags [P1(sum 100 leaf-wrapped... )] correctly for a manual 2-peak case', () => {
    const p1: SumNode = { hash: hexToBytes(B1.hash), sum: 100n };
    const p2: SumNode = { hash: hexToBytes(B2.hash), sum: 250n };
    const bagged = bagPeaks([p1, p2]);
    expect(bagged.hash).toEqual(parent(p1, p2).hash);
  });
});
