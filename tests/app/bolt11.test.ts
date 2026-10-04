import { describe, expect, it } from 'vitest';
import { bech32Words, invoicePaymentHash, invoiceTimes } from '../../src/app/bolt11.js';

// A real Mutinynet invoice from the isolated real-Lightning test mint
// (LDK node), paid during a browser run; its payment hash was recorded
// independently by the paying node.
const INVOICE =
  'lntbs640n1p4vqr4rdqqnp4qghscp9uqkayfuxamxvcqy26wzupvmtck8qz4cj766vw67qu67vrwpp5ht5ch2slvf0e255af2hf05purcfy7wsyg8cmkdszxjc86qskd8qssp5dud83qg5czs7g7psk0mdmjazxdrnslg9cegg4wmaxlnve5zlgd7q9qyysgqcqzp2xqrrssqjth9fk9cs3lmx98rvqqtxdgv65pp38y2y68dqg5v58t422s4v7znuzgplc2xv6vv30uwf4jf2qam6mxprqne25nm3zmxngca3gv59sqkpsshy';

describe('BOLT11 payment hash', () => {
  it('reads the payment hash of a real Mutinynet invoice', () => {
    expect(invoicePaymentHash(INVOICE)).toBe('bae98baa1f625f95529d4aae97d03c1e124f3a0441f1bb360234b07d021669c1');
    expect(invoicePaymentHash(INVOICE.toUpperCase())).toBe('bae98baa1f625f95529d4aae97d03c1e124f3a0441f1bb360234b07d021669c1');
  });

  it('rejects a corrupted invoice (bech32 checksum)', () => {
    const flipped = INVOICE.slice(0, 60) + (INVOICE[60] === 'q' ? 'p' : 'q') + INVOICE.slice(61);
    expect(bech32Words(flipped)).toBeNull();
    expect(invoicePaymentHash(flipped)).toBeNull();
    expect(invoicePaymentHash('not an invoice')).toBeNull();
  });
});

describe('BOLT11 timestamps', () => {
  it('reads creation time and expiry from the invoice', () => {
    const t = invoiceTimes(INVOICE)!;
    expect(t.createdAt).toBeGreaterThan(1_790_000_000); // created 2026-10-02
    expect(t.createdAt).toBeLessThan(1_791_000_000);
    expect(t.expiresAt - t.createdAt).toBeGreaterThan(0);
  });
});
