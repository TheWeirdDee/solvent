// Fixture mint keyset + real issuance. This is the "ALLOWED FIXTURE"
// boundary (PRD §6): the mint identity and its keys are ours to control
// for the demo, but every cryptographic operation (blind signing, DLEQ,
// receipt signing) is the real thing from @cashu/cashu-ts, so a holder
// verifier exercises exactly the code path it would against a real mint.
import {
  Amount,
  blindMessage,
  constructUnblindedSignature,
  createBlindSignature,
  createDLEQProof,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function scalarToHex32(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return hex.padStart(64, '0');
}

export interface MintKeyset {
  keysetId: string;
  /** amount -> per-denomination keypair. The private key signs both blind signatures AND PoL receipts for that amount (PR #388 §"Signed Transactional Receipts": `private_keys[amount]`). */
  amounts: Record<number, { privateKeyHex: string; publicKeyHex: string }>;
}

export function generateFixtureKeyset(amounts: number[]): MintKeyset {
  const keysetId = '00' + bytesToHex(createRandomSecretKey()).slice(0, 14);
  const entries: MintKeyset['amounts'] = {};
  for (const amount of amounts) {
    const priv = createRandomSecretKey();
    entries[amount] = { privateKeyHex: bytesToHex(priv), publicKeyHex: bytesToHex(getPubKeyFromPrivKey(priv)) };
  }
  return { keysetId, amounts: entries };
}

export interface IssuedItem {
  proof: Proof;
  /** The mint's real, original blinded message point (compressed hex) — captured at issuance for evidence/testing. Never trust this on the holder side; the holder reconstructs it independently (see reconstruct.ts). */
  bPrimeHex: string;
  cPrimeHex: string;
}

/** Real secp256k1 Cashu issuance for one (amount, secret) pair, using the keyset's real per-amount key. */
export function issue(keyset: MintKeyset, amount: number, secret: string): IssuedItem {
  const key = keyset.amounts[amount];
  if (!key) throw new Error(`generateFixtureKeyset: no key for amount ${amount}`);

  const secretBytes = new TextEncoder().encode(secret);
  const { B_, r } = blindMessage(secretBytes);
  const privBytes = hexToBytes(key.privateKeyHex);
  const blindSig = createBlindSignature(B_, privBytes, keyset.keysetId);
  const dleq = createDLEQProof(B_, privBytes);
  const A = pointFromHex(key.publicKeyHex);
  const unblinded = constructUnblindedSignature(blindSig, r, secretBytes, A);

  const proof: Proof = {
    id: keyset.keysetId,
    amount: Amount.from(amount),
    secret,
    C: unblinded.C.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s), r: scalarToHex32(r) },
  };

  return { proof, bPrimeHex: B_.toHex(true), cPrimeHex: blindSig.C_.toHex(true) };
}
