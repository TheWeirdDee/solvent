// CLI wrapper: runs the Gate 0 spike (src/cashu/gate0.ts) and writes the
// required evidence/gate-0/ artifacts. Run with: npx tsx src/cli/gate0.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runGate0Spike } from '../cashu/gate0.js';

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'gate-0');

function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const r = runGate0Spike();
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  log('SOLVENT Gate 0 — NUT-12 transfer invariant spike');
  log('cashu library: @cashu/cashu-ts 4.10.2');
  log('');
  log(`[1] real issuance produced: amount=${r.amount} keyset=${r.keysetId}`);
  log(`    original B'  = ${r.originalBPrimeHex}`);
  log(`    original C_  = ${r.originalCPrimeHex}`);
  log('');
  log('[2] real token encode/decode round trip complete');
  log(`    encoded token length: ${r.encodedToken.length} chars`);
  log(`    received proof contains dleq.e/s/r: ${r.dleqSurvivedTransfer}`);
  if (!r.dleqSurvivedTransfer) log('    CRITICAL FAILURE: r (or e/s) was stripped by the real transfer path.');
  log('');
  log('[3] independent receiver-side reconstruction');
  log(`    reconstructed B' = ${r.reconstructedBPrimeHex || '(not computed — dleq missing)'}`);
  log(`    reconstructed C' = ${r.reconstructedCPrimeHex || '(not computed — dleq missing)'}`);
  log(`    original_B' == reconstructed_B' : ${r.bPrimeEqual}`);
  log(`    DLEQ valid                      : ${r.dleqValid}`);
  log('');
  log(`GATE 0: ${r.pass ? 'PASS' : 'BLOCKED'}`);

  writeFileSync(
    path.join(EVIDENCE_DIR, 'original-issuance.json'),
    JSON.stringify(
      {
        cashu_library: '@cashu/cashu-ts',
        cashu_library_version: '4.10.2',
        keyset_id: r.keysetId,
        amount: r.amount,
        amount_public_key_A: r.amountPublicKeyHex,
        original_b_prime: r.originalBPrimeHex,
        original_blind_signature_c_prime: r.originalCPrimeHex,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  writeFileSync(
    path.join(EVIDENCE_DIR, 'token-received.json'),
    JSON.stringify(
      {
        transfer_path: 'getEncodedToken() -> cashu token string -> getDecodedToken()',
        encoded_token: r.encodedToken,
        mint: r.mintUrl,
        received_proof: { ...r.receivedProof, amount: Number(r.receivedProof.amount) },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  writeFileSync(
    path.join(EVIDENCE_DIR, 'reconstruction.json'),
    JSON.stringify(
      {
        original_b_prime: r.originalBPrimeHex,
        reconstructed_b_prime: r.reconstructedBPrimeHex,
        equal: r.bPrimeEqual,
        dleq_valid: r.dleqValid,
        reconstructed_c_prime: r.reconstructedCPrimeHex,
        original_c_prime: r.originalCPrimeHex,
        c_prime_equal: r.cPrimeEqual,
        cashu_library: '@cashu/cashu-ts',
        cashu_library_version: '4.10.2',
        transfer_path: 'getEncodedToken() -> cashu token string -> getDecodedToken()',
        received_proof_contains_r: r.dleqSurvivedTransfer,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  writeFileSync(path.join(EVIDENCE_DIR, 'verify.txt'), lines.join('\n') + '\n', 'utf8');

  process.exit(r.pass ? 0 : 1);
}

main();
