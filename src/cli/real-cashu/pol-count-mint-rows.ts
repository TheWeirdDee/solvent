// npm run verify:pol-count -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 Step 8 crash drill: prints a single-line snapshot of
// real NUT-04 row counts (signed blind_signature rows, solvent liability
// rows, solvent signed-receipt rows), all scoped to operation_kind =
// 'mint'. Used to diff "before" vs "after" a real process kill mid-request
// — the counts must be identical if the interrupted transaction
// contributed nothing (the expected, required outcome — see
// docs/receipt-lifecycle.md).
import { DatabaseSync } from 'node:sqlite';

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-count-mint-rows.ts <path-to-cdk-mintd.sqlite>');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const cdk = db.prepare(`SELECT count(*) AS n FROM blind_signature WHERE operation_kind = 'mint' AND c IS NOT NULL`).get() as { n: number };
  const liability = db.prepare(`SELECT count(*) AS n FROM solvent_issued_liability WHERE operation_kind = 'mint'`).get() as { n: number };
  const signed = db
    .prepare(
      `SELECT count(*) AS n FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE r.liability_kind = 'issued' AND il.operation_kind = 'mint' AND r.status = 'signed'`,
    )
    .get() as { n: number };
  db.close();

  console.log(`cdk=${cdk.n} liability=${liability.n} signed_receipts=${signed.n}`);
}

main();
