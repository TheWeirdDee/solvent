// npm run verify:pol-seed-pending -- <path-to-cdk-mintd.sqlite> <keyset_id> <count>
//
// SOLVENT — Phase 2 Step 8 closure: seeds N synthetic, durably-`pending`
// PoL receipt obligations directly into the real mint database — the same
// direct-SQL-manipulation technique already proven for the atomicity test
// (npm run verify:pol-atomicity), applied here to test the recovery
// mechanism specifically. Must run while `cdk-mintd` is stopped.
//
// Tagged `operation_kind = 'batch_mint'` (not `'mint'`) deliberately: these
// rows are NOT backed by a real blind_signature row (unlike every other
// row this project's evidence produces), so they must stay out of
// pol-nut04-reconciliation.ts's real-vs-real cross-check, which only ever
// looks at `operation_kind = 'mint'`. This is a synthetic crash/recovery
// fixture, not a real Cashu operation, and is clearly marked as such
// throughout — see docs/receipt-lifecycle.md.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

function main() {
  const [dbPath, keysetId, countArg] = process.argv.slice(2);
  if (!dbPath || !keysetId || !countArg) {
    throw new Error('usage: pol-seed-pending-receipts.ts <path-to-cdk-mintd.sqlite> <keyset_id> <count>');
  }
  const count = Number(countArg);
  const db = new DatabaseSync(dbPath);

  const seeded: { id: string; blindedMessageHex: string; amount: number }[] = [];
  const amounts = [1, 2, 4, 8, 16, 32, 64, 128];

  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const amount = amounts[i % amounts.length]!;
    const blindedMessageHex = randomBytes(33).toString('hex');
    const liabilityId = randomBytes(16).toString('hex');
    const receiptId = randomBytes(16).toString('hex');
    const message = `Cashu_PoL_Receipt_Issued:${blindedMessageHex}:0`;
    const now = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO solvent_issued_liability
         (id, blinded_message_hex, operation_id, operation_kind, keyset_id, amount, signature_c_hex, created_at)
       VALUES (?, ?, NULL, 'batch_mint', ?, ?, ?, ?)`,
    ).run(liabilityId, blindedMessageHex, keysetId, amount, randomBytes(33).toString('hex'), now);

    db.prepare(
      `INSERT INTO solvent_pol_receipt
         (id, liability_kind, liability_id, keyset_id, amount, message, status, created_at)
       VALUES (?, 'issued', ?, ?, ?, ?, 'pending', ?)`,
    ).run(receiptId, liabilityId, keysetId, amount, Buffer.from(message, 'utf8'), now);

    seeded.push({ id: receiptId, blindedMessageHex, amount });
  }
  db.exec('COMMIT');
  db.close();

  console.log('SOLVENT — SEEDED SYNTHETIC PENDING PoL RECEIPTS\n');
  console.log(`Seeded ${seeded.length} pending receipt(s) for keyset ${keysetId}:`);
  for (const s of seeded) console.log(`  ${s.id} amount=${s.amount} blinded_message=${s.blindedMessageHex}`);
}

main();
