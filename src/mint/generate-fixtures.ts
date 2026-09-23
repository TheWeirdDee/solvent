// Generates the committed demo fixtures under fixtures/. Run with:
//   npm run generate:fixtures
//
// Deliberately does NOT persist a pre-signed Nostr event: a signed event
// carries issued_at/valid_until timestamps, and a fixture baked at generation
// time would silently go stale for whoever clones the repo later. Instead,
// publish.ts and cli/verify-fixture.ts sign a FRESH event at run time from
// the static fixture data (mint identity, keyset, roots, reserve) using the
// same demo Nostr key persisted here — so the demo always works out of the
// box, with zero network dependency for local verification.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMintFixture, type BuildMintFixtureParams } from './build.js';
import type { MintFixture } from './types.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '..', '..', 'fixtures');
const TOKENS_DIR = path.join(FIXTURES_DIR, 'tokens');

// Mint A really issues both T1 (30k) and T_hidden (70k), plus one unrelated
// burn (5k, some other earlier redemption). It only PUBLISHES T1 in its
// mint_root. Reported reserve (40k) looks healthy against the
// UNDERreported liabilities (30k - 5k = 25k) — this is the hero demo beat:
// had T_hidden been honestly counted, true liabilities would be 95k against
// the same 40k reserve.
const MINT_A: BuildMintFixtureParams = {
  mintIdentity: 'mint-a',
  keysetId: 'solvent-mint-a-keyset-v1',
  epoch: 1,
  reserveSats: 40_000,
  validitySeconds: 86_400, // 24h — long enough that a freshly-signed demo event never goes stale mid-session
  mintProofSpecs: [
    { label: 't1', amount: 30_000, secret: 'solvent-fixture-mint-a-t1-secret', published: true },
    { label: 't-hidden', amount: 70_000, secret: 'solvent-fixture-mint-a-t-hidden-secret', published: false },
  ],
  burnSpecs: [{ label: 'b1', amount: 5_000, secret: 'solvent-fixture-mint-a-burn-1-secret' }],
};

// Mint B honestly includes its one issued token, but reserve is short.
const MINT_B: BuildMintFixtureParams = {
  mintIdentity: 'mint-b',
  keysetId: 'solvent-mint-b-keyset-v1',
  epoch: 1,
  reserveSats: 25_000,
  validitySeconds: 86_400,
  mintProofSpecs: [{ label: 't-b1', amount: 50_000, secret: 'solvent-fixture-mint-b-t-b1-secret', published: true }],
  burnSpecs: [{ label: 'b1', amount: 10_000, secret: 'solvent-fixture-mint-b-burn-1-secret' }],
};

function writeJson(filePath: string, data: unknown) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(FIXTURES_DIR, filePath)}`);
}

function generate(params: BuildMintFixtureParams) {
  const { fixture, issuedProofs } = buildMintFixture(params);

  const fixtureOut: MintFixture = fixture;
  writeJson(path.join(FIXTURES_DIR, `${params.mintIdentity}.json`), fixtureOut);

  for (const [label, proof] of Object.entries(issuedProofs)) {
    writeJson(path.join(TOKENS_DIR, `${label}.json`), { mintIdentity: params.mintIdentity, label, proof });
  }

  console.log(
    `${params.mintIdentity}: mint_root=${fixture.mintRoot.sumSats} burn_root=${fixture.burnRoot.sumSats} ` +
      `liabilities=${fixture.liabilitiesSats} reserve=${fixture.reserveSats}\n`,
  );
}

mkdirSync(TOKENS_DIR, { recursive: true });
generate(MINT_A);
generate(MINT_B);
console.log('Fixtures generated. Run `npm run publish:event -- mint-a` to publish a live signed event.');
