// npm run verify:pol-crash-trigger
//
// SOLVENT — Phase 2 Step 8 crash drill trigger. Deliberately minimal: pays
// one real Lightning invoice and issues one real NUT-04 mint call — no
// swap, no melt. Meant to be run in the background against a mint started
// with SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS set (patches/cdk/0003-*.patch),
// so the real mint process can be SIGKILLed by the CI step while this
// call is genuinely in flight, inside the delay window. A failure here
// (including "connection reset" from the mint dying mid-request) is the
// EXPECTED outcome of a successful crash drill, not a bug — the CI step
// checks the resulting database state, not this script's own exit code.
import { Wallet } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';

async function main() {
  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  const lndSource = new LndClient({ restUrl: lndSourceRestUrl, macaroonHex: lndSourceMacaroonHex });
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();

  const quote = await wallet.createMintQuoteBolt11(amountSat);
  console.log(`crash-drill trigger: quote ${quote.quote} created`);

  const payment = await lndSource.payInvoiceSync(quote.request);
  if (!payment.ok) throw new Error(`crash-drill trigger: real payment failed: ${payment.paymentError}`);
  console.log(`crash-drill trigger: real payment settled, preimage ${payment.paymentPreimageHex?.slice(0, 16)}...`);

  // This call is expected to hang/error if the mint is killed mid-request
  // (SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS holds the transaction open) — that
  // is the point of the drill, not a failure of this script.
  await wallet.mintProofsBolt11(amountSat, quote.quote);
  console.log('crash-drill trigger: mint call returned successfully (no crash occurred, or it landed after commit)');
}

main().catch((err) => {
  console.log(`crash-drill trigger: mint call did not complete — ${(err as Error).message} (expected if the mint was killed mid-request)`);
});
