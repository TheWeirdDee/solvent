// npm run verify:real-mint:browser -- <site-url> <mint-url> <evidence-url> [--screenshots <dir>]
//
// Drives the primary real-backend flow (#/mint) in a real Chromium, exactly
// as a judge would: no console, no JSON pasting. Requires a running patched
// cdk-mintd and SOLVENT sidecar (with SOLVENT_DEMO_ALLOW_OMISSION=1 for the
// second flow). Everything behind the page is real: the mint, its epochs,
// public Nostr relays and the Mutinynet reserve.
//
//   1. honest:          Get ecash and verify it          -> ACCEPT VERIFIED
//   2. broken promise:  ... and make the mint break it   -> REFUSE_ISSUANCE_OMITTED
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function runFlow(page: Page, button: string, timeoutMs: number): Promise<{ badge: string; headline: string; steps: string[]; code: string }> {
  await page.click(button);
  await page.waitForSelector('#mint-result:not([hidden])', { timeout: timeoutMs });
  const badge = (await page.textContent('#mint-decision-badge'))?.trim() ?? '';
  const headline = (await page.textContent('#mint-decision-headline'))?.trim() ?? '';
  const steps = await page.$$eval('#mint-steps li', (els) => els.map((e) => e.textContent ?? ''));
  const code = steps.map((s) => s.match(/Verification finished: (\w+)/)?.[1]).find(Boolean) ?? '';
  return { badge, headline, steps, code };
}

async function main() {
  const [site, mint, evidence] = process.argv.slice(2);
  const shotIdx = process.argv.indexOf('--screenshots');
  const shots = shotIdx >= 0 ? process.argv[shotIdx + 1] : undefined;
  if (!site || !mint || !evidence) throw new Error('usage: verify-real-mint-browser.ts <site-url> <mint-url> <evidence-url> [--screenshots <dir>]');
  if (shots) mkdirSync(shots, { recursive: true });
  const base = site.endsWith('/') ? site : `${site}/`;
  const url = `${base}#/mint?mint=${encodeURIComponent(mint)}&evidence=${encodeURIComponent(evidence)}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(url);
    await page.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
    const reality = (await page.textContent('#mint-reality')) ?? '';
    check('the page shows the mint, its NUT-06 identity and an honest Lightning label', /Real CDK mint/.test(reality) && /NUT-06/.test(reality) && /(Real Lightning|Demo fakewallet)/.test(reality));
    const interval = 240_000;

    const honest = await runFlow(page, '#mint-honest-btn', interval);
    if (shots) await page.screenshot({ path: path.join(shots, 'real-mint-honest-1440.png'), fullPage: true });
    check('honest flow: the receipt promise is shown with its epoch', honest.steps.some((s) => /signed a promise to count this issuance in accounting epoch \d+/.test(s)));
    check('honest flow reaches ACCEPT VERIFIED', honest.badge.includes('ACCEPT') && honest.code === 'ACCEPT_VERIFIED', `${honest.badge} ${honest.headline} (${honest.code})`);

    const omitVisible = await page.isVisible('#mint-omit-btn');
    check('the broken-promise demo is offered by this mint', omitVisible);
    if (omitVisible) {
      await page.click('#mint-again-btn');
      const broken = await runFlow(page, '#mint-omit-btn', interval);
      if (shots) await page.screenshot({ path: path.join(shots, 'real-mint-broken-promise-1440.png'), fullPage: true });
      check('broken-promise flow: the omission was scheduled on the real closer', broken.steps.some((s) => /will leave this issuance out of epoch/.test(s)));
      check('broken-promise flow reaches REFUSE_ISSUANCE_OMITTED', broken.badge.includes('REFUSE') && broken.code === 'REFUSE_ISSUANCE_OMITTED', `${broken.badge} ${broken.headline} (${broken.code})`);
    }

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(url);
    await mobile.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('390px: the real-mint page has no horizontal overflow', overflow <= 0, `${overflow}px`);
    const buttonOverflow = await mobile.evaluate(() =>
      [...document.querySelectorAll('.mint-actions .btn')].filter((b) => (b as HTMLElement).offsetParent !== null).map((b) => Math.max(b.scrollWidth - b.clientWidth, b.scrollHeight - b.clientHeight)),
    );
    check('390px: action button labels fit inside their buttons', buttonOverflow.every((o) => o <= 0), JSON.stringify(buttonOverflow));
    if (shots) await mobile.screenshot({ path: path.join(shots, 'real-mint-390.png'), fullPage: true });
  } finally {
    await browser.close();
  }
  console.log('');
  console.log(failures === 0 ? 'REAL MINT BROWSER FLOW VERIFIED' : `REAL MINT BROWSER FLOW FAILED — ${failures} check(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('verify-real-mint-browser crashed:', err);
  process.exitCode = 1;
});
