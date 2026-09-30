// Prepares the Railway service variables for a SOLVENT deployment
// (docs/DEPLOY-RAILWAY.md) in deploy/secrets/railway.env — git-ignored —
// ready to paste into Railway's Variables → Raw Editor.
//
//   npm run railway:secrets -- [--mint-url https://<mint domain>]
//
// Idempotent: values already in the file are kept, so re-running never
// rotates the mint seed (the NUT-06 identity), the manifest key or the
// reserve key. Missing values are generated locally. The reserve outpoint is
// filled in from Mutinynet once the reserve address has a confirmed UTXO.
// Prints variable NAMES and the (public) reserve address only — never a
// secret value.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hex } from '@scure/base';
import { utils as btcUtils } from '@scure/btc-signer';
import { generateSignetReserveKey, type SignetReserveKey } from '../reserve/taproot.js';
import { fetchAddressUtxos } from '../reserve/esplora.js';

const SECRETS_DIR = path.join('deploy', 'secrets');
const ENV_FILE = path.join(SECRETS_DIR, 'railway.env');
const RESERVE_KEY_FILE = path.join(SECRETS_DIR, 'reserve-key.json');

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2] ?? '';
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out.set(m[1]!, v);
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  mkdirSync(SECRETS_DIR, { recursive: true });
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : new Map<string, string>();
  const created: string[] = [];
  const setIfMissing = (k: string, make: () => string) => {
    if (!env.get(k)) {
      env.set(k, make());
      created.push(k);
    }
  };

  setIfMissing('CDK_MINTD_MNEMONIC', () => generateMnemonic(wordlist));
  setIfMissing('SOLVENT_MANIFEST_PRIVKEY', () => hex.encode(btcUtils.randomPrivateKeyBytes()));
  setIfMissing('SOLVENT_NOSTR_SECRET_HEX', () => hex.encode(btcUtils.randomPrivateKeyBytes()));

  // The reserve-control key: never the published test key in evidence/reserves/.
  let reserveKey: SignetReserveKey;
  if (env.get('SOLVENT_RESERVE_KEY_JSON')) {
    reserveKey = JSON.parse(env.get('SOLVENT_RESERVE_KEY_JSON')!) as SignetReserveKey;
  } else if (existsSync(RESERVE_KEY_FILE)) {
    reserveKey = JSON.parse(readFileSync(RESERVE_KEY_FILE, 'utf8')) as SignetReserveKey;
    env.set('SOLVENT_RESERVE_KEY_JSON', JSON.stringify(reserveKey));
  } else {
    reserveKey = generateSignetReserveKey();
    env.set('SOLVENT_RESERVE_KEY_JSON', JSON.stringify(reserveKey));
    created.push('SOLVENT_RESERVE_KEY_JSON');
  }
  const published = JSON.parse(readFileSync(path.join('evidence', 'reserves', 'reserve-key.json'), 'utf8')) as SignetReserveKey;
  if (reserveKey.outputPublicKeyXOnlyHex === published.outputPublicKeyXOnlyHex) {
    throw new Error('the reserve key is the PUBLISHED test key; a public deployment needs its own (delete it from deploy/secrets and re-run)');
  }
  if (!existsSync(RESERVE_KEY_FILE)) writeFileSync(RESERVE_KEY_FILE, JSON.stringify(reserveKey, null, 2) + '\n', { mode: 0o600 });

  let outpointNote = '';
  if (!env.get('SOLVENT_RESERVE_OUTPOINT')) {
    try {
      const utxos = (await fetchAddressUtxos(reserveKey.address)).filter((u) => u.status.confirmed).sort((a, b) => b.value - a.value);
      const best = utxos[0];
      if (best) {
        env.set('SOLVENT_RESERVE_OUTPOINT', `${best.txid}:${best.vout}`);
        created.push('SOLVENT_RESERVE_OUTPOINT');
        outpointNote = `reserve outpoint found: ${best.txid}:${best.vout} (${best.value} sats)`;
      } else {
        outpointNote = 'reserve address has no confirmed UTXO yet: fund it on Mutinynet, wait one block (~30s), re-run';
      }
    } catch (err) {
      outpointNote = `could not query Mutinynet (${(err as Error).message}); re-run later`;
    }
  }

  const mintUrl = arg('--mint-url');
  if (mintUrl) {
    if (!/^https:\/\/[^/]+\/?$/.test(mintUrl)) throw new Error('--mint-url must be https://<host> (the Railway domain for port 8085)');
    env.set('SOLVENT_PUBLIC_MINT_URL', mintUrl.replace(/\/$/, ''));
  }

  // Fixed public configuration (docs/DEPLOY-RAILWAY.md).
  env.set('PORT', '8085');
  if (!env.has('SOLVENT_DEMO_ALLOW_OMISSION')) env.set('SOLVENT_DEMO_ALLOW_OMISSION', '1');
  if (!env.has('SOLVENT_EPOCH_INTERVAL_SECONDS')) env.set('SOLVENT_EPOCH_INTERVAL_SECONDS', '30');
  if (!env.has('SOLVENT_EVIDENCE_VALIDITY_SECONDS')) env.set('SOLVENT_EVIDENCE_VALIDITY_SECONDS', '3600');
  if (!env.has('SOLVENT_PUBLIC_MINT_URL')) env.set('SOLVENT_PUBLIC_MINT_URL', '');

  const order = [
    'SOLVENT_PUBLIC_MINT_URL', 'PORT', 'CDK_MINTD_MNEMONIC', 'SOLVENT_MANIFEST_PRIVKEY', 'SOLVENT_RESERVE_KEY_JSON',
    'SOLVENT_RESERVE_OUTPOINT', 'SOLVENT_NOSTR_SECRET_HEX', 'SOLVENT_DEMO_ALLOW_OMISSION',
    'SOLVENT_EPOCH_INTERVAL_SECONDS', 'SOLVENT_EVIDENCE_VALIDITY_SECONDS',
  ];
  const keys = [...order.filter((k) => env.has(k)), ...[...env.keys()].filter((k) => !order.includes(k))];
  // Unquoted on purpose: compact JSON and space-separated words need no quoting
  // in Railway's Raw Editor, and quotes would risk ending up inside the value.
  const body = [
    '# SOLVENT Railway variables — SECRET. Paste into Railway: service → Variables → Raw Editor.',
    '# Never commit this file (deploy/secrets/ is git-ignored). Keep a backup: the mint seed IS the mint.',
    ...keys.map((k) => `${k}=${env.get(k)!}`),
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, body, { mode: 0o600 });

  console.log(`Wrote ${ENV_FILE} (${keys.length} variables: ${keys.join(', ')})`);
  if (created.length) console.log(`Generated now: ${created.join(', ')}`);
  console.log(`Reserve address (Mutinynet, public): ${reserveKey.address}`);
  if (outpointNote) console.log(outpointNote);
  const missing = ['SOLVENT_PUBLIC_MINT_URL', 'SOLVENT_RESERVE_OUTPOINT'].filter((k) => !env.get(k));
  console.log(missing.length ? `Still to fill: ${missing.join(', ')}` : 'All variables present.');
}

main().catch((err) => {
  console.error(`railway-secrets: ${(err as Error).message}`);
  process.exit(1);
});
