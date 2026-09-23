import { Amount, getPubKeyFromPrivKey, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../encode/canonical.js';
import { checkDleqAndReconstructCPrime } from './dleq.js';
import { generateFixtureProof } from './mint-sim.js';

// Official NUT-12 test vector — cashubtc/nuts, tests/12-tests.md, "DLEQ
// verification on Proof". Confirms our wrapper agrees with the spec, not
// just with our own fixture mint.
const OFFICIAL_KEYSET_ID = '00882760bfa2eb41';
const OFFICIAL_KEYS = { '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const OFFICIAL_PROOF: Proof = {
  id: OFFICIAL_KEYSET_ID,
  amount: Amount.from(1),
  secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
  C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
  dleq: {
    e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
    s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
    r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
  },
};

describe('checkDleqAndReconstructCPrime — official NUT-12 vector', () => {
  it('verifies the official spec test vector and reconstructs C\'', () => {
    const result = checkDleqAndReconstructCPrime(OFFICIAL_PROOF, OFFICIAL_KEYS);
    expect(result.valid).toBe(true);
    expect(result.cPrimeHex).toBeDefined();
    expect(result.cPrimeHex).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it('rejects a modified e', () => {
    const tampered = { ...OFFICIAL_PROOF, dleq: { ...OFFICIAL_PROOF.dleq!, e: '00' + OFFICIAL_PROOF.dleq!.e.slice(2) } };
    expect(checkDleqAndReconstructCPrime(tampered, OFFICIAL_KEYS).valid).toBe(false);
  });

  it('rejects a modified s', () => {
    const tampered = { ...OFFICIAL_PROOF, dleq: { ...OFFICIAL_PROOF.dleq!, s: '00' + OFFICIAL_PROOF.dleq!.s.slice(2) } };
    expect(checkDleqAndReconstructCPrime(tampered, OFFICIAL_KEYS).valid).toBe(false);
  });

  it('rejects a modified r (still verifies structurally but reconstructs wrong point, so DLEQ fails)', () => {
    const tampered = { ...OFFICIAL_PROOF, dleq: { ...OFFICIAL_PROOF.dleq!, r: '00' + OFFICIAL_PROOF.dleq!.r!.slice(2) } };
    expect(checkDleqAndReconstructCPrime(tampered, OFFICIAL_KEYS).valid).toBe(false);
  });

  it('rejects when checked against the wrong mint public key', () => {
    const someOtherPrivKey = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111'.slice(0, 64));
    const wrongKeys = { '1': bytesToHex(getPubKeyFromPrivKey(someOtherPrivKey)) };
    expect(checkDleqAndReconstructCPrime(OFFICIAL_PROOF, wrongKeys).valid).toBe(false);
  });

  it('rejects a proof with no DLEQ data at all (unsupported -> RED)', () => {
    const { dleq: _dleq, ...withoutDleq } = OFFICIAL_PROOF;
    expect(checkDleqAndReconstructCPrime(withoutDleq as Proof, OFFICIAL_KEYS).valid).toBe(false);
  });

  it('rejects a proof whose DLEQ omits the blinding factor r', () => {
    const { r: _r, ...dleqWithoutR } = OFFICIAL_PROOF.dleq!;
    const proof = { ...OFFICIAL_PROOF, dleq: dleqWithoutR };
    expect(checkDleqAndReconstructCPrime(proof, OFFICIAL_KEYS).valid).toBe(false);
  });

  it('rejects when the claimed amount has no key in the keyset', () => {
    expect(checkDleqAndReconstructCPrime({ ...OFFICIAL_PROOF, amount: Amount.from(2) }, OFFICIAL_KEYS).valid).toBe(false);
  });
});

describe('checkDleqAndReconstructCPrime — self-generated fixture mint', () => {
  it('reconstructs C\' equal to the real mint-signed C_ for a fresh keypair/secret', () => {
    const { proof, keys, mintOriginalCPrimeHex } = generateFixtureProof({
      keysetId: 'solvent-test-keyset',
      amount: 42,
      secret: 'unit-test-secret-abc',
    });
    const result = checkDleqAndReconstructCPrime(proof, keys);
    expect(result.valid).toBe(true);
    expect(result.cPrimeHex).toBe(mintOriginalCPrimeHex);
  });

  it('amount tampering breaks inclusion at the leaf level even though DLEQ still targets the original key', () => {
    // Changing amount without changing the key set makes hasValidDleq look
    // up a different (missing) key entirely, which fails closed.
    const { proof, keys } = generateFixtureProof({
      keysetId: 'solvent-test-keyset-2',
      amount: 10,
      secret: 'unit-test-secret-xyz',
    });
    const tampered: Proof = { ...proof, amount: Amount.from(20) };
    expect(checkDleqAndReconstructCPrime(tampered, keys).valid).toBe(false);
  });
});
