// CLI: Gate 1 — real issuance + signed PoL receipt. Uses ONE coherent
// fixture mint identity (src/cashu/keys.ts) for both the real Cashu
// issuance and the real BIP-340-signed receipt, binding the exact
// holder-reconstructed B' (src/cashu/reconstruct.ts) to a target epoch.
// Writes evidence/gate-1/. Run with: npx tsx src/cli/gate1.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateFixtureKeyset, issue } from '../cashu/keys.js';
import { reconstruct } from '../cashu/reconstruct.js';
import { issuedReceiptMessage, signIssuedReceipt, verifyIssuedReceipt, type PolReceipt } from '../pol/receipt.js';

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'gate-1');
const TARGET_EPOCH = 12;
const AMOUNT = 1000;

function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const keyset = generateFixtureKeyset([AMOUNT]);
  const key = keyset.amounts[AMOUNT]!;
  const { proof } = issue(keyset, AMOUNT, `gate1-secret-${Date.now()}`);

  // Holder independently reconstructs B' (Gate 0's mechanism) before ever
  // trusting a receipt about it.
  const recon = reconstruct(proof, keyset.keysetId, key.publicKeyHex);
  if (!recon.valid || !recon.bPrimeHex) {
    console.error('Gate 1 requires a successful Gate-0-style reconstruction first:', recon.reason);
    process.exit(1);
  }
  const bPrime = recon.bPrimeHex;

  // Mint signs a receipt promising this exact B' belongs in epoch 12,
  // using the SAME per-amount key that produced the blind signature.
  const receipt = signIssuedReceipt(bPrime, TARGET_EPOCH, key.privateKeyHex);
  const verifies = verifyIssuedReceipt(receipt, bPrime, key.publicKeyHex);

  const flippedB = '03' + bPrime.slice(2);
  const flippedBOk = verifyIssuedReceipt(receipt, flippedB, key.publicKeyHex);
  const changedEpochReceipt: PolReceipt = { ...receipt, target_epoch: TARGET_EPOCH + 1 };
  const changedEpochOk = verifyIssuedReceipt(changedEpochReceipt, bPrime, key.publicKeyHex);
  const otherKeyset = generateFixtureKeyset([AMOUNT]);
  const wrongKeyOk = verifyIssuedReceipt(receipt, bPrime, otherKeyset.amounts[AMOUNT]!.publicKeyHex);

  console.log('SOLVENT Gate 1 — real issuance + signed PoL receipt');
  console.log(`  keyset                = ${keyset.keysetId}`);
  console.log(`  amount                = ${AMOUNT}`);
  console.log(`  holder-reconstructed B' = ${bPrime}`);
  console.log(`  target_epoch          = ${TARGET_EPOCH}`);
  console.log(`  receipt message       = ${issuedReceiptMessage(bPrime, TARGET_EPOCH)}`);
  console.log(`  receipt signature     = ${receipt.signature}`);
  console.log(`  VALID RECEIPT         -> verifies=${verifies} (expect true)`);
  console.log(`  flip B'               -> verifies=${flippedBOk} (expect false)`);
  console.log(`  change target_epoch   -> verifies=${changedEpochOk} (expect false)`);
  console.log(`  wrong key             -> verifies=${wrongKeyOk} (expect false)`);

  const pass = verifies && !flippedBOk && !changedEpochOk && !wrongKeyOk;
  console.log(`GATE 1: ${pass ? 'PASS' : 'BLOCKED'}`);

  writeFileSync(
    path.join(EVIDENCE_DIR, 'receipt.json'),
    JSON.stringify(
      {
        keyset_id: keyset.keysetId,
        amount: AMOUNT,
        amount_public_key: key.publicKeyHex,
        holder_reconstructed_b_prime: bPrime,
        target_epoch: TARGET_EPOCH,
        message: issuedReceiptMessage(bPrime, TARGET_EPOCH),
        receipt,
        checks: {
          valid_receipt: verifies,
          flip_b_prime: flippedBOk,
          change_target_epoch: changedEpochOk,
          wrong_key: wrongKeyOk,
        },
        pass,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  process.exit(pass ? 0 : 1);
}

main();
