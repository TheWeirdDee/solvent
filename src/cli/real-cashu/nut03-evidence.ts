// SOLVENT — Phase 2 NUT-03 evidence correction. Real, dedicated
// machine-readable evidence for the NUT-03 swap suite. Every
// evidence/real-pol/<run-id>/nut03-*.json file is written by the exact
// script that computed the value, at the moment it computed it, from the
// same real database/HTTP responses the console output is built from —
// never reconstructed afterward from a log, and never a fixture. See
// DECISIONS.md's evidence-correction entry and docs/receipt-lifecycle.md's
// NUT-03 section.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The real run identifier this evidence belongs to. CI sets SOLVENT_RUN_ID
 * to the real GitHub Actions run id; local runs fall back to a timestamp so
 * the scripts remain runnable outside CI without crashing. */
export function currentRunId(): string {
  return process.env.SOLVENT_RUN_ID ?? `local-${Date.now()}`;
}

export interface Nut03EvidenceInput {
  /** File name under evidence/real-pol/<run-id>/, e.g. "nut03-swap.json". */
  filename: string;
  /** Short machine-readable operation identifier, e.g. "nut03_swap". */
  operation: string;
  pass: boolean;
  /** Everything else: measured values, identifiers, expected/actual, reason/invariant. */
  data: Record<string, unknown>;
}

/** Writes one real NUT-03 evidence file. Returns the absolute path written. */
export function writeNut03Evidence(input: Nut03EvidenceInput): string {
  const runId = currentRunId();
  const dir = path.resolve(import.meta.dirname, '..', '..', '..', 'evidence', 'real-pol', runId);
  mkdirSync(dir, { recursive: true });
  const record = {
    schema_version: '1.0.0',
    run_id: runId,
    operation: input.operation,
    timestamp: new Date().toISOString(),
    pass: input.pass,
    ...input.data,
  };
  const filePath = path.join(dir, input.filename);
  writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(`Wrote NUT-03 evidence: evidence/real-pol/${runId}/${input.filename} (pass=${input.pass})`);
  return filePath;
}

export const NUT07_METHOD = 'real POST /v1/checkstate (NUT-07) against the real mint, via cashu-ts Mint.check({ Ys })';

export interface Nut07Group {
  expected: string;
  actual: string[];
}

/** Standard shape every NUT-03 evidence file uses to record its real NUT-07
 * reconciliation, so nut03-nut07-reconciliation.json can collate them
 * without guessing. A group passes only if it is non-empty and every real
 * state returned by the mint equals the expected state. */
export function nut07Block(args: { originals?: Nut07Group; replacements?: Nut07Group; note?: string }): Record<string, unknown> {
  const ok = (g?: Nut07Group) => !g || (g.actual.length > 0 && g.actual.every((s) => s === g.expected));
  return {
    checked: true,
    method: NUT07_METHOD,
    ...args,
    pass: ok(args.originals) && ok(args.replacements),
  };
}

/** Real swap-scoped row counts, read directly from the real database —
 * the same queries pol-count-swap-rows.ts uses, exposed here so scripts
 * that need a before/after snapshot around one real operation (not just a
 * standalone CLI print) can capture the same real numbers as evidence. */
export function swapRowCounts(dbPath: string): { consumed: number; issued: number; signed: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const consumed = db.prepare(`SELECT count(*) AS n FROM solvent_consumed_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  const issued = db.prepare(`SELECT count(*) AS n FROM solvent_issued_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  const signed = db
    .prepare(
      `SELECT count(*) AS n FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE r.liability_kind = 'issued' AND il.operation_kind = 'swap' AND r.status = 'signed'`,
    )
    .get() as { n: number };
  db.close();
  return { consumed: consumed.n, issued: issued.n, signed: signed.n };
}

/** Real whole-database outstanding-liability totals — see
 * pol-swap-multi.ts for why this is a whole-database delta, not a
 * swap-scoped absolute value. */
export function outstandingTotals(dbPath: string): { issuedSat: number; consumedSat: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const issued = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM solvent_issued_liability`).get() as { n: number };
  const consumed = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM solvent_consumed_liability`).get() as { n: number };
  db.close();
  return { issuedSat: issued.n, consumedSat: consumed.n };
}
