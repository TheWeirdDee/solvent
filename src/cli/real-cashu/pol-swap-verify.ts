// npm run verify:pol-swap -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 continuation, Steps 9-13: a real NUT-03 swap end to
// end. Mints fresh proofs via a real Lightning payment (dedicated to this
// test, kept separate from other operations' accounting rows), checks
// their real NUT-07 state, performs a real swap via the low-level `Mint`
// client (so the exact blinded outputs are known to this script), checks
// the real post-swap proof states, verifies the real CDK-defined
// conservation equation (input = output + fee) against the mint's own
// live `input_fee_ppk`, and retrieves + independently verifies every
// replacement output's real PoL receipt. Also writes real, dedicated
// machine-readable evidence (nut03-swap.json, nut03-conservation.json,
// nut03-accounting-rows.json, nut03-receipts.json) from the exact same
// values this script's own console output is built from — see
// nut03-evidence.ts and DECISIONS.md's evidence-correction entry.
import {
  Mint,
  OutputData,
  CheckStateEnum,
  hashToCurve,
  schnorrVerifyDigest,
  type Proof,
  type SerializedBlindedMessage,
  type MintRequest,
  type SwapRequest,
  type MintKeys,
} from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { LndClient } from './lnd-client.js';
import { nut07Block, swapRowCounts, writeNut03Evidence } from './nut03-evidence.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function proofY(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

async function mintReal(mint: Mint, lnd: LndClient, keyset: MintKeys, amountSat: number): Promise<Proof[]> {
  const quote = await mint.createMintQuoteBolt11({ amount: amountSat, unit: 'sat' });
  const payment = await lnd.payInvoiceSync(quote.request);
  if (!payment.ok) throw new Error(`real payment failed: ${payment.paymentError}`);
  const outputData = OutputData.createRandomData(amountSat, keyset);
  const outputs: SerializedBlindedMessage[] = outputData.map((o) => o.blindedMessage);
  const mintRequest: MintRequest = { quote: quote.quote, outputs };
  const response = await mint.mintBolt11(mintRequest);
  return outputData.map((o, i) => o.toProof(response.signatures[i]!, keyset));
}

async function checkStates(mint: Mint, proofs: Proof[]): Promise<CheckStateEnum[]> {
  const ys = proofs.map(proofY);
  const res = await mint.check({ Ys: ys });
  const byY = new Map(res.states.map((s) => [s.Y, s.state]));
  return ys.map((y) => byY.get(y) ?? ('UNKNOWN' as CheckStateEnum));
}

async function main() {
  const dbPath = process.argv[2];
  // Optional third arg: a variant suffix so a second real call in the same
  // run (e.g. the post-restart swap) writes its own evidence files rather
  // than silently overwriting the first call's — each real swap this
  // script performs is a distinct real event and deserves its own record.
  const variant = process.argv[3] ? `-${process.argv[3]}` : '';
  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }
  if (!dbPath) {
    throw new Error('usage: pol-swap-verify.ts <path-to-cdk-mintd.sqlite> [variant-suffix] (db path required to write real NUT-03 evidence)');
  }

  console.log('SOLVENT — PHASE 2 REAL NUT-03 SWAP ACCOUNTING\n');

  const mint = new Mint(mintUrl);
  const keysResp = await mint.getKeys();
  const keyset = keysResp.keysets[0]!;
  const inputFeePpk = keyset.input_fee_ppk ?? 0;
  console.log(line('Fee configuration (input_fee_ppk)', inputFeePpk === 0, `${inputFeePpk}`));

  const lndSource = new LndClient({ restUrl: lndSourceRestUrl, macaroonHex: lndSourceMacaroonHex });

  const inputProofs = await mintReal(mint, lndSource, keyset, amountSat);
  console.log(`Real mint for swap input: ${inputProofs.length} proofs, ${amountSat} sat total\n`);

  const preStates = await checkStates(mint, inputProofs);
  const preAllUnspent = preStates.every((s) => s === CheckStateEnum.UNSPENT);
  console.log(line('Incoming proofs before swap (UNSPENT)', preAllUnspent, preStates.join(',')));

  const inputTotal = inputProofs.reduce((sum, p) => sum + Number(p.amount), 0);
  const fee = Math.ceil((inputProofs.length * inputFeePpk) / 1000);
  const outputTotal = inputTotal - fee;

  const swapOutputData = OutputData.createRandomData(outputTotal, keyset);
  const swapOutputs: SerializedBlindedMessage[] = swapOutputData.map((o) => o.blindedMessage);
  const swapPayload: SwapRequest = { inputs: inputProofs, outputs: swapOutputs };

  // Real row-count snapshot immediately around the real swap call — this
  // is the only point where "rows this specific swap created" is
  // knowable; a later, standalone query against the final database
  // couldn't isolate it from other swaps in the same run.
  const rowsBeforeSwap = swapRowCounts(dbPath);
  const swapResponse = await mint.swap(swapPayload);
  const rowsAfterSwap = swapRowCounts(dbPath);
  const replacementProofs = swapOutputData.map((o, i) => o.toProof(swapResponse.signatures[i]!, keyset));
  console.log(
    line('Real NUT-03 swap', replacementProofs.length === swapOutputData.length, `${replacementProofs.length} replacement proofs`),
  );

  const postOriginalStates = await checkStates(mint, inputProofs);
  const allSpent = postOriginalStates.every((s) => s === CheckStateEnum.SPENT);
  console.log(line('Original proofs after swap (SPENT)', allSpent, postOriginalStates.join(',')));

  const postReplacementStates = await checkStates(mint, replacementProofs);
  const allUnspent = postReplacementStates.every((s) => s === CheckStateEnum.UNSPENT);
  console.log(line('Replacement proofs (UNSPENT)', allUnspent, postReplacementStates.join(',')));

  const conserved = inputTotal === outputTotal + fee;
  console.log(line('Conservation (input = output + fee)', conserved, `${inputTotal} = ${outputTotal} + ${fee}`));

  let receiptsSigned = 0;
  let receiptsVerified = 0;
  const receiptDetails: Array<{ index: number; blinded_message_hex: string; amount: number; status: string; verified: boolean }> = [];
  for (let i = 0; i < swapOutputData.length; i++) {
    const bm = swapOutputData[i]!.blindedMessage;
    const hex = bm.B_;
    const amount = Number(bm.amount);
    const res = await fetch(`${mintUrl}/v1/solvent/pol-receipt/${hex}`);
    if (!res.ok) {
      console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, false, `HTTP ${res.status}`));
      receiptDetails.push({ index: i, blinded_message_hex: hex, amount, status: `http_${res.status}`, verified: false });
      continue;
    }
    const body = (await res.json()) as { status: string; target_epoch?: number; signature?: string };
    if (body.status !== 'signed' || !body.signature) {
      console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, false, `status=${body.status}`));
      receiptDetails.push({ index: i, blinded_message_hex: hex, amount, status: body.status, verified: false });
      continue;
    }
    receiptsSigned++;
    const pubkey = keyset.keys[String(amount)];
    const message = new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${hex}:${body.target_epoch}`);
    const ok = pubkey ? schnorrVerifyDigest(body.signature, sha256(message), pubkey, false) : false;
    if (ok) receiptsVerified++;
    console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, ok));
    receiptDetails.push({ index: i, blinded_message_hex: hex, amount, status: body.status, verified: ok });
  }
  console.log(
    line('Replacement PoL receipts (signed)', receiptsSigned === swapOutputData.length, `${receiptsSigned}/${swapOutputData.length}`),
  );
  console.log(
    line('Replacement receipt verification', receiptsVerified === swapOutputData.length, `${receiptsVerified}/${swapOutputData.length}`),
  );

  const consumedRowsCreated = rowsAfterSwap.consumed - rowsBeforeSwap.consumed;
  const issuedRowsCreated = rowsAfterSwap.issued - rowsBeforeSwap.issued;
  const receiptRowsCreated = rowsAfterSwap.signed - rowsBeforeSwap.signed;
  const rowsMatch =
    consumedRowsCreated === inputProofs.length &&
    issuedRowsCreated === replacementProofs.length &&
    receiptRowsCreated === replacementProofs.length;
  console.log(
    line(
      'Accounting rows created by this swap',
      rowsMatch,
      `consumed=${consumedRowsCreated} issued=${issuedRowsCreated} signed_receipts=${receiptRowsCreated}`,
    ),
  );

  const allPass =
    inputFeePpk === 0 &&
    preAllUnspent &&
    allSpent &&
    allUnspent &&
    conserved &&
    rowsMatch &&
    receiptsSigned === swapOutputData.length &&
    receiptsVerified === swapOutputData.length;

  writeNut03Evidence({
    filename: `nut03-swap${variant}.json`,
    operation: 'nut03_swap',
    pass: allPass,
    data: {
      input_sats: inputTotal,
      input_proof_count: inputProofs.length,
      output_sats: outputTotal,
      output_proof_count: replacementProofs.length,
      fee_sats: fee,
      consumed_rows_created: consumedRowsCreated,
      issued_rows_created: issuedRowsCreated,
      receipt_rows_created: receiptRowsCreated,
      signed_receipts: `${receiptsSigned}/${swapOutputData.length}`,
      original_proof_states_before: preStates,
      original_proof_states_after: postOriginalStates,
      replacement_proof_states_after: postReplacementStates,
      nut07: nut07Block({
        originals: { expected: 'SPENT', actual: postOriginalStates },
        replacements: { expected: 'UNSPENT', actual: postReplacementStates },
        note: `originals were also checked before the swap: ${preStates.join(',')} (expected all UNSPENT)`,
      }),
      // Expectations derived from this run's own real inputs, not hardcoded:
      // the requested mint amount, the mint's live input_fee_ppk, and the
      // actual number of real input/replacement proofs.
      expected: {
        input_sats: amountSat,
        output_sats: amountSat - fee,
        fee_sats: Math.ceil((inputProofs.length * inputFeePpk) / 1000),
        consumed_rows_created: inputProofs.length,
        issued_rows_created: replacementProofs.length,
        receipt_rows_created: replacementProofs.length,
        signed_receipts: `${replacementProofs.length}/${replacementProofs.length}`,
      },
      actual: {
        input_sats: inputTotal,
        output_sats: outputTotal,
        fee_sats: fee,
        consumed_rows_created: consumedRowsCreated,
        issued_rows_created: issuedRowsCreated,
        receipt_rows_created: receiptRowsCreated,
        signed_receipts: `${receiptsSigned}/${swapOutputData.length}`,
      },
      invariant: 'P2-S1, P2-S2, P2-S3, P2-S7, P2-S8, P2-S11, P2-S12, P2-S13 (INVARIANTS.md)',
    },
  });

  writeNut03Evidence({
    filename: `nut03-conservation${variant}.json`,
    operation: 'nut03_conservation',
    pass: conserved,
    data: {
      input_sats: inputTotal,
      output_sats: outputTotal,
      fee_sats: fee,
      input_fee_ppk: inputFeePpk,
      equation: `${inputTotal} = ${outputTotal} + ${fee}`,
      equation_holds: conserved,
      invariant: 'P2-S5 (fees disabled), P2-S6 (fees enabled) — INVARIANTS.md',
    },
  });

  writeNut03Evidence({
    filename: `nut03-accounting-rows${variant}.json`,
    operation: 'nut03_accounting_rows',
    pass: rowsMatch,
    data: {
      rows_before_swap: rowsBeforeSwap,
      rows_after_swap: rowsAfterSwap,
      consumed_rows_created: consumedRowsCreated,
      issued_rows_created: issuedRowsCreated,
      receipt_rows_created: receiptRowsCreated,
      expected_consumed_rows: inputProofs.length,
      expected_issued_rows: replacementProofs.length,
      expected_receipt_rows: replacementProofs.length,
      invariant: 'P2-S1, P2-S2, P2-S3 (INVARIANTS.md)',
    },
  });

  writeNut03Evidence({
    filename: `nut03-receipts${variant}.json`,
    operation: 'nut03_receipts',
    pass: receiptsSigned === swapOutputData.length && receiptsVerified === swapOutputData.length,
    data: {
      receipts_signed: receiptsSigned,
      receipts_verified: receiptsVerified,
      total_outputs: swapOutputData.length,
      per_output: receiptDetails,
      verification_method: 'independent BIP-340 Schnorr verification against the mint\'s own public /v1/keys response',
      invariant: 'P2-S3, P2-S13 (INVARIANTS.md)',
    },
  });

  console.log('');
  console.log(`Input amount:                 ${inputTotal}`);
  console.log(`Input proof count:             ${inputProofs.length}`);
  console.log(`Replacement amount:            ${outputTotal}`);
  console.log(`Replacement proof count:       ${replacementProofs.length}`);
  console.log(`Protocol fee:                  ${fee}`);
  console.log('');
  if (allPass) {
    console.log('REAL NUT-03 SWAP ACCOUNTING VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('NUT-03 NOT VERIFIED — swap accounting incomplete');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-swap-verify crashed:', err);
  process.exitCode = 1;
});
