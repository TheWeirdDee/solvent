// npm run verify:pol-retry
//
// SOLVENT — Phase 2 Step 7/P2-I9: proves a real retry of an
// already-completed NUT-04 issuance cannot duplicate SOLVENT accounting —
// via a genuine second HTTP request to the real mint, not a simulated
// database write. Run immediately after `npm run verify:cashu-real`
// succeeds, while the mint is still running: reads the already-issued
// quote id straight from that run's own evidence (`mint-quote.json`) and
// attempts to mint against it again.
//
// CDK's own process_mint_request() (crates/cdk/src/mint/issue/mod.rs)
// rejects a quote already in the `Issued` state before it ever reaches the
// database transaction that the SOLVENT triggers watch — so a rejected
// retry structurally cannot produce a new blind_signature row, and
// therefore cannot produce a new SOLVENT accounting row either. This test
// proves the rejection actually happens for real, rather than assuming it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Wallet, isMintOperationError } from '@cashu/cashu-ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function latestPriorRunId(): string {
  const base = path.join(REPO_ROOT, 'evidence', 'real-cashu');
  const runs = readdirSync(base)
    .filter((d) => existsSync(path.join(base, d, 'summary.json')) && existsSync(path.join(base, d, 'mint-quote.json')))
    .sort();
  const last = runs[runs.length - 1];
  if (!last) throw new Error(`No prior evidence run with a mint-quote.json found under ${base} — run \`npm run verify:cashu-real\` first.`);
  return last;
}

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(28)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

async function main() {
  const mintUrl = process.env.CDK_MINT_URL;
  if (!mintUrl) throw new Error('Missing required env var CDK_MINT_URL');

  const priorRunId = latestPriorRunId();
  const quoteFile = path.join(REPO_ROOT, 'evidence', 'real-cashu', priorRunId, 'mint-quote.json');
  const { quote, amount } = JSON.parse(readFileSync(quoteFile, 'utf8')) as { quote: string; amount: number };

  console.log('SOLVENT — PHASE 2 NUT-04 RETRY IDEMPOTENCY\n');
  console.log(`Retrying an already-issued quote from prior run ${priorRunId} (quote ${quote}, ${amount} sat)\n`);

  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();

  let rejected = false;
  let detail = '';
  try {
    await wallet.mintProofsBolt11(amount, quote);
    detail = 'mint incorrectly re-issued proofs for an already-issued quote';
  } catch (err) {
    if (isMintOperationError(err)) {
      rejected = true;
      detail = `real mint HTTP error (code ${err.code}, status ${err.status}): ${err.message}`;
    } else {
      detail = `rejected before reaching the mint (not a real mint response): ${(err as Error).message}`;
    }
  }

  console.log(line('Retry idempotency', rejected, detail));
  console.log('');
  if (rejected) {
    console.log('NUT-04 RETRY IDEMPOTENCY VERIFIED');
    process.exitCode = 0;
  } else {
    console.log(`PHASE 2 NOT VERIFIED — retry idempotency: ${detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-nut04-retry-idempotency crashed:', err);
  process.exitCode = 1;
});
