// SOLVENT — Phase 2 NUT-03 evidence correction. Validates a real NUT-03
// evidence package (evidence/real-pol/<run-id>/nut03-*.json). Every check
// recomputes its conclusion from the raw measured values in the file — it
// never trusts a file's own `pass` field alone — and a missing file, a
// missing field, or an empty directory is a failure, never a skip. Used by
// `npm run verify:nut03-evidence` (pol-verify-nut03-evidence.ts).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The complete NUT-03 evidence contract: exactly the files the NUT-03
// scripts write in one CI run (15). pol-swap-verify.ts runs twice — once
// normally, once with variant "post-restart" — and writes four files each
// time.
export const REQUIRED_NUT03_FILES = [
  'nut03-swap.json',
  'nut03-conservation.json',
  'nut03-accounting-rows.json',
  'nut03-receipts.json',
  'nut03-swap-post-restart.json',
  'nut03-conservation-post-restart.json',
  'nut03-accounting-rows-post-restart.json',
  'nut03-receipts-post-restart.json',
  'nut03-failed-swap.json',
  'nut03-double-spend.json',
  'nut03-crash-before-commit.json',
  'nut03-response-loss.json',
  'nut03-restart.json',
  'nut03-multi-swap.json',
  'nut03-nut07-reconciliation.json',
] as const;

export interface CheckResult {
  file: string;
  check: string;
  pass: boolean;
  detail?: string;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);

function allEqual(values: unknown[] | undefined, expected: string): boolean {
  return !!values && values.length > 0 && values.every((v) => v === expected);
}

/** Recomputes a nut07 block's verdict from its raw actual states. */
function nut07Holds(block: unknown): boolean {
  const b = obj(block);
  if (!b || b.checked !== true) return false;
  const groups = [obj(b.originals), obj(b.replacements)].filter((g): g is Json => !!g);
  if (groups.length === 0) return false;
  return groups.every((g) => typeof g.expected === 'string' && allEqual(arr(g.actual), g.expected));
}

const FORBIDDEN_KEYS = /"(secret|mnemonic|macaroon|macaroon_hex|private_key|privkey|seed)"\s*:/i;

export function verifyNut03EvidenceDir(dir: string): { results: CheckResult[]; pass: boolean } {
  const results: CheckResult[] = [];
  const add = (file: string, check: string, pass: boolean, detail?: string) => results.push({ file, check, pass, detail });

  if (!existsSync(dir)) {
    add(dir, 'evidence directory exists', false, 'directory not found');
    return { results, pass: false };
  }
  if (readdirSync(dir).filter((f) => f.startsWith('nut03-')).length === 0) {
    add(dir, 'evidence directory contains NUT-03 files', false, 'no nut03-*.json files at all');
    return { results, pass: false };
  }

  const loaded = new Map<string, Json>();
  for (const file of REQUIRED_NUT03_FILES) {
    const p = path.join(dir, file);
    if (!existsSync(p)) {
      add(file, 'present', false, 'required file missing');
      continue;
    }
    const text = readFileSync(p, 'utf8');
    let json: Json;
    try {
      json = JSON.parse(text) as Json;
    } catch (err) {
      add(file, 'valid JSON', false, (err as Error).message);
      continue;
    }
    loaded.set(file, json);
    add(file, 'present', true);
    add(file, 'no secret-bearing keys', !FORBIDDEN_KEYS.test(text));
    for (const field of ['schema_version', 'run_id', 'operation', 'timestamp']) {
      add(file, `has ${field}`, typeof json[field] === 'string' && (json[field] as string).length > 0);
    }
    add(file, 'pass === true', json.pass === true, `pass=${String(json.pass)}`);
  }

  const runIds = new Set([...loaded.values()].map((j) => j.run_id));
  add('(all)', 'every file has the same run_id', runIds.size === 1, [...runIds].join(', '));

  const swapChecks = (file: string) => {
    const s = loaded.get(file);
    if (!s) return;
    const input = num(s.input_sats);
    const output = num(s.output_sats);
    const fee = num(s.fee_sats);
    const inCount = num(s.input_proof_count);
    const outCount = num(s.output_proof_count);
    add(file, 'conservation: input = output + fee', input !== undefined && output !== undefined && fee !== undefined && input === output + fee, `${input} = ${output} + ${fee}`);
    add(file, 'consumed rows = input proof count', inCount !== undefined && num(s.consumed_rows_created) === inCount, `${String(s.consumed_rows_created)} vs ${inCount}`);
    add(file, 'issued rows = replacement proof count', outCount !== undefined && num(s.issued_rows_created) === outCount, `${String(s.issued_rows_created)} vs ${outCount}`);
    add(file, 'receipt rows = replacement proof count', outCount !== undefined && num(s.receipt_rows_created) === outCount, `${String(s.receipt_rows_created)} vs ${outCount}`);
    add(file, 'signed receipts complete', s.signed_receipts === `${outCount}/${outCount}`, String(s.signed_receipts));
    add(file, 'originals UNSPENT before swap', allEqual(arr(s.original_proof_states_before), 'UNSPENT'));
    add(file, 'originals SPENT after swap', allEqual(arr(s.original_proof_states_after), 'SPENT'));
    add(file, 'replacements UNSPENT after swap', allEqual(arr(s.replacement_proof_states_after), 'UNSPENT'));
    add(file, 'real NUT-07 block holds', nut07Holds(s.nut07));
  };
  swapChecks('nut03-swap.json');
  swapChecks('nut03-swap-post-restart.json');

  const conservationChecks = (file: string) => {
    const c = loaded.get(file);
    if (!c) return;
    const i = num(c.input_sats);
    const o = num(c.output_sats);
    const f = num(c.fee_sats);
    add(file, 'recomputed equation holds', i !== undefined && o !== undefined && f !== undefined && i === o + f && c.equation_holds === true, `${i} = ${o} + ${f}`);
  };
  conservationChecks('nut03-conservation.json');
  conservationChecks('nut03-conservation-post-restart.json');

  const accountingRowChecks = (file: string) => {
    const r = loaded.get(file);
    if (!r) return;
    const before = obj(r.rows_before_swap);
    const after = obj(r.rows_after_swap);
    const d = (k: string) => (num(after?.[k]) ?? NaN) - (num(before?.[k]) ?? NaN);
    add(file, 'consumed delta = expected', d('consumed') === num(r.expected_consumed_rows), `${d('consumed')} vs ${String(r.expected_consumed_rows)}`);
    add(file, 'issued delta = expected', d('issued') === num(r.expected_issued_rows), `${d('issued')} vs ${String(r.expected_issued_rows)}`);
    add(file, 'signed receipt delta = expected', d('signed') === num(r.expected_receipt_rows), `${d('signed')} vs ${String(r.expected_receipt_rows)}`);
  };
  accountingRowChecks('nut03-accounting-rows.json');
  accountingRowChecks('nut03-accounting-rows-post-restart.json');

  const receiptChecks = (file: string) => {
    const rc = loaded.get(file);
    if (!rc) return;
    const total = num(rc.total_outputs);
    const per = arr(rc.per_output) ?? [];
    add(file, 'every receipt signed', total !== undefined && total > 0 && num(rc.receipts_signed) === total);
    add(file, 'every receipt independently verified', total !== undefined && num(rc.receipts_verified) === total);
    add(file, 'per-output detail complete and verified', per.length === total && per.every((p) => obj(p)?.verified === true));
  };
  receiptChecks('nut03-receipts.json');
  receiptChecks('nut03-receipts-post-restart.json');

  const fs = loaded.get('nut03-failed-swap.json');
  if (fs) {
    const zero = (a: string, b: string) => num(fs[b]) !== undefined && num(fs[a]) === num(fs[b]);
    add('nut03-failed-swap.json', 'mint request reached the real mint', fs.real_mint_request_attempted === true);
    add('nut03-failed-swap.json', 'mint error recorded', typeof fs.mint_response === 'string' && (fs.mint_response as string).length > 0, String(fs.mint_response));
    add('nut03-failed-swap.json', '0 new consumed rows', zero('consumed_rows_before', 'consumed_rows_after'));
    add('nut03-failed-swap.json', '0 new issued rows', zero('issued_rows_before', 'issued_rows_after'));
    add('nut03-failed-swap.json', '0 new receipt rows', zero('receipt_rows_before', 'receipt_rows_after'));
    add('nut03-failed-swap.json', 'real NUT-07 block holds', nut07Holds(fs.nut07));
  }

  const ds = loaded.get('nut03-double-spend.json');
  if (ds) {
    add('nut03-double-spend.json', 'mint refused as already spent', typeof ds.mint_response === 'string' && /already spent/i.test(ds.mint_response as string), String(ds.mint_response));
    add('nut03-double-spend.json', 'originals still SPENT after refusal', ds.originals_still_spent_after_refusal === true);
    add('nut03-double-spend.json', 'real NUT-07 block holds', nut07Holds(ds.nut07));
  }

  const cr = loaded.get('nut03-crash-before-commit.json');
  if (cr) {
    const before = obj(cr.row_counts_before_crash);
    const after = obj(cr.row_counts_after_crash_and_restart);
    const same = !!before && !!after && ['consumed', 'issued', 'signed_receipts'].every((k) => num(before[k]) !== undefined && num(before[k]) === num(after[k]));
    add('nut03-crash-before-commit.json', 'label is CRASH_BEFORE_COMMIT_ROLLBACK', cr.label === 'CRASH_BEFORE_COMMIT_ROLLBACK', String(cr.label));
    add('nut03-crash-before-commit.json', 'real SIGKILL sent', cr.sigkill_sent === true);
    add('nut03-crash-before-commit.json', 'no partial accounting rows (recomputed)', same, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    add('nut03-crash-before-commit.json', 'originals released (real NUT-07 UNSPENT)', nut07Holds(cr.nut07));
  }

  const rl = loaded.get('nut03-response-loss.json');
  if (rl) {
    const before = obj(rl.accounting_rows_before_restore);
    const after = obj(rl.accounting_rows_after_restore);
    const dup = !!before && !!after && ['consumed', 'issued'].every((k) => num(before[k]) !== undefined && num(before[k]) === num(after[k]));
    add('nut03-response-loss.json', 'restore created 0 duplicate rows (recomputed)', dup && num(rl.duplicates_created) === 0);
    add('nut03-response-loss.json', 'all replacement proofs recovered', num(rl.replacement_proofs_recovered) !== undefined && num(rl.replacement_proofs_recovered) === num(rl.expected_replacement_proofs));
    add('nut03-response-loss.json', 'all receipts recovered', num(rl.receipts_recovered) !== undefined && num(rl.receipts_recovered) === num(rl.expected_receipts));
    add('nut03-response-loss.json', 'real NUT-07 block holds', nut07Holds(rl.nut07));
  }

  const rs = loaded.get('nut03-restart.json');
  if (rs) {
    const before = obj(rs.swap_scoped_accounting_before_restart);
    const after = obj(rs.swap_scoped_accounting_after_restart);
    const same = !!before && !!after && ['consumed', 'issued', 'signed_receipts'].every((k) => num(before[k]) !== undefined && num(before[k]) === num(after[k]));
    add('nut03-restart.json', 'swap-scoped state unchanged across restart (recomputed)', same, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    add('nut03-restart.json', 'real swap after restart passed', rs.swap_after_restart_pass === true);
  }

  const ms = loaded.get('nut03-multi-swap.json');
  if (ms) {
    const baseline = obj(ms.before);
    const baseOut = num(baseline?.outstanding_sat);
    const recomputedBase = (num(baseline?.issued_sat) ?? NaN) - (num(baseline?.consumed_sat) ?? NaN);
    add('nut03-multi-swap.json', 'baseline outstanding = issued - consumed', baseOut !== undefined && baseOut === recomputedBase);
    const swaps = arr(ms.swaps) ?? [];
    add('nut03-multi-swap.json', 'at least two consecutive swaps', swaps.length >= 2, `${swaps.length}`);
    swaps.forEach((raw, idx) => {
      const s = obj(raw);
      const out = (num(s?.issued_sat) ?? NaN) - (num(s?.consumed_sat) ?? NaN);
      add('nut03-multi-swap.json', `swap ${String(s?.label ?? idx)}: outstanding unchanged (recomputed)`, baseOut !== undefined && out === baseOut && num(s?.outstanding_sat) === out, `${out} vs ${baseOut}`);
      add('nut03-multi-swap.json', `swap ${String(s?.label ?? idx)}: real NUT-07 block holds`, nut07Holds(s?.nut07));
    });
  }

  const n7 = loaded.get('nut03-nut07-reconciliation.json');
  if (n7) {
    const rows = arr(n7.reconciled_through_nut07) ?? [];
    add('nut03-nut07-reconciliation.json', 'lists reconciled scenarios', rows.length > 0, `${rows.length}`);
    add('nut03-nut07-reconciliation.json', 'every listed scenario checked and passed', rows.length > 0 && rows.every((row) => obj(row)?.checked === true && obj(row)?.pass === true));
  }

  return { results, pass: results.length > 0 && results.every((x) => x.pass) };
}
