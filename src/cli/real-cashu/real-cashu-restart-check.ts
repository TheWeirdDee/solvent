// npm run verify:cashu-real:restart
//
// SOLVENT — Phase 1, item 12: process-restart persistence check.
//
// Must be run AFTER real-cashu-foundation.ts has already produced a full
// VERIFIED run, and AFTER the CDK mint process has been killed and
// restarted against the SAME on-disk work-dir/database (see
// .github/workflows/real-cashu-integration.yml) — this is what actually
// proves the mint's SPENT/UNSPENT state is durable rather than an
// in-memory artifact a process restart would silently reset. A fresh
// Node process, a fresh Wallet instance, and a fresh /v1/checkstate call
// are used throughout — nothing here is carried over from the prior run's
// own process memory. The prior run's evidence directory is located
// automatically (newest under evidence/real-cashu/); no runId needs to be
// passed by hand.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Wallet, getDecodedToken, getEncodedToken, type Proof, type Token } from '@cashu/cashu-ts';
import { EvidenceWriter } from './evidence.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function latestPriorRunId(): string {
  const base = path.join(REPO_ROOT, 'evidence', 'real-cashu');
  const runs = readdirSync(base)
    .filter((d) => existsSync(path.join(base, d, 'summary.json')))
    .sort();
  const last = runs[runs.length - 1];
  if (!last) throw new Error(`No prior evidence run found under ${base} — run \`npm run verify:cashu-real\` first.`);
  return last;
}

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(48)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

async function main() {
  const mintUrl = process.env.CDK_MINT_URL;
  if (!mintUrl) throw new Error('Missing required env var CDK_MINT_URL');

  const priorRunId = latestPriorRunId();
  const senderStateFile = path.join(REPO_ROOT, '.real-cashu-state', `sender-${priorRunId}`, 'wallet-state.json');
  if (!existsSync(senderStateFile)) {
    throw new Error(`No sender wallet state found at ${senderStateFile} — cannot verify restart persistence.`);
  }
  const senderState = JSON.parse(readFileSync(senderStateFile, 'utf8')) as { proofs: Proof[] };
  const originalProofs = senderState.proofs;
  if (originalProofs.length === 0) {
    throw new Error('Sender wallet state has no proofs to check — nothing to verify persistence against.');
  }

  console.log('SOLVENT — REAL CASHU FOUNDATION: RESTART PERSISTENCE CHECK\n');
  console.log(`Checking against prior run ${priorRunId} (${originalProofs.length} known-SPENT proof(s) from before the mint restart)\n`);

  const evidence = new EvidenceWriter(`${priorRunId}-restart`);
  const results: { label: string; ok: boolean; detail?: string }[] = [];
  const record = (label: string, ok: boolean, detail?: string) => {
    results.push({ label, ok, detail });
    console.log(line(label, ok, detail));
  };

  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();

  const stateAfterRestart = await wallet.checkProofsStates(originalProofs);
  const stillSpent = stateAfterRestart.every((s) => s.state === 'SPENT');
  record(
    'R12 Already-spent proofs still SPENT after mint process restart',
    stillSpent,
    `${stateAfterRestart.filter((s) => s.state === 'SPENT').length}/${stateAfterRestart.length} SPENT`,
  );
  evidence.write('restart-proof-state', stateAfterRestart);

  let doubleSpendStillRejected = false;
  let detail = '';
  try {
    const token: Token = { mint: mintUrl, proofs: originalProofs } as Token;
    const decoded = getDecodedToken(getEncodedToken(token), [originalProofs[0]!.id]);
    const preview = await wallet.ops.receive(decoded).prepare();
    await wallet.completeSwap(preview);
    detail = 'mint incorrectly accepted already-spent proofs after restart';
  } catch (err) {
    doubleSpendStillRejected = true;
    detail = (err as Error).message;
  }
  record('R13 Double-spend of pre-restart proofs still REFUSED after restart', doubleSpendStillRejected, detail);
  evidence.write('restart-double-spend-result', { rejected: doubleSpendStillRejected, detail });

  const summary = {
    runId: `${priorRunId}-restart`,
    checkedAgainstPriorRun: priorRunId,
    allPassed: results.every((r) => r.ok),
    results,
  };
  evidence.write('summary', summary);

  console.log('');
  if (summary.allPassed) {
    console.log('REAL CASHU FOUNDATION RESTART PERSISTENCE VERIFIED');
    process.exitCode = 0;
  } else {
    console.log(`PHASE 1 NOT VERIFIED — restart persistence: ${results.filter((r) => !r.ok).map((r) => r.label).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('real-cashu-restart-check crashed:', err);
  process.exitCode = 1;
});
