// Claims that audits found false or stale must not creep back into the
// current-facing documents or the app. Historical logs (DECISIONS.md, the
// PRD, captured evidence) are deliberately not scanned: they record what was
// true at the time.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CURRENT_DOCS = [
  'README.md',
  'PROTOCOL.md',
  'VERIFY_IN_5_MINUTES.md',
  'index.html',
  'docs/start-here.md',
  'docs/getting-started.md',
  'docs/DEMO-RUNBOOK.md',
  'docs/verification-bundle.md',
  'docs/nostr-schema.md',
  'docs/event-schema.md',
  'docs/phase3b-public-evidence.md',
  'docs/trust-boundaries.md',
  'docs/DEPLOY-REAL-MINT.md',
  'docs/reserve-attestation.md',
  'evidence/README.md',
  'src/app/faq-data.ts',
  'src/app/decision-view.ts',
];

const STALE: { claim: RegExp; why: string }[] = [
  { claim: /live-funding blocker/i, why: 'the reserve is funded' },
  { claim: /each refused for the right reason/i, why: 'A01 and A17 are honest controls that are accepted' },
  { claim: /UI leads with \*\*REFUSE \/ PUBLIC EVIDENCE NOT FOUND/i, why: 'event-not-found is shown as "could not complete" (amber)' },
  { claim: /signature makes it spendable/i, why: 'a signature shows authenticity, not that a token is unspent or redeemable' },
  { claim: /\bnine (verification )?checks\b/i, why: 'there are eight checks plus one final decision' },
  { claim: /covers what (it|the mint) owes/i, why: 'coverage is of the liabilities in the committed accounting state' },
  { claim: /SOLVENT publishes to:\s*\n\s*- `wss:\/\/relay\.damus\.io`/, why: 'damus is part of the historical relay set, not the current one' },
];

describe('current documents carry no claim an audit found stale', () => {
  for (const file of CURRENT_DOCS) {
    it(file, () => {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      const found = STALE.filter((s) => s.claim.test(text)).map((s) => `${s.claim} — ${s.why}`);
      expect(found).toEqual([]);
    });
  }
});
