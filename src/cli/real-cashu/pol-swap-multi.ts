// npm run verify:pol-swap-multi
//
// SOLVENT — Phase 2 continuation, Step 18. Proves replacement accounting
// doesn't drift across successive ownership transitions: mint once, then
// two real consecutive swaps (A, then B, each spending the previous
// swap's own replacement outputs), tracking cumulative issued/consumed
// totals and outstanding liability after each step. Outstanding must stay
// constant at the original minted amount throughout.
import {
  Mint,
  OutputData,
  CheckStateEnum,
  hashToCurve,
  type MintRequest,
  type Proof,
  type SerializedBlindedMessage,
  type SwapRequest,
  type MintKeys,
} from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';
import { nut07Block, outstandingTotals, writeNut03Evidence } from './nut03-evidence.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function proofY(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

async function realStates(mint: Mint, proofs: Proof[]): Promise<string[]> {
  const ys = proofs.map(proofY);
  const res = await mint.check({ Ys: ys });
  const byY = new Map(res.states.map((s) => [s.Y, s.state as string]));
  return ys.map((y) => byY.get(y) ?? 'UNKNOWN');
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
  const steps: Array<{
    label: string;
    issued_sat: number;
    consumed_sat: number;
    outstanding_sat: number;
    outstanding_unchanged: boolean;
    nut07: Record<string, unknown>;
    pass: boolean;
  }> = [];
  for (const label of ['A', 'B']) {
    const previousProofs = proofs;
    proofs = await swapOnce(mint, keyset, previousProofs);
    const totals = outstandingTotals(dbPath);
    const outstanding = totals.issuedSat - totals.consumedSat;
    const outstandingOk = outstanding === baselineOutstanding;

    // Real NUT-07 per step: the proofs this swap consumed must now be SPENT,
    // and the proofs it issued must be UNSPENT.
    const nut07 = nut07Block({
      originals: { expected: CheckStateEnum.SPENT, actual: await realStates(mint, previousProofs) },
      replacements: { expected: CheckStateEnum.UNSPENT, actual: await realStates(mint, proofs) },
    });
    const ok = outstandingOk && nut07.pass === true;
    allPass = allPass && ok;
    steps.push({
      label,
      issued_sat: totals.issuedSat,
      consumed_sat: totals.consumedSat,
      outstanding_sat: outstanding,
      outstanding_unchanged: outstandingOk,
      nut07,
      pass: ok,
    });
    console.log(
      line(
        `After swap ${label}`,
        ok,
        `issued=${totals.issuedSat} consumed=${totals.consumedSat} outstanding=${outstanding} (expected unchanged at ${baselineOutstanding}); NUT-07 ${nut07.pass ? 'PASS' : 'FAIL'}`,
      ),
    );
  }

  writeNut03Evidence({
    filename: 'nut03-multi-swap.json',
    operation: 'nut03_multi_swap',
    pass: allPass,
    data: {
      before: { issued_sat: before.issuedSat, consumed_sat: before.consumedSat, outstanding_sat: baselineOutstanding },
      swaps: steps,
      expected_outstanding_sat: baselineOutstanding,
      nut07: nut07Block({
        originals: { expected: CheckStateEnum.SPENT, actual: steps.flatMap((s) => ((s.nut07.originals as { actual: string[] }).actual)) },
        replacements: { expected: CheckStateEnum.UNSPENT, actual: steps.flatMap((s) => ((s.nut07.replacements as { actual: string[] }).actual)) },
        note: 'per-step detail is in swaps[].nut07; this is the union across both swaps',
      }),
      measurement_method: 'whole-database SUM(amount) over solvent_issued_liability/solvent_consumed_liability, not row counts — a delta relative to this script\'s own baseline, since other CI steps mint/swap in the same database',
      invariant: 'P2-S9 extended to consecutive swaps (INVARIANTS.md)',
    },
  });

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
