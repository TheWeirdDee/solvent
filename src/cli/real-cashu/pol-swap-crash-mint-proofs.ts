// npm run verify:pol-swap-crash-mint -- <output-json-path>
//
// SOLVENT — Phase 2 continuation, Step 14 setup: mints a real, fresh set of
// proofs via a real Lightning payment while the mint is running WITHOUT
// the SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS hook active, and persists them
// to a JSON file. Kept as a separate step from the swap crash-drill
// trigger itself so the mint's own NUT-04 delay hook (also gated by the
// same env var — patches/cdk/0003-*.patch) never fires during minting;
// only the later swap attempt (patches/cdk/0006-*.patch's hook in
// finalize()) is meant to hang. See docs/receipt-lifecycle.md's NUT-03
// section.
import { writeFileSync } from 'node:fs';
import { Mint, OutputData, type MintRequest, type SerializedBlindedMessage } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('usage: pol-swap-crash-mint-proofs.ts <output-json-path>');

  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  const mint = new Mint(mintUrl);
  const keysResp = await mint.getKeys();
  const keyset = keysResp.keysets[0]!;

  const lndSource = new LndClient({ restUrl: lndSourceRestUrl, macaroonHex: lndSourceMacaroonHex });
  const quote = await mint.createMintQuoteBolt11({ amount: amountSat, unit: 'sat' });
  const payment = await lndSource.payInvoiceSync(quote.request);
  if (!payment.ok) throw new Error(`real payment failed: ${payment.paymentError}`);

  const outputData = OutputData.createRandomData(amountSat, keyset);
  const outputs: SerializedBlindedMessage[] = outputData.map((o) => o.blindedMessage);
  const mintRequest: MintRequest = { quote: quote.quote, outputs };
  const response = await mint.mintBolt11(mintRequest);
  const proofs = outputData.map((o, i) => o.toProof(response.signatures[i]!, keyset));

  writeFileSync(outPath, JSON.stringify({ keysetId: keyset.id, proofs }, null, 2));
  console.log(`Minted ${proofs.length} real proofs (${amountSat} sat) for the swap crash drill, written to ${outPath}`);
}

main().catch((err) => {
  console.error('pol-swap-crash-mint-proofs crashed:', err);
  process.exitCode = 1;
});
