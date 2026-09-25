// Tests the NUT-03 evidence *checker*, not NUT-03 itself. The package built
// here is synthetic test input written to an OS temp directory — never
// under evidence/, never presented as a real run — used only to prove the
// checker fails closed on every corruption class it is meant to catch.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_NUT03_FILES, verifyNut03EvidenceDir } from '../../src/cli/real-cashu/nut03-evidence-verifier.js';

type Json = Record<string, unknown>;

const n7 = (orig?: string[], repl?: string[], origExp = 'SPENT') => ({
  checked: true,
  method: 'synthetic',
  ...(orig ? { originals: { expected: origExp, actual: orig } } : {}),
  ...(repl ? { replacements: { expected: 'UNSPENT', actual: repl } } : {}),
  pass: true,
});

const six = (s: string) => Array(6).fill(s) as string[];

function syntheticPackage(): Record<string, Json> {
  const base = (operation: string) => ({ schema_version: '1.0.0', run_id: 'synthetic-test', operation, timestamp: '2026-01-01T00:00:00.000Z', pass: true });
  const swap = (op: string) => ({
    ...base(op),
    input_sats: 1000,
    input_proof_count: 6,
    output_sats: 1000,
    output_proof_count: 6,
    fee_sats: 0,
    consumed_rows_created: 6,
    issued_rows_created: 6,
    receipt_rows_created: 6,
    signed_receipts: '6/6',
    original_proof_states_before: six('UNSPENT'),
    original_proof_states_after: six('SPENT'),
    replacement_proof_states_after: six('UNSPENT'),
    nut07: n7(six('SPENT'), six('UNSPENT')),
  });
  const conservation = () => ({ ...base('nut03_conservation'), input_sats: 1000, output_sats: 1000, fee_sats: 0, equation_holds: true });
  const accountingRows = () => ({
    ...base('nut03_accounting_rows'),
    rows_before_swap: { consumed: 0, issued: 0, signed: 0 },
    rows_after_swap: { consumed: 6, issued: 6, signed: 6 },
    expected_consumed_rows: 6,
    expected_issued_rows: 6,
    expected_receipt_rows: 6,
  });
  const receipts = () => ({
    ...base('nut03_receipts'),
    receipts_signed: 6,
    receipts_verified: 6,
    total_outputs: 6,
    per_output: Array.from({ length: 6 }, (_, i) => ({ index: i, verified: true })),
  });
  return {
    'nut03-swap.json': swap('nut03_swap'),
    'nut03-swap-post-restart.json': swap('nut03_swap'),
    'nut03-conservation.json': conservation(),
    'nut03-conservation-post-restart.json': conservation(),
    'nut03-accounting-rows.json': accountingRows(),
    'nut03-accounting-rows-post-restart.json': accountingRows(),
    'nut03-receipts.json': receipts(),
    'nut03-receipts-post-restart.json': receipts(),
    'nut03-failed-swap.json': {
      ...base('nut03_failed_swap'),
      real_mint_request_attempted: true,
      mint_response: 'Token Already Spent',
      consumed_rows_before: 6,
      consumed_rows_after: 6,
      issued_rows_before: 6,
      issued_rows_after: 6,
      receipt_rows_before: 6,
      receipt_rows_after: 6,
      nut07: n7(six('SPENT'), six('UNSPENT')),
    },
    'nut03-double-spend.json': {
      ...base('nut03_double_spend'),
      mint_response: 'Token Already Spent',
      originals_still_spent_after_refusal: true,
      nut07: n7(six('SPENT'), six('UNSPENT')),
    },
    'nut03-crash-before-commit.json': {
      ...base('nut03_crash_before_commit'),
      label: 'CRASH_BEFORE_COMMIT_ROLLBACK',
      sigkill_sent: true,
      row_counts_before_crash: { consumed: 6, issued: 6, signed_receipts: 6 },
      row_counts_after_crash_and_restart: { consumed: 6, issued: 6, signed_receipts: 6 },
      nut07: n7(six('UNSPENT'), undefined, 'UNSPENT'),
    },
    'nut03-response-loss.json': {
      ...base('nut03_response_loss_recovery'),
      replacement_proofs_recovered: 6,
      expected_replacement_proofs: 6,
      receipts_recovered: 6,
      expected_receipts: 6,
      accounting_rows_before_restore: { consumed: 12, issued: 12 },
      accounting_rows_after_restore: { consumed: 12, issued: 12 },
      duplicates_created: 0,
      nut07: n7(six('SPENT'), six('UNSPENT')),
    },
    'nut03-restart.json': {
      ...base('nut03_restart'),
      swap_scoped_accounting_before_restart: { consumed: 12, issued: 12, signed_receipts: 12 },
      swap_scoped_accounting_after_restart: { consumed: 12, issued: 12, signed_receipts: 12 },
      swap_after_restart_pass: true,
    },
    'nut03-multi-swap.json': {
      ...base('nut03_multi_swap'),
      before: { issued_sat: 3000, consumed_sat: 2000, outstanding_sat: 1000 },
      swaps: [
        { label: 'A', issued_sat: 4000, consumed_sat: 3000, outstanding_sat: 1000, nut07: n7(six('SPENT'), six('UNSPENT')) },
        { label: 'B', issued_sat: 5000, consumed_sat: 4000, outstanding_sat: 1000, nut07: n7(six('SPENT'), six('UNSPENT')) },
      ],
    },
    'nut03-nut07-reconciliation.json': {
      ...base('nut03_nut07_reconciliation'),
      reconciled_through_nut07: [{ scenario: 'successful swap', checked: true, pass: true }],
    },
  };
}

let dir: string | undefined;

function write(pkg: Record<string, Json>): string {
  dir = mkdtempSync(path.join(tmpdir(), 'nut03-verifier-test-'));
  for (const [name, json] of Object.entries(pkg)) writeFileSync(path.join(dir, name), JSON.stringify(json));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// Every filename the real NUT-03 producer scripts can write, read straight
// from their source. pol-swap-verify.ts's `${variant}` expands to '' and to
// '-post-restart' (the CI workflow calls it with the variant "post-restart").
const PRODUCERS = [
  'pol-swap-verify.ts',
  'pol-swap-double-spend.ts',
  'pol-swap-crash-evidence.ts',
  'pol-swap-restore.ts',
  'pol-swap-restart-evidence.ts',
  'pol-swap-multi.ts',
  'pol-nut03-nut07-summary.ts',
];

function producedFilenames(): string[] {
  const names = new Set<string>();
  for (const script of PRODUCERS) {
    const src = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'cli', 'real-cashu', script), 'utf8');
    for (const m of src.matchAll(/filename:\s*[`'"]([^`'"]+)[`'"]/g)) {
      const raw = m[1]!;
      for (const variant of raw.includes('${variant}') ? ['', '-post-restart'] : ['']) {
        names.add(raw.replace('${variant}', variant));
      }
    }
  }
  return [...names].sort();
}

describe('NUT-03 evidence contract', () => {
  it('the verifier requires exactly the files the producer scripts write (15)', () => {
    expect(producedFilenames()).toEqual([...REQUIRED_NUT03_FILES].sort());
    expect(REQUIRED_NUT03_FILES).toHaveLength(15);
  });
});

describe('NUT-03 evidence verifier', () => {
  it('covers exactly the required file list', () => {
    expect(Object.keys(syntheticPackage()).sort()).toEqual([...REQUIRED_NUT03_FILES].sort());
  });

  it('passes a complete, internally consistent package', () => {
    const { pass, results } = verifyNut03EvidenceDir(write(syntheticPackage()));
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(pass).toBe(true);
  });

  it('fails a directory that does not exist', () => {
    expect(verifyNut03EvidenceDir(path.join(tmpdir(), 'definitely-not-a-real-nut03-dir')).pass).toBe(false);
  });

  it('fails a directory with no NUT-03 files (no silent pass)', () => {
    expect(verifyNut03EvidenceDir(write({})).pass).toBe(false);
  });

  it('fails when a required file is missing', () => {
    const d = write(syntheticPackage());
    unlinkSync(path.join(d, 'nut03-restart.json'));
    expect(verifyNut03EvidenceDir(d).pass).toBe(false);
  });

  const corruptions: Array<[string, (p: Record<string, Json>) => void]> = [
    ['pass=false', (p) => (p['nut03-swap.json']!.pass = false)],
    ['conservation broken', (p) => (p['nut03-swap.json']!.output_sats = 999)],
    ['row counts inconsistent', (p) => (p['nut03-swap.json']!.issued_rows_created = 5)],
    ['signed receipts incomplete', (p) => (p['nut03-receipts.json']!.receipts_verified = 5)],
    ['post-restart receipts incomplete', (p) => (p['nut03-receipts-post-restart.json']!.receipts_signed = 5)],
    ['post-restart accounting rows inconsistent', (p) => ((p['nut03-accounting-rows-post-restart.json']!.rows_after_swap as Json).issued = 5)],
    ['failed swap produced rows', (p) => (p['nut03-failed-swap.json']!.consumed_rows_after = 7)],
    ['crash produced partial rows', (p) => ((p['nut03-crash-before-commit.json']!.row_counts_after_crash_and_restart as Json).issued = 7)],
    ['restore duplicated accounting', (p) => ((p['nut03-response-loss.json']!.accounting_rows_after_restore as Json).consumed = 13)],
    ['restart changed state', (p) => ((p['nut03-restart.json']!.swap_scoped_accounting_after_restart as Json).consumed = 11)],
    [
      'multi-swap moved outstanding liability',
      (p) => {
        const swaps = p['nut03-multi-swap.json']!.swaps as Json[];
        swaps[1]!.issued_sat = 5001;
        swaps[1]!.outstanding_sat = 1001;
      },
    ],
    ['NUT-07 state contradicts claim', (p) => (((p['nut03-swap.json']!.nut07 as Json).originals as Json).actual = ['SPENT', 'UNSPENT'])],
    ['retired crash label', (p) => (p['nut03-crash-before-commit.json']!.label = 'CRASH_AFTER_COMMIT')],
    ['secret-bearing key present', (p) => (p['nut03-swap.json']!.secret = 'x')],
    ['mixed run ids', (p) => (p['nut03-restart.json']!.run_id = 'another-run')],
  ];

  for (const [name, corrupt] of corruptions) {
    it(`fails when ${name}`, () => {
      const pkg = syntheticPackage();
      corrupt(pkg);
      expect(verifyNut03EvidenceDir(write(pkg)).pass).toBe(false);
    });
  }
});
