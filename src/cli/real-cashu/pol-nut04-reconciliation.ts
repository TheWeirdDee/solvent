// npm run verify:pol-nut04 -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 Step 8A: independently reconciles SOLVENT's own
// trigger-populated accounting journal against CDK's own real
// `blind_signature` table, in the same real database file — two
// independent sources of truth inside one real mint, not the journal
// compared only against itself. Must run after a real NUT-04 lifecycle has
// executed (npm run verify:cashu-real) and while `cdk-mintd` is stopped, to
// read the file without a concurrent writer (same pattern as the
// process-restart check).
import { DatabaseSync } from 'node:sqlite';

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-nut04-reconciliation.ts <path-to-cdk-mintd.sqlite>');

  const db = new DatabaseSync(dbPath, { readOnly: true });

  // Real CDK data: every real, fully-signed NUT-04 mint output.
  const cdkRow = db
    .prepare(`SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total FROM blind_signature WHERE operation_kind = 'mint' AND c IS NOT NULL`)
    .get() as { n: number; total: number };

  // SOLVENT's own trigger-populated journal.
  const solventRow = db
    .prepare(`SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total FROM solvent_issued_liability WHERE operation_kind = 'mint'`)
    .get() as { n: number; total: number };

  const receiptRow = db.prepare(`SELECT count(*) AS n FROM solvent_pol_receipt WHERE liability_kind = 'issued'`).get() as { n: number };

  db.close();

  const countMatch = cdkRow.n === solventRow.n;
  const amountMatch = cdkRow.total === solventRow.total;
  const receiptMatch = receiptRow.n === solventRow.n;
  const match = countMatch && amountMatch && receiptMatch;

  console.log('SOLVENT — PHASE 2 NUT-04 ACCOUNTING RECONCILIATION\n');
  console.log(`MINTED AMOUNT:\n${cdkRow.total} sats\n`);
  console.log(`REAL CASHU OUTPUTS:\n${cdkRow.n}\n`);
  console.log(`SOLVENT ISSUED-LIABILITY RECORDS:\n${solventRow.n}\n`);
  console.log(`SUM OF SOLVENT ISSUED LIABILITIES:\n${solventRow.total} sats\n`);
  console.log(`SOLVENT PoL RECEIPT OUTBOX ROWS:\n${receiptRow.n}\n`);
  console.log(`MATCH:\n${match ? 'YES' : 'NO'}`);

  if (!match) {
    console.error(
      `\nPHASE 2 NOT VERIFIED — reconciliation mismatch: count ${cdkRow.n} vs ${solventRow.n} (match=${countMatch}), amount ${cdkRow.total} vs ${solventRow.total} (match=${amountMatch}), receipts ${receiptRow.n} vs issued ${solventRow.n} (match=${receiptMatch})`,
    );
    process.exitCode = 1;
    return;
  }
  if (cdkRow.n === 0) {
    console.error('\nPHASE 2 NOT VERIFIED — zero real mint operations found; nothing was actually reconciled.');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

main();
