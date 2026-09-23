// Gate 6 — real Taproot (P2TR) key-path address derivation, using
// @scure/btc-signer (audited, purpose-built Bitcoin transaction library —
// not hand-rolled BIP-341 point tweaking; see DECISIONS.md for why this
// dependency was added specifically for Gate 6).
import { hex } from '@scure/base';
import { p2tr, TEST_NETWORK, utils as btcUtils } from '@scure/btc-signer';
import { taprootTweakPrivKey } from '@scure/btc-signer/utils.js';

/** testnet and signet share the same address encoding (bech32 HRP "tb"); @scure/btc-signer's TEST_NETWORK covers both. */
export const SIGNET_ADDRESS_NETWORK = TEST_NETWORK;

export interface SignetReserveKey {
  internalPrivateKeyHex: string;
  internalPublicKeyXOnlyHex: string;
  tweakedPrivateKeyHex: string;
  /** The x-only public key actually on-chain — this is `reserve_pubkey` in the statement. */
  outputPublicKeyXOnlyHex: string;
  address: string;
  scriptPubKeyHex: string;
}

/** Generates a fresh real secp256k1 keypair and derives its P2TR key-path-only address and tweaked spending key. */
export function generateSignetReserveKey(): SignetReserveKey {
  const internalPrivateKey = btcUtils.randomPrivateKeyBytes();
  const internalPublicKeyXOnly = btcUtils.pubSchnorr(internalPrivateKey);
  const payment = p2tr(internalPublicKeyXOnly, undefined, SIGNET_ADDRESS_NETWORK);
  if (!payment.address) throw new Error('p2tr() did not return an address');
  const tweakedPrivateKey = taprootTweakPrivKey(internalPrivateKey);
  return {
    internalPrivateKeyHex: hex.encode(internalPrivateKey),
    internalPublicKeyXOnlyHex: hex.encode(internalPublicKeyXOnly),
    tweakedPrivateKeyHex: hex.encode(tweakedPrivateKey),
    outputPublicKeyXOnlyHex: hex.encode(payment.tweakedPubkey),
    address: payment.address,
    scriptPubKeyHex: hex.encode(payment.script),
  };
}
