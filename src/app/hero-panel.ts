// Illustrative hero terminal panel on the landing page. Uses the REAL v2
// protocol (src/app/protocol-demo.ts) — real blind-signed issuance, a real
// signed PoL receipt, a real signed epoch manifest, and the real central
// verify() decision — computed once on load. This is homepage decoration
// (nobody acts on it directly), but every line is read from a genuine
// VerifyResult; nothing here is a hardcoded REFUSE. See
// docs/trust-boundaries.md, and verifier-panel.ts for the interactive
// version a visitor actually drives.
import { EPOCH_INDEX, runScenario } from './protocol-demo.js';
import { formatSats } from './format.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`hero-panel: missing #${id}`);
  return el as T;
}

export async function renderHeroPanel(): Promise<void> {
  const scenario = await runScenario('omitted');
  const isAccept = scenario.verifyResult.decision === 'ACCEPT';

  byId('hero-epoch').textContent = String(EPOCH_INDEX);
  byId('hero-amount').textContent = `${formatSats(scenario.amount)} verified`;
  byId('hero-receipt-sig').textContent = scenario.verifyResult.checks.receiptValid ? 'SIGNED ✓' : 'INVALID ✕';
  byId('hero-promised-epoch').textContent = String(scenario.receipt.target_epoch);
  byId('hero-epoch-closed').textContent = scenario.verifyResult.checks.targetEpochClosed ? 'CLOSED ✓' : 'OPEN ✕';

  const includedEl = byId('hero-included');
  const included = scenario.verifyResult.checks.inclusionValid;
  includedEl.textContent = included ? 'YES ✓' : 'NO ✕';
  includedEl.classList.toggle('term-neg', !included);

  const reserveEl = byId('hero-reserve');
  reserveEl.textContent = scenario.reserveLive.verified ? `${formatSats(scenario.reserveLive.verifiedReserveSats)} ✓` : 'short';

  const resultEl = byId('hero-result');
  resultEl.textContent = isAccept ? 'ACCEPT' : 'REFUSE';
  resultEl.className = `terminal-result ${isAccept ? 'green' : 'red'}`;
  byId('hero-result-reason').textContent = `Reason: ${scenario.verifyResult.reasonCode}`;
}
