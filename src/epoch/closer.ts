// SOLVENT Phase 3A — the real PoL epoch closer for the patched CDK mint.
//
// Reads the mint's own SQLite database (the same file cdk-mintd writes),
// derives each keyset's issued and spent sum-MMRs from SOLVENT's liability
// rows — only rows backed by a real CDK write (a signed `blind_signature`,
// a SPENT `proof`) — signs one epoch manifest per keyset with the mint's
// manifest key, and closes the epoch atomically. Schema, state machine and
// race analysis: migrations/solvent-accounting/0003_pol_epoch_lifecycle.sql
// and docs/epoch-lifecycle.md.
//
// Reuses src/pol/* unchanged — the same sum-MMR, manifest and receipt code
// validated against the draft's official vectors. Nothing here invents a
// second encoding.
import type { DatabaseSync } from 'node:sqlite';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import {
  bytesToHex,
  globalDigest,
  keysetMerkleRoot,
  manifestDigestHex,
  signManifest,
  sortKeysets,
  verifyManifest,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../pol/manifest.js';
import { append, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf, type InclusionProof, type Mmr } from '../pol/mmr.js';
import { issuedReceiptMessage, type PolReceipt } from '../pol/receipt.js';

/** Active keysets carry no scheduled deactivation (see docs/epoch-lifecycle.md). */
export const NO_DEACTIVATION = 0;

export interface IssuedLiabilityRow {
  id: string;
  blinded_message_hex: string;
  amount: number;
  operation_kind: string;
  target_epoch: number;
  seq: number;
}

export interface ConsumedLiabilityRow {
  id: string;
  proof_y_hex: string;
  amount: number;
  operation_kind: string;
  target_epoch: number;
  seq: number;
}

export interface KeysetCommitment {
  keysetId: string;
  issuedRows: IssuedLiabilityRow[];
  spentRows: ConsumedLiabilityRow[];
  issued: Mmr;
  spent: Mmr;
}

export interface ClosedKeysetManifest {
  manifest: ManifestFields;
  manifestDigest: string;
  manifestSignature: string;
}

export interface ClosedEpoch {
  epochIndex: number;
  previousGlobalDigest: string;
  globalDigest: string;
  manifestPubkey: string;
  keysets: ClosedKeysetManifest[];
  nextOpenEpoch: number;
  /** Set only when the operator explicitly requested the broken-promise demo mode. */
  omitted: { liabilityId: string; blindedMessageHex: string; amount: number } | null;
  /** Every issuance omitted from this epoch (`omitted` is the first of these). */
  omittedAll: { liabilityId: string; blindedMessageHex: string; amount: number }[];
  /** Liability rows targeting this epoch with no real CDK write behind them (e.g. the Phase 2 synthetic recovery fixture) — excluded, and reported rather than hidden. */
  unbackedIssuedRowsExcluded: number;
  unbackedConsumedRowsExcluded: number;
}

export interface CloseEpochOptions {
  /** 32-byte hex secret of the mint's manifest key (the draft's master key). */
  manifestPrivateKeyHex: string;
  /** Wall clock for the manifest timestamp; defaults to now. */
  now?: Date;
  /**
   * EXPLICIT OPT-IN ADVERSARIAL DEMO MODE — never set by default. The
   * blinded-message hex of an issuance promised to the epoch being closed,
   * which this close then leaves out of that epoch's issued commitment
   * (and every later one). The receipt, the token and the liability row
   * are untouched; the mint simply breaks its signed promise.
   */
  omitPromisedIssuance?: string;
  /**
   * Same demo mode, for several requests at once (the public demo's queue).
   * Lenient and atomic: inside the close transaction, every listed blinded
   * message whose issuance exists AND was promised to the epoch being closed
   * is omitted; the rest are ignored (not yet issued, or promised to a later
   * epoch) and reported back through `omittedAll` only when applied.
   */
  omitIfPromisedToThisEpoch?: string[];
  /** Test-only hook: runs after every write, immediately before COMMIT. */
  beforeCommit?: () => void;
}

export class EpochError extends Error {}

export function rfc3339Seconds(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

export function manifestPubkeyHex(manifestPrivateKeyHex: string): string {
  return bytesToHex(getPubKeyFromPrivKey(hexToBytes32(manifestPrivateKeyHex)));
}

function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new EpochError('manifest private key must be 32 bytes of hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function openEpoch(db: DatabaseSync): { epochIndex: number; openedAt: number } {
  const row = db.prepare(`SELECT epoch_index, opened_at FROM solvent_pol_epoch WHERE state = 'OPEN'`).get() as
    | { epoch_index: number; opened_at: number }
    | undefined;
  if (!row) throw new EpochError('no OPEN PoL epoch — is migration 0003 applied?');
  return { epochIndex: row.epoch_index, openedAt: row.opened_at };
}

/**
 * The exact leaves of `keysetId`'s commitments as of epoch `epochIndex`:
 * every CDK-backed liability stamped with an epoch <= epochIndex, in the
 * append order the mint recorded them (seq), minus any issuance an operator
 * deliberately omitted from an epoch <= epochIndex. Cumulative, so epoch
 * N+1's MMRs extend epoch N's — the draft's append-only property.
 */
export function deriveKeysetCommitment(db: DatabaseSync, keysetId: string, epochIndex: number): KeysetCommitment {
  const issuedRows = db
    .prepare(
      `SELECT il.id, il.blinded_message_hex, il.amount, il.operation_kind, il.target_epoch, il.seq
       FROM solvent_issued_liability il
       JOIN blind_signature bs ON bs.blinded_message = unhex(il.blinded_message_hex) AND bs.c IS NOT NULL
       WHERE il.keyset_id = ? AND il.target_epoch <= ?
         AND NOT EXISTS (SELECT 1 FROM solvent_pol_epoch_omission o WHERE o.liability_id = il.id AND o.omitted_from_epoch <= ?)
       ORDER BY il.seq`,
    )
    .all(keysetId, epochIndex, epochIndex) as unknown as IssuedLiabilityRow[];
  const spentRows = db
    .prepare(
      `SELECT cl.id, cl.proof_y_hex, cl.amount, cl.operation_kind, cl.target_epoch, cl.seq
       FROM solvent_consumed_liability cl
       JOIN proof p ON p.y = unhex(cl.proof_y_hex) AND p.state = 'SPENT'
       WHERE cl.keyset_id = ? AND cl.target_epoch <= ?
       ORDER BY cl.seq`,
    )
    .all(keysetId, epochIndex) as unknown as ConsumedLiabilityRow[];

  let issued = emptyMmr();
  for (const r of issuedRows) issued = append(issued, issuedLeaf(r.blinded_message_hex, r.amount));
  let spent = emptyMmr();
  for (const r of spentRows) spent = append(spent, spentLeaf(r.proof_y_hex, r.amount));
  return { keysetId, issuedRows, spentRows, issued, spent };
}

function countUnbacked(db: DatabaseSync, epochIndex: number): { issued: number; consumed: number } {
  const issued = db
    .prepare(
      `SELECT count(*) AS n FROM solvent_issued_liability il
       WHERE il.target_epoch = ?
         AND NOT EXISTS (SELECT 1 FROM blind_signature bs WHERE bs.blinded_message = unhex(il.blinded_message_hex) AND bs.c IS NOT NULL)`,
    )
    .get(epochIndex) as { n: number };
  const consumed = db
    .prepare(
      `SELECT count(*) AS n FROM solvent_consumed_liability cl
       WHERE cl.target_epoch = ?
         AND NOT EXISTS (SELECT 1 FROM proof p WHERE p.y = unhex(cl.proof_y_hex) AND p.state = 'SPENT')`,
    )
    .get(epochIndex) as { n: number };
  return { issued: issued.n, consumed: consumed.n };
}

function manifestFrom(
  keyset: { id: string; unit: string; active: boolean; deactivationEpoch: number },
  epochIndex: number,
  timestamp: string,
  previousGlobalDigest: string,
  c: KeysetCommitment,
): ManifestFields {
  const issuedRoot = root(c.issued);
  const spentRoot = root(c.spent);
  return {
    keyset_id: keyset.id,
    unit: keyset.unit,
    epoch_index: epochIndex,
    timestamp,
    previous_global_digest: previousGlobalDigest,
    issued_mmr_size: c.issued.leaves.length,
    issued_mmr_root_hash: bytesToHex(issuedRoot.hash),
    issued_mmr_root_sum: Number(issuedRoot.sum),
    spent_mmr_size: c.spent.leaves.length,
    spent_mmr_root_hash: bytesToHex(spentRoot.hash),
    spent_mmr_root_sum: Number(spentRoot.sum),
    outstanding_balance: Number(issuedRoot.sum - spentRoot.sum),
    active: keyset.active,
    deactivation_epoch: keyset.deactivationEpoch,
  };
}

function keysetEntry(m: ManifestFields): KeysetManifestEntry {
  return {
    keyset_id: m.keyset_id,
    unit: m.unit,
    issued_mmr_size: m.issued_mmr_size,
    issued_mmr_root_hash: m.issued_mmr_root_hash,
    issued_mmr_root_sum: m.issued_mmr_root_sum,
    spent_mmr_size: m.spent_mmr_size,
    spent_mmr_root_hash: m.spent_mmr_root_hash,
    spent_mmr_root_sum: m.spent_mmr_root_sum,
    active: m.active,
    deactivation_epoch: m.deactivation_epoch,
  };
}

/** The draft's global digest over every keyset manifest of one epoch. */
export function epochGlobalDigestHex(previousGlobalDigest: string, epochIndex: number, manifests: ManifestFields[]): string {
  const sorted = sortKeysets(manifests.map(keysetEntry));
  return bytesToHex(globalDigest(previousGlobalDigest, epochIndex, sorted.length, keysetMerkleRoot(sorted)));
}

function previousClosed(db: DatabaseSync, epochIndex: number): { global_digest: string; manifest_pubkey: string } | undefined {
  return db
    .prepare(`SELECT global_digest, manifest_pubkey FROM solvent_pol_epoch WHERE epoch_index = ? AND state = 'CLOSED'`)
    .get(epochIndex - 1) as { global_digest: string; manifest_pubkey: string } | undefined;
}

/**
 * Closes the currently OPEN epoch N and opens N+1, in one BEGIN IMMEDIATE
 * transaction. Serialises against cdk-mintd's own BEGIN IMMEDIATE writes,
 * so every liability stamped N is committed before this reads, and none can
 * be stamped N after it commits. Any failure — including a crash — before
 * COMMIT leaves N OPEN with no manifests written.
 */
export function closeEpoch(db: DatabaseSync, opts: CloseEpochOptions): ClosedEpoch {
  const manifestPubkey = manifestPubkeyHex(opts.manifestPrivateKeyHex);
  const now = opts.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const timestamp = rfc3339Seconds(now);

  db.exec('BEGIN IMMEDIATE');
  try {
    const { epochIndex } = openEpoch(db);

    const prev = previousClosed(db, epochIndex);
    if (epochIndex > 1 && !prev) throw new EpochError(`epoch ${epochIndex - 1} is not closed`);
    if (prev && prev.manifest_pubkey !== manifestPubkey) {
      throw new EpochError(`manifest key changed: epoch ${epochIndex - 1} was signed by ${prev.manifest_pubkey}, this close would sign with ${manifestPubkey}`);
    }
    const previousGlobalDigest = prev ? prev.global_digest : ZERO_DIGEST_HEX;

    let omitted: ClosedEpoch['omitted'] = null;
    if (opts.omitPromisedIssuance !== undefined) {
      const bm = opts.omitPromisedIssuance.toLowerCase();
      const row = db
        .prepare(`SELECT id, amount, target_epoch FROM solvent_issued_liability WHERE blinded_message_hex = ?`)
        .get(bm) as { id: string; amount: number; target_epoch: number } | undefined;
      if (!row) throw new EpochError(`omission requested for unknown issuance ${bm}`);
      if (row.target_epoch !== epochIndex) {
        throw new EpochError(`omission requested for an issuance promised to epoch ${row.target_epoch}, not the epoch being closed (${epochIndex})`);
      }
      db.prepare(`INSERT INTO solvent_pol_epoch_omission (liability_id, omitted_from_epoch, recorded_at) VALUES (?, ?, ?)`).run(row.id, epochIndex, nowSeconds);
      omitted = { liabilityId: row.id, blindedMessageHex: bm, amount: row.amount };
    }
    const omittedAll: ClosedEpoch['omittedAll'] = omitted ? [omitted] : [];
    for (const raw of new Set((opts.omitIfPromisedToThisEpoch ?? []).map((b) => b.toLowerCase()))) {
      if (omitted && raw === omitted.blindedMessageHex) continue;
      const row = db
        .prepare(`SELECT id, amount FROM solvent_issued_liability WHERE blinded_message_hex = ? AND target_epoch = ?`)
        .get(raw, epochIndex) as { id: string; amount: number } | undefined;
      if (!row) continue;
      db.prepare(`INSERT INTO solvent_pol_epoch_omission (liability_id, omitted_from_epoch, recorded_at) VALUES (?, ?, ?)`).run(row.id, epochIndex, nowSeconds);
      omittedAll.push({ liabilityId: row.id, blindedMessageHex: raw, amount: row.amount });
    }
    if (!omitted && omittedAll.length > 0) omitted = omittedAll[0]!;

    const keysetRows = db.prepare(`SELECT id, unit, active FROM keyset ORDER BY id`).all() as { id: string; unit: string; active: number }[];
    if (keysetRows.length === 0) throw new EpochError('the mint has no keysets');

    const keysets: ClosedKeysetManifest[] = [];
    const insertKeyset = db.prepare(
      `INSERT INTO solvent_pol_epoch_keyset
         (epoch_index, keyset_id, unit, issued_mmr_size, issued_mmr_root_hash, issued_mmr_root_sum,
          spent_mmr_size, spent_mmr_root_hash, spent_mmr_root_sum, outstanding_balance, active,
          deactivation_epoch, manifest_digest, manifest_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const k of keysetRows) {
      const active = Boolean(k.active);
      const firstInactive = db
        .prepare(`SELECT MIN(epoch_index) AS e FROM solvent_pol_epoch_keyset WHERE keyset_id = ? AND active = 0`)
        .get(k.id) as { e: number | null };
      const deactivationEpoch = active ? NO_DEACTIVATION : (firstInactive.e ?? epochIndex);
      const commitment = deriveKeysetCommitment(db, k.id, epochIndex);
      const manifest = manifestFrom({ id: k.id, unit: k.unit, active, deactivationEpoch }, epochIndex, timestamp, previousGlobalDigest, commitment);
      const manifestSignature = signManifest(manifest, opts.manifestPrivateKeyHex);
      const manifestDigest = manifestDigestHex(manifest);
      insertKeyset.run(
        epochIndex, manifest.keyset_id, manifest.unit,
        manifest.issued_mmr_size, manifest.issued_mmr_root_hash, manifest.issued_mmr_root_sum,
        manifest.spent_mmr_size, manifest.spent_mmr_root_hash, manifest.spent_mmr_root_sum,
        manifest.outstanding_balance, active ? 1 : 0, manifest.deactivation_epoch, manifestDigest, manifestSignature,
      );
      keysets.push({ manifest, manifestDigest, manifestSignature });
    }

    const globalDigestHex = epochGlobalDigestHex(previousGlobalDigest, epochIndex, keysets.map((k) => k.manifest));
    db.prepare(
      `UPDATE solvent_pol_epoch
       SET state = 'CLOSED', closed_at = ?, manifest_timestamp = ?, previous_global_digest = ?,
           global_digest = ?, keyset_count = ?, manifest_pubkey = ?
       WHERE epoch_index = ?`,
    ).run(nowSeconds, timestamp, previousGlobalDigest, globalDigestHex, keysets.length, manifestPubkey, epochIndex);
    db.prepare(`INSERT INTO solvent_pol_epoch (epoch_index, state, opened_at) VALUES (?, 'OPEN', ?)`).run(epochIndex + 1, nowSeconds);

    const unbacked = countUnbacked(db, epochIndex);
    opts.beforeCommit?.();
    db.exec('COMMIT');
    return {
      epochIndex,
      previousGlobalDigest,
      globalDigest: globalDigestHex,
      manifestPubkey,
      keysets,
      nextOpenEpoch: epochIndex + 1,
      omitted,
      omittedAll,
      unbackedIssuedRowsExcluded: unbacked.issued,
      unbackedConsumedRowsExcluded: unbacked.consumed,
    };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Reads a closed epoch's stored manifests back exactly as signed. */
export function loadClosedEpoch(db: DatabaseSync, epochIndex: number): ClosedEpoch | null {
  const e = db
    .prepare(`SELECT * FROM solvent_pol_epoch WHERE epoch_index = ? AND state = 'CLOSED'`)
    .get(epochIndex) as
    | { epoch_index: number; manifest_timestamp: string; previous_global_digest: string; global_digest: string; manifest_pubkey: string }
    | undefined;
  if (!e) return null;
  const rows = db
    .prepare(`SELECT * FROM solvent_pol_epoch_keyset WHERE epoch_index = ? ORDER BY keyset_id`)
    .all(epochIndex) as unknown as {
    keyset_id: string; unit: string; issued_mmr_size: number; issued_mmr_root_hash: string; issued_mmr_root_sum: number;
    spent_mmr_size: number; spent_mmr_root_hash: string; spent_mmr_root_sum: number; outstanding_balance: number;
    active: number; deactivation_epoch: number; manifest_digest: string; manifest_signature: string;
  }[];
  const omissions = db
    .prepare(
      `SELECT o.liability_id, il.blinded_message_hex, il.amount FROM solvent_pol_epoch_omission o
       JOIN solvent_issued_liability il ON il.id = o.liability_id WHERE o.omitted_from_epoch = ? ORDER BY il.seq`,
    )
    .all(epochIndex) as unknown as { liability_id: string; blinded_message_hex: string; amount: number }[];
  const omittedAll = omissions.map((o) => ({ liabilityId: o.liability_id, blindedMessageHex: o.blinded_message_hex, amount: o.amount }));
  const unbacked = countUnbacked(db, epochIndex);
  return {
    epochIndex,
    previousGlobalDigest: e.previous_global_digest,
    globalDigest: e.global_digest,
    manifestPubkey: e.manifest_pubkey,
    keysets: rows.map((r) => ({
      manifest: {
        keyset_id: r.keyset_id,
        unit: r.unit,
        epoch_index: epochIndex,
        timestamp: e.manifest_timestamp,
        previous_global_digest: e.previous_global_digest,
        issued_mmr_size: r.issued_mmr_size,
        issued_mmr_root_hash: r.issued_mmr_root_hash,
        issued_mmr_root_sum: r.issued_mmr_root_sum,
        spent_mmr_size: r.spent_mmr_size,
        spent_mmr_root_hash: r.spent_mmr_root_hash,
        spent_mmr_root_sum: r.spent_mmr_root_sum,
        outstanding_balance: r.outstanding_balance,
        active: r.active === 1,
        deactivation_epoch: r.deactivation_epoch,
      },
      manifestDigest: r.manifest_digest,
      manifestSignature: r.manifest_signature,
    })),
    nextOpenEpoch: epochIndex + 1,
    omitted: omittedAll[0] ?? null,
    omittedAll,
    unbackedIssuedRowsExcluded: unbacked.issued,
    unbackedConsumedRowsExcluded: unbacked.consumed,
  };
}

export interface EpochAudit {
  epochIndex: number;
  ok: boolean;
  failures: string[];
}

/**
 * Independently re-derives a closed epoch from the liability rows and checks
 * it against what was stored and signed: roots, sums, sizes, outstanding
 * arithmetic, manifest digests and signatures, the global digest and its
 * chain to the previous epoch.
 */
export function auditClosedEpoch(db: DatabaseSync, epochIndex: number): EpochAudit {
  const failures: string[] = [];
  const closed = loadClosedEpoch(db, epochIndex);
  if (!closed) return { epochIndex, ok: false, failures: [`epoch ${epochIndex} is not closed`] };

  const expectedPrev = epochIndex === 1 ? ZERO_DIGEST_HEX : previousClosed(db, epochIndex)?.global_digest;
  if (closed.previousGlobalDigest !== expectedPrev) failures.push('previous_global_digest does not chain to the previous epoch');

  for (const k of closed.keysets) {
    const m = k.manifest;
    const c = deriveKeysetCommitment(db, m.keyset_id, epochIndex);
    const ir = root(c.issued);
    const sr = root(c.spent);
    if (m.issued_mmr_size !== c.issued.leaves.length || m.issued_mmr_root_hash !== bytesToHex(ir.hash) || BigInt(m.issued_mmr_root_sum) !== ir.sum) {
      failures.push(`keyset ${m.keyset_id}: issued commitment does not re-derive from the liability rows`);
    }
    if (m.spent_mmr_size !== c.spent.leaves.length || m.spent_mmr_root_hash !== bytesToHex(sr.hash) || BigInt(m.spent_mmr_root_sum) !== sr.sum) {
      failures.push(`keyset ${m.keyset_id}: spent commitment does not re-derive from the liability rows`);
    }
    if (m.outstanding_balance !== m.issued_mmr_root_sum - m.spent_mmr_root_sum) failures.push(`keyset ${m.keyset_id}: outstanding != issued - spent`);
    if (manifestDigestHex(m) !== k.manifestDigest) failures.push(`keyset ${m.keyset_id}: stored manifest digest mismatch`);
    if (!verifyManifest(m, k.manifestSignature, closed.manifestPubkey)) failures.push(`keyset ${m.keyset_id}: manifest signature invalid`);
  }
  if (epochGlobalDigestHex(closed.previousGlobalDigest, epochIndex, closed.keysets.map((k) => k.manifest)) !== closed.globalDigest) {
    failures.push('global digest does not recompute from the keyset manifests');
  }
  return { epochIndex, ok: failures.length === 0, failures };
}

export type IssuanceEvidence =
  | {
      state: 'EPOCH_OPEN';
      blindedMessageHex: string;
      keysetId: string;
      amount: number;
      receipt: PolReceipt;
      receiptStatus: string;
    }
  | {
      state: 'EPOCH_CLOSED';
      blindedMessageHex: string;
      keysetId: string;
      amount: number;
      receipt: PolReceipt;
      receiptStatus: string;
      manifest: ManifestFields;
      manifestSignature: string;
      manifestDigest: string;
      masterPublicKeyHex: string;
      globalDigest: string;
      issuedMmrSize: number;
      /** null exactly when the closed epoch's issued commitment does not contain this issuance. */
      inclusionProof: InclusionProof | null;
      leafIndex: number | null;
    };

/**
 * Everything the mint can hand a holder about one issuance: its signed
 * receipt and, once the promised epoch is closed, that epoch's signed
 * manifest for the issuance's keyset plus an inclusion proof built from
 * the same leaves the closer committed to (asserted, not assumed).
 */
export function issuanceEvidence(db: DatabaseSync, blindedMessageHex: string): IssuanceEvidence {
  const bm = blindedMessageHex.toLowerCase();
  const row = db
    .prepare(
      `SELECT il.id, il.keyset_id, il.amount, il.target_epoch, r.status, r.signature_hex, CAST(r.message AS TEXT) AS message
       FROM solvent_issued_liability il
       JOIN solvent_pol_receipt r ON r.liability_kind = 'issued' AND r.liability_id = il.id
       WHERE il.blinded_message_hex = ?`,
    )
    .get(bm) as
    | { id: string; keyset_id: string; amount: number; target_epoch: number; status: string; signature_hex: string | null; message: string }
    | undefined;
  if (!row) throw new EpochError(`no SOLVENT liability for blinded message ${bm}`);
  if (row.message !== issuedReceiptMessage(bm, row.target_epoch)) {
    throw new EpochError(`receipt message ${row.message} does not promise epoch ${row.target_epoch}`);
  }
  const receipt: PolReceipt = { target_epoch: row.target_epoch, signature: row.signature_hex ?? '' };
  const base = { blindedMessageHex: bm, keysetId: row.keyset_id, amount: row.amount, receipt, receiptStatus: row.status };

  const closed = loadClosedEpoch(db, row.target_epoch);
  if (!closed) return { state: 'EPOCH_OPEN', ...base };
  const k = closed.keysets.find((x) => x.manifest.keyset_id === row.keyset_id);
  if (!k) throw new EpochError(`epoch ${row.target_epoch} has no manifest for keyset ${row.keyset_id}`);

  const c = deriveKeysetCommitment(db, row.keyset_id, row.target_epoch);
  const r = root(c.issued);
  if (bytesToHex(r.hash) !== k.manifest.issued_mmr_root_hash || Number(r.sum) !== k.manifest.issued_mmr_root_sum) {
    throw new EpochError(`epoch ${row.target_epoch} keyset ${row.keyset_id}: stored issued root no longer re-derives from the liability rows`);
  }
  const leafIndex = c.issuedRows.findIndex((x) => x.blinded_message_hex === bm);
  return {
    state: 'EPOCH_CLOSED',
    ...base,
    manifest: k.manifest,
    manifestSignature: k.manifestSignature,
    manifestDigest: k.manifestDigest,
    masterPublicKeyHex: closed.manifestPubkey,
    globalDigest: closed.globalDigest,
    issuedMmrSize: c.issued.leaves.length,
    inclusionProof: leafIndex >= 0 ? getInclusionProof(c.issued, leafIndex) : null,
    leafIndex: leafIndex >= 0 ? leafIndex : null,
  };
}

/** Every accounting row of one operation (one NUT-03 swap or NUT-05 melt), read from the liability tables. */
export interface SpendOperation {
  consumed: { proofYHex: string; amount: number; targetEpoch: number }[];
  issued: { blindedMessageHex: string; amount: number; targetEpoch: number }[];
  consumedSum: number;
  issuedSum: number;
}

export type SpendEvidence =
  | {
      state: 'EPOCH_OPEN';
      proofYHex: string;
      keysetId: string;
      amount: number;
      operationKind: string;
      operationId: string | null;
      targetEpoch: number;
      operation: SpendOperation;
    }
  | {
      state: 'EPOCH_CLOSED';
      proofYHex: string;
      keysetId: string;
      amount: number;
      operationKind: string;
      operationId: string | null;
      targetEpoch: number;
      operation: SpendOperation;
      manifest: ManifestFields;
      manifestSignature: string;
      manifestDigest: string;
      masterPublicKeyHex: string;
      globalDigest: string;
      spentMmrSize: number;
      /** null exactly when the closed epoch's spent commitment does not contain this spend. */
      inclusionProof: InclusionProof | null;
      leafIndex: number | null;
      /** The same keyset's manifest in the epoch before, when there is one: the committed liability before this operation's epoch. */
      previous: { epochIndex: number; manifest: ManifestFields; manifestSignature: string } | null;
    };

/**
 * The spent-side counterpart of issuanceEvidence: for one proof the mint
 * consumed (NUT-03 swap input or NUT-05 melt input), the consumed liability
 * row and, once its epoch is closed, that epoch's signed manifest plus an
 * inclusion proof in the spent sum-MMR built from the same rows the closer
 * committed to (asserted, not assumed). Only proofs CDK actually marked
 * SPENT are in the spent commitment (deriveKeysetCommitment).
 */
export function spendEvidence(db: DatabaseSync, proofYHex: string): SpendEvidence {
  const y = proofYHex.toLowerCase();
  const row = db
    .prepare(
      `SELECT cl.keyset_id, cl.amount, cl.operation_kind, cl.operation_id, cl.target_epoch
       FROM solvent_consumed_liability cl
       JOIN proof p ON p.y = unhex(cl.proof_y_hex) AND p.state = 'SPENT'
       WHERE cl.proof_y_hex = ?`,
    )
    .get(y) as { keyset_id: string; amount: number; operation_kind: string; operation_id: string | null; target_epoch: number } | undefined;
  if (!row) throw new EpochError(`no SOLVENT consumed liability for spent proof ${y}`);
  const consumed = row.operation_id
    ? (db
        .prepare(
          `SELECT cl.proof_y_hex AS proofYHex, cl.amount, cl.target_epoch AS targetEpoch FROM solvent_consumed_liability cl
           JOIN proof p ON p.y = unhex(cl.proof_y_hex) AND p.state = 'SPENT'
           WHERE cl.operation_id = ? ORDER BY cl.seq`,
        )
        .all(row.operation_id) as unknown as SpendOperation['consumed'])
    : [{ proofYHex: y, amount: row.amount, targetEpoch: row.target_epoch }];
  // Only outputs the mint really signed (blind_signature.c set) count, as in the issued commitment.
  const issued = row.operation_id
    ? (db
        .prepare(
          `SELECT il.blinded_message_hex AS blindedMessageHex, il.amount, il.target_epoch AS targetEpoch FROM solvent_issued_liability il
           JOIN blind_signature bs ON bs.blinded_message = unhex(il.blinded_message_hex) AND bs.c IS NOT NULL
           WHERE il.operation_id = ? ORDER BY il.seq`,
        )
        .all(row.operation_id) as unknown as SpendOperation['issued'])
    : [];
  const operation: SpendOperation = {
    consumed,
    issued,
    consumedSum: consumed.reduce((a, c) => a + c.amount, 0),
    issuedSum: issued.reduce((a, c) => a + c.amount, 0),
  };
  const base = { proofYHex: y, keysetId: row.keyset_id, amount: row.amount, operationKind: row.operation_kind, operationId: row.operation_id, targetEpoch: row.target_epoch, operation };

  const closed = loadClosedEpoch(db, row.target_epoch);
  if (!closed) return { state: 'EPOCH_OPEN', ...base };
  const k = closed.keysets.find((x) => x.manifest.keyset_id === row.keyset_id);
  if (!k) throw new EpochError(`epoch ${row.target_epoch} has no manifest for keyset ${row.keyset_id}`);

  const c = deriveKeysetCommitment(db, row.keyset_id, row.target_epoch);
  const r = root(c.spent);
  if (bytesToHex(r.hash) !== k.manifest.spent_mmr_root_hash || Number(r.sum) !== k.manifest.spent_mmr_root_sum) {
    throw new EpochError(`epoch ${row.target_epoch} keyset ${row.keyset_id}: stored spent root no longer re-derives from the liability rows`);
  }
  const leafIndex = c.spentRows.findIndex((x) => x.proof_y_hex === y);
  const prevEpoch = loadClosedEpoch(db, row.target_epoch - 1);
  const prev = prevEpoch?.keysets.find((x) => x.manifest.keyset_id === row.keyset_id);
  return {
    state: 'EPOCH_CLOSED',
    ...base,
    manifest: k.manifest,
    manifestSignature: k.manifestSignature,
    manifestDigest: k.manifestDigest,
    masterPublicKeyHex: closed.manifestPubkey,
    globalDigest: closed.globalDigest,
    spentMmrSize: c.spent.leaves.length,
    inclusionProof: leafIndex >= 0 ? getInclusionProof(c.spent, leafIndex) : null,
    leafIndex: leafIndex >= 0 ? leafIndex : null,
    previous: prev ? { epochIndex: row.target_epoch - 1, manifest: prev.manifest, manifestSignature: prev.manifestSignature } : null,
  };
}
