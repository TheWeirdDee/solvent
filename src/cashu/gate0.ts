// GATE 0 — load-bearing spike (SOLVENT v2 PRD §5 / §20). See docs/gate-0.md
// for the full writeup. `runGate0Spike()` is the pure, testable core;
// `main()` below is the CLI wrapper that additionally writes evidence
// files under evidence/gate-0/.
//
// Every step uses real @cashu/cashu-ts crypto (blind signing, DLEQ
// creation, DLEQ verification, EC point arithmetic) and the library's
// real getEncodedToken/getDecodedToken serialization — the same path a
// wallet uses to hand a token to another wallet. No object is
// hand-authored as if it were a valid proof.
import {
  Amount,
  blindMessage,
  constructUnblindedSignature,
  createBlindSignature,
  createDLEQProof,
  createRandomSecretKey,
  getDecodedToken,
  getEncodedToken,
  getPubKeyFromPrivKey,
  hasValidDleq,
  hashToCurve,
  pointFromHex,
  type Keys,
  type Proof,
  type Token,
} from '@cashu/cashu-ts';

// The secp256k1 generator point G — a fixed public curve parameter, not a
// secret or an invented value (the same constant @noble/curves uses
// internally as Point.BASE; cashu-ts does not re-export it directly, so it
// is reconstructed from its well-known compressed encoding via the
// library's own pointFromHex).
export const SECP256K1_G_HEX = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function scalarToHex32(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return hex.padStart(64, '0');
}

export interface Gate0Result {
  pass: boolean;
  keysetId: string;
  amount: number;
  mintUrl: string;
  amountPublicKeyHex: string;
  originalBPrimeHex: string;
  originalCPrimeHex: string;
  encodedToken: string;
  receivedProof: Proof;
  dleqSurvivedTransfer: boolean;
  reconstructedBPrimeHex: string;
  reconstructedCPrimeHex: string;
  bPrimeEqual: boolean;
  cPrimeEqual: boolean;
  dleqValid: boolean;
}

export function runGate0Spike(): Gate0Result {
  const keysetId = '00' + bytesToHex(createRandomSecretKey()).slice(0, 14); // realistic 16-hex-char keyset id shape
  const amount = 1000;
  const mintUrl = 'https://gate0.solvent.local'; // fixture mint identity — labelled, not a live endpoint

  // ---- 1. Real secp256k1 Cashu issuance (mint side) ----
  const mintPrivKey = createRandomSecretKey();
  const A = getPubKeyFromPrivKey(mintPrivKey);
  const Apoint = pointFromHex(bytesToHex(A));

  const secretStr = `gate0-secret-${bytesToHex(createRandomSecretKey()).slice(0, 16)}`;
  const secretBytes = new TextEncoder().encode(secretStr);

  const { B_, r } = blindMessage(secretBytes);
  const originalBPrimeHex = B_.toHex(true);

  const blindSig = createBlindSignature(B_, mintPrivKey, keysetId);
  const dleq = createDLEQProof(B_, mintPrivKey);

  const unblinded = constructUnblindedSignature(blindSig, r, secretBytes, Apoint);

  const issuanceProof: Proof = {
    id: keysetId,
    amount: Amount.from(amount),
    secret: secretStr,
    C: unblinded.C.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s), r: scalarToHex32(r) },
  };

  // ---- 2. Real wallet-to-wallet serialization round trip ----
  const token: Token = { mint: mintUrl, proofs: [issuanceProof] };
  const encodedToken = getEncodedToken(token); // no removeDleq -> DLEQ preserved by default
  const decoded = getDecodedToken(encodedToken, [keysetId]);
  const receivedProof = decoded.proofs[0]!;

  const dleqSurvivedTransfer =
    !!receivedProof.dleq && receivedProof.dleq.e !== undefined && receivedProof.dleq.s !== undefined && receivedProof.dleq.r !== undefined;

  // ---- 3. Independent receiver-side reconstruction ----
  const keys: Keys = { [String(amount)]: bytesToHex(A) };
  let reconstructedBPrimeHex = '';
  let reconstructedCPrimeHex = '';
  let dleqValid = false;

  if (dleqSurvivedTransfer) {
    const Y = hashToCurve(new TextEncoder().encode(receivedProof.secret));
    const G = pointFromHex(SECP256K1_G_HEX);
    const rReceived = BigInt('0x' + receivedProof.dleq!.r);
    reconstructedBPrimeHex = Y.add(G.multiply(rReceived)).toHex(true);
    reconstructedCPrimeHex = pointFromHex(receivedProof.C).add(Apoint.multiply(rReceived)).toHex(true);
    dleqValid = hasValidDleq(receivedProof, { id: keysetId, keys }, { require: true });
  }

  const originalCPrimeHex = blindSig.C_.toHex(true);
  const bPrimeEqual = reconstructedBPrimeHex === originalBPrimeHex;
  const cPrimeEqual = reconstructedCPrimeHex === originalCPrimeHex;

  return {
    pass: dleqSurvivedTransfer && bPrimeEqual && cPrimeEqual && dleqValid,
    keysetId,
    amount,
    mintUrl,
    amountPublicKeyHex: bytesToHex(A),
    originalBPrimeHex,
    originalCPrimeHex,
    encodedToken,
    receivedProof,
    dleqSurvivedTransfer,
    reconstructedBPrimeHex,
    reconstructedCPrimeHex,
    bPrimeEqual,
    cPrimeEqual,
    dleqValid,
  };
}
