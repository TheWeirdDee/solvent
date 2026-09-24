// npm run verify:pol-recovery -- <path-to-cdk-mintd.sqlite> <expected-count>
//
// SOLVENT — Phase 2 Step 8 closure: verifies that every synthetic pending
// receipt seeded by pol-seed-pending-receipts.ts was recovered by the real
// mint's startup recovery scan (patches/cdk/0004-*.patch) — signed for
// real, with a signature that independently verifies against the real
// mint public key, and that recovery is structurally duplicate-safe (it
// only ever UPDATEs an existing, uniquely-identified row — there is no
// code path by which running it again could produce a second row for the
// same obligation; confirmed here by asserting the row count is exactly
// what was seeded, never more).
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrVerifyDigest } from '@cashu/cashu-ts';

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(34)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
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
  const expectedCount = Number(process.argv[3]);
  const mintUrl = process.env.CDK_MINT_URL;
  if (!dbPath || !expectedCount) throw new Error('usage: pol-recovery-verify.ts <path-to-cdk-mintd.sqlite> <expected-count>');
  if (!mintUrl) throw new Error('Missing required env var CDK_MINT_URL');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.status AS status, r.signature_hex AS signature_hex,
              il.keyset_id AS keyset_id, il.amount AS amount, il.blinded_message_hex AS blinded_message_hex
       FROM solvent_pol_receipt r
       JOIN solvent_issued_liability il ON il.id = r.liability_id
       WHERE il.operation_kind = 'batch_mint'`,
    )
    .all() as unknown as { id: string; status: string; signature_hex: string | null; keyset_id: string; amount: number; blinded_message_hex: string }[];
  db.close();

  console.log('SOLVENT — PHASE 2 RECEIPT RECOVERY VERIFICATION\n');
  console.log(`Synthetic pending receipts found: ${rows.length} (expected exactly ${expectedCount})\n`);

  const countOk = rows.length === expectedCount;
  console.log(line('Row count matches (no duplicates, none lost)', countOk, `${rows.length}/${expectedCount}`));

  const allSigned = rows.every((r) => r.status === 'signed' && !!r.signature_hex);
  console.log(line('All rows recovered to status=signed', allSigned));

  let allValid = allSigned;
  const keysCache = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!allSigned) break;
    if (!keysCache.has(r.keyset_id)) keysCache.set(r.keyset_id, await fetchPublicKeys(mintUrl, r.keyset_id));
    const pubkey = keysCache.get(r.keyset_id)![String(r.amount)];
    if (!pubkey) {
      console.log(line(`Receipt ${r.id.slice(0, 8)}`, false, 'no public key for this amount'));
      allValid = false;
      continue;
    }
    const message = new TextEncoder().encode(`Cashu_PoL_Receipt_Issued:${r.blinded_message_hex}:0`);
    const ok = schnorrVerifyDigest(r.signature_hex!, sha256(message), pubkey, false);
    console.log(line(`Receipt ${r.id.slice(0, 8)} (amount ${r.amount})`, ok, ok ? 'recovered signature VALID' : 'recovered signature INVALID'));
    if (!ok) allValid = false;
  }

  const allPass = countOk && allSigned && allValid;
  console.log('');
  if (allPass) {
    console.log('RECEIPT RECOVERY VERIFIED');
    process.exitCode = 0;
  } else {
    console.log('PHASE 2 NOT VERIFIED — receipt recovery failed');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('pol-recovery-verify crashed:', err);
  process.exitCode = 1;
});
