// Test helper: an in-memory database with the REAL CDK v0.18.1 schema plus
// SOLVENT migrations 0001-0003, and the exact NUT-04 write sequence cdk-mintd
// performs inside one BEGIN IMMEDIATE transaction (same as the simulator in
// closer.test.ts, which exercises the full lifecycle including swaps).
import { computeMessageDigest, schnorrSignDigest, type Proof } from '@cashu/cashu-ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateFixtureKeyset, issue, type MintKeyset } from '../../src/cashu/keys.js';
import { spentY } from '../../src/cashu/reconstruct.js';
import { hexToBytes } from '../../src/pol/mmr.js';

const ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(ROOT, 'evidence/real-pol/cdk-schema-v0.18.1.sql'), 'utf8');
const MIGRATIONS = ['0001_nut04_issued_liability.sql', '0002_nut03_consumed_liability.sql', '0003_pol_epoch_lifecycle.sql'].map((f) =>
  readFileSync(join(ROOT, 'migrations/solvent-accounting', f), 'utf8'),
);
export const AMOUNTS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

export function createMintDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}

export interface Issued {
  proof: Proof;
  blindedMessageHex: string;
  amount: number;
}

export interface Prepared {
  amount: number;
  item: ReturnType<typeof issue>;
}

export class CdkSim {
  constructor(
    readonly db: DatabaseSync,
    readonly keyset: MintKeyset = generateFixtureKeyset(AMOUNTS),
  ) {
    db.prepare(
      `INSERT OR IGNORE INTO keyset (id, unit, active, valid_from, derivation_path, input_fee_ppk, derivation_path_index, amounts)
       VALUES (?, 'sat', 1, 0, 'm/0''/0''/0''', 0, 0, ?)`,
    ).run(keyset.keysetId, JSON.stringify(AMOUNTS));
  }

  /** A wallet's output prepared before minting: its blinded message B_ is known before the mint sees it. */
  prepare(amount: number): Prepared {
    return { amount, item: issue(this.keyset, amount, `mint-${Math.random()}`) };
  }

  /** A real NUT-04 mint request: add_blinded_messages, add_blind_signatures, then sign each receipt over its DB-stamped epoch. */
  mint(amounts: number[]): Issued[] {
    return this.mintPrepared(amounts.map((a) => this.prepare(a)));
  }

  /** The same NUT-04 request for outputs the wallet prepared in advance. */
  mintPrepared(prepared: Prepared[]): Issued[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = prepared.map(({ amount, item }) => {
        const bm = Buffer.from(hexToBytes(item.bPrimeHex));
        this.db
          .prepare(
            `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index)
             VALUES (?, ?, ?, NULL, NULL, 0, 'mint', ?, 0)`,
          )
          .run(bm, amount, this.keyset.keysetId, `op-${Math.random()}`);
        this.db
          .prepare(`UPDATE blind_signature SET c = ?, dleq_e = ?, dleq_s = ?, signed_time = 0 WHERE blinded_message = ?`)
          .run(Buffer.from(hexToBytes(item.cPrimeHex)), item.proof.dleq!.e, item.proof.dleq!.s, bm);
        const row = this.db
          .prepare(
            `SELECT r.message FROM solvent_pol_receipt r JOIN solvent_issued_liability il ON il.id = r.liability_id
             WHERE il.blinded_message_hex = ? AND r.liability_kind = 'issued'`,
          )
          .get(item.bPrimeHex) as { message: Uint8Array };
        const signature = schnorrSignDigest(computeMessageDigest(new TextDecoder().decode(row.message), true), this.keyset.amounts[amount]!.privateKeyHex);
        this.db
          .prepare(
            `UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ?, signed_at = 0
             WHERE liability_kind = 'issued' AND liability_id = (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ?)`,
          )
          .run(signature, item.bPrimeHex);
        return { proof: item.proof, blindedMessageHex: item.bPrimeHex, amount };
      });
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * A real NUT-03 swap, as SwapSaga does it: inputs recorded PENDING in setup
   * under one operation id, then finalize() signs the replacement outputs
   * (same operation id, each with its PoL receipt) and marks the inputs SPENT
   * in one transaction.
   */
  swap(inputs: Issued[], outputAmounts: number[]): { outputs: Issued[]; inputYs: string[] } {
    return this.spend('swap', inputs, outputAmounts);
  }

  /** A real NUT-05 melt as MeltSaga finalizes it: inputs SPENT, NUT-08 change outputs signed under the same operation id. */
  melt(inputs: Issued[], changeAmounts: number[]): { outputs: Issued[]; inputYs: string[] } {
    return this.spend('melt', inputs, changeAmounts);
  }

  private spend(kind: 'swap' | 'melt', inputs: Issued[], outputAmounts: number[]): { outputs: Issued[]; inputYs: string[] } {
    const operationId = `op-${Math.random()}`;
    const ys = inputs.map((i) => spentY(i.proof.secret));
    this.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < inputs.length; i++) {
      this.db
        .prepare(
          `INSERT INTO proof (y, amount, keyset_id, secret, c, state, quote_id, created_time, operation_kind, operation_id)
           VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, 0, ?, ?)`,
        )
        .run(Buffer.from(hexToBytes(ys[i]!)), inputs[i]!.amount, this.keyset.keysetId, inputs[i]!.proof.secret, Buffer.from(hexToBytes(inputs[i]!.proof.C)), kind, operationId);
    }
    this.db.exec('COMMIT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outputs = outputAmounts.map((amount) => {
        const item = issue(this.keyset, amount, `${kind}-${Math.random()}`);
        const bm = Buffer.from(hexToBytes(item.bPrimeHex));
        this.db
          .prepare(
            `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index)
             VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, 0)`,
          )
          .run(bm, amount, this.keyset.keysetId, kind, operationId);
        this.db
          .prepare(`UPDATE blind_signature SET c = ?, dleq_e = ?, dleq_s = ?, signed_time = 0 WHERE blinded_message = ?`)
          .run(Buffer.from(hexToBytes(item.cPrimeHex)), item.proof.dleq!.e, item.proof.dleq!.s, bm);
        const row = this.db
          .prepare(
            `SELECT r.message FROM solvent_pol_receipt r JOIN solvent_issued_liability il ON il.id = r.liability_id
             WHERE il.blinded_message_hex = ? AND r.liability_kind = 'issued'`,
          )
          .get(item.bPrimeHex) as { message: Uint8Array };
        const signature = schnorrSignDigest(computeMessageDigest(new TextDecoder().decode(row.message), true), this.keyset.amounts[amount]!.privateKeyHex);
        this.db
          .prepare(
            `UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ?, signed_at = 0
             WHERE liability_kind = 'issued' AND liability_id = (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ?)`,
          )
          .run(signature, item.bPrimeHex);
        return { proof: item.proof, blindedMessageHex: item.bPrimeHex, amount };
      });
      for (const y of ys) this.db.prepare(`UPDATE proof SET state = 'SPENT' WHERE y = ?`).run(Buffer.from(hexToBytes(y)));
      this.db.exec('COMMIT');
      return { outputs, inputYs: ys };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
