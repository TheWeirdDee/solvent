// npm run verify:pol-nut03-nut07-summary
//
// SOLVENT — Phase 2 NUT-03 evidence correction. Writes
// evidence/real-pol/<run-id>/nut03-nut07-reconciliation.json by collating
// the real `nut07` blocks each scenario script already wrote into its own
// evidence file (each block records the real states the mint's own
// /v1/checkstate returned, at the moment that script checked them). It
// performs no new checks and invents no values: a scenario with no real
// NUT-07 block is listed as `checked: false` with the reason, never
// promoted to a pass.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { currentRunId, writeNut03Evidence } from './nut03-evidence.js';

interface Scenario {
  scenario: string;
  file: string;
}

// Scenarios that make a proof-state claim and are expected to carry a real
// NUT-07 block.
const WITH_NUT07: Scenario[] = [
  { scenario: 'successful swap', file: 'nut03-swap.json' },
  { scenario: 'successful swap after restart', file: 'nut03-swap-post-restart.json' },
  { scenario: 'failed swap', file: 'nut03-failed-swap.json' },
  { scenario: 'double-spend after swap', file: 'nut03-double-spend.json' },
  { scenario: 'response-loss recovery (NUT-09 restore)', file: 'nut03-response-loss.json' },
  { scenario: 'multi-swap', file: 'nut03-multi-swap.json' },
  { scenario: 'crash before commit (originals released after restart)', file: 'nut03-crash-before-commit.json' },
];

// Scenarios whose claim is not a proof-state claim, so NUT-07 is not the
// right instrument — listed so their absence is explicit, not silent.
const WITHOUT_NUT07 = [
  {
    scenario: 'restart (accounting state unchanged)',
    file: 'nut03-restart.json',
    reason: 'the claim is that swap-scoped accounting rows are unchanged across a process restart — measured by real row counts, not proof states. The swap performed after restart has its own NUT-07 block (nut03-swap-post-restart.json).',
  },
  {
    scenario: 'privacy linkage',
    file: 'docs/privacy.md',
    reason: 'a static source/schema audit, not a runtime property — there is no runtime evidence file for it by design',
  },
];

function main() {
  const dir = path.resolve(import.meta.dirname, '..', '..', '..', 'evidence', 'real-pol', currentRunId());

  const rows = WITH_NUT07.map(({ scenario, file }) => {
    const p = path.join(dir, file);
    if (!existsSync(p)) {
      return { scenario, file, present: false, checked: false, pass: false, reason: 'evidence file missing' };
    }
    const json = JSON.parse(readFileSync(p, 'utf8')) as { nut07?: { checked?: boolean; pass?: boolean; originals?: unknown; replacements?: unknown } };
    if (!json.nut07 || json.nut07.checked !== true) {
      return { scenario, file, present: true, checked: false, pass: false, reason: 'file present but carries no real nut07 block' };
    }
    return {
      scenario,
      file,
      present: true,
      checked: true,
      originals: json.nut07.originals ?? null,
      replacements: json.nut07.replacements ?? null,
      pass: json.nut07.pass === true,
    };
  });

  const pass = rows.every((r) => r.checked && r.pass);
  for (const r of rows) {
    console.log(`${r.scenario.padEnd(58)}${r.checked ? (r.pass ? 'PASS' : 'FAIL') : 'NOT CHECKED'}`);
  }
  for (const r of WITHOUT_NUT07) {
    console.log(`${r.scenario.padEnd(58)}N/A (not a proof-state claim)`);
  }

  writeNut03Evidence({
    filename: 'nut03-nut07-reconciliation.json',
    operation: 'nut03_nut07_reconciliation',
    pass,
    data: {
      reconciled_through_nut07: rows,
      not_reconciled_through_nut07: WITHOUT_NUT07,
      method: 'collated from each scenario file\'s own real nut07 block; no new checks performed here',
      invariant: 'P2-S11, P2-S12 (INVARIANTS.md)',
    },
  });

  process.exitCode = pass ? 0 : 1;
}

main();
