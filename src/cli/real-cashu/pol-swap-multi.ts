// npm run verify:pol-swap-multi
//
// SOLVENT — Phase 2 continuation, Step 18. Proves replacement accounting
// doesn't drift across successive ownership transitions: mint once, then
// two real consecutive swaps (A, then B, each spending the previous
// swap's own replacement outputs), tracking cumulative issued/consumed
// totals and outstanding liability after each step. Outstanding must stay
// constant at the original minted amount throughout.
import { DatabaseSync } from 'node:sqlite';
import { Mint, OutputData, type MintRequest, type Proof, type SerializedBlindedMessage, type SwapRequest, type MintKeys } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

// Whole-database totals (not scoped to this test's own rows), because
// "outstanding liability" is a property of the mint's entire accounting
// state, not one operation. Other CI steps mint/swap in the same
// database before this one runs, so the assertion below compares
// before/after *within this script's own run* (a pure swap must not
// change the global outstanding total), not against a hardcoded absolute
// value — a more general, order-independent form of the same invariant.
function outstandingTotals(dbPath: string): { issuedSat: number; consumedSat: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const issued = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM solvent_issued_liability`).get() as { n: number };
  const consumed = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM solvent_consumed_liability`).get() as { n: number };
  db.close();
  return { issuedSat: issued.n, consumedSat: consumed.n };
}

async function swapOnce(mint: Mint, keyset: MintKeys, inputProofs: Proof[]): Promise<Proof[]> {
  const total = inputProofs.reduce((sum, p) => sum + Number(p.amount), 0);
  const outputData = OutputData.createRandomData(total, keyset);
  const outputs: SerializedBlindedMessage[] = outputData.map((o) => o.blindedMessage);
  const swapPayload: SwapRequest = { inputs: inputProofs, outputs };
  const response = await mint.swap(swapPayload);
  return outputData.map((o, i) => o.toProof(response.signatures[i]!, keyset));
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-swap-multi.ts <path-to-cdk-mintd.sqlite>');

  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  console.log('SOLVENT — PHASE 2 REAL MULTIPLE CONSECUTIVE SWAPS\n');

  const mint = new Mint(mintUrl);
  const keysResp = await mint.getKeys();
  const keyset = keysResp.keysets[0]!;

  const lndSource = new LndClient({ restUrl: lndSourceRestUrl, macaroonHex: lndSourceMacaroonHex });
  const quote = await mint.createMintQuoteBolt11({ amount: amountSat, unit: 'sat' });
  const payment = await lndSource.payInvoiceSync(quote.request);
  if (!payment.ok) throw new Error(`real payment failed: ${payment.paymentError}`);

  const mintOutputData = OutputData.createRandomData(amountSat, keyset);
  const mintOutputs: SerializedBlindedMessage[] = mintOutputData.map((o) => o.blindedMessage);
  const mintRequest: MintRequest = { quote: quote.quote, outputs: mintOutputs };
  const mintResponse = await mint.mintBolt11(mintRequest);
  let proofs = mintOutputData.map((o, i) => o.toProof(mintResponse.signatures[i]!, keyset));

  const before = outstandingTotals(dbPath);
  const baselineOutstanding = before.issuedSat - before.consumedSat;
  console.log(`Before any swap:  issued=${before.issuedSat} consumed=${before.consumedSat} outstanding=${baselineOutstanding}`);

  let allPass = true;
  for (const label of ['A', 'B']) {
    proofs = await swapOnce(mint, keyset, proofs);
    const totals = outstandingTotals(dbPath);
    const outstanding = totals.issuedSat - totals.consumedSat;
    const ok = outstanding === baselineOutstanding;
    allPass = allPass && ok;
    console.log(
      line(
        `After swap ${label}`,
        ok,
        `issued=${totals.issuedSat} consumed=${totals.consumedSat} outstanding=${outstanding} (expected unchanged at ${baselineOutstanding})`,
      ),
    );
  }

  console.log('');
  if (allPass) {
    console.log('REAL MULTIPLE CONSECUTIVE SWAPS VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('NUT-03 NOT VERIFIED — multi-swap outstanding liability drifted');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-swap-multi crashed:', err);
  process.exitCode = 1;
});
