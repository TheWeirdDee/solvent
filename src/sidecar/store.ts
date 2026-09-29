// SOLVENT sidecar — the publication record for every closed epoch, kept in
// the sidecar's own JSON file (never in the mint's database). Written
// atomically (temp file + rename) so a crash never leaves a torn record.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { NostrEvent } from 'nostr-tools';
import type { RelayPublishResult } from '../nostr/pol-evidence.js';
import type { ReserveBinding } from '../reserve/binding.js';
import type { ReserveAttestation } from '../reserve/evaluate.js';

export interface EpochPublication {
  epoch_index: number;
  /** published = ACKed and fetched back by id; unpublished = built but never publicly confirmed; failed = could not be built. */
  status: 'published' | 'unpublished' | 'failed';
  event: NostrEvent | null;
  event_id: string | null;
  relays: RelayPublishResult[];
  fetched_from: string[];
  reserve_attestation: ReserveAttestation | null;
  reserve_binding: ReserveBinding | null;
  published_at: string;
  valid_until: number | null;
  omitted_issuance: string | null;
  detail: string;
}

export class PublicationStore {
  private data: Record<string, EpochPublication>;

  constructor(private readonly path: string) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, EpochPublication>) : {};
  }

  get(epoch: number): EpochPublication | undefined {
    return this.data[String(epoch)];
  }

  latest(): EpochPublication | undefined {
    const keys = Object.keys(this.data).map(Number).sort((a, b) => b - a);
    return keys.length ? this.data[String(keys[0])] : undefined;
  }

  put(p: EpochPublication): void {
    this.data[String(p.epoch_index)] = p;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}
