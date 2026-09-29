// Phase 3A — the real epoch lifecycle against the REAL CDK v0.18.1 SQLite
// schema (evidence/real-pol/cdk-schema-v0.18.1.sql, dumped from a built
// cdk-sqlite, not hand-written) plus SOLVENT's migrations 0001-0003.
//
// `CdkSim` issues exactly the SQL writes cdk-mintd issues, inside the same
// BEGIN IMMEDIATE transactions (see docs/cdk-integration-seams.md and
// patches/cdk/0007-*.patch), and signs each receipt over the message the
// database stamped — the same path the patched Rust takes. The real mint
// itself is exercised end to end by src/cli/real-cashu/pol-epoch-e2e.ts.
import { computeMessageDigest, createRandomSecretKey, schnorrSignDigest } from '@cashu/cashu-ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { generateFixtureKeyset, issue, type MintKeyset } from '../../src/cashu/keys.js';
import { reconstruct, spentY } from '../../src/cashu/reconstruct.js';
import {
  auditClosedEpoch,
  closeEpoch,
  deriveKeysetCommitment,
  issuanceEvidence,
  loadClosedEpoch,
  manifestPubkeyHex,
  openEpoch,
} from '../../src/epoch/closer.js';
import { verifyManifest, ZERO_DIGEST_HEX } from '../../src/pol/manifest.js';
import { append, bytesToHex, emptyMmr, issuedLeaf, root, spentLeaf, verifyInclusionProof, hexToBytes } from '../../src/pol/mmr.js';
import { issuedReceiptMessage, verifyIssuedReceipt } from '../../src/pol/receipt.js';
import { verify } from '../../src/verifier/verify.js';
import type { Proof } from '@cashu/cashu-ts';

const ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(ROOT, 'evidence/real-pol/cdk-schema-v0.18.1.sql'), 'utf8');
const MIGRATIONS = ['0001_nut04_issued_liability.sql', '0002_nut03_consumed_liability.sql', '0003_pol_epoch_lifecycle.sql'].map((f) =>
  readFileSync(join(ROOT, 'migrations/solvent-accounting', f), 'utf8'),
);
const AMOUNTS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
// File-backed tests set up the full CDK schema through ~79 autocommitted,
// fsynced statements: ~0.3-0.6s on an idle or moderately loaded machine,
// but fsync-bound, so heavy disk contention (e.g. a parallel Rust build) has
// pushed them past Vitest's 5s default. Explicit, and only for these tests.
const FILE_DB_TIMEOUT_MS = 15_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'solvent-epoch-'));
  tempDirs.push(dir);
  return join(dir, 'cdk-mintd.sqlite');
}

function createMintDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}

interface Issued {
  proof: Proof;
  blindedMessageHex: string;
  amount: number;
}

/** Performs cdk-mintd's own write sequence against the database. */
class CdkSim {
  constructor(
    readonly db: DatabaseSync,
    readonly keyset: MintKeyset = generateFixtureKeyset(AMOUNTS),
  ) {
    db.prepare(
      `INSERT OR IGNORE INTO keyset (id, unit, active, valid_from, derivation_path, input_fee_ppk, derivation_path_index, amounts)
       VALUES (?, 'sat', 1, 0, 'm/0''/0''/0''', 0, 0, ?)`,
    ).run(keyset.keysetId, JSON.stringify(AMOUNTS));
  }

  private writeOutputs(outputs: { amount: number; secret: string }[], operationKind: 'mint' | 'swap', operationId: string): Issued[] {
    const issued: Issued[] = [];
    for (const o of outputs) {
      const item = issue(this.keyset, o.amount, o.secret);
      const bm = Buffer.from(hexToBytes(item.bPrimeHex));
      // add_blinded_messages (c NULL), then add_blind_signatures (c set) —
      // the non-batch NUT-04 path and SwapSaga::finalize's path.
      this.db
        .prepare(
          `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, quote_id, created_time, operation_kind, operation_id, order_index)
           VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, 0)`,
        )
        .run(bm, o.amount, this.keyset.keysetId, operationKind, operationId);
      this.db
        .prepare(`UPDATE blind_signature SET c = ?, dleq_e = ?, dleq_s = ?, signed_time = 0 WHERE blinded_message = ?`)
        .run(Buffer.from(hexToBytes(item.cPrimeHex)), item.proof.dleq!.e, item.proof.dleq!.s, bm);
      // Mint::sign_pol_receipts_in_tx — read the DB-stamped message, sign it
      // with the per-amount key, record it (patches/cdk/0007).
      const row = this.db
        .prepare(
          `SELECT r.message FROM solvent_pol_receipt r JOIN solvent_issued_liability il ON il.id = r.liability_id
           WHERE il.blinded_message_hex = ? AND r.liability_kind = 'issued'`,
        )
        .get(item.bPrimeHex) as { message: Uint8Array };
      const digest = computeMessageDigest(new TextDecoder().decode(row.message), true);
      const signature = schnorrSignDigest(digest, this.keyset.amounts[o.amount]!.privateKeyHex);
      this.db
        .prepare(
          `UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ?, signed_at = 0
           WHERE liability_kind = 'issued' AND liability_id = (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ?)`,
        )
        .run(signature, item.bPrimeHex);
      issued.push({ proof: item.proof, blindedMessageHex: item.bPrimeHex, amount: o.amount });
    }
    return issued;
  }

  /** A real NUT-04 mint request: one BEGIN IMMEDIATE transaction. */
  mint(amounts: number[]): Issued[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = this.writeOutputs(
        amounts.map((amount) => ({ amount, secret: `mint-${Math.random()}` })),
        'mint',
        `op-${Math.random()}`,
      );
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** A real NUT-03 swap: inputs recorded PENDING in setup, then finalize() in one transaction. */
  swap(inputs: Issued[], outputAmounts: number[]): { outputs: Issued[]; inputYs: string[] } {
    const operationId = `op-${Math.random()}`;
    const ys = inputs.map((i) => spentY(i.proof.secret));
    this.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < inputs.length; i++) {
      this.db
        .prepare(
          `INSERT INTO proof (y, amount, keyset_id, secret, c, state, quote_id, created_time, operation_kind, operation_id)
           VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, 0, 'swap', ?)`,
        )
        .run(Buffer.from(hexToBytes(ys[i]!)), inputs[i]!.amount, this.keyset.keysetId, inputs[i]!.proof.secret, Buffer.from(hexToBytes(inputs[i]!.proof.C)), operationId);
    }
    this.db.exec('COMMIT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outputs = this.writeOutputs(
        outputAmounts.map((amount) => ({ amount, secret: `swap-${Math.random()}` })),
        'swap',
        operationId,
      );
      for (const y of ys) this.db.prepare(`UPDATE proof SET state = 'SPENT' WHERE y = ?`).run(Buffer.from(hexToBytes(y)));
      this.db.exec('COMMIT');
      return { outputs, inputYs: ys };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

function newKey(): string {
  return bytesToHex(createRandomSecretKey());
}

function epochRows(db: DatabaseSync) {
  return db.prepare(`SELECT epoch_index, state FROM solvent_pol_epoch ORDER BY epoch_index`).all() as { epoch_index: number; state: string }[];
}

function targetEpochOf(db: DatabaseSync, blindedMessageHex: string): number {
  return (db.prepare(`SELECT target_epoch FROM solvent_issued_liability WHERE blinded_message_hex = ?`).get(blindedMessageHex) as { target_epoch: number }).target_epoch;
}

function verifyWithEvidence(cdk: CdkSim, i: Issued, phase3bGates?: { reserveSats: number }) {
  const ev = issuanceEvidence(cdk.db, i.blindedMessageHex);
  if (ev.state !== 'EPOCH_CLOSED') throw new Error('epoch not closed');
  return verify({
    proof: i.proof,
    mint: 'cdk-mintd',
    keysetId: cdk.keyset.keysetId,
    amountPublicKeyHex: cdk.keyset.amounts[i.amount]!.publicKeyHex,
    receipt: ev.receipt,
    manifest: ev.manifest,
    manifestSignature: ev.manifestSignature,
    masterPublicKeyHex: ev.masterPublicKeyHex,
    issuedMmrSize: ev.issuedMmrSize,
    inclusionProof: ev.inclusionProof,
    // Nostr publication and live reserve are Phase 3B. Unless a test
    // explicitly supplies them, they are omitted and verify() fails closed.
    ...(phase3bGates ? { reserve: { verified: true, reserveSats: phase3bGates.reserveSats }, nostr: { verified: true } } : {}),
  });
}

describe('Phase 3A epoch lifecycle — state machine', () => {
  it('1. exactly one OPEN epoch exists after the migration, and a second cannot be opened', () => {
    const db = createMintDb();
    expect(epochRows(db)).toEqual([{ epoch_index: 1, state: 'OPEN' }]);
    expect(() => db.prepare(`INSERT INTO solvent_pol_epoch (epoch_index, state, opened_at) VALUES (2, 'OPEN', 0)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO solvent_pol_epoch (epoch_index, state, opened_at) VALUES (5, 'OPEN', 0)`).run()).toThrow(/contiguously/);
  });

  it('the migration refuses a mint that already holds Phase 2 epoch-0 liabilities', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.prepare(
      `INSERT INTO blind_signature (blinded_message, amount, keyset_id, c, created_time, operation_kind) VALUES (x'02aa', 1, 'k', x'03bb', 0, 'mint')`,
    ).run();
    expect(() => db.exec(MIGRATIONS[2]!)).toThrow(/CHECK constraint/);
  });

  it('6. closing N opens N+1, and exactly one epoch is OPEN afterwards', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    cdk.mint([8]);
    const closed = closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    expect(closed.epochIndex).toBe(1);
    expect(closed.nextOpenEpoch).toBe(2);
    expect(epochRows(db)).toEqual([
      { epoch_index: 1, state: 'CLOSED' },
      { epoch_index: 2, state: 'OPEN' },
    ]);
    expect(openEpoch(db).epochIndex).toBe(2);
  });

  it('5. a closed epoch, its manifests, liability rows and receipt messages are immutable', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [i] = cdk.mint([16]);
    closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    expect(() => db.prepare(`UPDATE solvent_pol_epoch SET global_digest = ? WHERE epoch_index = 1`).run('00'.repeat(32))).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE solvent_pol_epoch SET state = 'OPEN' WHERE epoch_index = 1`).run()).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM solvent_pol_epoch WHERE epoch_index = 1`).run()).toThrow(/never deleted/);
    expect(() => db.prepare(`UPDATE solvent_pol_epoch_keyset SET issued_mmr_root_sum = 0`).run()).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM solvent_pol_epoch_keyset`).run()).toThrow(/never deleted/);
    expect(() => db.prepare(`UPDATE solvent_issued_liability SET target_epoch = 2`).run()).toThrow(/immutable/);
    expect(() => db.prepare(`UPDATE solvent_pol_receipt SET message = x'00'`).run()).toThrow(/immutable/);
    expect(auditClosedEpoch(db, 1).ok).toBe(true);
    expect(targetEpochOf(db, i!.blindedMessageHex)).toBe(1);
  });

  it('an OPEN epoch cannot be closed without all of its keyset manifests', () => {
    const db = createMintDb();
    new CdkSim(db);
    expect(() =>
      db
        .prepare(
          `UPDATE solvent_pol_epoch SET state='CLOSED', closed_at=1, manifest_timestamp='t', previous_global_digest='p', global_digest='g', keyset_count=1, manifest_pubkey='k' WHERE epoch_index=1`,
        )
        .run(),
    ).toThrow(/all of its keyset manifests/);
  });
});

describe('Phase 3A epoch lifecycle — receipt targets', () => {
  it('2. a NUT-04 issuance is stamped with, and its receipt promises, the current open epoch', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [a] = cdk.mint([64]);
    expect(targetEpochOf(db, a!.blindedMessageHex)).toBe(1);
    closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    const [b] = cdk.mint([32]);
    expect(targetEpochOf(db, b!.blindedMessageHex)).toBe(2);

    for (const [i, epoch] of [[a!, 1], [b!, 2]] as const) {
      const ev = issuanceEvidence(db, i.blindedMessageHex);
      expect(ev.receipt.target_epoch).toBe(epoch);
      expect(ev.receiptStatus).toBe('signed');
      const recon = reconstruct(i.proof, cdk.keyset.keysetId, cdk.keyset.amounts[i.amount]!.publicKeyHex);
      expect(recon.bPrimeHex).toBe(i.blindedMessageHex);
      expect(verifyIssuedReceipt(ev.receipt, recon.bPrimeHex!, cdk.keyset.amounts[i.amount]!.publicKeyHex)).toBe(true);
      // No trace of the retired Phase 2 placeholder.
      expect(verifyIssuedReceipt({ ...ev.receipt, target_epoch: 0 }, recon.bPrimeHex!, cdk.keyset.amounts[i.amount]!.publicKeyHex)).toBe(false);
    }
  });

  it('3. NUT-03 swap replacement outputs and consumed inputs are stamped with the open epoch at finalize', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const inputs = cdk.mint([64, 32]);
    closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    const { outputs, inputYs } = cdk.swap(inputs, [64, 16, 16]);
    for (const o of outputs) {
      expect(targetEpochOf(db, o.blindedMessageHex)).toBe(2);
      expect(issuanceEvidence(db, o.blindedMessageHex).receipt.target_epoch).toBe(2);
    }
    const consumed = db.prepare(`SELECT proof_y_hex, target_epoch, operation_kind FROM solvent_consumed_liability ORDER BY seq`).all() as {
      proof_y_hex: string; target_epoch: number; operation_kind: string;
    }[];
    expect(consumed.map((c) => c.proof_y_hex)).toEqual(inputYs);
    expect(consumed.every((c) => c.target_epoch === 2 && c.operation_kind === 'swap')).toBe(true);
  });

  it('a receipt can never promise a closed epoch: a liability targeting one is refused by the database', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    cdk.mint([1]);
    closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    expect(() =>
      db
        .prepare(
          `INSERT INTO solvent_issued_liability (id, blinded_message_hex, operation_kind, keyset_id, amount, signature_c_hex, target_epoch, created_at)
           VALUES ('x', 'ab', 'mint', ?, 1, 'cd', 1, 0)`,
        )
        .run(cdk.keyset.keysetId),
    ).toThrow(/currently open PoL epoch/);
  });

  it('while a close holds the write lock, cdk-mintd cannot start an issuance transaction (BEGIN IMMEDIATE serialises them)', () => {
    const path = newDbFile();
    const closer = createMintDb(path);
    closer.exec('PRAGMA journal_mode = WAL');
    new CdkSim(closer);
    const mintConn = new DatabaseSync(path, { timeout: 0 });
    closer.exec('BEGIN IMMEDIATE');
    expect(() => mintConn.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
    closer.exec('ROLLBACK');
    mintConn.exec('BEGIN IMMEDIATE');
    mintConn.exec('ROLLBACK');
    mintConn.close();
    closer.close();
  }, FILE_DB_TIMEOUT_MS);
});

describe('Phase 3A epoch lifecycle — commitments derive from real rows', () => {
  it('7-9. issued and spent sum-MMRs re-derive from the CDK-backed liability rows; outstanding = issued - spent', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const minted = cdk.mint([512, 256, 128, 64, 32, 8]);
    const swapIn = minted.slice(0, 2);
    const { outputs } = cdk.swap(swapIn, [512, 128, 64, 32, 16, 16]); // 768 in, 768 out
    // A liability row with no real CDK write behind it (the Phase 2
    // synthetic recovery fixture's shape) must never enter a commitment.
    db.prepare(
      `INSERT INTO solvent_issued_liability (id, blinded_message_hex, operation_kind, keyset_id, amount, signature_c_hex, target_epoch, created_at)
       VALUES ('synthetic', ?, 'batch_mint', ?, 999, 'cd', 1, 0)`,
    ).run('02' + 'ee'.repeat(32), cdk.keyset.keysetId);

    const closed = closeEpoch(db, { manifestPrivateKeyHex: newKey() });
    expect(closed.unbackedIssuedRowsExcluded).toBe(1);
    const m = closed.keysets[0]!.manifest;

    // Independent reconstruction straight from what CDK did.
    let issued = emptyMmr();
    for (const i of [...minted, ...outputs]) issued = append(issued, issuedLeaf(i.blindedMessageHex, i.amount));
    let spent = emptyMmr();
    for (const i of swapIn) spent = append(spent, spentLeaf(spentY(i.proof.secret), i.amount));
    const ir = root(issued);
    const sr = root(spent);

    expect(m.issued_mmr_size).toBe(12);
    expect(m.issued_mmr_root_hash).toBe(bytesToHex(ir.hash));
    expect(m.issued_mmr_root_sum).toBe(1000 + 768);
    expect(m.spent_mmr_size).toBe(2);
    expect(m.spent_mmr_root_hash).toBe(bytesToHex(sr.hash));
    expect(m.spent_mmr_root_sum).toBe(768);
    expect(m.outstanding_balance).toBe(1000); // a conserving swap leaves the liability unchanged
    expect(auditClosedEpoch(db, 1)).toEqual({ epochIndex: 1, ok: true, failures: [] });
  });

  it('10. every keyset manifest is signed by the manifest key, and the key cannot silently change', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const key = newKey();
    cdk.mint([4]);
    const closed = closeEpoch(db, { manifestPrivateKeyHex: key });
    expect(closed.manifestPubkey).toBe(manifestPubkeyHex(key));
    for (const k of closed.keysets) expect(verifyManifest(k.manifest, k.manifestSignature, closed.manifestPubkey)).toBe(true);
    expect(() => closeEpoch(db, { manifestPrivateKeyHex: newKey() })).toThrow(/manifest key changed/);
    expect(openEpoch(db).epochIndex).toBe(2);
  });

  it('17. consecutive epochs chain previous_global_digest, and the issued MMR is append-only across them', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const key = newKey();
    cdk.mint([8, 4]);
    const e1 = closeEpoch(db, { manifestPrivateKeyHex: key });
    cdk.mint([2]);
    const e2 = closeEpoch(db, { manifestPrivateKeyHex: key });
    const e3 = closeEpoch(db, { manifestPrivateKeyHex: key }); // empty epoch still closes and chains
    expect(e1.previousGlobalDigest).toBe(ZERO_DIGEST_HEX);
    expect(e2.previousGlobalDigest).toBe(e1.globalDigest);
    expect(e3.previousGlobalDigest).toBe(e2.globalDigest);
    expect(e3.keysets[0]!.manifest.issued_mmr_root_hash).toBe(e2.keysets[0]!.manifest.issued_mmr_root_hash);
    const c1 = deriveKeysetCommitment(db, cdk.keyset.keysetId, 1);
    const c2 = deriveKeysetCommitment(db, cdk.keyset.keysetId, 2);
    expect(c2.issuedRows.slice(0, c1.issuedRows.length)).toEqual(c1.issuedRows);
    for (const e of [1, 2, 3]) expect(auditClosedEpoch(db, e).ok).toBe(true);
  });
});

describe('Phase 3A epoch lifecycle — the hero invariant on real epochs', () => {
  it('11. honest close: the promised issuance is included, and the central verifier accepts once Phase 3B gates pass', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [a, b] = cdk.mint([128, 64]);
    closeEpoch(db, { manifestPrivateKeyHex: newKey() });

    const ev = issuanceEvidence(db, b!.blindedMessageHex);
    expect(ev.state).toBe('EPOCH_CLOSED');
    if (ev.state !== 'EPOCH_CLOSED') return;
    expect(ev.leafIndex).toBe(1);
    expect(
      verifyInclusionProof(issuedLeaf(b!.blindedMessageHex, 64), ev.inclusionProof!, ev.issuedMmrSize, hexToBytes(ev.manifest.issued_mmr_root_hash), BigInt(ev.manifest.issued_mmr_root_sum)),
    ).toBe(true);

    // Without Nostr + reserve (Phase 3B) every PoL check passes and the
    // verifier still refuses to accept — it fails closed.
    const partial = verifyWithEvidence(cdk, b!);
    expect(partial.decision).toBe('REFUSE');
    expect(partial.reasonCode).toBe('REFUSE_UNVERIFIABLE');
    expect(partial.checks).toMatchObject({ receiptValid: true, targetEpochClosed: true, manifestValid: true, liabilityArithmeticValid: true, inclusionValid: true });

    expect(verifyWithEvidence(cdk, a!, { reserveSats: 1_000_000 }).reasonCode).toBe('ACCEPT_VERIFIED');
  });

  it('12-14. broken promise: omission mode excludes exactly the promised issuance, still signs a valid manifest, and the verifier refuses', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [kept, victim, keptToo] = cdk.mint([256, 128, 32]);
    const receiptBefore = issuanceEvidence(db, victim!.blindedMessageHex).receipt;
    const key = newKey();

    const closed = closeEpoch(db, { manifestPrivateKeyHex: key, omitPromisedIssuance: victim!.blindedMessageHex });
    expect(closed.omitted).toMatchObject({ blindedMessageHex: victim!.blindedMessageHex, amount: 128 });

    // 12 — exactly that leaf is missing; the others are there.
    const c = deriveKeysetCommitment(db, cdk.keyset.keysetId, 1);
    expect(c.issuedRows.map((r) => r.blinded_message_hex)).toEqual([kept!.blindedMessageHex, keptToo!.blindedMessageHex]);
    const m = closed.keysets[0]!.manifest;
    expect(m.issued_mmr_root_sum).toBe(256 + 32);
    expect(m.outstanding_balance).toBe(288);

    // 13 — the adversarial epoch is internally consistent and properly signed.
    expect(verifyManifest(m, closed.keysets[0]!.manifestSignature, closed.manifestPubkey)).toBe(true);
    expect(auditClosedEpoch(db, 1).ok).toBe(true);

    // The holder's token and receipt were never touched.
    const ev = issuanceEvidence(db, victim!.blindedMessageHex);
    expect(ev.receipt).toEqual(receiptBefore);
    expect(ev.receipt.target_epoch).toBe(1);
    expect(ev.state === 'EPOCH_CLOSED' && ev.inclusionProof).toBeNull();

    // 14 — even with a healthy reserve and valid publication, REFUSE.
    const result = verifyWithEvidence(cdk, victim!, { reserveSats: 1_000_000 });
    expect(result.decision).toBe('REFUSE');
    expect(result.reasonCode).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(result.checks).toMatchObject({ receiptValid: true, targetEpochClosed: true, manifestValid: true, liabilityArithmeticValid: true });
    expect(verifyWithEvidence(cdk, kept!, { reserveSats: 1_000_000 }).reasonCode).toBe('ACCEPT_VERIFIED');

    // The omission is a consistent lie: later epochs keep it out, so the
    // adversarial issued MMR stays append-only.
    const [later] = cdk.mint([4]);
    closeEpoch(db, { manifestPrivateKeyHex: key });
    const c2 = deriveKeysetCommitment(db, cdk.keyset.keysetId, 2);
    expect(c2.issuedRows.map((r) => r.blinded_message_hex)).toEqual([kept!.blindedMessageHex, keptToo!.blindedMessageHex, later!.blindedMessageHex]);
    expect(auditClosedEpoch(db, 2).ok).toBe(true);
  });

  it('omission mode only accepts an issuance promised to the epoch being closed', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const key = newKey();
    const [old] = cdk.mint([2]);
    closeEpoch(db, { manifestPrivateKeyHex: key });
    expect(() => closeEpoch(db, { manifestPrivateKeyHex: key, omitPromisedIssuance: old!.blindedMessageHex })).toThrow(/promised to epoch 1/);
    expect(() => closeEpoch(db, { manifestPrivateKeyHex: key, omitPromisedIssuance: '02' + '11'.repeat(32) })).toThrow(/unknown issuance/);
    expect(openEpoch(db).epochIndex).toBe(2);
    expect(db.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_omission`).get()).toEqual({ n: 0 });
  });
});

describe('Phase 3A epoch lifecycle — failure and restart', () => {
  it('4. a close that fails before COMMIT leaves the epoch OPEN with nothing written', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [victim] = cdk.mint([8]);
    expect(() =>
      closeEpoch(db, {
        manifestPrivateKeyHex: newKey(),
        omitPromisedIssuance: victim!.blindedMessageHex,
        beforeCommit: () => {
          throw new Error('injected failure');
        },
      }),
    ).toThrow('injected failure');
    expect(epochRows(db)).toEqual([{ epoch_index: 1, state: 'OPEN' }]);
    expect(db.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_keyset`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_omission`).get()).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
    // And the mint keeps issuing into the still-open epoch.
    expect(targetEpochOf(db, cdk.mint([4])[0]!.blindedMessageHex)).toBe(1);
  });

  it('15. epoch state survives closing and reopening the database file', () => {
    const path = newDbFile();
    const db = createMintDb(path);
    const cdk = new CdkSim(db);
    const key = newKey();
    const [i] = cdk.mint([32, 16]);
    const e1 = closeEpoch(db, { manifestPrivateKeyHex: key });
    db.close();

    const reopened = new DatabaseSync(path);
    expect(openEpoch(reopened).epochIndex).toBe(2);
    const loaded = loadClosedEpoch(reopened, 1)!;
    expect(loaded.globalDigest).toBe(e1.globalDigest);
    expect(loaded.keysets).toEqual(e1.keysets);
    expect(auditClosedEpoch(reopened, 1).ok).toBe(true);
    const ev = issuanceEvidence(reopened, i!.blindedMessageHex);
    expect(ev.state === 'EPOCH_CLOSED' && ev.inclusionProof !== null).toBe(true);
    reopened.close();
  }, FILE_DB_TIMEOUT_MS);

  it('16. a real SIGKILL during a fully staged close cannot leave a half-closed epoch', async () => {
    const path = newDbFile();
    const db = createMintDb(path);
    db.exec('PRAGMA journal_mode = WAL');
    const cdk = new CdkSim(db);
    cdk.mint([64, 8]);
    db.close();

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/real-cashu/pol-epoch-close.ts', path], {
      cwd: ROOT,
      env: { ...process.env, SOLVENT_MANIFEST_PRIVKEY: newKey(), SOLVENT_TEST_DELAY_BEFORE_EPOCH_COMMIT_MS: '30000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`closer never staged its commit: ${output}`)), 20_000);
      const onData = (d: Buffer) => {
        output += d.toString();
        if (output.includes('fully staged')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    });
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    const after = new DatabaseSync(path);
    expect(epochRows(after)).toEqual([{ epoch_index: 1, state: 'OPEN' }]);
    expect(after.prepare(`SELECT count(*) AS n FROM solvent_pol_epoch_keyset`).get()).toEqual({ n: 0 });
    after.close();

    // A normal close afterwards succeeds and is sound.
    const again = new DatabaseSync(path);
    const closed = closeEpoch(again, { manifestPrivateKeyHex: newKey() });
    expect(closed.epochIndex).toBe(1);
    expect(auditClosedEpoch(again, 1).ok).toBe(true);
    again.close();
  }, 40_000);
});

// Receipts built by the database must be byte-identical to src/pol's own encoding.
describe('Phase 3A receipt message encoding', () => {
  it('the trigger-built receipt message equals issuedReceiptMessage()', () => {
    const db = createMintDb();
    const cdk = new CdkSim(db);
    const [i] = cdk.mint([1]);
    const row = db.prepare(`SELECT CAST(message AS TEXT) AS m FROM solvent_pol_receipt`).get() as { m: string };
    expect(row.m).toBe(issuedReceiptMessage(i!.blindedMessageHex, 1));
  });
});
