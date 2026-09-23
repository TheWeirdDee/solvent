// A controlled fixture mint's signing side, built entirely from real
// @cashu/cashu-ts crypto primitives (blind signing + NUT-12 DLEQ proof
// creation). This is the "ALLOWED FIXTURE" boundary described in the PRD:
// the mint identity and its issuance records are ours to control, but every
// cryptographic operation (blinding, signing, DLEQ) is the real thing, so a
// holder-side verifier exercises the same code path it would against a real
// mint.
import {
  Amount,
  blindMessage,
  constructUnblindedSignature,
  createBlindSignature,
  createDLEQProof,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  pointFromHex,
  type Keys,
  type Proof,
} from '@cashu/cashu-ts';
import { bytesToHex } from '../encode/canonical.js';

export interface FixtureMintKey {
  amount: number;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

/** One private/public keypair per amount a fixture mint will issue. */
export function generateFixtureKeyset(amounts: number[]): FixtureMintKey[] {
  return amounts.map((amount) => {
    const privateKey = createRandomSecretKey();
    return { amount, privateKey, publicKeyHex: bytesToHex(getPubKeyFromPrivKey(privateKey)) };
  });
}

export function keysetToKeys(keyset: FixtureMintKey[]): Keys {
  const keys: Keys = {};
  for (const k of keyset) keys[String(k.amount)] = k.publicKeyHex;
  return keys;
}

function scalarToHex32(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return hex.padStart(64, '0');
}

export interface IssuedFixtureProof {
  proof: Proof;
  keys: Keys;
  /** The mint's real, original blind signature point C_, for test assertions. */
  mintOriginalCPrimeHex: string;
}

/**
 * Simulates a full real Cashu mint→wallet round trip for one token:
 * wallet blinds a secret, mint signs it and produces a NUT-12 DLEQ proof,
 * wallet unblinds, and the final Proof is assembled with `r` attached so a
 * receiver can verify offline (NUT-12 "sender includes r for the receiver").
 */
export function issueFixtureProof(params: {
  key: FixtureMintKey;
  keysetId: string;
  secret: string;
}): IssuedFixtureProof {
  const { key, keysetId, secret } = params;
  const secretBytes = new TextEncoder().encode(secret);

  const { B_, r } = blindMessage(secretBytes);
  const blindSig = createBlindSignature(B_, key.privateKey, keysetId); // { C_, id }
  const dleq = createDLEQProof(B_, key.privateKey); // { e, s } — mint-side, no r

  const A = pointFromHex(key.publicKeyHex);
  const unblinded = constructUnblindedSignature(blindSig, r, secretBytes, A); // { C, secret, id }

  const proof: Proof = {
    id: keysetId,
    amount: Amount.from(key.amount),
    secret,
    C: unblinded.C.toHex(true),
    dleq: {
      e: bytesToHex(dleq.e),
      s: bytesToHex(dleq.s),
      r: scalarToHex32(r),
    },
  };

  return {
    proof,
    keys: { [String(key.amount)]: key.publicKeyHex },
    mintOriginalCPrimeHex: blindSig.C_.toHex(true),
  };
}

/** Convenience one-shot used by tests: generates a single-amount keyset and issues one proof. */
export function generateFixtureProof(params: { keysetId: string; amount: number; secret: string }): IssuedFixtureProof {
  const [key] = generateFixtureKeyset([params.amount]);
  return issueFixtureProof({ key: key!, keysetId: params.keysetId, secret: params.secret });
}
