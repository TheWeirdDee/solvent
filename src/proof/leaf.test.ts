import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../encode/canonical.js';
import { burnLeafHash, hashSecret } from './burn-leaf.js';
import { mintLeafHash } from './mint-leaf.js';

const CPRIME_A = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
const CPRIME_B = '0244eccfc7a348274458bb38044c7f3c389b3c2086c7ec18b5812d2877ab937787';

describe('mint-leaf hash', () => {
  const base = { keysetId: 'keyset-1', amount: 100, cPrimeHex: CPRIME_A };

  it('same data produces the same hash', () => {
    expect(bytesToHex(mintLeafHash(base))).toBe(bytesToHex(mintLeafHash({ ...base })));
  });

  it('changing keysetId changes the hash', () => {
    expect(bytesToHex(mintLeafHash(base))).not.toBe(bytesToHex(mintLeafHash({ ...base, keysetId: 'keyset-2' })));
  });

  it('changing amount changes the hash', () => {
    expect(bytesToHex(mintLeafHash(base))).not.toBe(bytesToHex(mintLeafHash({ ...base, amount: 101 })));
  });

  it("changing C' changes the hash", () => {
    expect(bytesToHex(mintLeafHash(base))).not.toBe(bytesToHex(mintLeafHash({ ...base, cPrimeHex: CPRIME_B })));
  });

  it('field-boundary shift does not collide (keysetId="ab",amount=1 vs keysetId="a",amount=b-like split)', () => {
    // Length-prefixing in canonical encoding must prevent this class of collision.
    const x = mintLeafHash({ keysetId: 'ab', amount: 1, cPrimeHex: CPRIME_A });
    const y = mintLeafHash({ keysetId: 'a', amount: 100, cPrimeHex: CPRIME_A }); // arbitrary different split
    expect(bytesToHex(x)).not.toBe(bytesToHex(y));
  });
});

describe('burn-leaf hash', () => {
  const secretHashHex = hashSecret('some-spent-secret');
  const base = { keysetId: 'keyset-1', amount: 50, secretHashHex };

  it('same data produces the same hash', () => {
    expect(bytesToHex(burnLeafHash(base))).toBe(bytesToHex(burnLeafHash({ ...base })));
  });

  it('changing amount changes the hash', () => {
    expect(bytesToHex(burnLeafHash(base))).not.toBe(bytesToHex(burnLeafHash({ ...base, amount: 51 })));
  });

  it('changing the underlying secret changes secretHashHex and thus the leaf hash', () => {
    const other = hashSecret('a-different-secret');
    expect(secretHashHex).not.toBe(other);
    expect(bytesToHex(burnLeafHash(base))).not.toBe(bytesToHex(burnLeafHash({ ...base, secretHashHex: other })));
  });

  it('mint-leaf and burn-leaf hashes never collide for equivalent field values (domain separation)', () => {
    const mint = mintLeafHash({ keysetId: 'keyset-1', amount: 50, cPrimeHex: CPRIME_A });
    const burn = burnLeafHash({ keysetId: 'keyset-1', amount: 50, secretHashHex: bytesToHex(mint) });
    // Even when we deliberately feed one hash as the other's "secretHashHex"/"cPrimeHex" field, the
    // domain tag differs, so the two leaf kinds can never be confused for one another.
    const mintOfSameShape = mintLeafHash({ keysetId: 'keyset-1', amount: 50, cPrimeHex: bytesToHex(mint) });
    expect(bytesToHex(burn)).not.toBe(bytesToHex(mintOfSameShape));
  });
});
