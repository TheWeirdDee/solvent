// CLI: end-to-end GREEN/RED check for a fixture mint + token, exercising
// the exact same verify() used by the web client.
//
//   npm run verify:fixture -- mint-a t1
//   npm run verify:fixture -- mint-a t-hidden
//   npm run verify:fixture -- mint-b t-b1
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { NostrEvent } from 'nostr-tools';
import { fixturesDir, loadMintFixture, loadTokenProof } from '../mint/load.js';
import { isEventFresh } from '../nostr/event.js';
import { signFreshEvent } from '../nostr/publish-core.js';
import { verify } from '../verifier/rules.js';

function pass(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL';
}

function loadOrSignEvent(mintIdentity: string, now: number): { event: NostrEvent; source: 'cache' | 'local' } {
  const cachePath = path.join(fixturesDir(), '.cache', `${mintIdentity}.event.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as NostrEvent;
    const content = JSON.parse(cached.content) as { issued_at: number; valid_until: number };
    if (isEventFresh(content, now)) {
      return { event: cached, source: 'cache' };
    }
  }
  const fixture = loadMintFixture(mintIdentity);
  const event = signFreshEvent(fixture, mintIdentity, now);
  return { event, source: 'local' };
}

function main() {
  const mintIdentity = process.argv[2];
  const tokenLabel = process.argv[3];
  if (!mintIdentity || !tokenLabel) {
    console.error('usage: npm run verify:fixture -- <mint-identity> <token-label>');
    process.exit(1);
  }

  const fixture = loadMintFixture(mintIdentity);
  const { proof } = loadTokenProof(tokenLabel);
  const now = Math.floor(Date.now() / 1000);
  const { event, source } = loadOrSignEvent(mintIdentity, now);

  const result = verify({ expectedMintIdentity: mintIdentity, fixture, event, proof, now });

  console.log(`SOLVENT verify — mint="${mintIdentity}" token="${tokenLabel}" (event: ${source === 'cache' ? 'cached relay-published' : 'freshly signed locally'})\n`);
  console.log(`Nostr signature   ${pass(result.checks.nostrSignature)}`);
  console.log(`Freshness         ${pass(result.checks.freshness)}`);
  console.log(`Latest event      ${pass(result.checks.latestEvent)}`);
  console.log(`Arithmetic        ${pass(result.checks.arithmetic)}`);
  console.log(`Reserve coverage  ${pass(result.checks.reserveCoverage)}`);
  console.log(`Cashu origin      ${pass(result.checks.cashuOrigin)}`);
  console.log(`DLEQ              ${pass(result.checks.dleq)}`);
  console.log(`C' reconstructed  ${result.details.cPrimeHex ? result.details.cPrimeHex : pass(result.checks.cPrimeReconstruction)}`);
  console.log(`Amount match      ${pass(result.checks.amountMatch)}`);
  console.log(`Mint inclusion    ${pass(result.checks.inclusion)}`);
  console.log(`Proof bundle root ${pass(result.checks.proofBundleRoots)}`);
  console.log();
  console.log(`Liabilities       ${result.details.recomputedLiabilitiesSats ?? '?'} sats`);
  console.log(`Reserve           ${fixture.reserveSats} sats (${fixture.reserveKind})`);
  console.log(`Ratio             ${result.details.ratio === Infinity ? '∞' : result.details.ratio?.toFixed(2)}x`);
  if (result.details.mintLeafHashHex) console.log(`Mint leaf hash    ${result.details.mintLeafHashHex}`);
  console.log();
  console.log(`DECISION          ${result.decision}`);
  console.log(`REASON            ${result.reason}`);

  // RED is a valid, expected demo outcome (not a script failure), so exit 0
  // either way — the DECISION line above is the source of truth.
}

main();
