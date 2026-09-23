// CLI: Gate 6 — real Bitcoin Signet reserve attestation (PRD §11.2's
// bounded implementation). Derives (or reuses) a real Taproot key-path
// address, attempts real faucet funding, and — once/if a real UTXO exists
// at that address — independently re-queries it via a public Esplora API
// and runs the full signature/binding/coverage evaluation for real.
//
// KNOWN BLOCKER (see DECISIONS.md): as of this build, every readily
// reachable public Signet faucet requires either a browser-solved CAPTCHA
// or (Mutinynet specifically) GitHub OAuth / an L402 Lightning payment —
// none of which this script will do on its own, since both involve a real
// external account/payment decision that isn't this script's to make. If
// the address below has not been funded, this still exercises and
// evidences the entire real mechanism (address derivation, statement
// schema, dual signatures, all required negative cases) against locally
// constructed chain state, and reports honestly that the live on-chain
// leg is pending funding — never fabricating a "verified" result.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { bytesToHex } from '../cashu/keys.js';
import { fetchAddressUtxos, fetchTipHeight, fetchTxOutScript, requestFaucetFunds, RESERVE_NETWORK_LABEL } from '../reserve/esplora.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation } from '../reserve/evaluate.js';
import { fetchChainState } from '../reserve/fetch-and-evaluate.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../reserve/statement.js';
import { generateSignetReserveKey, type SignetReserveKey } from '../reserve/taproot.js';

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'reserves');
const KEY_FILE = path.join(EVIDENCE_DIR, 'reserve-key.json');
const OUTSTANDING_BALANCE = 70_000;

function loadOrCreateReserveKey(): SignetReserveKey {
  if (existsSync(KEY_FILE)) {
    const parsed = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as SignetReserveKey & { _warning?: string };
    return parsed;
  }
  const key = generateSignetReserveKey();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const withWarning = {
    _warning: 'SIGNET TEST KEY ONLY — controls zero-value Bitcoin Signet (Mutinynet) testnet coins, never mainnet funds. Safe to publish; never reuse this key material for anything of real value.',
    ...key,
  };
  writeFileSync(KEY_FILE, JSON.stringify(withWarning, null, 2) + '\n', 'utf8');
  return key;
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  console.log('SOLVENT Gate 6 — real Bitcoin Signet reserve attestation\n');
  console.log(`Network: ${RESERVE_NETWORK_LABEL} (see docs/reserve-attestation.md for exactly why this signet variant)\n`);

  const reserveKey = loadOrCreateReserveKey();
  console.log(`Reserve address (persisted across runs at evidence/reserves/reserve-key.json): ${reserveKey.address}`);
  console.log(`Reserve output pubkey (x-only, tweaked): ${reserveKey.outputPublicKeyXOnlyHex}\n`);

  const bearerToken = process.env.MUTINYNET_FAUCET_TOKEN;
  const faucet = await requestFaucetFunds(reserveKey.address, 150_000, bearerToken);
  console.log(`Automated faucet request: ${faucet.ok ? 'OK' : 'FAILED'} — ${faucet.detail}`);
  if (!faucet.ok) {
    console.log(
      '  This is the known blocker: fund this address yourself in a real browser (e.g. https://faucet.mutinynet.com,\n' +
        '  solving its human verification) or set MUTINYNET_FAUCET_TOKEN to a bearer token you obtained yourself, then re-run `npm run gate6`.',
    );
  }

  const utxos = await fetchAddressUtxos(reserveKey.address).catch(() => []);
  console.log(`\nLive UTXOs at this address: ${utxos.length}`);

  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  type CaseResult = { label: string; expected_reason_code: string | null; actual_reason_code: string | null; verified: boolean; pass: boolean; detail: string };
  const cases: CaseResult[] = [];
  let liveVerified = false;
  let tipHeight = 0;

  if (utxos.length > 0) {
    tipHeight = await fetchTipHeight();
    const outpoints = await Promise.all(
      utxos.map(async (u) => {
        const out = await fetchTxOutScript(u.txid, u.vout);
        return { txid: u.txid, vout: u.vout, value_sats: out?.value ?? u.value, script_pubkey_hex: out?.scriptPubKeyHex ?? reserveKey.scriptPubKeyHex };
      }),
    );
    const statement: ReserveStatement = {
      network: RESERVE_NETWORK_LABEL,
      reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
      outpoints,
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      block_height: tipHeight,
    };
    const statementSignature = signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
    const digest = reserveStatementDigestHex(statement);
    const bindingSignature = signReserveBinding(statement.reserve_pubkey, digest, masterPrivHex);
    const attestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: masterPubHex };

    const chainState = await fetchChainState(statement);
    const result = evaluateReserveAttestation(attestation, chainState, OUTSTANDING_BALANCE, tipHeight);
    liveVerified = result.verified;
    cases.push({
      label: `LIVE: real ${outpoints.length} outpoint(s), independently re-queried via Esplora`,
      expected_reason_code: null,
      actual_reason_code: result.reasonCode ?? null,
      verified: result.verified,
      pass: true, // this case's "pass" is just "ran end to end"; the live coverage outcome is reported separately
      detail: result.detail,
    });
    writeFileSync(path.join(EVIDENCE_DIR, 'live-attestation.json'), JSON.stringify({ attestation, chainState: Object.fromEntries(chainState), tipHeight, result }, null, 2) + '\n', 'utf8');
    console.log(`\nLIVE attestation result: ${result.verified ? 'VERIFIED' : `REFUSED (${result.reasonCode})`} — ${result.detail}`);
  } else {
    console.log('\nNo live UTXO yet — running the required negative-case battery against locally constructed (but real-crypto) chain state instead.');
  }

  // The required negative cases (PRD Gate 6 pass bar: missing evidence,
  // wrong UTXO, wrong owner/binding, amount mismatch, spent reserve, stale
  // evidence, reserve below liabilities, malformed proof) — constructed
  // locally with the SAME real reserve key and real signing/verification
  // code path as the live case above, same pattern as attacks.ts/gate5.ts.
  function buildStatement(overrides: Partial<ReserveStatement> = {}): ReserveStatement {
    return {
      network: RESERVE_NETWORK_LABEL,
      reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
      outpoints: [{ txid: 'ab'.repeat(32), vout: 0, value_sats: 80_000, script_pubkey_hex: reserveKey.scriptPubKeyHex }],
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      block_height: 500_000,
      ...overrides,
    };
  }
  const honestStatement = buildStatement();
  const honestChainState = new Map<string, ChainStateEntry>([
    ['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
  ]);
  function attest(statement: ReserveStatement, opts: { badStatementSig?: boolean; badBindingSig?: boolean } = {}): ReserveAttestation {
    const statementSignature = opts.badStatementSig ? '00'.repeat(64) : signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
    const digest = reserveStatementDigestHex(statement);
    const bindingSignature = opts.badBindingSig ? '11'.repeat(64) : signReserveBinding(statement.reserve_pubkey, digest, masterPrivHex);
    return { statement, statementSignature, bindingSignature, masterPublicKeyHex: masterPubHex };
  }

  const negativeCases: { label: string; expected: string; attestation: ReserveAttestation; chainState: Map<string, ChainStateEntry>; tip: number; balance: number }[] = [
    { label: 'malformed proof (no outpoints)', expected: 'REFUSE_RESERVE_ATTESTATION_INVALID', attestation: attest(buildStatement({ outpoints: [] })), chainState: honestChainState, tip: 500_000, balance: OUTSTANDING_BALANCE },
    { label: 'wrong owner/binding (reserve key signature forged)', expected: 'REFUSE_RESERVE_ATTESTATION_INVALID', attestation: attest(honestStatement, { badStatementSig: true }), chainState: honestChainState, tip: 500_000, balance: OUTSTANDING_BALANCE },
    { label: 'wrong owner/binding (master key never signed this reserve key)', expected: 'REFUSE_RESERVE_ATTESTATION_INVALID', attestation: attest(honestStatement, { badBindingSig: true }), chainState: honestChainState, tip: 500_000, balance: OUTSTANDING_BALANCE },
    { label: 'stale evidence (attested height far behind tip)', expected: 'REFUSE_RESERVE_ATTESTATION_INVALID', attestation: attest(buildStatement({ block_height: 100 })), chainState: honestChainState, tip: 500_000, balance: OUTSTANDING_BALANCE },
    { label: 'wrong UTXO (declared outpoint not found on chain)', expected: 'REFUSE_RESERVE_STATE_MISMATCH', attestation: attest(honestStatement), chainState: new Map(), tip: 500_000, balance: OUTSTANDING_BALANCE },
    {
      label: 'amount mismatch (on-chain value differs from statement)',
      expected: 'REFUSE_RESERVE_STATE_MISMATCH',
      attestation: attest(honestStatement),
      chainState: new Map([['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 1, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }]]),
      tip: 500_000,
      balance: OUTSTANDING_BALANCE,
    },
    {
      label: 'spent reserve (declared outpoint spent since attestation)',
      expected: 'REFUSE_RESERVE_UTXO_SPENT',
      attestation: attest(honestStatement),
      chainState: new Map([['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: true }]]),
      tip: 500_000,
      balance: OUTSTANDING_BALANCE,
    },
    { label: 'reserve below liabilities', expected: 'REFUSE_RESERVE_SHORT', attestation: attest(honestStatement), chainState: honestChainState, tip: 500_000, balance: 999_999 },
    { label: 'honest case (ACCEPT)', expected: 'ACCEPT', attestation: attest(honestStatement), chainState: honestChainState, tip: 500_000, balance: OUTSTANDING_BALANCE },
  ];

  for (const nc of negativeCases) {
    const result = evaluateReserveAttestation(nc.attestation, nc.chainState, nc.balance, nc.tip);
    const pass = nc.expected === 'ACCEPT' ? result.verified : result.reasonCode === nc.expected;
    cases.push({ label: nc.label, expected_reason_code: nc.expected === 'ACCEPT' ? null : nc.expected, actual_reason_code: result.reasonCode ?? null, verified: result.verified, pass, detail: result.detail });
  }

  console.log('\nCases:');
  for (const c of cases) console.log(`  ${c.label.padEnd(62)} ${c.pass ? 'PASS' : 'FAIL'}  (${c.actual_reason_code ?? 'verified'})`);

  const allCasesPass = cases.every((c) => c.pass);
  console.log(`\nMechanism (signing/verification/negative cases): ${allCasesPass ? 'PASS' : 'FAIL'}`);
  console.log(`Live on-chain leg: ${liveVerified ? 'PASS (real funded UTXO independently verified)' : 'BLOCKED (address not yet funded — see above)'}`);
  console.log(`\nGATE 6: ${allCasesPass ? (liveVerified ? 'PASS' : 'MECHANISM PASS / LIVE BLOCKED') : 'FAIL'}`);

  writeFileSync(
    path.join(EVIDENCE_DIR, 'cases.json'),
    JSON.stringify(
      {
        network: RESERVE_NETWORK_LABEL,
        reserve_address: reserveKey.address,
        reserve_output_pubkey: reserveKey.outputPublicKeyXOnlyHex,
        live_utxo_count: utxos.length,
        live_verified: liveVerified,
        tip_height: tipHeight,
        faucet_attempt: faucet,
        cases,
        mechanism_pass: allCasesPass,
        note: liveVerified
          ? 'live_verified=true: the LIVE case above independently re-queried a real, real-world-broadcast Bitcoin Signet (Mutinynet) UTXO via a public Esplora API and confirmed it covers outstanding liabilities. See docs/reserve-attestation.md.'
          : 'live_verified=false means the reserve address has not yet received real on-chain funds — see the faucet_attempt field and docs/reserve-attestation.md. Every other field (address, signatures, evaluator) is real; only the on-chain funding step is pending an external human action.',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    path.join(EVIDENCE_DIR, 'verify.txt'),
    `SOLVENT Gate 6 evidence\nnetwork: ${RESERVE_NETWORK_LABEL}\nreserve address: ${reserveKey.address}\nlive utxos: ${utxos.length}\nlive verified: ${liveVerified}\nfaucet attempt: ${faucet.ok ? 'OK' : 'FAILED — ' + faucet.detail}\ncases:\n${cases.map((c) => `  ${c.label} -> ${c.pass ? 'PASS' : 'FAIL'}`).join('\n')}\nmechanism: ${allCasesPass ? 'PASS' : 'FAIL'}\n`,
    'utf8',
  );

  process.exit(allCasesPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Gate 6 crashed:', err);
  process.exit(1);
});
