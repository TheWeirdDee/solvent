// npm run verify:pol-swap-restart-evidence -- <before-string> <after-string> <post-restart-swap-pass 0|1>
//
// SOLVENT — Phase 2 NUT-03 evidence correction. Called by the CI workflow's
// own bash after the real process-restart reconciliation and the real
// swap performed immediately afterward. <before-string>/<after-string> are
// the exact, real output of `npm run verify:pol-count-swap` taken before
// and after killing and restarting the real mint process — parsed here,
// not reconstructed from a log.
import { writeNut03Evidence } from './nut03-evidence.js';

function parseCounts(s: string): { consumed: number; issued: number; signed_receipts: number } {
  const m = s.match(/consumed=(\d+)\s+issued=(\d+)\s+signed_receipts=(\d+)/);
  if (!m) throw new Error(`could not parse row-count string: "${s}"`);
  return { consumed: Number(m[1]), issued: Number(m[2]), signed_receipts: Number(m[3]) };
}

function main() {
  const [beforeStr, afterStr, postRestartSwapPassStr] = process.argv.slice(2);
  if (!beforeStr || !afterStr) {
    throw new Error('usage: pol-swap-restart-evidence.ts <before-string> <after-string> <post-restart-swap-pass 0|1>');
  }
  const before = parseCounts(beforeStr);
  const after = parseCounts(afterStr);
  const identical = before.consumed === after.consumed && before.issued === after.issued && before.signed_receipts === after.signed_receipts;
  const postRestartSwapPass = postRestartSwapPassStr === '1';

  const pass = identical && postRestartSwapPass;
  console.log(`Swap restart evidence: before=${JSON.stringify(before)} after=${JSON.stringify(after)} post_restart_swap_pass=${postRestartSwapPass}`);
  process.exitCode = pass ? 0 : 1;

  writeNut03Evidence({
    filename: 'nut03-restart.json',
    operation: 'nut03_restart',
    pass,
    data: {
      swap_scoped_accounting_before_restart: before,
      swap_scoped_accounting_after_restart: after,
      state_unchanged_across_restart: identical,
      snapshot_points:
        'taken (mint stopped) in the workflow\'s "Reconcile Phase 2 accounting ... (pre-restart)" and "(post-restart)" steps; the real mint process is killed and restarted between them — see .github/workflows/real-cashu-integration.yml for the exact sequence',
      real_swap_performed_after_restart: true,
      swap_after_restart_pass: postRestartSwapPass,
      swap_after_restart_evidence: 'evidence/real-pol/<run-id>/nut03-swap-post-restart.json (pol-swap-verify.ts re-run after restart with variant "post-restart", written as its own file)',
      invariant: 'P2-S9 (INVARIANTS.md)',
    },
  });
}

main();
