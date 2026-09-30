// SOLVENT sidecar — the broken-promise demo's request queue, one entry per
// exact issuance (blinded message B_), persisted next to the publication
// store so a restart never turns a requested broken promise into an honest
// run. Written atomically (temp file + rename).
//
// A wallet registers its B_ BEFORE asking the mint to sign it, so the request
// always exists before the issuance does and the epoch the issuance is
// promised to can never close without seeing it. The closer applies requests
// inside its own transaction (closeEpoch's omitIfPromisedToThisEpoch), so
// each request is applied to exactly its own issuance, in exactly the epoch
// that issuance was promised to — any number per epoch, no cross-user effect.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface OmissionRequest {
  blinded_message: string;
  requested_at: number;
  /**
   * pending: waiting for its issuance's promised epoch to close;
   * applied: omitted from `epoch` (the broken promise happened);
   * missed: the issuance's promised epoch closed before the request existed
   *         (only possible for a request made after issuance) — reported, never silent;
   * expired: no issuance with this B_ appeared in time.
   */
  state: 'pending' | 'applied' | 'missed' | 'expired';
  epoch: number | null;
}

export const OMISSION_REQUEST_TTL_SECONDS = 15 * 60;
const MAX_PENDING = 500;

export class OmissionQueue {
  private data: Record<string, OmissionRequest>;

  constructor(private readonly path: string | null) {
    this.data = path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, OmissionRequest>) : {};
  }

  get(bm: string): OmissionRequest | undefined {
    return this.data[bm];
  }

  pending(): string[] {
    return Object.values(this.data).filter((r) => r.state === 'pending').map((r) => r.blinded_message);
  }

  /** Idempotent: re-registering the same B_ returns the existing request. */
  register(bm: string, nowSeconds: number): OmissionRequest | null {
    const existing = this.data[bm];
    if (existing) return existing;
    if (this.pending().length >= MAX_PENDING) return null;
    const r: OmissionRequest = { blinded_message: bm, requested_at: nowSeconds, state: 'pending', epoch: null };
    this.data[bm] = r;
    this.save();
    return r;
  }

  settle(bm: string, state: OmissionRequest['state'], epoch: number | null): void {
    const r = this.data[bm];
    if (!r) return;
    this.data[bm] = { ...r, state, epoch };
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}
