import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, field, fieldStr, hexToBytes, u32BE, u64BEFromSats, utf8 } from './canonical.js';

describe('canonical encoding', () => {
  it('length-prefixes fields so ("ab","c") and ("a","bc") never collide', () => {
    const a = concatBytes(fieldStr('ab'), fieldStr('c'));
    const b = concatBytes(fieldStr('a'), fieldStr('bc'));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('u32BE round-trips via DataView', () => {
    const encoded = u32BE(305419896); // 0x12345678
    expect(bytesToHex(encoded)).toBe('12345678');
  });

  it('u32BE rejects negative and out-of-range values', () => {
    expect(() => u32BE(-1)).toThrow();
    expect(() => u32BE(2 ** 32)).toThrow();
    expect(() => u32BE(1.5)).toThrow();
  });

  it('u64BEFromSats encodes a large sats amount deterministically', () => {
    expect(bytesToHex(u64BEFromSats(100_000))).toBe('00000000000186a0');
    expect(bytesToHex(u64BEFromSats(100_000))).toBe(bytesToHex(u64BEFromSats(100_000n)));
  });

  it('u64BEFromSats rejects negative and non-safe-integer amounts', () => {
    expect(() => u64BEFromSats(-1)).toThrow();
    expect(() => u64BEFromSats(1.5)).toThrow();
    expect(() => u64BEFromSats(2 ** 53)).toThrow();
  });

  it('field is invertible in length so a shifted boundary changes the hash input', () => {
    const x = field(utf8('hello'));
    const y = field(utf8('hell')); // different length prefix
    expect(bytesToHex(x)).not.toBe(bytesToHex(y));
  });

  it('hexToBytes/bytesToHex round-trip', () => {
    const hex = 'deadbeef00';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  it('hexToBytes rejects odd-length or non-hex input', () => {
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});
