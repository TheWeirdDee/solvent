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
import { Mint, OutputData, hashToCurve, CheckStateEnum, type MintRequest, type Proof, type SerializedBlindedMessage, type SwapRequest } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';
import { nut07Block, swapRowCounts, writeNut03Evidence } from './nut03-evidence.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function proofY(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
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
  const firstSwapResponse = await mint.swap(firstSwap);
  const firstReplacementProofs = firstOutputData.map((o, i) => o.toProof(firstSwapResponse.signatures[i]!, keyset));
  console.log(line('Real first swap (spends original inputs)', true));

  // Real NUT-07 reconciliation: confirm the originals are genuinely SPENT
  // and the first swap's replacements genuinely UNSPENT via /v1/checkstate,
  // not merely inferred from the swap call succeeding.
  const statesAfterFirstSwap = await mint.check({ Ys: originalProofs.map(proofY) });
  const originalsSpentAfterFirstSwap = statesAfterFirstSwap.states.every((s) => s.state === CheckStateEnum.SPENT);
  console.log(line('Real NUT-07: originals SPENT after first swap', originalsSpentAfterFirstSwap));
  const firstReplacementStates = await mint.check({ Ys: firstReplacementProofs.map(proofY) });
  const firstReplacementsUnspent = firstReplacementStates.states.every((s) => s.state === CheckStateEnum.UNSPENT);
  console.log(line('Real NUT-07: first swap replacements UNSPENT', firstReplacementsUnspent));

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

  // Real NUT-07: the refused attempt must not have changed the originals'
  // state either (still SPENT, not reverted or duplicated).
  const statesAfterRefusal = await mint.check({ Ys: originalProofs.map(proofY) });
  const originalsStillSpentAfterRefusal = statesAfterRefusal.states.every((s) => s.state === CheckStateEnum.SPENT);
  console.log(line('Real NUT-07: originals still SPENT after refusal', originalsStillSpentAfterRefusal));

  const allPass = refused && noNewRows && originalsSpentAfterFirstSwap && firstReplacementsUnspent && originalsStillSpentAfterRefusal;

  const nut07 = nut07Block({
    originals: { expected: 'SPENT', actual: statesAfterRefusal.states.map((s) => s.state) },
    replacements: { expected: 'UNSPENT', actual: firstReplacementStates.states.map((s) => s.state) },
    note: 'originals checked after the first (successful) swap and again after the refused reuse attempt; "replacements" are the first swap\'s outputs — the refused attempt produced none',
  });

  writeNut03Evidence({
    filename: 'nut03-failed-swap.json',
    operation: 'nut03_failed_swap',
    pass: refused && noNewRows,
    data: {
      real_mint_request_attempted: true,
      mint_response: mintResponseMessage,
      consumed_rows_before: countsAfterFirstSwap.consumed,
      consumed_rows_after: countsAfterDoubleSpendAttempt.consumed,
      issued_rows_before: countsAfterFirstSwap.issued,
      issued_rows_after: countsAfterDoubleSpendAttempt.issued,
      receipt_rows_before: countsAfterFirstSwap.signed,
      receipt_rows_after: countsAfterDoubleSpendAttempt.signed,
      new_consumed_rows: countsAfterDoubleSpendAttempt.consumed - countsAfterFirstSwap.consumed,
      new_issued_rows: countsAfterDoubleSpendAttempt.issued - countsAfterFirstSwap.issued,
      new_receipt_rows: countsAfterDoubleSpendAttempt.signed - countsAfterFirstSwap.signed,
      expected: { new_consumed_rows: 0, new_issued_rows: 0, new_receipt_rows: 0 },
      nut07,
      invariant: 'P2-S4 (INVARIANTS.md)',
    },
  });

  writeNut03Evidence({
    filename: 'nut03-double-spend.json',
    operation: 'nut03_double_spend',
    pass: refused && originalsSpentAfterFirstSwap && firstReplacementsUnspent && originalsStillSpentAfterRefusal,
    data: {
      real_mint_request_attempted: true,
      mint_response: mintResponseMessage,
      originals_spent_after_first_swap: originalsSpentAfterFirstSwap,
      originals_still_spent_after_refusal: originalsStillSpentAfterRefusal,
      first_swap_replacements_unspent: firstReplacementsUnspent,
      nut07,
      note: 'the same real event as nut03-failed-swap.json — reusing already-spent swap inputs is both the failed-swap and the double-spend-after-swap case here, not two different code paths',
      invariant: 'P2-S4, P2-S11 (INVARIANTS.md)',
    },
  });

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
