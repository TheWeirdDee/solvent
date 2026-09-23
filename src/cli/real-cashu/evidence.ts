// Writes the Phase 1 real-integration evidence package
// (evidence/real-cashu/<run-id>/...) — see item 15 of the Phase 1 spec.
// Secrets (proof.secret, macaroons, private keys) are redacted before
// writing; only hashes/identifiers sufficient to independently verify the
// run are kept in the clear.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Proof } from '@cashu/cashu-ts';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A proof's secret is bearer material — never write it to a public evidence artifact. Replace it with its hash, keep the amount/id/C (public) as-is. */
export function redactProof(p: Proof): Record<string, unknown> {
  return { id: p.id, amount: typeof p.amount === 'object' && 'toNumber' in p.amount ? (p.amount as { toNumber(): number }).toNumber() : p.amount, C: p.C, secret_sha256: sha256Hex(p.secret) };
}

export class EvidenceWriter {
  readonly dir: string;

  constructor(runId: string) {
    this.dir = path.resolve(import.meta.dirname, '..', '..', '..', 'evidence', 'real-cashu', runId);
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(path.join(this.dir, 'logs'), { recursive: true });
  }

  write(name: string, data: unknown): void {
    writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  writeLog(name: string, text: string): void {
    writeFileSync(path.join(this.dir, 'logs', `${name}.log`), text, 'utf8');
  }
}
