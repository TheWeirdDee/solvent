// npm run verify:pol-receipts -- <path-to-cdk-mintd.sqlite>
//
// SOLVENT — Phase 2 Step 15: independent PoL receipt verification.
//
// Deliberately has NO access to: the mint's seed, the signatory, private
// keys, or CDK's write path. Its only inputs are public: the mint's own
// `/v1/keys` HTTP response (the real per-amount public keys every wallet
// already fetches) and the signed receipt rows SOLVENT's own real patch
// (patches/cdk/0003-wire-pol-receipt-signing-into-nut04-issuance.patch)
// wrote into the database. It independently reconstructs the exact
// canonical receipt message from the real blinded_message_hex/amount data
// — never trusting the stored `message` blob at face value — and verifies
// the real BIP-340 Schnorr signature against it, per the pinned draft's
// "Message Formats and Cryptography" section (docs/draft-alignment.md).
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrVerifyDigest } from '@cashu/cashu-ts';

interface Receipt {
  id: string;
  keyset_id: string;
  amount: number;
  blinded_message_hex: string;
  signature_hex: string;
}

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(34)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

function canonicalMessage(blindedMessageHex: string): Uint8Array {
  return new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${blindedMessageHex}:0`);
}

function verify(pubkeyHex: string, blindedMessageHex: string, signatureHex: string): boolean {
  const digest = sha256(canonicalMessage(blindedMessageHex));
  return schnorrVerifyDigest(signatureHex, digest, pubkeyHex, false);
}

async function fetchPublicKeys(mintUrl: string, keysetId: string): Promise<Record<string, string>> {
  const res = await fetch(`${mintUrl}/v1/keys/${keysetId}`);
  if (!res.ok) throw new Error(`mint /v1/keys/${keysetId} -> HTTP ${res.status}`);
  const body = (await res.json()) as { keysets: { id: string; keys: Record<string, string> }[] };
  const keyset = body.keysets.find((k) => k.id === keysetId);
  if (!keyset) throw new Error(`keyset ${keysetId} not present in mint's own /v1/keys response`);
  return keyset.keys;
}

async function main() {
  const dbPath = process.argv[2];
  const mintUrl = process.env.CDK_MINT_URL;
  if (!dbPath) throw new Error('usage: pol-receipt-verify.ts <path-to-cdk-mintd.sqlite>');
  if (!mintUrl) throw new Error('Missing required env var CDK_MINT_URL');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const receipts = db
    .prepare(
      `SELECT r.id AS id, il.keyset_id AS keyset_id, il.amount AS amount,
              il.blinded_message_hex AS blinded_message_hex, r.signature_hex AS signature_hex
       FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE r.liability_kind = 'issued' AND il.operation_kind = 'mint' AND r.status = 'signed'`,
    )
    .all() as unknown as Receipt[];
  db.close();

  console.log('SOLVENT — PHASE 2 INDEPENDENT PoL RECEIPT VERIFICATION\n');
  console.log(`Found ${receipts.length} signed receipt(s) to verify\n`);

  if (receipts.length === 0) {
    console.log('PHASE 2 NOT VERIFIED — zero signed receipts found; nothing was actually verified.');
    process.exitCode = 1;
    return;
  }

  const keysetCache = new Map<string, Record<string, string>>();
  const getKeys = async (keysetId: string) => {
    if (!keysetCache.has(keysetId)) keysetCache.set(keysetId, await fetchPublicKeys(mintUrl, keysetId));
    return keysetCache.get(keysetId)!;
  };

  let allValid = true;
  for (const r of receipts) {
    const keys = await getKeys(r.keyset_id);
    const pubkey = keys[String(r.amount)];
    if (!pubkey) {
      console.log(line(`Receipt ${r.id.slice(0, 8)}`, false, `no public key for amount ${r.amount} in keyset ${r.keyset_id}`));
      allValid = false;
      continue;
    }
    const ok = verify(pubkey, r.blinded_message_hex, r.signature_hex);
    console.log(line(`Receipt ${r.id.slice(0, 8)} (amount ${r.amount})`, ok, ok ? 'signature VALID against real mint public key' : 'signature INVALID'));
    if (!ok) allValid = false;
  }

  // Deliberate mutation tests (Phase 2 Step 15/20) — every mutation of an
  // otherwise-valid receipt must fail verification.
  console.log('');
  const sample = receipts[0]!;
  const sampleKeys = await getKeys(sample.keyset_id);
  const samplePubkey = sampleKeys[String(sample.amount)]!;
  const baselineOk = verify(samplePubkey, sample.blinded_message_hex, sample.signature_hex);
  console.log(line('Baseline (unmutated) receipt', baselineOk));

  const tamperedAmountPubkey = sampleKeys[String(sample.amount)] ? Object.values(sampleKeys).find((k) => k !== samplePubkey) : undefined;
  const tests: { label: string; ok: boolean }[] = [
    { label: 'Tampered public key (wrong amount)', ok: !verify(tamperedAmountPubkey ?? '02' + '00'.repeat(32), sample.blinded_message_hex, sample.signature_hex) },
    { label: 'Tampered blinded message', ok: !verify(samplePubkey, sample.blinded_message_hex.slice(0, -2) + '00', sample.signature_hex) },
    { label: 'Tampered signature', ok: !verify(samplePubkey, sample.blinded_message_hex, sample.signature_hex.slice(0, -2) + '00') },
    { label: 'Tampered epoch (message forged with :1 instead of :0)', ok: !schnorrVerifyDigest(sample.signature_hex, sha256(new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${sample.blinded_message_hex}:1`)), samplePubkey, false) },
  ];
  for (const t of tests) {
    console.log(line(t.label, t.ok, t.ok ? 'correctly REFUSED' : 'incorrectly accepted a tampered receipt'));
    if (!t.ok) allValid = false;
  }

  console.log('');
  if (allValid) {
    console.log(`INDEPENDENT PoL RECEIPT VERIFICATION: ${receipts.length}/${receipts.length} PASS`);
    process.exitCode = 0;
  } else {
    console.log('PHASE 2 NOT VERIFIED — independent receipt verification failed');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-receipt-verify crashed:', err);
  process.exitCode = 1;
});
