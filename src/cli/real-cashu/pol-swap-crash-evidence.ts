// npm run verify:pol-swap-crash-evidence -- <before-string> <after-string> <sigkill-sent 0|1> <proofs-json-path> [<between-string>]
//
// <between-string> (optional) is the same row-count output taken after the
// kill but before the restart, while the mint process is dead. If the
// read-only open could not read the file at that moment (e.g. a hot
// journal left by the kill), the CI step passes the literal "unreadable"
// and this script records exactly that rather than inventing a number.
//
// SOLVENT — Phase 2 NUT-03 evidence correction. Called by the CI workflow's
// own bash immediately after the real swap crash drill (a genuine
// `kill -9` inside `SwapSaga::finalize()`, before `tx.commit()`) and the
// restart that follows it. <before-string>/<after-string> are the exact,
// real output of `npm run verify:pol-count-swap` against the real database
// (e.g. "consumed=24 issued=24 signed_receipts=24") — parsed here, not
// re-derived or reconstructed from a log. <proofs-json-path> is the real
// proof file pol-swap-crash-mint-proofs.ts wrote; this script queries the
// real, restarted mint's NUT-07 endpoint for those exact proofs.
//
// NUT-07 caveat, stated so no one over-reads the result: CDK's real
// check_state (crates/cdk/src/mint/check_spendable.rs) reports a proof with
// no row as UNSPENT (`state.unwrap_or(State::Unspent)`). So UNSPENT here
// proves the originals are not stuck PENDING and not SPENT — i.e. usable
// again — but it cannot by itself distinguish "compensated and deleted"
// from "never recorded". The row-count diff is what shows no partial
// accounting survived.
import { readFileSync } from 'node:fs';
import { Mint, hashToCurve } from '@cashu/cashu-ts';
import { nut07Block, writeNut03Evidence } from './nut03-evidence.js';

function parseCounts(s: string): { consumed: number; issued: number; signed_receipts: number } {
  const m = s.match(/consumed=(\d+)\s+issued=(\d+)\s+signed_receipts=(\d+)/);
  if (!m) throw new Error(`could not parse row-count string: "${s}"`);
  return { consumed: Number(m[1]), issued: Number(m[2]), signed_receipts: Number(m[3]) };
}

async function main() {
  const [beforeStr, afterStr, sigkillSentStr, proofsPath, betweenStr] = process.argv.slice(2);
  if (!beforeStr || !afterStr || !proofsPath) {
    throw new Error('usage: pol-swap-crash-evidence.ts <before-string> <after-string> <sigkill-sent 0|1> <proofs-json-path>');
  }
  const mintUrl = process.env.CDK_MINT_URL;
  if (!mintUrl) throw new Error('Missing required env var: CDK_MINT_URL');

  const before = parseCounts(beforeStr);
  const after = parseCounts(afterStr);
  const sigkillSent = sigkillSentStr === '1';
  const partial = {
    consumed: after.consumed - before.consumed,
    issued: after.issued - before.issued,
    signed_receipts: after.signed_receipts - before.signed_receipts,
  };
  const noPartialRows = partial.consumed === 0 && partial.issued === 0 && partial.signed_receipts === 0;

  const stored = JSON.parse(readFileSync(proofsPath, 'utf8')) as { proofs: Array<{ secret: string }> };
  const ys = stored.proofs.map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true));
  const res = await new Mint(mintUrl).check({ Ys: ys });
  const byY = new Map(res.states.map((s) => [s.Y, s.state as string]));
  const originalStates = ys.map((y) => byY.get(y) ?? 'UNKNOWN');
  const nut07 = nut07Block({
    originals: { expected: 'UNSPENT', actual: originalStates },
    note:
      'after restart + CDK compensation the originals must not be SPENT or stuck PENDING. No replacements are checked: none were ever durably issued. CDK reports rowless proofs as UNSPENT, so this proves "usable again", not "was compensated" — the row-count diff covers the latter.',
  });

  const pass = sigkillSent && noPartialRows && nut07.pass === true;
  console.log(`Swap crash drill: sigkill_sent=${sigkillSent} partial_rows=${JSON.stringify(partial)} originals_after_restart=${originalStates.join(',')}`);

  writeNut03Evidence({
    filename: 'nut03-crash-before-commit.json',
    operation: 'nut03_crash_before_commit',
    pass,
    data: {
      label: 'CRASH_BEFORE_COMMIT_ROLLBACK',
      crash_method: 'real SIGKILL (kill -9) sent to the real mint process',
      crash_location: "inside SwapSaga::finalize(), before tx.commit() — patches/cdk/0006-*.patch's SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS hook",
      sigkill_sent: sigkillSent,
      row_counts_before_crash: before,
      row_counts_after_crash_and_restart: after,
      row_counts_after_crash_before_restart:
        betweenStr && /consumed=\d+/.test(betweenStr)
          ? parseCounts(betweenStr)
          : { measured: false, raw: betweenStr ?? 'not provided' },
      partial_accounting_rows_created: partial,
      expected_partial_accounting_rows_created: { consumed: 0, issued: 0, signed_receipts: 0 },
      recovery_mechanism_invoked:
        'Mint::recover_from_incomplete_sagas() — real, pre-existing CDK code (crates/cdk/src/mint/start_up_check.rs), called automatically from Mint::start() on the restart that follows the kill',
      original_proof_count: ys.length,
      nut07,
      invariant: 'P2-S4, P2-S9 (INVARIANTS.md)',
    },
  });

  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error('pol-swap-crash-evidence crashed:', err);
  process.exitCode = 1;
});
