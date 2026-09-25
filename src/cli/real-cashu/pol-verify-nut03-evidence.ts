// npm run verify:nut03-evidence -- [<run-id> | --dir <path>]
//
// SOLVENT — Phase 2 NUT-03 evidence correction. Validates the real NUT-03
// machine-readable evidence package for one run and exits non-zero on any
// failure — a missing file, pass=false, a conservation break, inconsistent
// row counts, incomplete receipts, rows created by a failed swap, partial
// rows after the crash drill, duplicated accounting after restore, state
// changed by a restart, or outstanding liability moved by a pure swap.
// There is no "skip": an absent directory or file is a FAIL.
import path from 'node:path';
import { verifyNut03EvidenceDir } from './nut03-evidence-verifier.js';

function resolveDir(): string {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--dir');
  if (dirFlag !== -1) {
    const dir = args[dirFlag + 1];
    if (!dir) throw new Error('--dir requires a path');
    return path.resolve(dir);
  }
  const runId = args[0] ?? process.env.SOLVENT_RUN_ID;
  if (!runId) throw new Error('usage: pol-verify-nut03-evidence.ts <run-id> | --dir <path>   (or set SOLVENT_RUN_ID)');
  return path.resolve(import.meta.dirname, '..', '..', '..', 'evidence', 'real-pol', runId);
}

function main() {
  const dir = resolveDir();
  console.log(`SOLVENT — NUT-03 MACHINE-READABLE EVIDENCE VERIFICATION\n${dir}\n`);
  const { results, pass } = verifyNut03EvidenceDir(dir);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.file.padEnd(36)} ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log('');
  if (pass) {
    console.log(`NUT-03 EVIDENCE VERIFIED — ${results.length} checks, 0 failed`);
    process.exitCode = 0;
  } else {
    console.log(`NUT-03 EVIDENCE NOT VERIFIED — ${failed} of ${results.length} checks failed`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error('pol-verify-nut03-evidence crashed:', err);
  process.exitCode = 1;
}
