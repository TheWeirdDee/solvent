// npm run verify:pol-swap-crash-trigger -- <proofs-json-path>
//
// SOLVENT — Phase 2 continuation, Step 14 crash-drill trigger. Reads the
// real proofs minted by pol-swap-crash-mint-proofs.ts and attempts a real
// NUT-03 swap against a mint running WITH
// SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS set. Meant to be run in the
// background so the real mint process can be SIGKILLed by the CI step
// while this call is genuinely in flight, inside finalize()'s delay
// window (patches/cdk/0006-*.patch). A failure here (including "connection
// reset" from the mint dying mid-request) is the EXPECTED outcome of a
// successful crash drill, not a bug — the CI step checks the resulting
// database state, not this script's own exit code.
import { readFileSync } from 'node:fs';
import { Amount, Mint, OutputData, type Proof, type SerializedBlindedMessage, type SwapRequest } from '@cashu/cashu-ts';

async function main() {
  const proofsPath = process.argv[2];
  if (!proofsPath) throw new Error('usage: pol-swap-crash-trigger.ts <proofs-json-path>');

  const mintUrl = process.env.CDK_MINT_URL;
  if (!mintUrl) throw new Error('Missing required env var: CDK_MINT_URL');

  const stored = JSON.parse(readFileSync(proofsPath, 'utf8')) as { keysetId: string; proofs: Array<Omit<Proof, 'amount'> & { amount: string }> };
  const proofs: Proof[] = stored.proofs.map((p) => ({ ...p, amount: Amount.from(p.amount) }));
  const inputTotal = proofs.reduce((sum, p) => sum + Number(p.amount), 0);

  const mint = new Mint(mintUrl);
  const keysResp = await mint.getKeys();
  const keyset = keysResp.keysets.find((k) => k.id === stored.keysetId) ?? keysResp.keysets[0]!;

  const outputData = OutputData.createRandomData(inputTotal, keyset);
  const outputs: SerializedBlindedMessage[] = outputData.map((o) => o.blindedMessage);
  const swapPayload: SwapRequest = { inputs: proofs, outputs };

  console.log(`swap crash-drill trigger: submitting real swap for ${proofs.length} proofs (${inputTotal} sat)`);
  // This call is expected to hang/error if the mint is killed mid-request
  // (SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS holds finalize()'s transaction
  // open) — that is the point of the drill, not a failure of this script.
  await mint.swap(swapPayload);
  console.log('swap crash-drill trigger: swap call returned successfully (no crash occurred, or it landed after commit)');
}

main().catch((err) => {
  console.log(`swap crash-drill trigger: swap call did not complete — ${(err as Error).message} (expected if the mint was killed mid-request)`);
});
