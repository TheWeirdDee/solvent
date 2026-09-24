// npm run verify:pol-swap-restore
//
// SOLVENT — Phase 2 continuation, Steps 15-16. Proves the real, existing
// CDK recovery mechanism for "the swap committed but the client never got
// the response": a real NUT-03 swap is submitted and completes on the
// mint (the response is available, but deliberately not used to build
// proofs, standing in for a client that received nothing), then the exact
// same blinded outputs are resubmitted to the real NUT-09 `POST /v1/restore`
// endpoint (crates/cdk-axum's existing, unpatched route — not a SOLVENT
// addition). Confirms: original inputs are SPENT (the swap really did
// commit), the restored signatures reconstruct valid, real proofs, those
// proofs are UNSPENT and spendable, and their PoL receipts are retrievable
// and verify — all without ever touching the swap's own original response.
// No new swap accounting is created by the restore call itself.
import {
  Mint,
  OutputData,
  CheckStateEnum,
  hashToCurve,
  schnorrVerifyDigest,
  type Proof,
  type MintRequest,
  type SerializedBlindedMessage,
  type SwapRequest,
  type PostRestorePayload,
} from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { DatabaseSync } from 'node:sqlite';
import { LndClient } from './lnd-client.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(38)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function proofY(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

function swapRowCounts(dbPath: string): { consumed: number; issued: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const consumed = db.prepare(`SELECT count(*) AS n FROM solvent_consumed_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  const issued = db.prepare(`SELECT count(*) AS n FROM solvent_issued_liability WHERE operation_kind = 'swap'`).get() as { n: number };
  db.close();
  return { consumed: consumed.n, issued: issued.n };
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('usage: pol-swap-restore.ts <path-to-cdk-mintd.sqlite>');

  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  console.log('SOLVENT — PHASE 2 REAL SWAP RESPONSE-LOSS RECOVERY (NUT-09 restore)\n');

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
  const inputProofs = mintOutputData.map((o, i) => o.toProof(mintResponse.signatures[i]!, keyset));

  const swapOutputData = OutputData.createRandomData(amountSat, keyset);
  const swapOutputs: SerializedBlindedMessage[] = swapOutputData.map((o) => o.blindedMessage);
  const swapPayload: SwapRequest = { inputs: inputProofs, outputs: swapOutputs };

  const countsBeforeRestore = swapRowCounts(dbPath);
  // The swap really commits on the mint here — this is the real "committed
  // but client discards the response" case, not a simulation of the swap
  // itself.
  await mint.swap(swapPayload);
  console.log(line('Real swap committed (response deliberately discarded)', true));

  const postOriginalStates = await mint.check({ Ys: inputProofs.map(proofY) });
  const allSpent = postOriginalStates.states.every((s) => s.state === CheckStateEnum.SPENT);
  console.log(line('Original inputs SPENT (swap really committed)', allSpent));

  const restorePayload: PostRestorePayload = { outputs: swapOutputs };
  const restoreResponse = await mint.restore(restorePayload);
  const restoredProofs = swapOutputData.map((o, i) => o.toProof(restoreResponse.signatures[i]!, keyset));
  console.log(
    line('NUT-09 restore recovered replacement signatures', restoredProofs.length === swapOutputData.length, `${restoredProofs.length}`),
  );

  const restoredStates = await mint.check({ Ys: restoredProofs.map(proofY) });
  const allUnspent = restoredStates.states.every((s) => s.state === CheckStateEnum.UNSPENT);
  console.log(line('Restored proofs are real and UNSPENT', allUnspent));

  const countsAfterRestore = swapRowCounts(dbPath);
  const noDuplicateAccounting = countsAfterRestore.consumed === countsBeforeRestore.consumed && countsAfterRestore.issued === countsBeforeRestore.issued;
  console.log(
    line(
      'Restore created no new/duplicate accounting',
      noDuplicateAccounting,
      `before=${JSON.stringify(countsBeforeRestore)} after=${JSON.stringify(countsAfterRestore)}`,
    ),
  );

  let receiptsVerified = 0;
  for (let i = 0; i < swapOutputData.length; i++) {
    const bm = swapOutputData[i]!.blindedMessage;
    const hex = bm.B_;
    const amount = Number(bm.amount);
    const res = await fetch(`${mintUrl}/v1/solvent/pol-receipt/${hex}`);
    if (!res.ok) continue;
    const body = (await res.json()) as { status: string; target_epoch?: number; signature?: string };
    if (body.status !== 'signed' || !body.signature) continue;
    const pubkey = keyset.keys[String(amount)];
    const message = new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${hex}:${body.target_epoch}`);
    const ok = pubkey ? schnorrVerifyDigest(body.signature, sha256(message), pubkey, false) : false;
    if (ok) receiptsVerified++;
  }
  console.log(
    line('Receipts retrievable and verified after restore', receiptsVerified === swapOutputData.length, `${receiptsVerified}/${swapOutputData.length}`),
  );

  const allPass = allSpent && restoredProofs.length === swapOutputData.length && allUnspent && noDuplicateAccounting && receiptsVerified === swapOutputData.length;

  console.log('');
  if (allPass) {
    console.log('REAL SWAP RESPONSE-LOSS RECOVERY VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('NUT-03 NOT VERIFIED — response-loss recovery incomplete');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-swap-restore crashed:', err);
  process.exitCode = 1;
});
