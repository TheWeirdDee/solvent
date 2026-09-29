// Phase 3B trust root: mint identity (NUT-06) -> manifest key delegation.
//
// The real signer is cdk-mintd's signatory (patches/cdk/0008); its output is
// checked against a fixture captured from the real local CLI. The in-test
// signer below exists only to construct negative cases — it signs the same
// canonical bytes with a BIP32 master key, exactly as DbSignatory does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import {
  delegationMessage,
  MANIFEST_KEY_DELEGATION_SCHEMA,
  parseCompressedPubkey,
  verifyDelegatedManifest,
  verifyManifestKeyDelegation,
  xOnlyFromCompressed,
  type ManifestKeyDelegation,
} from '../../src/epoch/delegation.js';
import { signManifest, type ManifestFields } from '../../src/pol/manifest.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const MINT_URL = 'https://mint.example';

/** A mint identity exactly as DbSignatory derives it: the BIP32 master key of the seed. */
function mintIdentity(seed: Uint8Array) {
  const master = HDKey.fromMasterSeed(seed);
  return { priv: master.privateKey!, pub: hex(master.publicKey!) };
}

function newManifestKey() {
  const priv = createRandomSecretKey();
  return { privHex: hex(priv), pub: hex(getPubKeyFromPrivKey(priv)) };
}

function sign(identityPriv: Uint8Array, fields: Omit<ManifestKeyDelegation, 'schema' | 'signature'>): ManifestKeyDelegation {
  const d = { schema: MANIFEST_KEY_DELEGATION_SCHEMA, ...fields, signature: '' };
  d.signature = hex(schnorr.sign(sha256(delegationMessage(d)), identityPriv));
  return d;
}

const MINT = mintIdentity(new TextEncoder().encode('solvent-test-mint-seed-000000000'));
const OTHER_MINT = mintIdentity(new TextEncoder().encode('solvent-unrelated-mint-seed-0000'));

function valid(manifestPub: string, validFrom = 1): ManifestKeyDelegation {
  return sign(MINT.priv, { mint_url: MINT_URL, mint_identity_pubkey: MINT.pub, manifest_pubkey: manifestPub, valid_from_epoch: validFrom, created_at: 1_790_000_000 });
}

function manifest(epoch: number): ManifestFields {
  return {
    keyset_id: '00ab', unit: 'sat', epoch_index: epoch, timestamp: '2026-09-29T00:00:00Z', previous_global_digest: '00'.repeat(32),
    issued_mmr_size: 0, issued_mmr_root_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', issued_mmr_root_sum: 0,
    spent_mmr_size: 0, spent_mmr_root_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', spent_mmr_root_sum: 0,
    outstanding_balance: 0, active: true, deactivation_epoch: 0,
  };
}

describe('manifest key delegation — canonical encoding', () => {
  it('matches the Rust encoder byte for byte (cross-language vector from patch 0008)', () => {
    const m = delegationMessage({
      mint_url: MINT_URL,
      mint_identity_pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      manifest_pubkey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      valid_from_epoch: 3,
      created_at: 1_790_000_000,
    });
    expect(hex(m)).toBe(
      '0022736f6c76656e742f6d616e69666573742d6b65792d64656c65676174696f6e2f7631001468747470733a2f2f6d696e742e6578616d706c650279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179802c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee50000000000000003000000006ab13b80',
    );
  });

  it('J. the NUT-06 identity of the local test mint is the BIP32 master key of its seed, and its x-only form is its x coordinate', () => {
    // The public BIP-39 test vector the local and CI regtest mints use.
    const seed = mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const id = mintIdentity(seed);
    expect(id.pub).toBe('03d902f35f560e0470c63313c7369168d9d7df2d49bf295fd9fb7cb109ccee0494');
    expect(xOnlyFromCompressed(id.pub)).toBe(id.pub.slice(2));
    expect(xOnlyFromCompressed(id.pub)).toBe(hex(schnorr.getPublicKey(id.priv)));
  });
});

describe('manifest key delegation — verification', () => {
  const mk = newManifestKey();
  const expectFor = (d: ManifestKeyDelegation, epoch = 1) => ({ mintUrl: MINT_URL, mintIdentityPubkey: MINT.pub, manifestPubkey: d.manifest_pubkey, epochIndex: epoch });

  it('A. a valid delegation verifies', () => {
    const d = valid(mk.pub);
    expect(verifyManifestKeyDelegation(d, expectFor(d))).toEqual({ ok: true });
    expect(verifyManifestKeyDelegation({ ...d, mint_identity_xonly_pubkey: MINT.pub.slice(2) }, expectFor(d)).ok).toBe(true);
  });

  it('B. a changed manifest pubkey fails', () => {
    const d = { ...valid(mk.pub), manifest_pubkey: newManifestKey().pub };
    expect(verifyManifestKeyDelegation(d, expectFor(d))).toMatchObject({ ok: false, reason: 'DELEGATION_SIGNATURE_INVALID' });
  });

  it('C. a changed mint URL fails', () => {
    const d = { ...valid(mk.pub), mint_url: 'https://evil.example' };
    expect(verifyManifestKeyDelegation(d, { ...expectFor(d), mintUrl: 'https://evil.example' })).toMatchObject({ ok: false, reason: 'DELEGATION_SIGNATURE_INVALID' });
    expect(verifyManifestKeyDelegation(valid(mk.pub), { ...expectFor(d), mintUrl: 'https://evil.example' })).toMatchObject({ ok: false, reason: 'DELEGATION_MINT_MISMATCH' });
  });

  it('D. a changed valid_from_epoch fails', () => {
    const d = { ...valid(mk.pub, 5), valid_from_epoch: 1 };
    expect(verifyManifestKeyDelegation(d, expectFor(d))).toMatchObject({ ok: false, reason: 'DELEGATION_SIGNATURE_INVALID' });
  });

  it('E. a changed created_at fails', () => {
    const d = { ...valid(mk.pub), created_at: 1_790_000_001 };
    expect(verifyManifestKeyDelegation(d, expectFor(d))).toMatchObject({ ok: false, reason: 'DELEGATION_SIGNATURE_INVALID' });
  });

  it('F. a delegation signed by an unrelated mint identity fails', () => {
    const forged = sign(OTHER_MINT.priv, { mint_url: MINT_URL, mint_identity_pubkey: MINT.pub, manifest_pubkey: mk.pub, valid_from_epoch: 1, created_at: 1 });
    expect(verifyManifestKeyDelegation(forged, expectFor(forged))).toMatchObject({ ok: false, reason: 'DELEGATION_SIGNATURE_INVALID' });
    const honestOther = sign(OTHER_MINT.priv, { mint_url: MINT_URL, mint_identity_pubkey: OTHER_MINT.pub, manifest_pubkey: mk.pub, valid_from_epoch: 1, created_at: 1 });
    expect(verifyManifestKeyDelegation(honestOther, expectFor(honestOther))).toMatchObject({ ok: false, reason: 'DELEGATION_IDENTITY_MISMATCH' });
  });

  it('G. a manifest signed by a different key than the delegated one fails, even though its own signature is valid', () => {
    const d = valid(mk.pub);
    const rogue = newManifestKey();
    const m = manifest(3);
    const rogueSig = signManifest(m, rogue.privHex);
    const mint = { mintUrl: MINT_URL, mintIdentityPubkey: MINT.pub };
    expect(verifyDelegatedManifest(m, rogueSig, rogue.pub, d, mint)).toMatchObject({ ok: false, reason: 'DELEGATION_MANIFEST_KEY_MISMATCH' });
    expect(verifyDelegatedManifest(m, rogueSig, mk.pub, d, mint)).toMatchObject({ ok: false, reason: 'MANIFEST_SIGNATURE_INVALID' });
    expect(verifyDelegatedManifest(m, signManifest(m, mk.privHex), mk.pub, d, mint)).toEqual({ ok: true });
  });

  it('an epoch before valid_from_epoch is out of scope', () => {
    const d = valid(mk.pub, 4);
    expect(verifyManifestKeyDelegation(d, expectFor(d, 3))).toMatchObject({ ok: false, reason: 'DELEGATION_EPOCH_OUT_OF_SCOPE' });
    expect(verifyManifestKeyDelegation(d, expectFor(d, 4)).ok).toBe(true);
  });

  it('an x-only copy that is not derived from the compressed identity is rejected', () => {
    const d = { ...valid(mk.pub), mint_identity_xonly_pubkey: OTHER_MINT.pub.slice(2) };
    expect(verifyManifestKeyDelegation(d, expectFor(d))).toMatchObject({ ok: false, reason: 'DELEGATION_XONLY_MISMATCH' });
  });

  it('K. a malformed compressed identity pubkey fails', () => {
    const d = valid(mk.pub);
    for (const bad of [MINT.pub.slice(2), '04' + MINT.pub.slice(2), '02' + 'ff'.repeat(32), MINT.pub.toUpperCase(), '']) {
      expect(verifyManifestKeyDelegation({ ...d, mint_identity_pubkey: bad }, { ...expectFor(d), mintIdentityPubkey: bad })).toMatchObject({ ok: false, reason: 'DELEGATION_BAD_IDENTITY_KEY' });
    }
    expect(parseCompressedPubkey('02' + 'ff'.repeat(32))).toBeNull();
  });

  it('L. a malformed manifest pubkey fails', () => {
    const d = valid(mk.pub);
    for (const bad of [mk.pub.slice(2), '05' + mk.pub.slice(2), '03' + 'ff'.repeat(32), 'zz']) {
      expect(verifyManifestKeyDelegation({ ...d, manifest_pubkey: bad }, { ...expectFor(d), manifestPubkey: bad })).toMatchObject({ ok: false, reason: 'DELEGATION_BAD_MANIFEST_KEY' });
    }
    const selfDelegation = sign(MINT.priv, { mint_url: MINT_URL, mint_identity_pubkey: MINT.pub, manifest_pubkey: MINT.pub, valid_from_epoch: 1, created_at: 1 });
    expect(verifyManifestKeyDelegation(selfDelegation, expectFor(selfDelegation))).toMatchObject({ ok: false, reason: 'DELEGATION_BAD_MANIFEST_KEY' });
  });

  it('rejects a wrong schema and malformed scalar fields', () => {
    const d = valid(mk.pub);
    expect(verifyManifestKeyDelegation({ ...d, schema: 'solvent/manifest-key-delegation/v2' }, expectFor(d))).toMatchObject({ reason: 'DELEGATION_SCHEMA' });
    expect(verifyManifestKeyDelegation({ ...d, valid_from_epoch: 0 }, expectFor(d))).toMatchObject({ reason: 'DELEGATION_MALFORMED' });
    expect(verifyManifestKeyDelegation({ ...d, signature: 'ab' }, expectFor(d))).toMatchObject({ reason: 'DELEGATION_MALFORMED' });
    expect(verifyManifestKeyDelegation({ ...d, mint_url: 'ftp://mint.example' }, expectFor(d))).toMatchObject({ reason: 'DELEGATION_MALFORMED' });
  });
});

describe('manifest key delegation — real cdk-mintd signer', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'delegation-local-cdk-mintd.json'), 'utf8')) as {
    nut06_pubkey: string;
    delegation: ManifestKeyDelegation;
  };

  it('a delegation signed by the real patched cdk-mintd signatory verifies against that mint\'s NUT-06 pubkey', () => {
    const d = fixture.delegation;
    expect(d.mint_identity_pubkey).toBe(fixture.nut06_pubkey);
    expect(d.mint_identity_xonly_pubkey).toBe(xOnlyFromCompressed(fixture.nut06_pubkey));
    expect(
      verifyManifestKeyDelegation(d, { mintUrl: d.mint_url, mintIdentityPubkey: fixture.nut06_pubkey, manifestPubkey: d.manifest_pubkey, epochIndex: d.valid_from_epoch }),
    ).toEqual({ ok: true });
    expect(
      verifyManifestKeyDelegation(d, { mintUrl: d.mint_url, mintIdentityPubkey: fixture.nut06_pubkey, manifestPubkey: newManifestKey().pub, epochIndex: d.valid_from_epoch }),
    ).toMatchObject({ ok: false, reason: 'DELEGATION_MANIFEST_KEY_MISMATCH' });
  });
});
