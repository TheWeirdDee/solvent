// npm run verify:pol-wallet
//
// SOLVENT — Phase 2 Step 8 closure, Steps 15-16: a minimal real wallet-side
// consumption path. Performs a real Lightning-paid NUT-04 mint via the
// low-level `Mint` client (so the exact blinded-message values used are
// known to this script, not hidden inside the high-level `Wallet`'s own
// bookkeeping), then — as a real wallet would — retrieves each output's
// real PoL receipt via patches/cdk/0005-*.patch's real HTTP endpoint and
// independently verifies every one against the mint's real public key.
// Proves the cross-layer count invariant end to end: real Cashu outputs
// received == real PoL receipts retrieved == real PoL receipts verified.
import { Amount, Mint, createRandomRawBlindedMessage, type SerializedBlindedMessage, type MintRequest } from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrVerifyDigest } from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(30)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

async function main() {
  const mintUrl = process.env.CDK_MINT_URL;
  const lndSourceRestUrl = process.env.LND_SOURCE_REST_URL;
  const lndSourceMacaroonHex = process.env.LND_SOURCE_MACAROON_HEX;
  const amountSat = Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000');
  if (!mintUrl || !lndSourceRestUrl || !lndSourceMacaroonHex) {
    throw new Error('Missing required env vars: CDK_MINT_URL, LND_SOURCE_REST_URL, LND_SOURCE_MACAROON_HEX');
  }

  console.log('SOLVENT — PHASE 2 REAL WALLET RECEIPT CONSUMPTION\n');

  const mint = new Mint(mintUrl);
  const keysets = await mint.getKeys();
  const keysetId = keysets.keysets[0]!.id;
  const publicKeys = keysets.keysets[0]!.keys;

  const lndSource = new LndClient({ restUrl: lndSourceRestUrl, macaroonHex: lndSourceMacaroonHex });

  const quote = await mint.createMintQuoteBolt11({ amount: amountSat, unit: 'sat' });
  console.log(`Real mint quote created: ${quote.quote}`);

  const payment = await lndSource.payInvoiceSync(quote.request);
  if (!payment.ok) throw new Error(`real payment failed: ${payment.paymentError}`);
  console.log(`Real Lightning payment settled: preimage ${payment.paymentPreimageHex?.slice(0, 16)}...\n`);

  // Denominations summing to amountSat=1000, matching Phase 1's own
  // pattern — real, fresh blinded outputs, with the blinded-message hex
  // captured here (not hidden inside a high-level Wallet).
  const denominations = [512, 256, 128, 64, 32, 8];
  const outputs: SerializedBlindedMessage[] = [];
  const blindedMessageHexes: string[] = [];
  for (const amount of denominations) {
    const raw = createRandomRawBlindedMessage();
    const hex = raw.B_.toHex(true);
    blindedMessageHexes.push(hex);
    outputs.push({ amount: Amount.from(amount), B_: hex, id: keysetId });
  }

  const mintRequest: MintRequest = { quote: quote.quote, outputs };
  const mintResponse = await mint.mintBolt11(mintRequest);
  const proofsReceived = mintResponse.signatures.length;
  console.log(line('Cashu proofs received', proofsReceived === denominations.length, `${proofsReceived}`));

  // Real wallet-side receipt retrieval — one real HTTP GET per output,
  // against the real retrieval endpoint this patch adds.
  let receiptsReceived = 0;
  let receiptsVerified = 0;
  for (let i = 0; i < blindedMessageHexes.length; i++) {
    const hex = blindedMessageHexes[i]!;
    const amount = denominations[i]!;
    const res = await fetch(`${mintUrl}/v1/solvent/pol-receipt/${hex}`);
    if (!res.ok) {
      console.log(line(`Receipt for output ${i} (amount ${amount})`, false, `HTTP ${res.status}`));
      continue;
    }
    const body = (await res.json()) as { status: string; target_epoch?: number; signature?: string };
    if (body.status !== 'signed' || !body.signature) {
      console.log(line(`Receipt for output ${i} (amount ${amount})`, false, `status=${body.status}`));
      continue;
    }
    receiptsReceived++;

    const pubkey = publicKeys[String(amount)];
    const message = new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${hex}:${body.target_epoch}`);
    const ok = pubkey ? schnorrVerifyDigest(body.signature, sha256(message), pubkey, false) : false;
    console.log(line(`Receipt for output ${i} (amount ${amount})`, ok, ok ? 'retrieved and independently verified' : 'verification FAILED'));
    if (ok) receiptsVerified++;
  }

  console.log('');
  console.log(`Cashu proofs received:      ${proofsReceived}`);
  console.log(`PoL receipts received:      ${receiptsReceived}`);
  console.log(`PoL receipts verified:      ${receiptsVerified}/${receiptsReceived}`);

  const allPass = proofsReceived === denominations.length && receiptsReceived === denominations.length && receiptsVerified === denominations.length;
  console.log('');
  if (allPass) {
    console.log('REAL WALLET RECEIPT CONSUMPTION VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('PHASE 2 NOT VERIFIED — wallet receipt consumption incomplete');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-wallet-consume-receipts crashed:', err);
  process.exitCode = 1;
});
