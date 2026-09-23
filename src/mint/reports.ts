// Rebuilds a mint's mint_root / burn_root Merkle-sum trees from its fixture
// records, and answers "does a specific issuance have a valid inclusion
// path" by content lookup — mirroring what a real mint's inclusion-proof
// endpoint would answer for a given leaf, just served locally in Phase 1
// (see docs/trust-assumptions.md).
import { bytesEqual, buildTree, getInclusionProof, wrapLeaf, type InclusionProof, type MerkleSumTree } from '../proof/merkle-sum.js';
import { burnLeafHash, burnLeafSum } from '../proof/burn-leaf.js';
import { mintLeafHash, mintLeafSum } from '../proof/mint-leaf.js';
import type { MintFixture } from './types.js';

export interface CompiledReport {
  mintTree: MerkleSumTree;
  burnTree: MerkleSumTree;
}

export function compileReport(fixture: MintFixture): CompiledReport {
  const published = fixture.mintRecords.filter((r) => r.published);
  const mintLeaves = published.map((r) =>
    wrapLeaf(
      mintLeafHash({ keysetId: fixture.keysetId, amount: r.amount, cPrimeHex: r.cPrimeHex }),
      mintLeafSum(r.amount),
    ),
  );
  const mintTree = buildTree(mintLeaves);

  const burnLeaves = fixture.burnRecords.map((r) =>
    wrapLeaf(
      burnLeafHash({ keysetId: fixture.keysetId, amount: r.amount, secretHashHex: r.secretHashHex }),
      burnLeafSum(r.amount),
    ),
  );
  const burnTree = buildTree(burnLeaves);

  return { mintTree, burnTree };
}

/**
 * Finds the inclusion proof for a mint-leaf matching (keysetId, amount, C')
 * by content. Returns null when no published leaf matches — which is
 * exactly the omitted-issuance case: the record may be real, but if the
 * mint never published it, no valid inclusion path can exist.
 */
export function findMintInclusionProof(
  fixture: MintFixture,
  report: CompiledReport,
  params: { amount: number; cPrimeHex: string },
): InclusionProof | null {
  const target = wrapLeaf(
    mintLeafHash({ keysetId: fixture.keysetId, amount: params.amount, cPrimeHex: params.cPrimeHex }),
    mintLeafSum(params.amount),
  );
  const idx = report.mintTree.leaves.findIndex((l) => bytesEqual(l.hash, target.hash) && l.sum === target.sum);
  if (idx === -1) return null;
  return getInclusionProof(report.mintTree, idx);
}

export function liabilitiesSats(fixture: MintFixture): number {
  return fixture.mintRoot.sumSats - fixture.burnRoot.sumSats;
}
