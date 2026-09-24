// npm run verify:pol-swap-double-spend
//
// SOLVENT — Phase 2 continuation, Steps 12-13. A real, genuinely invalid
// swap reaching the real mint: mints fresh proofs, spends them in one real
// successful swap, then submits a SECOND real raw swap request reusing
// the exact same (now-spent) original inputs. This single real scenario
// satisfies both requested checks at once — a "failed swap" (Step 12) and
// a "double-spend after swap" (Step 13) are the same real event here, not
// two different code paths: reusing an already-spent input is exactly how
// CDK's real double-spend rejection is triggered. Asserts the real mint
// refuses it, and that the failed attempt created zero new accounting
// rows (consumed, issued, or receipt) beyond what the first, successful
// swap created.
import { DatabaseSync } from 'node:sqlite';
import { Mint, OutputData, type MintRequest, type SerializedBlindedMessage, type SwapRequest } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function swapRowCounts(dbPath: string): { consumed: number; issued: number; signed: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const consumed = db.prepare(`SELECT count(*) AS n FROM solvent_consumed_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  const issued = db.prepare(`SELECT count(*) AS n FROM solvent_issued_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  const signed = db
    .prepare(
      `SELECT count(*) AS n FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE r.liability_kind = 'issued' AND il.operation_kind = 'swap' AND r.status = 'signed'`,
    )
    .get() as { n: number };
  db.close();
  return { consumed: consumed.n, issued: issued.n, signed: signed.n };
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-swap-double-spend.ts <path-to-cdk-mintd.sqlite>');

  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  console.log('SOLVENT — PHASE 2 REAL FAILED SWAP / DOUBLE-SPEND-AFTER-SWAP\n');

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
  const originalProofs = mintOutputData.map((o, i) => o.toProof(mintResponse.signatures[i]!, keyset));

  const firstOutputData = OutputData.createRandomData(amountSat, keyset);
  const firstOutputs: SerializedBlindedMessage[] = firstOutputData.map((o) => o.blindedMessage);
  const firstSwap: SwapRequest = { inputs: originalProofs, outputs: firstOutputs };
  await mint.swap(firstSwap);
  console.log(line('Real first swap (spends original inputs)', true));

  const countsAfterFirstSwap = swapRowCounts(dbPath);
  console.log(`Rows after the real, successful swap: consumed=${countsAfterFirstSwap.consumed} issued=${countsAfterFirstSwap.issued} signed=${countsAfterFirstSwap.signed}`);

  // Genuinely invalid: reuse the exact same, now-spent original proofs in a
  // second real raw swap request.
  const secondOutputData = OutputData.createRandomData(amountSat, keyset);
  const secondOutputs: SerializedBlindedMessage[] = secondOutputData.map((o) => o.blindedMessage);
  const secondSwap: SwapRequest = { inputs: originalProofs, outputs: secondOutputs };

  let refused = false;
  let mintResponseMessage = '';
  try {
    await mint.swap(secondSwap);
  } catch (err) {
    refused = true;
    mintResponseMessage = (err as Error).message;
  }
  console.log(line('Real mint refuses reused (already-spent) inputs', refused, mintResponseMessage));

  const countsAfterDoubleSpendAttempt = swapRowCounts(dbPath);
  const noNewRows =
    countsAfterDoubleSpendAttempt.consumed === countsAfterFirstSwap.consumed &&
    countsAfterDoubleSpendAttempt.issued === countsAfterFirstSwap.issued &&
    countsAfterDoubleSpendAttempt.signed === countsAfterFirstSwap.signed;
  console.log(
    line(
      'Zero new accounting rows from the refused attempt',
      noNewRows,
      `before=${JSON.stringify(countsAfterFirstSwap)} after=${JSON.stringify(countsAfterDoubleSpendAttempt)}`,
    ),
  );

  const allPass = refused && noNewRows;
  console.log('');
  if (allPass) {
    console.log('REAL FAILED SWAP / DOUBLE-SPEND-AFTER-SWAP VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('NUT-03 NOT VERIFIED — failed-swap/double-spend accounting incomplete');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-swap-double-spend crashed:', err);
  process.exitCode = 1;
});
