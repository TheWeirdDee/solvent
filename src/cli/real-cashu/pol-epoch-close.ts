// npm run pol:epoch-close -- <path-to-cdk-mintd.sqlite> [--every <seconds>] [--json-out <file>]
//
// SOLVENT Phase 3A — closes the real mint's currently OPEN PoL epoch and
// opens the next one (src/epoch/closer.ts). Safe to run while cdk-mintd is
// serving: both take SQLite's write lock with BEGIN IMMEDIATE, so a close
// and an issuance can never interleave (docs/epoch-lifecycle.md).
//
// Environment:
//   SOLVENT_MANIFEST_PRIVKEY         required — 32-byte hex manifest key
//   SOLVENT_OMIT_PROMISED_ISSUANCE   EXPLICIT OPT-IN ADVERSARIAL DEMO MODE:
//                                    a blinded-message hex promised to the
//                                    epoch being closed, which this close
//                                    deliberately leaves out. Never set by
//                                    default. Applies to one close only.
//   SOLVENT_TEST_DELAY_BEFORE_EPOCH_COMMIT_MS
//                                    test-only: stages the whole close, then
//                                    blocks before COMMIT so a crash drill
//                                    can SIGKILL the process in that window.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { closeEpoch, type ClosedEpoch } from '../../epoch/closer.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function summary(c: ClosedEpoch): string {
  const lines = [
    `CLOSED EPOCH ${c.epochIndex}  (next open: ${c.nextOpenEpoch})`,
    `  manifest pubkey        ${c.manifestPubkey}`,
    `  previous global digest ${c.previousGlobalDigest}`,
    `  global digest          ${c.globalDigest}`,
  ];
  for (const k of c.keysets) {
    const m = k.manifest;
    lines.push(
      `  keyset ${m.keyset_id} (${m.unit}${m.active ? '' : ', inactive'}): issued ${m.issued_mmr_size} leaves / ${m.issued_mmr_root_sum} sat, spent ${m.spent_mmr_size} / ${m.spent_mmr_root_sum} sat, outstanding ${m.outstanding_balance} sat`,
    );
  }
  if (c.omitted) lines.push(`  ADVERSARIAL DEMO: omitted promised issuance ${c.omitted.blindedMessageHex} (${c.omitted.amount} sat)`);
  if (c.unbackedIssuedRowsExcluded || c.unbackedConsumedRowsExcluded) {
    lines.push(`  excluded rows with no real CDK write behind them: issued ${c.unbackedIssuedRowsExcluded}, consumed ${c.unbackedConsumedRowsExcluded}`);
  }
  return lines.join('\n');
}

function closeOnce(dbPath: string, omit: string | undefined): ClosedEpoch {
  const key = process.env.SOLVENT_MANIFEST_PRIVKEY;
  if (!key) throw new Error('SOLVENT_MANIFEST_PRIVKEY is required');
  const delayMs = Number(process.env.SOLVENT_TEST_DELAY_BEFORE_EPOCH_COMMIT_MS ?? '0');
  // Wait up to 10s for cdk-mintd's write lock, matching its own busy_timeout.
  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  try {
    return closeEpoch(db, {
      manifestPrivateKeyHex: key,
      omitPromisedIssuance: omit,
      beforeCommit:
        delayMs > 0
          ? () => {
              console.log(`SOLVENT TEST HOOK: epoch close fully staged, delaying ${delayMs}ms before COMMIT`);
              sleepSync(delayMs);
            }
          : undefined,
    });
  } finally {
    db.close();
  }
}

function main() {
  const dbPath = process.argv[2];
  if (!dbPath || dbPath.startsWith('--')) throw new Error('usage: pol-epoch-close.ts <path-to-cdk-mintd.sqlite> [--every <seconds>] [--json-out <file>]');
  const jsonOut = arg('--json-out');
  const every = arg('--every');
  const omit = process.env.SOLVENT_OMIT_PROMISED_ISSUANCE || undefined;
  if (omit) console.log(`WARNING: SOLVENT_OMIT_PROMISED_ISSUANCE is set — this close will deliberately break the mint's signed promise for ${omit}`);

  const run = (omitThis: string | undefined) => {
    const closed = closeOnce(dbPath, omitThis);
    console.log(summary(closed));
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(closed, null, 2) + '\n');
    return closed;
  };

  if (!every) {
    run(omit);
    return;
  }
  const seconds = Number(every);
  if (!Number.isFinite(seconds) || seconds < 1) throw new Error('--every must be a whole number of seconds >= 1');
  console.log(`Closing an epoch every ${seconds}s (demo cadence — production mints choose their own).`);
  let first = true;
  for (;;) {
    sleepSync(seconds * 1000);
    run(first ? omit : undefined);
    first = false;
  }
}

try {
  main();
} catch (err) {
  console.error('pol-epoch-close failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
