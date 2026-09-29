// npm run verify:ui:browser -- <site-url> [--screenshots <dir>]
//
// A real-browser check of the product surface, against a local preview
// (`npm run build && npx vite preview`) or the deployed site. It is the
// deploy workflow's smoke test, so it must pass whether or not the live
// evidence is healthy right now: the live check only has to reach a real
// decision (ACCEPT or a REFUSE naming its reason), never specifically
// ACCEPT — verify-deployed-browser.ts is the strict ACCEPT check.
//
// Checks: every route renders without JS errors; /verify offers exactly
// Live check and Verify evidence; the landing page states the problem and
// the solution; no primary route shows reference-lab/test wording; no
// horizontal overflow at 1440/1024/768/390; the docs sidebar is sticky on
// desktop and replaced by a working menu on mobile; the live check runs
// all nine steps, shows the exact event id and reserve outpoint, and
// updates "Last checked" when re-run; the decision outweighs its headline;
// the lab keeps one mint identity across issuances.
//
// Requires Playwright's Chromium (`npx playwright install --with-deps
// chromium`). Uses process.exitCode, never a forced exit — see
// verify-deployed.ts.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const ROUTES: { hash: string; panel: string }[] = [
  { hash: '#/', panel: 'panel-home' },
  { hash: '#/verify', panel: 'panel-verify' },
  { hash: '#/docs', panel: 'panel-docs' },
  { hash: '#/protocol', panel: 'panel-protocol' },
  { hash: '#/publish', panel: 'panel-publish' },
  { hash: '#/lab', panel: 'panel-lab' },
];
const WIDTHS: { width: number; height: number }[] = [
  { width: 1440, height: 900 },
  { width: 1024, height: 800 },
  { width: 768, height: 1000 },
  { width: 390, height: 844 },
];
// Reference-lab / test wording that must not appear in the primary
// product's rendered text (only inside #/lab). Raw evidence the user opens
// (collapsed JSON, a pasted bundle) is data, not product copy, and is
// excluded because innerText skips closed <details> and textarea values.
const FORBIDDEN_PRIMARY = [/solvent-fixture-mint/i, /test environment/i, /fresh identity every time/i, /\bfixture\b/i, /\btest mint\b/i, /demo scenario/i, /fresh demo identity/i, /create test ecash/i];
const EXPECTED_DOCS_NAV = ['Start here', 'Getting started', 'Protocol & architecture', 'Verification bundle schema', 'Nostr schema', 'Reserve attestation', 'Attack corpus', 'Trust boundaries', 'Draft alignment', 'Verify in 5 minutes', 'Deploy a real mint', 'FAQ'];

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function go(page: Page, base: string, hash: string, panel: string): Promise<void> {
  await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction((id) => document.getElementById(id)?.hidden === false, panel, { timeout: 15000 });
}

/** Real horizontal overflow, measured with the page's overflow-x clipping safety net disabled so it can't hide anything. */
async function overflowOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = 'html, body { overflow-x: visible !important; }';
    document.head.appendChild(style);
    const vw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    if (document.documentElement.scrollWidth > vw + 1) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) continue;
        // Content that clips or scrolls its own overflow isn't page overflow.
        let clipped = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          if (ox !== 'visible') {
            clipped = true;
            break;
          }
        }
        if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} right=${Math.round(r.right)}`);
      }
      if (offenders.length === 0) offenders.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    }
    style.remove();
    return offenders.slice(0, 5);
  });
}

async function main(): Promise<boolean> {
  const url = process.argv[2] || process.env.SITE_URL;
  if (!url || url.startsWith('--')) {
    console.error('Usage: npm run verify:ui:browser -- <site-url> [--screenshots <dir>]');
    return false;
  }
  const shotsIdx = process.argv.indexOf('--screenshots');
  const shotsDir = shotsIdx > 0 ? process.argv[shotsIdx + 1] : undefined;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const base = url.endsWith('/') ? url.slice(0, -1) : url;
  console.log(`SOLVENT — browser UI check against ${base}\n`);

  const browser = await chromium.launch();
  try {
    // ---- routes, wording, overflow at every width ----
    for (const size of WIDTHS) {
      const ctx = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const route of ROUTES) {
        await go(page, base, route.hash, route.panel);
        await page.waitForTimeout(250);
        const offenders = await overflowOffenders(page);
        record(`${size.width}px ${route.hash} has no horizontal overflow`, offenders.length === 0, offenders.join('; '));
        if (size.width === 1440 && route.panel !== 'panel-lab' && route.panel !== 'panel-docs') {
          const text = await page.locator(`#${route.panel}`).innerText();
          const hits = FORBIDDEN_PRIMARY.filter((re) => re.test(text)).map(String);
          record(`${route.hash} shows no reference-lab/test wording`, hits.length === 0, hits.join(', '));
        }
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${size.width}-${route.panel}.png`), fullPage: route.panel !== 'panel-home' });
      }
      record(`${size.width}px: no JS errors across all routes`, errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();

    // ---- landing: problem + solution + built for ----
    await go(page, base, '#/', 'panel-home');
    const problem = await page.locator('#problem').innerText();
    const solution = await page.locator('#solution').innerText();
    const builtFor = await page.locator('#built-for').innerText();
    record('landing states THE PROBLEM', /the problem/i.test(problem) && /a valid cashu token/i.test(problem) && /the gap/i.test(problem));
    record('landing states THE SOLUTION', /the solution/i.test(solution) && /checkable/i.test(solution) && /valid token ≠ solvent mint/i.test(solution));
    record('landing says who it is BUILT FOR', /built for/i.test(builtFor) && /cashu wallets/i.test(builtFor) && /mint operators/i.test(builtFor));

    // ---- /verify: exactly two modes ----
    await go(page, base, '#/verify', 'panel-verify');
    const tabs = await page.locator('#panel-verify .mode-tab').allInnerTexts();
    record('/verify offers exactly Live check + Verify evidence', JSON.stringify(tabs.map((t) => t.trim())) === JSON.stringify(['Live check', 'Verify evidence']), tabs.join(' | '));

    // ---- live check ----
    await go(page, base, '#/verify?mode=live', 'panel-verify');
    const before = (await page.textContent('#live-status-time'))?.trim();
    await page.click('#run-verification-btn');
    await page.waitForFunction(() => (document.getElementById('decision-badge')?.textContent ?? '').trim().length > 0, undefined, { timeout: 60000 });
    const badge = (await page.textContent('#decision-badge'))?.trim() ?? '';
    const headline = (await page.textContent('#decision-headline'))?.trim() ?? '';
    const steps = await page.locator('#progress-steps .progress-step.visible').count();
    const ids = (await page.textContent('#live-checked-ids')) ?? '';
    record('live check reaches a real decision', /^(✓ ACCEPT|✕ REFUSE)$/.test(badge), `${badge} — ${headline}`);
    record('live check runs all nine steps', steps === 9, `${steps} steps shown`);
    record('live check shows the exact Nostr event id and reserve txid:vout', /[0-9a-f]{64}/.test(ids) && /[0-9a-f]{64}:\d+/.test(ids));
    const nostr = (await page.textContent('#live-status-nostr'))?.trim() ?? '';
    const reserve = (await page.textContent('#live-status-reserve'))?.trim() ?? '';
    const first = await page.getAttribute('#live-status-time', 'data-checked-at');
    record('live status reports Nostr + reserve state and a timestamp', before === 'Not yet run' && !!first && /^(LIVE|NOT FOUND|UNAVAILABLE|REJECTED)/.test(nostr) && /^(LIVE|SPENT|UNAVAILABLE|MISMATCH)$/.test(reserve), `Nostr ${nostr}, Reserve ${reserve}`);
    const sizes = await page.evaluate(() => ({
      badge: parseFloat(getComputedStyle(document.getElementById('decision-badge')!).fontSize),
      headline: parseFloat(getComputedStyle(document.getElementById('decision-headline')!).fontSize),
      fact: parseFloat(getComputedStyle(document.querySelector('.decision-fact dd')!).fontSize),
    }));
    record('the decision is the largest text on the result', sizes.badge > sizes.headline && sizes.headline > sizes.fact, JSON.stringify(sizes));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '1440-live-result.png'), fullPage: true });
    await page.waitForTimeout(1100);
    await page.click('#run-again-btn');
    await page.waitForFunction((prev) => document.getElementById('live-status-time')?.dataset.checkedAt !== prev, first, { timeout: 60000 });
    record('re-running the live check updates "Last checked"', true);

    // ---- verify evidence ----
    await go(page, base, '#/verify?mode=evidence', 'panel-verify');
    await page.click('#manual-load-example-btn');
    const loaded = await page.inputValue('#manual-bundle-input');
    const loadedId = (JSON.parse(loaded) as { nostrEvent?: { id?: string } }).nostrEvent?.id ?? '';
    record('"Load live example" loads the published reference case', /^[0-9a-f]{64}$/.test(loadedId) && ids.includes(loadedId), loadedId.slice(0, 16));
    await page.fill('#manual-bundle-input', 'cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb20');
    await page.click('#manual-verify-btn');
    const unsupported = (await page.textContent('#manual-decision-headline'))?.trim() ?? '';
    record('a plain Cashu token is refused as UNSUPPORTED MINT', unsupported === 'UNSUPPORTED MINT.', unsupported);

    // ---- docs: sticky sidebar on desktop ----
    await go(page, base, '#/docs?doc=trust-boundaries', 'panel-docs');
    const navLabels = (await page.locator('#docs-nav .docs-nav-link').allInnerTexts()).map((t) => t.trim());
    record('docs sidebar lists every section', JSON.stringify(navLabels) === JSON.stringify(EXPECTED_DOCS_NAV), navLabels.join(' | '));
    const active = (await page.locator('#docs-nav .docs-nav-link.active').innerText()).trim();
    record('docs sidebar highlights the active section', active === 'Trust boundaries', active);
    const top0 = await page.locator('.docs-sidebar').evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate(() => window.scrollTo(0, 1800));
    await page.waitForTimeout(200);
    const top1 = await page.locator('.docs-sidebar').evaluate((el) => el.getBoundingClientRect().top);
    const topbarBottom = await page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().bottom);
    record('docs sidebar stays in view while reading (sticky)', Math.abs(top1 - 100) <= 2 && top1 >= topbarBottom, `top ${Math.round(top0)} -> ${Math.round(top1)} after scrolling; topbar bottom ${Math.round(topbarBottom)}`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '1440-docs-scrolled.png') });

    // ---- lab: one identity across issuances ----
    await go(page, base, '#/lab', 'panel-lab');
    const identity = async () => (await page.locator('#lab-mint-rows dd').first().innerText()).trim();
    const epochs = async () => Number((await page.locator('#lab-mint-rows dd').nth(3).innerText()).trim());
    const id0 = await identity();
    const e0 = await epochs();
    await page.click('#lab-issue-btn');
    await page.waitForFunction(() => document.getElementById('lab-issuance')?.hidden === false, undefined, { timeout: 45000 });
    await page.click('#lab-check-btn');
    const labHeadline = (await page.textContent('#lab-decision-headline'))?.trim() ?? '';
    await page.click('#lab-issue-btn');
    await page.waitForFunction((n) => Number(document.querySelectorAll('#lab-mint-rows dd')[3]?.textContent) === n, e0 + 2, { timeout: 45000 });
    record('lab: "Check local cryptography" passes on a fresh issuance', labHeadline === 'LOCAL CRYPTOGRAPHY VALID.', labHeadline);
    record('lab: the mint identity persists across issuances, epochs advance', (await identity()) === id0 && (await epochs()) === e0 + 2, `${id0}, epochs ${e0} -> ${await epochs()}`);
    await ctx.close();

    // ---- docs + verify on a phone ----
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const mp = await phone.newPage();
    await go(mp, base, '#/docs', 'panel-docs');
    const selectVisible = await mp.locator('#docs-mobile-select').isVisible();
    const railVisible = await mp.locator('#docs-nav').isVisible();
    const sidebarPos = await mp.locator('.docs-sidebar').evaluate((el) => getComputedStyle(el).position);
    await mp.selectOption('#docs-mobile-select', 'nostr-schema');
    await mp.waitForFunction(() => window.location.hash.includes('nostr-schema') && (document.getElementById('docs-doc-content')?.textContent ?? '').includes('8181'), undefined, { timeout: 10000 });
    record('390px: docs use a menu, not a sticky side rail, and it navigates', selectVisible && !railVisible && sidebarPos === 'static');
    await go(mp, base, '#/verify?mode=live', 'panel-verify');
    await mp.click('#run-verification-btn');
    await mp.waitForFunction(() => (document.getElementById('decision-badge')?.textContent ?? '').trim().length > 0, undefined, { timeout: 60000 });
    const phoneOverflow = await overflowOffenders(mp);
    const phoneSizes = await mp.evaluate(() => ({
      badge: parseFloat(getComputedStyle(document.getElementById('decision-badge')!).fontSize),
      headline: parseFloat(getComputedStyle(document.getElementById('decision-headline')!).fontSize),
    }));
    record('390px: live result is readable with no overflow', phoneOverflow.length === 0 && phoneSizes.badge > phoneSizes.headline, phoneOverflow.join('; ') || JSON.stringify(phoneSizes));
    if (shotsDir) await mp.screenshot({ path: path.join(shotsDir, '390-live-result.png'), fullPage: true });
    await phone.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  return failed.length === 0;
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err) => {
    console.error('verify-ui-browser crashed:', err);
    process.exitCode = 1;
  });
