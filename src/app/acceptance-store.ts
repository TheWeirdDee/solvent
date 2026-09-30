// The reference acceptance store behind the Accept side effect in this app.
//
// SCOPE (said plainly wherever it is shown): this is a local, reference
// application store kept in this browser. It exists to prove that SOLVENT's
// verdict gates a REAL side effect exactly once — the real Gate 4 boundary
// (runAcceptGate -> acceptProof: real cashu-ts token encoding, committed to a
// store). It is not a universal Cashu wallet; a real wallet would put its own
// import/accept logic behind the same gate.
//
// Exactly-once: an issuance is identified by its proof (secret + C). The gate
// may run many times for the same issuance (retries, page reloads), but the
// real accept function is only invoked the first time it is ACCEPTED; every
// call that reaches it is counted in the persisted record, so the displayed
// "accept function calls" is read back from the store, never simulated.
import type { Proof } from '@cashu/cashu-ts';
import { acceptProof, runAcceptGate, type WalletStore } from '../enforcement/accept-gate.js';
import type { VerifyInput } from '../verifier/verify.js';

const KEY = 'solvent.acceptance.v1';

export interface StoredAcceptance {
  id: string;
  mint: string;
  amount: number;
  encodedToken: string;
  acceptedAt: string;
  /** How many times the real accept function ran for this issuance (1 when working correctly). */
  acceptCalls: number;
}

export interface EnforcementOutcome {
  decision: 'ACCEPT' | 'REFUSE';
  reasonCode: string;
  /** Calls made to the real accept function by THIS gate run (0 or 1). */
  callsThisRun: number;
  /** Total calls ever recorded for this issuance, read back from the store. */
  totalCalls: number;
  recordStored: boolean;
  acceptedAt: string | null;
  storeSizeBefore: number;
  storeSizeAfter: number;
  alreadyAccepted: boolean;
}

export function issuanceId(proof: Proof): string {
  return `${proof.secret}:${proof.C}`;
}

function load(): StoredAcceptance[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredAcceptance[]) : [];
  } catch {
    return [];
  }
}

function save(records: StoredAcceptance[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    /* storage unavailable: the in-memory result still stands for this page */
  }
}

export function acceptedRecord(proof: Proof): StoredAcceptance | undefined {
  return load().find((r) => r.id === issuanceId(proof));
}

export function acceptanceStoreSize(): number {
  return load().length;
}

/**
 * Runs the real acceptance gate for one issuance. REFUSE: the accept function
 * is not called and the store is untouched. ACCEPT: the accept function runs
 * once — unless this issuance was already accepted, in which case it is not
 * called again.
 */
export function enforce(input: VerifyInput): EnforcementOutcome {
  const records = load();
  const before = records.length;
  const existing = records.find((r) => r.id === issuanceId(input.proof));
  let callsThisRun = 0;
  const wallet: WalletStore = { accepted: [] };
  const { result, accepted } = runAcceptGate(input, wallet, (store, mint, proof) => {
    if (existing) {
      // Already accepted: the gate passes, but nothing is accepted twice.
      return { proof, encodedToken: existing.encodedToken, acceptedAt: existing.acceptedAt };
    }
    callsThisRun++;
    return acceptProof(store, mint, proof);
  });
  if (accepted && !existing) {
    const rec = wallet.accepted[0]!;
    records.push({ id: issuanceId(input.proof), mint: input.mint, amount: Number(input.proof.amount), encodedToken: rec.encodedToken, acceptedAt: rec.acceptedAt, acceptCalls: callsThisRun });
    save(records);
  }
  const after = load();
  const stored = after.find((r) => r.id === issuanceId(input.proof));
  return {
    decision: result.decision,
    reasonCode: result.reasonCode,
    callsThisRun,
    totalCalls: stored?.acceptCalls ?? 0,
    recordStored: !!stored,
    acceptedAt: stored?.acceptedAt ?? null,
    storeSizeBefore: before,
    storeSizeAfter: after.length,
    alreadyAccepted: !!existing,
  };
}
