// Validated against the official Cashu PR #388 draft test vector
// (github.com/a1denvalu3/nuts/blob/pol-spec/tests/pol-tests.md, section 4
// "Epoch Manifest Signatures"). Every hex-length field was independently
// verified against the raw fetched file before being hardcoded here (see
// DECISIONS.md — a prior digest-length assumption in this same vector set
// was caught and corrected this way).
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  emptyKeysetMerkleRoot,
  globalDigest,
  keysetLeafHash,
  keysetMerkleRoot,
  manifestMessage,
  sortKeysets,
  verifyManifest,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../../src/pol/manifest.js';

const VECTOR_ENTRY: KeysetManifestEntry = {
  keyset_id: '009a6154b71113b7',
  unit: 'sat',
  issued_mmr_size: 3,
  issued_mmr_root_hash: '2518b42edfff24ecc53c8897d1860783d1d26c41d61c378fe612cddeed877040',
  issued_mmr_root_sum: 850,
  spent_mmr_size: 0,
  spent_mmr_root_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // empty MMR hash
  spent_mmr_root_sum: 0,
  active: true,
  deactivation_epoch: 12,
};

const VECTOR_MASTER_PUBKEY = 'f3dd0e40dd3d888301b3b47aede737b6f9451ab451dfc05a1ae023ab4235b4dd';
const VECTOR_SIGNATURE =
  '01cb753c8fad0182e39d7f4543bd3bee77519a599268f51a8d260aa6f8acc721b5d46726296c57488fed0bb60b8e03d1c7a30093bf9537d30569be4bd52889f2';

const VECTOR_MANIFEST: ManifestFields = {
  keyset_id: VECTOR_ENTRY.keyset_id,
  unit: VECTOR_ENTRY.unit,
  epoch_index: 1,
  timestamp: '2026-06-11T12:00:00Z',
  previous_global_digest: ZERO_DIGEST_HEX,
  issued_mmr_size: VECTOR_ENTRY.issued_mmr_size,
  issued_mmr_root_hash: VECTOR_ENTRY.issued_mmr_root_hash,
  issued_mmr_root_sum: VECTOR_ENTRY.issued_mmr_root_sum,
  spent_mmr_size: VECTOR_ENTRY.spent_mmr_size,
  spent_mmr_root_hash: VECTOR_ENTRY.spent_mmr_root_hash,
  spent_mmr_root_sum: VECTOR_ENTRY.spent_mmr_root_sum,
  outstanding_balance: 850,
  active: VECTOR_ENTRY.active,
  deactivation_epoch: VECTOR_ENTRY.deactivation_epoch,
};

describe('keyset leaf / Merkle root (official vector)', () => {
  it('ZERO_DIGEST_HEX is exactly 32 zero bytes', () => {
    expect(ZERO_DIGEST_HEX.length).toBe(64);
  });

  it('keyset leaf hash matches the vector', () => {
    expect(bytesToHex(keysetLeafHash(VECTOR_ENTRY))).toBe('e5e9ab7244c98ae4a133a567a8fc8b1d176ffa5b25113733eeb190a4d89b85a7');
  });

  it('single-keyset Merkle root equals the leaf hash itself', () => {
    const root = keysetMerkleRoot(sortKeysets([VECTOR_ENTRY]));
    expect(bytesToHex(root)).toBe('e5e9ab7244c98ae4a133a567a8fc8b1d176ffa5b25113733eeb190a4d89b85a7');
  });

  it('empty keyset Merkle root matches the vector', () => {
    expect(bytesToHex(emptyKeysetMerkleRoot())).toBe('66b7de363bb498c9cf01f2997ec7f658b8734dd8bb5e959ea240c9ea9a951180');
    expect(bytesToHex(keysetMerkleRoot([]))).toBe('66b7de363bb498c9cf01f2997ec7f658b8734dd8bb5e959ea240c9ea9a951180');
  });
});

describe('global digest (official vector)', () => {
  it('matches the vector for epoch 1, one keyset', () => {
    const kRoot = keysetMerkleRoot(sortKeysets([VECTOR_ENTRY]));
    const digest = globalDigest(ZERO_DIGEST_HEX, 1, 1, kRoot);
    expect(bytesToHex(digest)).toBe('0f2035e358a37706bd93f5fa629b5576d074b5eed67e46f8932f4eb79c23e81a');
  });
});

describe('manifest message + signature (official vector)', () => {
  it('serialized manifest string matches the vector exactly', () => {
    const expected =
      '009a6154b71113b7:sat:1:2026-06-11T12:00:00Z:' +
      ZERO_DIGEST_HEX +
      ':3:2518b42edfff24ecc53c8897d1860783d1d26c41d61c378fe612cddeed877040:850:0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855:0:850:true:12';
    expect(manifestMessage(VECTOR_MANIFEST)).toBe(expected);
  });

  it('the official vector signature verifies against our manifest message + master pubkey', () => {
    expect(verifyManifest(VECTOR_MANIFEST, VECTOR_SIGNATURE, VECTOR_MASTER_PUBKEY)).toBe(true);
  });

  it('flipping outstanding_balance breaks verification', () => {
    const tampered = { ...VECTOR_MANIFEST, outstanding_balance: 851 };
    expect(verifyManifest(tampered, VECTOR_SIGNATURE, VECTOR_MASTER_PUBKEY)).toBe(false);
  });

  it('flipping active breaks verification', () => {
    const tampered = { ...VECTOR_MANIFEST, active: false };
    expect(verifyManifest(tampered, VECTOR_SIGNATURE, VECTOR_MASTER_PUBKEY)).toBe(false);
  });

  it('flipping epoch_index breaks verification', () => {
    const tampered = { ...VECTOR_MANIFEST, epoch_index: 2 };
    expect(verifyManifest(tampered, VECTOR_SIGNATURE, VECTOR_MASTER_PUBKEY)).toBe(false);
  });

  it('a garbage signature fails closed rather than throwing', () => {
    expect(verifyManifest(VECTOR_MANIFEST, '00'.repeat(64), VECTOR_MASTER_PUBKEY)).toBe(false);
  });
});

describe('sign/verify round trip with a fresh real key', () => {
  it('round-trips and rejects mutation', async () => {
    const { createRandomSecretKey, getPubKeyFromPrivKey } = await import('@cashu/cashu-ts');
    const priv = createRandomSecretKey();
    const privHex = bytesToHex(priv);
    const pubHex = bytesToHex(getPubKeyFromPrivKey(priv));
    const { signManifest } = await import('../../src/pol/manifest.js');
    const sig = signManifest(VECTOR_MANIFEST, privHex);
    expect(verifyManifest(VECTOR_MANIFEST, sig, pubHex)).toBe(true);
    expect(verifyManifest({ ...VECTOR_MANIFEST, epoch_index: 99 }, sig, pubHex)).toBe(false);
  });
});
