// NUT-05 (melt) liability accounting against the REAL CDK v0.18.1 schema and
// SOLVENT migrations 0001-0003, driven by the exact write sequence of CDK's
// melt saga (crates/cdk/src/mint/melt/{melt_saga/mod.rs,shared.rs}):
//
//   setup      add_proofs(inputs, PENDING, operation 'melt') + add_blinded_messages(change, c = NULL)
//   TX1        finalize_melt_core: quote -> Paid, update_proofs_state(inputs, SPENT)
//   TX2        process_melt_change: add_blind_signatures(change, c + final amount)
//              + Mint::sign_pol_receipts_in_tx (patches/cdk/0009)
//   failure    compensation removes the PENDING inputs and unsigned outputs
//
// No new SOLVENT schema is involved: the consumed-liability trigger already
// covers operation_kind 'melt' (TX1) and the issued trigger covers change
// signatures (TX2). These tests prove the accounting that falls out of that.
import { computeMessageDigest, schnorrSignDigest } from '@cashu/cashu-ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { issue } from '../../src/cashu/keys.js';
import { spentY } from '../../src/cashu/reconstruct.js';
import { auditClosedEpoch, closeEpoch, deriveKeysetCommitment, issuanceEvidence, openEpoch } from '../../src/epoch/closer.js';
import { hexToBytes } from '../../src/pol/mmr.js';
import { issuedReceiptMessage, verifyIssuedReceipt } from '../../src/pol/receipt.js';
import { CdkSim, createMintDb, type Issued } from './cdk-sim.js';

const KEY = 'aa'.repeat(32);
const ROOT = join(__dirname, '..', '..');
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Change {
  blindedMessageHex: string;
  amount: number;
  cPrimeHex: string;
  dleq: { e: string; s: string };
}

interface Melt {
  operationId: string;
  inputs: Issued[];
  inputYs: string[];
  change: Change[];
}

const buf = (hex: string) => Buffer.from(hexToBytes(hex));

/** setup_melt: inputs recorded PENDING under a melt operation, change outputs recorded unsigned. */
function meltSetup(cdk: CdkSim, inputs: Issued[], changeAmounts: number[]): Melt {
  const operationId = `melt-${Math.random()}`;
  const inputYs = inputs.map((i) => spentY(i.proof.secret));
  const change = changeAmounts.map((amount) => {
    const item = issue(cdk.keyset, amount, `change-${Math.random()}`);
    return { blindedMessageHex: item.bPrimeHex, amount, cPrimeHex: item.cPrimeHex, dleq: { e: item.proof.dleq!.e, s: item.proof.dleq!.s } };
  });
  cdk.db.exec('BEGIN IMMEDIATE');
  inputs.forEach((i, k) =>
    cdk.db
      .prepare(`INSERT INTO proof (y, amount, keyset_id, secret, c, state, quote_id, created_time, operation_kind, operation_id) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, 0, 'melt', ?)`)
      .run(buf(inputYs[k]!), i.amount, cdk.keyset.keysetId, i.proof.secret, buf(i.proof.C), operationId),
  );
  // Blank NUT-08 outputs carry a placeholder amount until TX2 signs them.
  for (const c of change) {
    cdk.db
      .prepare(`INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index) VALUES (?, 1, ?, NULL, NULL, 0, 'melt', ?, 0)`)
      .run(buf(c.blindedMessageHex), cdk.keyset.keysetId, operationId);
  }
  cdk.db.exec('COMMIT');
  return { operationId, inputs, inputYs, change };
}

/** TX1 — finalize_melt_core: the one real transition of the inputs into SPENT. */
function meltTx1(cdk: CdkSim, m: Melt): void {
  cdk.db.exec('BEGIN IMMEDIATE');
  for (const y of m.inputYs) cdk.db.prepare(`UPDATE proof SET state = 'SPENT' WHERE y = ? AND state != 'SPENT'`).run(buf(y));
  cdk.db.exec('COMMIT');
}

/** TX2 — process_melt_change: sign the change (c + final amount), then its receipts in the same transaction (patch 0009). */
function meltTx2(cdk: CdkSim, m: Melt, signCount = m.change.length): void {
  cdk.db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of m.change.slice(0, signCount)) {
      const row = cdk.db.prepare(`SELECT c FROM blind_signature WHERE blinded_message = ?`).get(buf(c.blindedMessageHex)) as { c: Uint8Array | null };
      if (row.c !== null) throw new Error('Duplicate'); // add_blind_signatures: message already signed
      cdk.db
        .prepare(`UPDATE blind_signature SET c = ?, dleq_e = ?, dleq_s = ?, signed_time = 0, amount = ? WHERE blinded_message = ?`)
        .run(buf(c.cPrimeHex), c.dleq.e, c.dleq.s, c.amount, buf(c.blindedMessageHex));
      const r = cdk.db
        .prepare(`SELECT r.message FROM solvent_pol_receipt r JOIN solvent_issued_liability il ON il.id = r.liability_id WHERE il.blinded_message_hex = ?`)
        .get(c.blindedMessageHex) as { message: Uint8Array };
      const sig = schnorrSignDigest(computeMessageDigest(new TextDecoder().decode(r.message), true), cdk.keyset.amounts[c.amount]!.privateKeyHex);
      cdk.db
        .prepare(`UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ?, signed_at = 0 WHERE liability_kind = 'issued' AND liability_id = (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ?)`)
        .run(sig, c.blindedMessageHex);
    }
    cdk.db.exec('COMMIT');
  } catch (e) {
    cdk.db.exec('ROLLBACK');
    throw e;
  }
}

/** Compensation after a failed payment: PENDING inputs and unsigned outputs are removed; nothing reaches SPENT. */
function meltFail(cdk: CdkSim, m: Melt): void {
  cdk.db.exec('BEGIN IMMEDIATE');
  for (const y of m.inputYs) cdk.db.prepare(`DELETE FROM proof WHERE y = ? AND state = 'PENDING'`).run(buf(y));
  for (const c of m.change) cdk.db.prepare(`DELETE FROM blind_signature WHERE blinded_message = ? AND c IS NULL`).run(buf(c.blindedMessageHex));
  cdk.db.exec('COMMIT');
}

const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const meltConsumed = (db: DatabaseSync) => db.prepare(`SELECT proof_y_hex, amount, target_epoch, operation_kind FROM solvent_consumed_liability WHERE operation_kind = 'melt' ORDER BY seq`).all() as { proof_y_hex: string; amount: number; target_epoch: number; operation_kind: string }[];
const meltIssued = (db: DatabaseSync) => db.prepare(`SELECT blinded_message_hex, amount, target_epoch FROM solvent_issued_liability WHERE operation_kind = 'melt' ORDER BY seq`).all() as { blinded_message_hex: string; amount: number; target_epoch: number }[];

/** A melt of `inputs` paying `paid` sats (amount + Lightning fee) returns inputs - paid as change. */
function world() {
  const cdk = new CdkSim(createMintDb());
  const inputs = cdk.mint([512, 256, 128, 64, 32, 8]); // 1000 sat issued
  return { cdk, inputs };
}

describe('NUT-05 melt accounting', () => {
  it('1-5. a paid melt with change: inputs become consumed liabilities, change becomes issued liabilities, both in the open epoch, receipts signed', () => {
    const { cdk, inputs } = world();
    const epoch = openEpoch(cdk.db).epochIndex;
    // Pay 300 sat + 2 sat fee from 1000 sat of inputs -> 698 sat change.
    const m = meltSetup(cdk, inputs, [512, 128, 32, 16, 8, 2]);
    meltTx1(cdk, m);
    meltTx2(cdk, m);

    const consumed = meltConsumed(cdk.db);
    expect(consumed.map((c) => c.proof_y_hex)).toEqual(m.inputYs); // 1
    expect(consumed.every((c) => c.target_epoch === epoch)).toBe(true); // 3
    expect(consumed.reduce((s, c) => s + c.amount, 0)).toBe(1000); // 4

    const issued = meltIssued(cdk.db);
    expect(issued.map((i) => i.blinded_message_hex)).toEqual(m.change.map((c) => c.blindedMessageHex)); // 2
    expect(issued.every((i) => i.target_epoch === epoch)).toBe(true); // 3
    expect(issued.reduce((s, i) => s + i.amount, 0)).toBe(698); // 5 — the real signed amounts, not the placeholder

    for (const c of m.change) {
      const ev = issuanceEvidence(cdk.db, c.blindedMessageHex);
      expect(ev.receiptStatus).toBe('signed');
      expect(ev.receipt.target_epoch).toBe(epoch);
      expect(verifyIssuedReceipt(ev.receipt, c.blindedMessageHex, cdk.keyset.amounts[c.amount]!.publicKeyHex)).toBe(true);
    }
  });

  it('6, 14, 15. after the close, outstanding falls by exactly the ecash destroyed (inputs - change), leaves are exact, audit passes', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs, [512, 128, 32, 16, 8, 2]);
    meltTx1(cdk, m);
    meltTx2(cdk, m);
    const closed = closeEpoch(cdk.db, { manifestPrivateKeyHex: KEY });
    const man = closed.keysets[0]!.manifest;
    expect(man.issued_mmr_root_sum).toBe(1000 + 698);
    expect(man.spent_mmr_root_sum).toBe(1000);
    expect(man.outstanding_balance).toBe(698); // 1000 minted - (1000 in - 698 change) = 698 still redeemable
    const c = deriveKeysetCommitment(cdk.db, cdk.keyset.keysetId, closed.epochIndex);
    expect(c.issuedRows.slice(6).map((r) => r.blinded_message_hex)).toEqual(m.change.map((x) => x.blindedMessageHex));
    expect(c.spentRows.map((r) => r.proof_y_hex)).toEqual(m.inputYs);
    expect(auditClosedEpoch(cdk.db, closed.epochIndex)).toEqual({ epochIndex: closed.epochIndex, ok: true, failures: [] });
  });

  it('a melt with no change (exact inputs) only consumes', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs.slice(0, 1), []); // 512 in, 512 paid
    meltTx1(cdk, m);
    meltTx2(cdk, m);
    expect(meltConsumed(cdk.db).reduce((s, c) => s + c.amount, 0)).toBe(512);
    expect(meltIssued(cdk.db)).toEqual([]);
  });

  it('unused blank change outputs never become liabilities', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs, [512, 128, 32, 16, 8, 2, 1, 1]); // wallet over-supplied outputs
    meltTx1(cdk, m);
    meltTx2(cdk, m, 6); // CDK signs only as many as the change needs
    expect(meltIssued(cdk.db)).toHaveLength(6);
  });

  it('7-8. a failed payment (compensation) records no accounting at all', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs, [512, 128]);
    meltFail(cdk, m);
    expect(meltConsumed(cdk.db)).toEqual([]);
    expect(meltIssued(cdk.db)).toEqual([]);
    expect(count(cdk.db, `SELECT count(*) AS n FROM solvent_pol_receipt r JOIN solvent_issued_liability il ON il.id = r.liability_id WHERE il.operation_kind = 'melt'`)).toBe(0);
  });

  it('9-10. double spend and finalization retries never duplicate accounting', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs, [512, 128, 32, 16, 8, 2]);
    meltTx1(cdk, m);
    meltTx1(cdk, m); // recovery re-runs TX1 on already-SPENT inputs
    meltTx2(cdk, m);
    expect(() => meltTx2(cdk, m)).toThrow('Duplicate'); // a second TX2 is rejected and rolled back
    expect(meltConsumed(cdk.db)).toHaveLength(6);
    expect(meltIssued(cdk.db)).toHaveLength(6);
    // A second melt attempting the same (already SPENT) inputs cannot re-consume them.
    cdk.db.exec('BEGIN IMMEDIATE');
    for (const y of m.inputYs) cdk.db.prepare(`UPDATE proof SET state = 'SPENT' WHERE y = ?`).run(buf(y));
    cdk.db.exec('COMMIT');
    expect(meltConsumed(cdk.db)).toHaveLength(6);
  });

  it('16. TX1 and TX2 are separate CDK transactions: an epoch close between them puts the spend in N and the change in N+1', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs, [512, 128, 32, 16, 8, 2]);
    meltTx1(cdk, m);
    const n = closeEpoch(cdk.db, { manifestPrivateKeyHex: KEY });
    meltTx2(cdk, m);
    const n1 = closeEpoch(cdk.db, { manifestPrivateKeyHex: KEY });
    expect(meltConsumed(cdk.db).every((c) => c.target_epoch === n.epochIndex)).toBe(true);
    expect(meltIssued(cdk.db).every((i) => i.target_epoch === n1.epochIndex)).toBe(true);
    // Between the two commits the mint really had 0 of this user's ecash outstanding; after TX2 it owes the change.
    expect(n.keysets[0]!.manifest.outstanding_balance).toBe(0);
    expect(n1.keysets[0]!.manifest.outstanding_balance).toBe(698);
    expect(auditClosedEpoch(cdk.db, n.epochIndex).ok && auditClosedEpoch(cdk.db, n1.epochIndex).ok).toBe(true);
  });

  it('12-13. a real SIGKILL while TX1 is staged leaves no partial accounting, and the state survives reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solvent-melt-'));
    tempDirs.push(dir);
    const path = join(dir, 'cdk-mintd.sqlite');
    const db = new DatabaseSync(path);
    db.exec(readFileSync(join(ROOT, 'evidence/real-pol/cdk-schema-v0.18.1.sql'), 'utf8'));
    for (const f of ['0001_nut04_issued_liability.sql', '0002_nut03_consumed_liability.sql', '0003_pol_epoch_lifecycle.sql']) {
      db.exec(readFileSync(join(ROOT, 'migrations/solvent-accounting', f), 'utf8'));
    }
    db.exec('PRAGMA journal_mode = WAL');
    const cdk = new CdkSim(db);
    const inputs = cdk.mint([512, 256]);
    const m = meltSetup(cdk, inputs, [512]);
    db.close();

    // A child process opens CDK's TX1 and blocks before COMMIT; the parent kills it.
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec('BEGIN IMMEDIATE');
      for (const y of ${JSON.stringify(m.inputYs)}) db.prepare("UPDATE proof SET state = 'SPENT' WHERE y = ?").run(Buffer.from(y, 'hex'));
      console.log('TX1 staged');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('TX1 never staged')), 20_000);
      child.stdout.on('data', (d: Buffer) => d.toString().includes('TX1 staged') && (clearTimeout(t), resolve()));
    });
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    const after = new DatabaseSync(path);
    expect(count(after, `SELECT count(*) AS n FROM solvent_consumed_liability`)).toBe(0);
    expect(count(after, `SELECT count(*) AS n FROM proof WHERE state = 'PENDING'`)).toBe(2);
    after.close();

    // Recovery re-runs the finalization normally; reopened state persists.
    const again = new CdkSim(new DatabaseSync(path), cdk.keyset);
    meltTx1(again, m);
    meltTx2(again, m);
    again.db.close();
    const reopened = new DatabaseSync(path);
    expect(meltConsumed(reopened).reduce((s, c) => s + c.amount, 0)).toBe(768);
    expect(meltIssued(reopened).reduce((s, i) => s + i.amount, 0)).toBe(512);
    reopened.close();
  }, 40_000);

  it('17. NUT-04 and NUT-03 accounting is unchanged alongside melts', () => {
    const { cdk, inputs } = world();
    const m = meltSetup(cdk, inputs.slice(0, 2), [512]);
    meltTx1(cdk, m);
    meltTx2(cdk, m);
    const more = cdk.mint([4]);
    const ev = issuanceEvidence(cdk.db, more[0]!.blindedMessageHex);
    expect(ev.receipt.target_epoch).toBe(openEpoch(cdk.db).epochIndex);
    expect(count(cdk.db, `SELECT count(*) AS n FROM solvent_issued_liability WHERE operation_kind = 'mint'`)).toBe(7);
    const closed = closeEpoch(cdk.db, { manifestPrivateKeyHex: KEY });
    expect(closed.keysets[0]!.manifest.outstanding_balance).toBe(1000 + 4 - 768 + 512);
    expect(issuedReceiptMessage(more[0]!.blindedMessageHex, closed.epochIndex)).toBe(`Cashu_PoL_Receipt_Issued:${more[0]!.blindedMessageHex}:${closed.epochIndex}`);
  });
});
