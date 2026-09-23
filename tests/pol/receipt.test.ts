// Cross-checked against the official Cashu PR #388 draft test vectors
// (github.com/a1denvalu3/nuts/blob/pol-spec/tests/pol-tests.md, section 5
// "Signed Transactional PoL Receipts"). We don't reproduce the exact
// signature bytes (BIP-340 uses fresh randomness per sign unless aux_rand
// is pinned, which cashu-ts's schnorrSignDigest wrapper doesn't expose) —
// instead we verify the KNOWN-GOOD vector signature against OUR computed
// digest, which proves the message construction is byte-exact to the spec.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import {
  issuedReceiptMessage,
  signIssuedReceipt,
  signSpentReceipt,
  spentReceiptMessage,
  verifyIssuedReceipt,
  verifySpentReceipt,
} from '../../src/pol/receipt.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// From the official test vector, section 5.
const VECTOR_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const VECTOR_B_PRIME = '02b1a03e1b10a23429fa221087e53f19001b97ad89498a44b93b3f23a851121df4';
const VECTOR_Y = '02c3a50646bc1a1fef3da21973b064eb6897de58231c5f3e2730bf18361592394a';
const VECTOR_EPOCH = 12;
const VECTOR_ISSUED_SIGNATURE =
  '31ef4e45aec5da42a7622bfbc6a8d0f9e07b562aa69092b6a2b7ea3a9b8ec92f88f4d510d488f55b00c2ea1bed0bb1f499c55eda275ffee9e0df60bf941a71b2';
const VECTOR_SPENT_SIGNATURE =
  '28b635335642ac4693f4eefb068500b5360c89df907537ad4f1baa25b5de48e30fb7a00f2e6a12ea864f5fbe0c0e5a8fd2c15ada088938eba55c339e215904df';

describe('PoL receipt — message construction matches the pinned draft exactly', () => {
  it('issued receipt message matches the spec-shown payload string', () => {
    expect(issuedReceiptMessage(VECTOR_B_PRIME, VECTOR_EPOCH)).toBe(
      `Cashu_PoL_Receipt_Issued:${VECTOR_B_PRIME}:12`,
    );
  });

  it('spent receipt message matches the spec-shown payload string', () => {
    expect(spentReceiptMessage(VECTOR_Y, VECTOR_EPOCH)).toBe(`Cashu_PoL_Receipt_Spent:${VECTOR_Y}:12`);
  });

  it('the official issued-receipt vector signature verifies against our computed digest', () => {
    // If our message/digest construction diverged from the spec at all,
    // this known-good signature (produced by a conforming implementation
    // per the draft's own test vectors) would fail to verify.
    const ok = verifyIssuedReceipt({ target_epoch: VECTOR_EPOCH, signature: VECTOR_ISSUED_SIGNATURE }, VECTOR_B_PRIME, VECTOR_PUBKEY);
    expect(ok).toBe(true);
  });

  it('the official spent-receipt vector signature verifies against our computed digest', () => {
    const ok = verifySpentReceipt({ target_epoch: VECTOR_EPOCH, signature: VECTOR_SPENT_SIGNATURE }, VECTOR_Y, VECTOR_PUBKEY);
    expect(ok).toBe(true);
  });
});

describe('PoL receipt — round trip with a fresh real key (Gate 1 pass criteria)', () => {
  const privKey = createRandomSecretKey();
  const pubKeyHex = bytesToHex(getPubKeyFromPrivKey(privKey));
  const privKeyHex = bytesToHex(privKey);
  const bPrime = VECTOR_B_PRIME;
  const epoch = 7;

  it('a freshly signed receipt verifies against the correct key', () => {
    const receipt = signIssuedReceipt(bPrime, epoch, privKeyHex);
    expect(verifyIssuedReceipt(receipt, bPrime, pubKeyHex)).toBe(true);
  });

  it('flipping a bit in B\' fails verification', () => {
    const receipt = signIssuedReceipt(bPrime, epoch, privKeyHex);
    const tamperedB = '03' + bPrime.slice(2); // flip the parity prefix byte
    expect(verifyIssuedReceipt(receipt, tamperedB, pubKeyHex)).toBe(false);
  });

  it('changing target_epoch after signing fails verification', () => {
    const receipt = signIssuedReceipt(bPrime, epoch, privKeyHex);
    const tampered = { ...receipt, target_epoch: epoch + 1 };
    expect(verifyIssuedReceipt(tampered, bPrime, pubKeyHex)).toBe(false);
  });

  it('verifying against the wrong key fails', () => {
    const receipt = signIssuedReceipt(bPrime, epoch, privKeyHex);
    const otherPubKeyHex = bytesToHex(getPubKeyFromPrivKey(createRandomSecretKey()));
    expect(verifyIssuedReceipt(receipt, bPrime, otherPubKeyHex)).toBe(false);
  });

  it('a forged/garbage signature fails verification (fails closed, does not throw)', () => {
    const receipt = { target_epoch: epoch, signature: '00'.repeat(64) };
    expect(verifyIssuedReceipt(receipt, bPrime, pubKeyHex)).toBe(false);
  });
});
