// Deterministic, unambiguous byte encoding used everywhere SOLVENT hashes
// structured data (leaves, tree nodes). Every field is length-prefixed so
// two different field splits can never collide on the same byte string
// (e.g. ("ab","c") vs ("a","bc") produce different bytes here).
//
// Layout of a length-prefixed field: u32BE(byteLength) || bytes

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function u32BE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`u32BE: ${n} is not a valid uint32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

// Sats amounts must be non-negative safe integers, never floats. Encoded as
// a big-endian u64 so leaf hashes are stable across platforms.
export function u64BEFromSats(n: number | bigint): Uint8Array {
  const big = typeof n === 'bigint' ? n : BigInt(n);
  if (typeof n === 'number' && !Number.isSafeInteger(n)) {
    throw new RangeError(`u64BEFromSats: ${n} is not a safe integer sats amount`);
  }
  if (big < 0n) throw new RangeError(`u64BEFromSats: ${big} is negative`);
  if (big > 0xffffffffffffffffn) throw new RangeError(`u64BEFromSats: ${big} exceeds u64`);
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(big >> 32n), false);
  view.setUint32(4, Number(big & 0xffffffffn), false);
  return out;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Length-prefix an arbitrary byte string so it can be safely concatenated
// with other fields without ambiguity.
export function field(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32BE(bytes.length), bytes);
}

export function fieldStr(text: string): Uint8Array {
  return field(utf8(text));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new RangeError(`hexToBytes: invalid hex string "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
