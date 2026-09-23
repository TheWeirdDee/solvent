// npm run verify:live-demo — independently verifies SOLVENT's stable Live
// Public Demo evidence (evidence/nostr/live-demo.json, generated/published
// by `npm run live-demo`): the exact same evidence the browser's "LIVE
// PUBLIC DEMO" case and "Load example bundle" load, run through
// verifyCanonicalLiveDemo() — the ONE canonical loader+verifier every
// caller (browser, this script, `npm run verify:submission`) shares, with
// real network calls (real relay fetch, real Esplora query) — this is a
// real-network gate, deliberately separate from `npm test` (fully mocked,
// deterministic).
//
// Distinct from `npm run verify:submission`, which re-derives Gate 0-6
// mechanism checks from scratch on every run AND requires this canonical
// demo to pass. This command instead checks one specific, already-published
// artifact is still genuinely live and verifiable — so a maintainer/judge
// can tell, before opening the browser, whether `npm run live-demo` needs
// a re-run. No duplicated verification logic lives here — only
// presentation (the freshness-window arithmetic below is display-only; the
// PASS/FAIL/ACCEPT decision itself comes entirely from
// verifyCanonicalLiveDemo()).
import { isPolEvidenceFresh } from '../nostr/pol-event.js';
import { maxAttestationAgeBlocks, RESERVE_FRESHNESS_POLICY } from '../reserve/evaluate.js';
import { CANONICAL_LIVE_DEMO_EVIDENCE_PATH, verifyCanonicalLiveDemo } from '../app/submission.js';

function line(label: string, ok: boolean | 'n/a', detail?: string): string {
  const status = ok === 'n/a' ? 'N/A ' : ok ? 'PASS' : 'FAIL';
  return `${label.padEnd(19)} ${status}${detail ? `  ${detail}` : ''}`;
}

async function main() {
  console.log('SOLVENT — Live Public Demo verifier (canonical)\n');

  // The one real thing: the exact same load + verify pipeline the browser
  // and verify:submission use, with real network calls (no injected mocks
  // here — this command's entire purpose is to prove the real thing still
  // works).
  const { result, reserveLive, nostrLive, bundle, evidenceSource, publishedAt } = await verifyCanonicalLiveDemo();

  // Nostr freshness — independent of whether it's found on a relay; this is
  // purely "is the signed content itself still within its own claimed
  // validity window". Display-only (verifyCanonicalLiveDemo's own
  // nostrLive.verified already reflects the real gate).
  const nostrContent = JSON.parse(bundle.nostrEvent!.content) as { issued_at: number; valid_until: number };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nostrFresh = isPolEvidenceFresh(nostrContent, nowSeconds);
  const nostrExpiresAt = new Date(nostrContent.valid_until * 1000).toISOString();

  // Reserve freshness display — network-aware (see maxAttestationAgeBlocks
  // in src/reserve/evaluate.ts): a flat block count is not a portable unit
  // across networks with different block cadences. Display-only; the real
  // gate is reserveLive.verified, computed inside verifyCanonicalLiveDemo().
  const network = bundle.reserveAttestation!.statement.network;
  const maxAgeBlocks = maxAttestationAgeBlocks(network);
  const secondsPerBlock = RESERVE_FRESHNESS_POLICY.secondsPerBlockByNetwork[network] ?? RESERVE_FRESHNESS_POLICY.defaultSecondsPerBlock;
  const reserveAgeBlocks = reserveLive.tipHeight !== undefined ? reserveLive.tipHeight - bundle.reserveAttestation!.statement.block_height : null;
  const reserveFresh: boolean | 'n/a' = reserveAgeBlocks === null ? 'n/a' : reserveAgeBlocks <= maxAgeBlocks;
  const blocksUntilReserveExpiry = reserveAgeBlocks === null ? null : maxAgeBlocks - reserveAgeBlocks;
  const reserveExpiresAt = blocksUntilReserveExpiry === null ? null : new Date(Date.now() + blocksUntilReserveExpiry * secondsPerBlock * 1000).toISOString();

  console.log(`Evidence source:      ${evidenceSource} (${CANONICAL_LIVE_DEMO_EVIDENCE_PATH})`);
  console.log(`Published at:         ${publishedAt}`);
  console.log(`Nostr event id:       ${bundle.nostrEvent!.id}`);
  console.log(`Mint identity:        ${bundle.masterPublicKeyHex}`);
  console.log(`Reserve network:      ${network} (freshness budget: ${maxAgeBlocks} blocks ~= ${(RESERVE_FRESHNESS_POLICY.targetSeconds / 3600).toFixed(1)}h at ~${secondsPerBlock}s/block)`);
  console.log('');
  console.log(line('Nostr relay', nostrLive.relayReachable));
  console.log(line('Exact event', nostrLive.eventFetched, nostrLive.eventFetched ? 'FOUND' : 'NOT FOUND'));
  console.log(line('Nostr freshness', nostrFresh, `expires ${nostrExpiresAt}`));
  console.log(line('Reserve UTXO', reserveLive.queryOk && reserveLive.verified, reserveLive.detail));
  console.log(line('Reserve freshness', reserveFresh, reserveAgeBlocks === null ? 'could not check tip height' : `~${reserveAgeBlocks} blocks old (max ${maxAgeBlocks}), expires ~${reserveExpiresAt}`));
  console.log(line('Decision', result.decision === 'ACCEPT', result.decision === 'ACCEPT' ? result.reasonCode : `${result.reasonCode} — ${result.reason}`));
  console.log('');

  const allPass = result.decision === 'ACCEPT';

  if (!allPass) {
    if (!nostrFresh || reserveFresh === false) {
      console.log('LIVE DEMO EVIDENCE EXPIRED — the public demo evidence needs to be refreshed. This is a demo-evidence freshness failure, not a verifier failure. Run `npm run live-demo` to regenerate and republish it (see docs/trust-boundaries.md\'s "Making regeneration safe" for exactly what that does and does not require redeploying).');
    } else {
      console.log(`LIVE DEMO VERIFICATION FAILED — ${result.reason}`);
    }
  } else {
    console.log('LIVE DEMO VERIFIED — genuinely public, genuinely fresh, genuinely ACCEPT_VERIFIED.');
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-live-demo crashed:', err);
  process.exit(1);
});
