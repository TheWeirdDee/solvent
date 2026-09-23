// Durable, file-backed wallet state for the Phase 1 real-Cashu sender and
// receiver — item 11/12 of the Phase 1 spec ("do not rely only on
// in-memory arrays"; "confirm state survives a normal process restart").
// Deliberately not a database engine: for Phase 1's single-run regtest
// verification, one JSON file per wallet directory is sufficient and
// trivially inspectable as evidence. A later phase that needs concurrent
// access or crash-mid-write atomicity can upgrade this without touching
// the Cashu protocol logic that uses it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Proof } from '@cashu/cashu-ts';

export interface WalletState {
  mintUrl: string;
  proofs: Proof[];
  /** Serialized swap/mint previews awaiting completion — see the "crash-safe" pattern in @cashu/cashu-ts's docs (serializeSwapPreview/deserializeSwapPreview). Cleared once the corresponding operation completes. */
  pendingPreviews: Record<string, unknown>;
  updatedAt: string;
}

export class ProofStore {
  private file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'wallet-state.json');
  }

  load(): WalletState {
    if (!existsSync(this.file)) {
      return { mintUrl: '', proofs: [], pendingPreviews: {}, updatedAt: new Date().toISOString() };
    }
    return JSON.parse(readFileSync(this.file, 'utf8')) as WalletState;
  }

  save(state: WalletState): void {
    writeFileSync(this.file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  }

  addProofs(mintUrl: string, proofs: Proof[]): void {
    const state = this.load();
    state.mintUrl = mintUrl;
    state.proofs = [...state.proofs, ...proofs];
    this.save(state);
  }

  removeProofsBySecret(secrets: string[]): void {
    const state = this.load();
    const remove = new Set(secrets);
    state.proofs = state.proofs.filter((p) => !remove.has(p.secret));
    this.save(state);
  }

  setPendingPreview(key: string, preview: unknown): void {
    const state = this.load();
    state.pendingPreviews[key] = preview;
    this.save(state);
  }

  clearPendingPreview(key: string): void {
    const state = this.load();
    delete state.pendingPreviews[key];
    this.save(state);
  }
}
