// Re-derives every closed epoch's signed commitments from the mint's own
// liability rows and checks them (auditClosedEpoch), read-only. Used to show
// that a restart or crash left the accounting coherent.
//   npx tsx src/cli/audit-epochs.ts <path to cdk-mintd.sqlite>
import { DatabaseSync } from 'node:sqlite';
import { auditClosedEpoch, openEpoch } from '../epoch/closer.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: audit-epochs.ts <cdk-mintd.sqlite>');
  process.exit(2);
}
const db = new DatabaseSync(path, { readOnly: true });
const open = openEpoch(db).epochIndex;
const failures: string[] = [];
for (let e = 1; e < open; e++) {
  const a = auditClosedEpoch(db, e);
  if (!a.ok) failures.push(`epoch ${e}: ${a.failures.join('; ')}`);
}
const counts = db
  .prepare(`SELECT (SELECT count(*) FROM solvent_issued_liability) AS issued, (SELECT count(*) FROM solvent_consumed_liability) AS consumed, (SELECT count(*) FROM proof WHERE state = 'SPENT') AS spent`)
  .get() as { issued: number; consumed: number; spent: number };
console.log(JSON.stringify({ open_epoch: open, closed_epochs_audited: open - 1, failures, rows: counts }));
process.exit(failures.length === 0 ? 0 : 1);
