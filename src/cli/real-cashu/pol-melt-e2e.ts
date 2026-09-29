// npm run verify:pol-melt -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT Phase 3C — real NUT-05 melt accounting against a running patched
// cdk-mintd (patches 0001-0009, migrations 0001-0003):
//
//   mint 1000 sat -> melt to a Lightning invoice with change ->
//     inputs  -> consumed liabilities (TX1, SPENT transition, open epoch)
//     change  -> issued liabilities + receipts signed in TX2 (patch 0009)
//   failed payment -> no accounting; double spend -> refused, no accounting
//   close the epoch -> outstanding fell by exactly (inputs - change); audit
//
// Environment:
//   CDK_MINT_URL, SOLVENT_MANIFEST_PRIVKEY, SOLVENT_RUN_ID
//   LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX
//       when set, the melt pays a real invoice created on that LND node
//       (lightning_backend = "lnd"); otherwise it pays a fresh invoice of the
//       same fakewallet mint (lightning_backend = "fakewallet").
// Evidence holds only public values (blinded messages, Y values, amounts).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Mint, Wallet, type Proof } from '@cashu/cashu-ts';
import { reconstruct, spentY } from '../../cashu/reconstruct.js';
import { auditClosedEpoch, closeEpoch, deriveKeysetCommitment, openEpoch } from '../../epoch/closer.js';
import { root } from '../../pol/mmr.js';
import { verifyIssuedReceipt } from '../../pol/receipt.js';
import { LndClient } from './lnd-client.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${label.padEnd(76)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
}

const sum = (xs: { amount: unknown }[]) => xs.reduce((s, x) => s + Number(x.amount), 0);

function outstanding(db: DatabaseSync, keysetId: string, epoch: number): number {
  const c = deriveKeysetCommitment(db, keysetId, epoch);
  return Number(root(c.issued).sum - root(c.spent).sum);
}

async function main() {
  const dbPath = process.argv[2];
  const mintUrl = process.env.CDK_MINT_URL;
  const key = process.env.SOLVENT_MANIFEST_PRIVKEY;
  if (!dbPath || !mintUrl || !key) throw new Error('usage: CDK_MINT_URL=… SOLVENT_MANIFEST_PRIVKEY=… pol-melt-e2e.ts <path-to-cdk-mintd.sqlite>');
  const lnd =
    process.env.LND_SOURCE_REST_URL && process.env.LND_SOURCE_MACAROON_HEX
      ? new LndClient({ restUrl: process.env.LND_SOURCE_REST_URL, macaroonHex: process.env.LND_SOURCE_MACAROON_HEX })
      : null;
  const backend = lnd ? 'lnd' : 'fakewallet';
  const runId = process.env.SOLVENT_RUN_ID ?? `nut05-local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = path.join('evidence', 'real-pol', runId);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, pass: boolean, body: Record<string, unknown>) =>
    writeFileSync(path.join(dir, name), JSON.stringify({ run_id: runId, generated_at: new Date().toISOString(), lightning_backend: backend, pass, ...body }, null, 2) + '\n');

  console.log(`SOLVENT — PHASE 3C REAL NUT-05 MELT ACCOUNTING (lightning_backend=${backend})\n`);
  const db = new DatabaseSync(dbPath, { timeout: 10_000 });
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();
  const keys = (await new Mint(mintUrl).getKeys()).keysets.find((k) => k.unit === 'sat')!;
  const blindedMessageOf = (p: Proof) => {
    const r = reconstruct(p, p.id, keys.keys[String(p.amount)]!);
    if (!r.valid || !r.bPrimeHex) throw new Error('DLEQ reconstruction failed — change must carry DLEQ');
    return r.bPrimeHex;
  };
  const consumedMelt = () =>
    db.prepare(`SELECT proof_y_hex, amount, target_epoch FROM solvent_consumed_liability WHERE operation_kind = 'melt'`).all() as { proof_y_hex: string; amount: number; target_epoch: number }[];

  try {
    const epochN = openEpoch(db).epochIndex;
    const before = outstanding(db, keys.id, epochN);

    // Mint 1000 sat (paid over real Lightning when LND is configured).
    const mq = await wallet.createMintQuoteBolt11(1000);
    if (lnd) {
      const pay = await lnd.payInvoiceSync(mq.request);
      if (!pay.ok) throw new Error(`mint invoice payment failed: ${pay.paymentError}`);
    }
    for (let i = 0; i < 60 && (await wallet.checkMintQuoteBolt11(mq.quote)).state !== 'PAID'; i++) await new Promise((r) => setTimeout(r, 500));
    const inputs = await wallet.mintProofsBolt11(1000, mq.quote);
    const inputYs = inputs.map((p) => spentY(p.secret));

    // A real invoice to melt to: on LND-2 (real payment) or, locally, the same mint.
    const lndInvoice = lnd ? await lnd.createInvoice(300, `solvent-nut05-${runId}`) : null;
    const invoice = lndInvoice ? lndInvoice.payment_request : (await wallet.createMintQuoteBolt11(300)).request;
    const meltQuote = await wallet.createMeltQuoteBolt11(invoice);
    const melted = await wallet.ops.meltBolt11(meltQuote, inputs).run();
    const change = melted.change;
    const inputsSum = sum(inputs);
    const changeSum = sum(change);
    const destroyed = inputsSum - changeSum;
    const lightningAmount = Number(meltQuote.amount);
    const fee = destroyed - lightningAmount;
    check('Melt paid', melted.quote.state === 'PAID', `amount ${lightningAmount} sat, fee reserve ${meltQuote.fee_reserve}, fee paid ${fee}, change ${changeSum}`);
    let settledOnLnd: boolean | null = null;
    if (lnd && lndInvoice) {
      const lookup = await lnd.lookupInvoice(lndInvoice.r_hash);
      settledOnLnd = lookup.settled === true || lookup.state === 'SETTLED';
      check('The destination invoice is SETTLED on the receiving LND node', settledOnLnd, `state ${lookup.state}`);
    }

    // TX1: inputs -> consumed liabilities in the open epoch.
    const consumed = consumedMelt().filter((c) => inputYs.includes(c.proof_y_hex));
    check('Every melt input is a consumed liability', consumed.length === inputs.length && sum(consumed) === inputsSum, `${consumed.length} rows, ${sum(consumed)} sat`);
    check(`Consumed rows are stamped with the open epoch ${epochN}`, consumed.every((c) => c.target_epoch === epochN));
    const states = await wallet.checkProofsStates(inputs);
    check('Melt inputs are SPENT (NUT-07)', states.every((s) => s.state === 'SPENT'));

    // TX2: change -> issued liabilities, receipts signed in the same transaction (patch 0009).
    const changeRows = change.map((p) => {
      const bm = blindedMessageOf(p);
      const row = db
        .prepare(
          `SELECT il.amount, il.target_epoch, il.operation_kind, r.status, r.signature_hex FROM solvent_issued_liability il
           JOIN solvent_pol_receipt r ON r.liability_kind = 'issued' AND r.liability_id = il.id WHERE il.blinded_message_hex = ?`,
        )
        .get(bm) as { amount: number; target_epoch: number; operation_kind: string; status: string; signature_hex: string | null } | undefined;
      return { bm, proofAmount: Number(p.amount), row };
    });
    check('Every change output is an issued liability (operation melt)', change.length > 0 && changeRows.every((c) => c.row?.operation_kind === 'melt' && c.row.amount === c.proofAmount), `${change.length} outputs, ${changeSum} sat`);
    check(`Change is stamped with the open epoch ${epochN}`, changeRows.every((c) => c.row?.target_epoch === epochN));
    check('Change receipts are signed immediately, not left pending (patch 0009)', changeRows.every((c) => c.row?.status === 'signed'));
    const receiptsOk = await Promise.all(
      changeRows.map(async (c) => {
        const r = (await (await fetch(`${mintUrl}/v1/solvent/pol-receipt/${c.bm}`)).json()) as { status: string; target_epoch?: number; signature?: string };
        return r.status === 'signed' && r.target_epoch === epochN && verifyIssuedReceipt({ target_epoch: r.target_epoch, signature: r.signature! }, c.bm, keys.keys[String(c.proofAmount)]!);
      }),
    );
    check('Change receipts verify from the retrieval endpoint', receiptsOk.every(Boolean));

    const after = outstanding(db, keys.id, epochN);
    check('Outstanding moved by exactly +minted - (inputs - change)', after - before === 1000 - destroyed, `${before} -> ${after} (Δ ${after - before} = 1000 - ${destroyed})`);

    // Failed payment: melting to an invoice that is already settled.
    const beforeFail = consumedMelt().length;
    const retryProofs = await (async () => {
      const q = await wallet.createMintQuoteBolt11(400);
      if (lnd) await lnd.payInvoiceSync(q.request);
      for (let i = 0; i < 60 && (await wallet.checkMintQuoteBolt11(q.quote)).state !== 'PAID'; i++) await new Promise((r) => setTimeout(r, 500));
      return wallet.mintProofsBolt11(400, q.quote);
    })();
    let failedPayment = 'not attempted';
    try {
      const q = await wallet.createMeltQuoteBolt11(invoice);
      const r = await wallet.ops.meltBolt11(q, retryProofs).run();
      failedPayment = `unexpectedly ${r.quote.state}`;
    } catch (err) {
      failedPayment = `refused: ${(err as Error).message.slice(0, 120)}`;
    }
    const retryStates = await wallet.checkProofsStates(retryProofs);
    const noAccounting = consumedMelt().length === beforeFail && retryStates.every((s) => s.state === 'UNSPENT');
    check('A melt to an already-paid invoice fails and records no accounting; inputs stay UNSPENT', failedPayment.startsWith('refused') && noAccounting, failedPayment);

    // Double spend: melting the already-spent inputs again.
    let doubleSpend = 'not attempted';
    try {
      const q = await wallet.createMeltQuoteBolt11(lnd ? (await lnd.createInvoice(100, 'solvent-nut05-double')).payment_request : (await wallet.createMintQuoteBolt11(100)).request);
      await wallet.ops.meltBolt11(q, inputs).run();
      doubleSpend = 'unexpectedly accepted';
    } catch (err) {
      doubleSpend = `refused: ${(err as Error).message.slice(0, 120)}`;
    }
    check('Melting already-spent inputs is refused, with no duplicate accounting', doubleSpend.startsWith('refused') && consumedMelt().length === beforeFail, doubleSpend);

    // Close the epoch: the manifest commits to the melt exactly.
    const closed = closeEpoch(db, { manifestPrivateKeyHex: key });
    const man = closed.keysets.find((k) => k.manifest.keyset_id === keys.id)!.manifest;
    const audit = auditClosedEpoch(db, closed.epochIndex);
    // Re-derived at close time: includes the 400 sat minted for the failed-payment case after `after` was measured.
    const atClose = outstanding(db, keys.id, closed.epochIndex);
    check(`Epoch ${closed.epochIndex} closes; manifest outstanding equals the re-derived value; audit passes`, audit.ok && man.outstanding_balance === atClose && atClose === after + 400, `${man.outstanding_balance} sat`);

    write('nut05-melt.json', failures === 0, {
      epoch: epochN,
      quote: meltQuote.quote,
      lightning_amount_sat: lightningAmount,
      fee_reserve_sat: Number(meltQuote.fee_reserve),
      fee_paid_sat: fee,
      inputs: { count: inputs.length, total_sat: inputsSum, spent_ys: inputYs },
      change: { count: change.length, total_sat: changeSum, outputs: changeRows.map((c) => ({ blinded_message: c.bm, amount: c.proofAmount, target_epoch: c.row?.target_epoch, receipt: c.row?.status })) },
      ecash_destroyed_sat: destroyed,
      outstanding_before_sat: before,
      outstanding_after_sat: after,
      failed_payment: failedPayment,
      double_spend: doubleSpend,
      closed_epoch: { index: closed.epochIndex, manifest: man, audit },
      settled_on_lnd: settledOnLnd,
    });
  } finally {
    db.close();
  }
  console.log(`\nEvidence written to ${dir}\n`);
  if (failures === 0) console.log(`PHASE 3C NUT-05 MELT ACCOUNTING VERIFIED (lightning_backend=${backend})`);
  else {
    console.log(`PHASE 3C NOT VERIFIED — ${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-melt-e2e crashed:', err);
  process.exitCode = 1;
});
