// The one BOLT11 field SOLVENT needs: the payment hash (tagged field `p`),
// read from the invoice itself so a returned preimage can be checked against
// it. Bech32 with checksum verification (BIP-173); no other field is parsed.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** The 5-bit data words of a bech32 string, or null if it is not valid bech32. */
export function bech32Words(s: string): number[] | null {
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  return data.slice(0, -6);
}

function wordsToBytes(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** The invoice's payment hash (hex), or null if the invoice cannot be decoded. */
export function invoicePaymentHash(invoice: string): string | null {
  const words = bech32Words(invoice);
  if (!words) return null;
  let i = 7; // 35-bit timestamp
  while (i + 3 <= words.length - 104) {
    const type = words[i]!;
    const len = words[i + 1]! * 32 + words[i + 2]!;
    if (type === 1 && len === 52) return [...wordsToBytes(words.slice(i + 3, i + 3 + len)).slice(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join('');
    i += 3 + len;
  }
  return null;
}

/** When the invoice was created and when it expires (unix seconds), from its own fields (BOLT11 default expiry: 3600 s). */
export function invoiceTimes(invoice: string): { createdAt: number; expiresAt: number } | null {
  const words = bech32Words(invoice);
  if (!words || words.length < 7) return null;
  const createdAt = words.slice(0, 7).reduce((a, w) => a * 32 + w, 0);
  let expiry = 3600;
  let i = 7;
  while (i + 3 <= words.length - 104) {
    const type = words[i]!;
    const len = words[i + 1]! * 32 + words[i + 2]!;
    if (type === 6) expiry = words.slice(i + 3, i + 3 + len).reduce((a, w) => a * 32 + w, 0);
    i += 3 + len;
  }
  return { createdAt, expiresAt: createdAt + expiry };
}
