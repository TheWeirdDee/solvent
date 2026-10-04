// npm run verify:railway -- <public mint URL> <public evidence URL> [--site <url>] [--no-browser] [--allow-http]
//                            [--pay-faucet <token file> | --pay-ldk <dashboard>] [--swap] [--melt]
//
// On a real-Lightning mint the browser flows need real payments: pass a payer
// (verify-real-mint-browser.ts), or pay each invoice the page shows by hand.
//
// --allow-http is for CI, which runs the same Railway image on 127.0.0.1.
//
// Checks a deployed SOLVENT mint + evidence service (docs/DEPLOY-RAILWAY.md)
// from the outside, the way a wallet or a judge reaches it:
//
//   A. the mint answers /v1/info over its public URL
//   B. its NUT-06 identity is the identity the evidence service's delegation names
//   C. the evidence service is healthy and bound to the SAME public mint URL
//      (never a localhost or internal hostname) and labels its Lightning backend
//   D. both answer a cross-origin request from the public app (CORS)
//   E. the latest published epoch's kind 8181 event is on public Nostr relays
//   F. then, in a real browser on the public site (unless --no-browser):
//        honest flow          -> ACCEPT_VERIFIED
//        broken-promise flow  -> REFUSE_ISSUANCE_OMITTED
//      which exercises the receipt endpoint, the closed epoch's public
//      evidence, the live Mutinynet reserve and the Nostr fetch-back.
import { spawnSync } from 'node:child_process';
import { fetchPolEventById } from '../nostr/pol-evidence.js';

/** Options passed through to the browser harness: who pays a real-Lightning invoice, and whether to also swap and pay. */
function harnessOptions(): string[] {
  const out: string[] = [];
  for (const flag of ['--pay-faucet', '--pay-ldk']) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1]) out.push(flag, process.argv[i + 1]!);
  }
  for (const flag of ['--swap', '--melt']) if (process.argv.includes(flag)) out.push(flag);
  return out;
}

const APP_ORIGIN = 'https://solvent-ashen.vercel.app';
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function getJson(url: string): Promise<{ status: number; acao: string | null; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { headers: { origin: APP_ORIGIN }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: res.status, acao: res.headers.get('access-control-allow-origin'), body };
  } catch (err) {
    console.log(`      ${url}: ${(err as Error).message}`);
    return { status: 0, acao: null, body: null };
  }
}

const corsOk = (acao: string | null) => acao === '*' || acao === APP_ORIGIN;

async function main() {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--site', '--expect-identity', '--pay-faucet', '--pay-ldk'].includes(all[i - 1] ?? ''));
  const [mintArg, evidenceArg] = positional;
  const siteIdx = process.argv.indexOf('--site');
  const site = (siteIdx >= 0 ? process.argv[siteIdx + 1] : undefined) ?? `${APP_ORIGIN}/`;
  if (!mintArg || !evidenceArg) throw new Error('usage: verify-railway.ts <public mint URL> <public evidence URL> [--site <url>] [--no-browser]');
  const mint = mintArg.replace(/\/$/, '');
  const evidence = evidenceArg.replace(/\/$/, '');
  if (!process.argv.includes('--allow-http')) {
    check('both URLs are public https URLs', mint.startsWith('https://') && evidence.startsWith('https://'), `${mint} ${evidence}`);
  }

  const info = await getJson(`${mint}/v1/info`);
  const identity = typeof info.body?.pubkey === 'string' ? info.body.pubkey : '';
  // A static site (e.g. a mis-built frontend) answers every path with HTML and
  // HTTP 200 — so the body, not the status, is what proves this is the mint.
  check('A. mint /v1/info answers with the real CDK mint (JSON, not a web page)', info.status === 200 && info.body !== null && /^cdk-mintd\//.test(String(info.body.version ?? '')) && /^0[23][0-9a-f]{64}$/.test(identity), `HTTP ${info.status}, version ${String(info.body?.version ?? 'none — not JSON')}, NUT-06 pubkey ${identity || 'missing'}`);
  const expectIdx = process.argv.indexOf('--expect-identity');
  const expected = expectIdx >= 0 ? process.argv[expectIdx + 1] : undefined;
  if (expected) check('A. the mint identity is unchanged', identity === expected, `expected ${expected}`);

  const root = await getJson(`${evidence}/`);
  check('C. evidence service answers / with its endpoint map', root.status === 200 && root.body?.service === 'SOLVENT evidence service', `HTTP ${root.status}`);
  const health = await getJson(`${evidence}/healthz`);
  check('C. evidence service /healthz answers', health.status === 200 && health.body?.ok === true, `HTTP ${health.status}, open epoch ${String(health.body?.open_epoch)}`);
  const st = await getJson(`${evidence}/v1/solvent/status`);
  const s = st.body ?? {};
  check('C. evidence service is bound to the public mint URL', s.mint_url === mint, `status.mint_url = ${String(s.mint_url)}`);
  check('B. the delegation names the mint\'s NUT-06 identity', !!identity && s.mint_identity_pubkey === identity, `${String(s.mint_identity_pubkey)}`);
  check('C. the Lightning backend is labelled', s.lightning_backend === 'fakewallet' || s.lightning_backend === 'lnd' || s.lightning_backend === 'ldk-node', `lightning_backend = ${String(s.lightning_backend)}`);
  check('C. the broken-promise demo is enabled', s.demo_omission_enabled === true);
  check('D. mint CORS allows the public app', corsOk(info.acao), `access-control-allow-origin: ${info.acao}`);
  check('D. evidence CORS allows the public app', corsOk(st.acao), `access-control-allow-origin: ${st.acao}`);

  const last = s.last_publication as { epoch_index: number; status: string; event_id: string | null } | null | undefined;
  if (!last) {
    console.log('INFO  E. no epoch published yet (epochs close only once they hold issuance; the browser flow below creates one)');
  } else if (last.status === 'published' && last.event_id) {
    const got = await fetchPolEventById(last.event_id);
    check(`E. epoch ${last.epoch_index}'s kind 8181 event is on public relays`, got.events.some((e) => e.id === last.event_id), got.perRelay.map((r) => `${r.relay}:${r.found ? 'found' : '-'}`).join(' '));
  } else {
    check(`E. latest epoch ${last.epoch_index} was published`, false, `status ${last.status}`);
  }

  if (!process.argv.includes('--no-browser')) {
    if (failures > 0) {
      console.log('SKIP  F. browser flows (fix the failures above first)');
    } else {
      console.log(`\nF. real browser on ${site}\n`);
      const r = spawnSync('npx', ['tsx', 'src/cli/verify-real-mint-browser.ts', site, mint, evidence, '--screenshots', 'evidence/railway-shots', ...harnessOptions()], { stdio: 'inherit', shell: process.platform === 'win32' });
      check('F. honest ACCEPT_VERIFIED and broken-promise REFUSE_ISSUANCE_OMITTED in the browser', r.status === 0);
    }
  }

  console.log(failures === 0 ? '\nRAILWAY DEPLOYMENT VERIFIED' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-railway crashed: ${(err as Error).message}`);
  process.exit(1);
});
