// Loads generated fixture/token JSON from disk for the CLI and (later) the UI.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeProofAmounts, type Proof, type ProofLike } from '@cashu/cashu-ts';
import type { MintFixture } from './types.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '..', '..', 'fixtures');

export function loadMintFixture(mintIdentity: string): MintFixture {
  const filePath = path.join(FIXTURES_DIR, `${mintIdentity}.json`);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as MintFixture;
}

export function loadTokenProof(label: string): { mintIdentity: string; label: string; proof: Proof } {
  const filePath = path.join(FIXTURES_DIR, 'tokens', `${label}.json`);
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as { mintIdentity: string; label: string; proof: ProofLike };
  const [proof] = normalizeProofAmounts([parsed.proof]);
  if (!proof) throw new Error(`loadTokenProof: could not normalize proof for token "${label}"`);
  return { mintIdentity: parsed.mintIdentity, label: parsed.label, proof };
}

export function fixturesDir(): string {
  return FIXTURES_DIR;
}
