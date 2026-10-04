// npm run verify:public-app -- [<site-url>] [--mint <url>] [--evidence <url>]
//                                [--pay-faucet <token file> | --pay-ldk <dashboard>] [--swap] [--melt]
//
// On a real-Lightning mint every issuance needs a real payment: pass a payer
// (verify-real-mint-browser.ts), or pay each invoice the page shows by hand.
//
// The judge path on the public app, in a real Chromium, with nothing pasted:
//
//   1. / shows the full landing page first
//   2. the primary CTA ("Mint & verify ecash") reaches #/mint
//   3. #/mint connects to the production mint + evidence service by itself
//   6. a browser refresh on #/mint reconnects
//   7. at 390px the landing and #/mint have no horizontal overflow
//   4/5. honest -> ACCEPT_VERIFIED, broken promise -> REFUSE_ISSUANCE_OMITTED,
//        through the default connection AND the explicit ?mint=&evidence= route
//
// Defaults: https://solvent-ashen.vercel.app/ and the Railway backend in .env.production.
import { spawnSync } from 'node:child_process';
import { chromium, type Page } from 'playwright';

const DEFAULT_SITE = 'https://solvent-ashen.vercel.app/';
const DEFAULT_MINT = 'https://solvent-production-2029.up.railway.app';
const DEFAULT_EVIDENCE = 'https://solvent-production-9c92.up.railway.app';

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

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function connectedMint(page: Page): Promise<string> {
  await page.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 45_000 });
  return (await page.textContent('#mint-reality')) ?? '';
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function main() {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--mint', '--evidence', '--pay-faucet', '--pay-ldk'].includes(all[i - 1] ?? ''));
  const site = (positional[0] ?? DEFAULT_SITE).replace(/\/?$/, '/');
  const mint = opt('--mint') ?? DEFAULT_MINT;
  const evidence = opt('--evidence') ?? DEFAULT_EVIDENCE;
  const host = (u: string) => new URL(u).host;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(site);
    await page.waitForSelector('#panel-home:not([hidden])', { timeout: 30_000 });
    const hero = (await page.textContent('.hero h1')) ?? '';
    const sections = await page.$$eval('#panel-home section[id]', (els) => els.map((e) => e.id));
    check('1. / shows the full landing page first', /MADE A PROMISE/i.test(hero) && sections.length >= 4, `${sections.length} sections: ${sections.join(', ')}`);

    const cta = page.locator('.hero-ctas a').first();
    const ctaText = ((await cta.textContent()) ?? '').trim();
    await cta.click();
    await page.waitForSelector('#panel-mint:not([hidden])', { timeout: 15_000 });
    check('2. the primary CTA "Mint & verify ecash" reaches #/mint', ctaText === 'Mint & verify ecash' && page.url().includes('#/mint'), `"${ctaText}" -> ${page.url()}`);

    const reality = await connectedMint(page);
    const unconfigured = await page.isVisible('#mint-unconfigured');
    check('3. #/mint connects to the production backend by itself', !unconfigured && reality.includes(host(mint)) && /NUT-06/.test(reality), `mint ${host(mint)} shown: ${reality.includes(host(mint))}`);
    check('3. the Lightning mode is labelled honestly', /(Demo fakewallet|Real Lightning)/.test(reality));

    await page.reload();
    const again = await connectedMint(page);
    check('6. a browser refresh on #/mint reconnects', again.includes(host(mint)) && (await page.isVisible('#panel-mint')));

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(site);
    await mobile.waitForSelector('#panel-home:not([hidden])');
    check('7. 390px: the landing page has no horizontal overflow', (await overflow(mobile)) <= 0, `${await overflow(mobile)}px`);
    await mobile.goto(`${site}#/mint`);
    await connectedMint(mobile);
    check('7. 390px: #/mint is connected with no horizontal overflow', (await overflow(mobile)) <= 0, `${await overflow(mobile)}px`);
  } finally {
    await browser.close();
  }

  const flows = (label: string, args: string[]) => {
    console.log(`\n4/5. ${label}\n`);
    const r = spawnSync('npx', ['tsx', 'src/cli/verify-real-mint-browser.ts', site, ...args, ...harnessOptions()], { stdio: 'inherit', shell: process.platform === 'win32' });
    check(`4/5. ${label}: honest ACCEPT_VERIFIED, broken promise REFUSE_ISSUANCE_OMITTED`, r.status === 0);
  };
  flows('default connection (plain #/mint)', ['-', '-']);
  flows('direct route (#/mint?mint=&evidence=)', [mint, evidence]);

  console.log(failures === 0 ? '\nPUBLIC APP VERIFIED' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-public-app crashed: ${(err as Error).message}`);
  process.exit(1);
});
