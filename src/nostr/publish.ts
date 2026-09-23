// CLI: publishes a freshly-signed SOLVENT solvency event for a fixture mint
// to public Nostr relays.
//
//   npm run publish:event -- mint-a
//
// Signs a NEW event every run (issued_at = now), from the static fixture
// data (roots, reserve, keyset) using the mint's persisted demo Nostr key —
// see mint/generate-fixtures.ts for why the event itself isn't baked into
// the committed fixture. Caches the signed event locally so verify-fixture
// and the browser UI's local fallback can use it without a network round
// trip. Signing/broadcasting logic lives in publish-core.ts, shared with the
// browser publisher panel — this file only adds the CLI's file caching.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixturesDir, loadMintFixture } from '../mint/load.js';
import { RELAYS, publishToRelays, signFreshEvent } from './publish-core.js';

async function main() {
  const mintIdentity = process.argv[2];
  if (!mintIdentity) {
    console.error('usage: npm run publish:event -- <mint-identity>');
    process.exit(1);
  }

  const fixture = loadMintFixture(mintIdentity!);
  const now = Math.floor(Date.now() / 1000);
  const event = signFreshEvent(fixture, mintIdentity!, now);
  const content = JSON.parse(event.content) as {
    mint_root: { hash: string; sum_sats: number };
    burn_root: { hash: string; sum_sats: number };
    liabilities_sats: number;
    reserve_sats: number;
    reserve_kind: string;
    issued_at: number;
    valid_until: number;
  };

  console.log(`Signed solvency event for "${mintIdentity}"`);
  console.log(`  event id       : ${event.id}`);
  console.log(`  mint pubkey    : ${event.pubkey}`);
  console.log(`  mint_root      : ${content.mint_root.hash} (${content.mint_root.sum_sats} sats)`);
  console.log(`  burn_root      : ${content.burn_root.hash} (${content.burn_root.sum_sats} sats)`);
  console.log(`  liabilities    : ${content.liabilities_sats} sats`);
  console.log(`  reserve        : ${content.reserve_sats} sats (${content.reserve_kind})`);
  console.log(`  valid          : ${new Date(content.issued_at * 1000).toISOString()} -> ${new Date(content.valid_until * 1000).toISOString()}`);
  console.log(`  relays         : ${RELAYS.join(', ')}`);

  const results = await publishToRelays(event);
  for (const r of results) {
    console.log(`  [${r.ok ? 'ok  ' : 'fail'}] ${r.relay}: ${r.detail}`);
  }

  const cacheDir = path.join(fixturesDir(), '.cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, `${mintIdentity}.event.json`), JSON.stringify(event, null, 2) + '\n', 'utf8');
  console.log(`\ncached signed event -> fixtures/.cache/${mintIdentity}.event.json`);

  if (!results.some((r) => r.ok)) {
    console.error('\nWARNING: no relay accepted the event. The signed event is still valid and cached locally for verify:fixture.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
