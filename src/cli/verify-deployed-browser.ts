// npm run verify:deployed:browser -- <deployed-url>   (or DEPLOYED_URL=... npm run verify:deployed:browser)
//
// The strongest deployed-site check available: opens a REAL headless
// Chromium browser against the deployed URL, runs /verify's Live check
// exactly as a judge would, and asserts it reaches a real ACCEPT VERIFIED
// — a real relay fetch, a real Esplora reserve query,
// and real BIP-340/DLEQ verification, all running in the actual deployed
// build, not a proxy for it. Distinct from verify-deployed.ts (which only
// confirms the deployed bundle CONTAINS the right evidence, via a text
// match) — this confirms the deployed bundle actually WORKS. It fails
// whenever the live reference case is not ACCEPT right now (stale evidence,
// relay outage): that is a signal to refresh the evidence. For "is the site
// up and working" regardless of evidence health, see verify-ui-browser.ts.
//
// Requires the `playwright` package's Chromium browser to be installed
// (`npx playwright install --with-deps chromium`) — done as a separate CI
// step, not from this script, since it's a one-time environment setup
// concern, not a per-run concern.
import { chromium } from 'playwright';

async function main(): Promise<boolean> {
  const url = process.argv[2] || process.env.DEPLOYED_URL;
  if (!url) {
    console.error('Usage: npm run verify:deployed:browser -- <deployed-url>  (or set DEPLOYED_URL)');
    return false;
  }
  const base = url.endsWith('/') ? url.slice(0, -1) : url;

  console.log('SOLVENT — deployed-site browser verifier\n');
  console.log(`Deployed URL: ${base}\n`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const jsErrors: string[] = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));

    console.log('Opening Verify -> Live check...');
    await page.goto(`${base}/#/verify?mode=live`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.locator('#run-verification-btn').click();

    console.log('Waiting for a real live verification (real relay fetch, real Esplora query)...');
    await page.waitForFunction(() => document.getElementById('decision-badge')?.textContent?.trim().length, { timeout: 45000 });
    await page.waitForTimeout(400);

    const badge = (await page.textContent('#decision-badge'))?.trim() ?? '';
    const headline = (await page.textContent('#decision-headline'))?.trim() ?? '';
    const acceptDisabled = await page.locator('#accept-btn').isDisabled();

    console.log(`\nDecision: "${badge}" — "${headline}"`);
    console.log(`Accept button disabled: ${acceptDisabled}`);
    console.log(`JS errors during run: ${jsErrors.length}`);
    if (jsErrors.length > 0) jsErrors.forEach((e) => console.log(`  - ${e}`));

    const ok = badge.includes('ACCEPT') && headline.includes('ACCEPT VERIFIED') && !acceptDisabled && jsErrors.length === 0;
    console.log('');
    if (ok) {
      console.log('DEPLOYED SITE VERIFIED — the live check reaches a real ACCEPT VERIFIED in an actual browser against the deployed build.');
    } else {
      console.log('DEPLOYED SITE FAILED — the live check did not reach a clean ACCEPT VERIFIED on the deployed build.');
    }
    return ok;
  } finally {
    await browser.close();
  }
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err) => {
    console.error('verify-deployed-browser crashed:', err);
    process.exitCode = 1;
  });
