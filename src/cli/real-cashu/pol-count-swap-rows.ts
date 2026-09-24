// npm run verify:pol-count-swap -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 NUT-03 continuation: prints a single-line snapshot of
// real swap row counts (consumed-liability rows, replacement issued-
// liability rows, signed receipt rows for those replacements), all scoped
// to operation_kind = 'swap'. Used both as a direct accounting-count check
// and to diff "before" vs "after" a real process kill mid-swap-transaction
// — the counts must be identical if the interrupted transaction
// contributed nothing. See docs/receipt-lifecycle.md's NUT-03 section.
import { DatabaseSync } from 'node:sqlite';

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-count-swap-rows.ts <path-to-cdk-mintd.sqlite>');

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

  console.log(`consumed=${consumed.n} issued=${issued.n} signed_receipts=${signed.n}`);
}

main();
