// npm run verify:pol-atomicity -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 Step 7's "CRITICAL ATOMICITY TEST": proves, against the
// mint's REAL database file (the exact schema `cdk-mintd` itself created and
// migrated — see docs/accounting-model.md), that a failure between the
// SOLVENT accounting trigger firing and the surrounding transaction's commit
// leaves BOTH the CDK economic state and the SOLVENT accounting state
// absent, and that a normal commit leaves BOTH present.
//
// Must run while `cdk-mintd` is stopped (same pattern as the process-restart
// check) — this connects to the database file directly, with no concurrent
// writer, and replays the exact statement sequence CDK's own real code
// issues (crates/cdk-sql-common/src/mint/{quotes.rs,signatures.rs}):
// INSERT ... c = NULL, then UPDATE ... SET c = <value>. Uses synthetic,
// obviously-fake blinded-message values that cannot collide with anything a
// real mint operation would ever produce, and deletes them again after a
// successful commit so they never pollute the real reconciliation check
// that runs later in the same CI job.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(28)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function fakeBlindedMessage(): Buffer {
  return Buffer.concat([Buffer.from([0x02]), randomBytes(32)]);
}

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-atomicity-check.ts <path-to-cdk-mintd.sqlite>');

  const db = new DatabaseSync(dbPath);
  const results: { label: string; ok: boolean; detail?: string }[] = [];
  const record = (label: string, ok: boolean, detail?: string) => {
    results.push({ label, ok, detail });
    console.log(line(label, ok, detail));
  };

  console.log('SOLVENT — PHASE 2 NUT-04 ACCOUNTING ATOMICITY\n');

  // ---- C1/C2-style test: fail AFTER the trigger fires, BEFORE commit -----
  const bmRollback = fakeBlindedMessage();
  db.exec('BEGIN');
  db.prepare(
    `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(bmRollback, 128, 'atomicity-test-keyset', 'atomicity-test-quote', Math.floor(Date.now() / 1000), 'mint', 'atomicity-test-op', 0);
  db.prepare(`UPDATE blind_signature SET c = ? WHERE blinded_message = ?`).run(fakeBlindedMessage(), bmRollback);
  // Simulate a crash between the trigger firing and the surrounding
  // transaction's commit: roll back instead of committing.
  db.exec('ROLLBACK');

  const cdkAfterRollback = db.prepare('SELECT count(*) AS n FROM blind_signature WHERE blinded_message = ?').get(bmRollback) as { n: number };
  const solventAfterRollback = db.prepare('SELECT count(*) AS n FROM solvent_issued_liability WHERE blinded_message_hex = ?').get(bmRollback.toString('hex')) as { n: number };
  const rollbackOk = cdkAfterRollback.n === 0 && solventAfterRollback.n === 0;
  record('CDK issuance after rollback', cdkAfterRollback.n === 0, cdkAfterRollback.n === 0 ? 'ABSENT' : `PRESENT (${cdkAfterRollback.n})`);
  record('SOLVENT accounting after rollback', solventAfterRollback.n === 0, solventAfterRollback.n === 0 ? 'ABSENT' : `PRESENT (${solventAfterRollback.n})`);

  // ---- Same operation, no injected failure: both must be present --------
  const bmCommit = fakeBlindedMessage();
  const signature = fakeBlindedMessage();
  db.exec('BEGIN');
  db.prepare(
    `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(bmCommit, 256, 'atomicity-test-keyset', 'atomicity-test-quote-2', Math.floor(Date.now() / 1000), 'mint', 'atomicity-test-op-2', 0);
  db.prepare(`UPDATE blind_signature SET c = ? WHERE blinded_message = ?`).run(signature, bmCommit);
  db.exec('COMMIT');

  const cdkAfterCommit = db.prepare('SELECT count(*) AS n FROM blind_signature WHERE blinded_message = ?').get(bmCommit) as { n: number };
  const solventLiability = db
    .prepare('SELECT amount, keyset_id FROM solvent_issued_liability WHERE blinded_message_hex = ?')
    .get(bmCommit.toString('hex')) as { amount: number; keyset_id: string } | undefined;
  const solventReceipt = db
    .prepare(
      `SELECT status FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE il.blinded_message_hex = ?`,
    )
    .get(bmCommit.toString('hex')) as { status: string } | undefined;
  const commitOk = cdkAfterCommit.n === 1 && !!solventLiability && solventLiability.amount === 256 && !!solventReceipt && solventReceipt.status === 'pending';
  record('CDK issuance after real commit', cdkAfterCommit.n === 1, cdkAfterCommit.n === 1 ? 'PRESENT' : 'ABSENT');
  record('SOLVENT accounting after real commit', !!solventLiability && solventLiability.amount === 256, solventLiability ? `PRESENT, amount=${solventLiability.amount}` : 'ABSENT');
  record('SOLVENT receipt outbox row after real commit', !!solventReceipt && solventReceipt.status === 'pending', solventReceipt ? `status=${solventReceipt.status}` : 'ABSENT');

  // Clean up the synthetic commit-path rows so they don't pollute the real
  // NUT-04 reconciliation check that runs later against real mint activity.
  db.exec('BEGIN');
  db.prepare('DELETE FROM solvent_pol_receipt WHERE liability_id IN (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ?)').run(bmCommit.toString('hex'));
  db.prepare('DELETE FROM solvent_issued_liability WHERE blinded_message_hex = ?').run(bmCommit.toString('hex'));
  db.prepare('DELETE FROM blind_signature WHERE blinded_message = ?').run(bmCommit);
  db.exec('COMMIT');

  db.close();

  const allPassed = rollbackOk && commitOk;
  console.log('');
  if (allPassed) {
    console.log('NUT-04 ACCOUNTING ATOMICITY VERIFIED');
    process.exitCode = 0;
  } else {
    console.log(`PHASE 2 NOT VERIFIED — atomicity: ${results.filter((r) => !r.ok).map((r) => r.label).join('; ')}`);
    process.exitCode = 1;
  }
}

main();
