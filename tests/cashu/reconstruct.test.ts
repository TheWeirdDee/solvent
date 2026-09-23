import { normalizeProofAmounts } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { generateFixtureKeyset, issue } from '../../src/cashu/keys.js';
import { reconstruct } from '../../src/cashu/reconstruct.js';

describe('reconstruct() — canonical holder-side NUT-12 reconstruction', () => {
  it('reconstructs the exact B\' and C\' the mint really signed', () => {
    const keyset = generateFixtureKeyset([1000]);
    const { proof, bPrimeHex, cPrimeHex } = issue(keyset, 1000, 'reconstruct-test-secret');
    const result = reconstruct(proof, keyset.keysetId, keyset.amounts[1000]!.publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.bPrimeHex).toBe(bPrimeHex);
    expect(result.cPrimeHex).toBe(cPrimeHex);
  });

  it('survives a real token-encode/decode round trip', () => {
    const keyset = generateFixtureKeyset([500]);
    const { proof, bPrimeHex } = issue(keyset, 500, 'reconstruct-transfer-secret');
    const [decoded] = normalizeProofAmounts([JSON.parse(JSON.stringify(proof))]);
    const result = reconstruct(decoded!, keyset.keysetId, keyset.amounts[500]!.publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.bPrimeHex).toBe(bPrimeHex);
  });

  it('rejects a keyset mismatch', () => {
    const keyset = generateFixtureKeyset([1000]);
    const { proof } = issue(keyset, 1000, 'x');
    const result = reconstruct(proof, 'some-other-keyset', keyset.amounts[1000]!.publicKeyHex);
    expect(result.valid).toBe(false);
  });

  it('rejects a proof with no DLEQ data', () => {
    const keyset = generateFixtureKeyset([1000]);
    const { proof } = issue(keyset, 1000, 'x');
    const { dleq: _dleq, ...withoutDleq } = proof;
    const result = reconstruct(withoutDleq as typeof proof, keyset.keysetId, keyset.amounts[1000]!.publicKeyHex);
    expect(result.valid).toBe(false);
  });

  it('rejects a tampered DLEQ (flipped e)', () => {
    const keyset = generateFixtureKeyset([1000]);
    const { proof } = issue(keyset, 1000, 'x');
    const tampered = { ...proof, dleq: { ...proof.dleq!, e: (proof.dleq!.e[0] === '0' ? '1' : '0') + proof.dleq!.e.slice(1) } };
    const result = reconstruct(tampered, keyset.keysetId, keyset.amounts[1000]!.publicKeyHex);
    expect(result.valid).toBe(false);
  });

  it('rejects verification against the wrong amount key', () => {
    const keysetA = generateFixtureKeyset([1000]);
    const keysetB = generateFixtureKeyset([1000]);
    const { proof } = issue(keysetA, 1000, 'x');
    const result = reconstruct(proof, keysetA.keysetId, keysetB.amounts[1000]!.publicKeyHex);
    expect(result.valid).toBe(false);
  });
});
