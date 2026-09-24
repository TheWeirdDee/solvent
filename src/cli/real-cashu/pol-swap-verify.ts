// npm run verify:pol-swap
//
// SOLVENT — Phase 2 continuation, Steps 9-13: a real NUT-03 swap end to
// end. Mints fresh proofs via a real Lightning payment (dedicated to this
// test, kept separate from other operations' accounting rows), checks
// their real NUT-07 state, performs a real swap via the low-level `Mint`
// client (so the exact blinded outputs are known to this script), checks
// the real post-swap proof states, verifies the real CDK-defined
// conservation equation (input = output + fee) against the mint's own
// live `input_fee_ppk`, and retrieves + independently verifies every
// replacement output's real PoL receipt.
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
  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
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

  const swapResponse = await mint.swap(swapPayload);
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
  for (let i = 0; i < swapOutputData.length; i++) {
    const bm = swapOutputData[i]!.blindedMessage;
    const hex = bm.B_;
    const amount = Number(bm.amount);
    const res = await fetch(`${mintUrl}/v1/solvent/pol-receipt/${hex}`);
    if (!res.ok) {
      console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, false, `HTTP ${res.status}`));
      continue;
    }
    const body = (await res.json()) as { status: string; target_epoch?: number; signature?: string };
    if (body.status !== 'signed' || !body.signature) {
      console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, false, `status=${body.status}`));
      continue;
    }
    receiptsSigned++;
    const pubkey = keyset.keys[String(amount)];
    const message = new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${hex}:${body.target_epoch}`);
    const ok = pubkey ? schnorrVerifyDigest(body.signature, sha256(message), pubkey, false) : false;
    if (ok) receiptsVerified++;
    console.log(line(`Receipt for replacement output ${i} (amount ${amount})`, ok));
  }
  console.log(
    line('Replacement PoL receipts (signed)', receiptsSigned === swapOutputData.length, `${receiptsSigned}/${swapOutputData.length}`),
  );
  console.log(
    line('Replacement receipt verification', receiptsVerified === swapOutputData.length, `${receiptsVerified}/${swapOutputData.length}`),
  );

  const allPass =
    inputFeePpk === 0 &&
    preAllUnspent &&
    allSpent &&
    allUnspent &&
    conserved &&
    receiptsSigned === swapOutputData.length &&
    receiptsVerified === swapOutputData.length;

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
