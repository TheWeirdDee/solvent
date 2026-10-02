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
// Re-check published evidence and Verify evidence; the landing page states
// the problem and the solution; no primary route shows reference-lab/test
// wording; no horizontal overflow at 1440/1024/768/390; the docs sidebar is
// sticky on desktop and replaced by a working menu on mobile; the reference
// check shows one compact progress line and one list of eight checks plus the decision, the exact
// event id and reserve outpoint, and updates "Last checked" when re-run; the
// decision outweighs its headline; the lab keeps one mint identity across
// issuances. Plus (September 30 audit): route titles, landing-only anchors,
// global navigation, the Protocol section index, external-link behaviour,
// an internal-link crawl of every rendered doc, the two hero experiences,
// JSON upload / wrong type / empty / malformed / drag-and-drop as INPUT
// errors, and a phone pass (burger navigation, touch targets, upload,
// overflow) in Chromium AND WebKit at 390px.
//
// Requires Playwright's Chromium (`npx playwright install --with-deps
// chromium`). Uses process.exitCode, never a forced exit — see
// verify-deployed.ts.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, webkit, type BrowserType, type Page } from 'playwright';

const ROUTES: { hash: string; panel: string }[] = [
  { hash: '#/', panel: 'panel-home' },
  { hash: '#/mint', panel: 'panel-mint' },
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
const EXPECTED_DOCS_NAV = ['Start here', 'Getting started', 'Protocol & architecture', 'Verification bundle schema', 'Nostr schema', 'Reserve attestation', 'Evidence index', 'Attack corpus', 'Trust boundaries', 'Reality map', 'Draft alignment', 'Verify in 5 minutes', 'Deploy a real mint', 'Deploy on Railway', 'Demo runbook', 'Project README', 'FAQ'];
const TITLES: Record<string, string> = {
  'panel-home': 'SOLVENT — Auditable Ecash',
  'panel-mint': 'SOLVENT — Live Mint',
  'panel-verify': 'SOLVENT — Verify',
  'panel-docs': 'SOLVENT — Docs',
  'panel-protocol': 'SOLVENT — Protocol',
  'panel-publish': 'SOLVENT — Evidence',
  'panel-lab': 'SOLVENT — Reference Lab',
};
const APP_ROUTES = new Set(['', 'mint', 'verify', 'publish', 'protocol', 'docs', 'lab']);

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

function window_hash_is(hash: string): boolean {
  return hash === '#/protocol';
}

async function tap(page: Page, sel: string): Promise<void> {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }));
  await page.click(sel);
}

/** JSON upload / drop paths: a valid bundle verifies; bad files are INPUT errors, never a verdict about a mint. */
async function uploadChecks(page: Page, base: string, validBundle: string, tag: string): Promise<void> {
  const badge = async () => ((await page.textContent('#manual-decision-badge')) ?? '').trim();
  await go(page, base, '#/verify?mode=evidence', 'panel-verify');
  await page.setInputFiles('#manual-bundle-file', { name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(validBundle) });
  await page.waitForFunction(() => /bundle\.json/.test(document.getElementById('manual-bundle-summary')?.textContent ?? ''), undefined, { timeout: 10000 });
  await tap(page, '#manual-verify-btn');
  await page.waitForFunction(() => !document.getElementById('manual-result')?.hidden && (document.getElementById('manual-decision-badge')?.textContent ?? '').length > 0, undefined, { timeout: 60000 });
  record(`${tag}: a valid uploaded bundle is verified`, /^(✓ ACCEPT|✕ REFUSE|⟳ NOT ACCEPTED — COULD NOT COMPLETE)$/.test(await badge()) && (await badge()) !== 'INPUT ERROR', await badge());

  await page.setInputFiles('#manual-bundle-file', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ "proof": ') });
  await page.waitForFunction(() => /broken\.json/.test(document.getElementById('manual-bundle-summary')?.textContent ?? ''), undefined, { timeout: 10000 });
  await tap(page, '#manual-verify-btn');
  await page.waitForTimeout(300);
  record(`${tag}: a malformed file is an INPUT ERROR`, (await badge()) === 'INPUT ERROR', await badge());

  await page.setInputFiles('#manual-bundle-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForTimeout(300);
  record(`${tag}: a non-JSON file type is an INPUT ERROR`, (await badge()) === 'INPUT ERROR' && /not a \.json file/.test((await page.textContent('#manual-decision-body')) ?? ''), (await page.textContent('#manual-decision-body')) ?? '');

  await page.setInputFiles('#manual-bundle-file', { name: 'empty.json', mimeType: 'application/json', buffer: Buffer.alloc(0) });
  await page.waitForTimeout(300);
  record(`${tag}: an empty file is an INPUT ERROR`, (await badge()) === 'INPUT ERROR' && /is empty/.test((await page.textContent('#manual-decision-body')) ?? ''));

  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
    document.getElementById('bundle-drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, validBundle);
  await page.waitForFunction(() => /dropped\.json/.test(document.getElementById('manual-bundle-summary')?.textContent ?? ''), undefined, { timeout: 10000 }).catch(() => {});
  record(`${tag}: drag-and-drop loads a bundle`, /dropped\.json/.test((await page.textContent('#manual-bundle-summary')) ?? '') && (await page.inputValue('#manual-bundle-input')).length > 100);
}

/** Every route at 390px in one browser engine: overflow, JS errors, burger navigation, touch targets, upload. */
async function phoneSuite(browser: import('playwright').Browser, base: string, name: string, shotsDir: string | undefined): Promise<void> {
  const tag = `${name} 390px`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  for (const route of ROUTES) {
    await go(page, base, route.hash, route.panel);
    await page.waitForTimeout(250);
    const offenders = await overflowOffenders(page);
    record(`${tag} ${route.hash}: no horizontal overflow`, offenders.length === 0, offenders.join('; '));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-390-${route.panel}.png`), fullPage: true });
  }
  record(`${tag}: no JS errors across all routes`, errors.length === 0, errors.slice(0, 3).join(' | '));

  // burger navigation
  await go(page, base, '#/', 'panel-home');
  await tap(page, '#nav-burger');
  await page.waitForFunction(() => document.getElementById('nav-drawer')?.hidden === false);
  const drawerLinks = (await page.locator('#nav-drawer a').allInnerTexts()).map((t) => t.trim());
  await page.locator('#nav-drawer a[href="#/mint"]').first().click();
  await page.waitForFunction(() => document.getElementById('panel-mint')?.hidden === false, undefined, { timeout: 10000 });
  await page.waitForTimeout(600);
  record(`${tag}: the burger menu reaches every section and closes after navigating`, ['Home', 'Live mint', 'Verify', 'Protocol', 'Evidence', 'Docs'].every((l) => drawerLinks.includes(l)) && (await page.locator('#nav-drawer').isHidden()), drawerLinks.join(' | '));

  // touch targets on the primary controls
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#panel-mint:not([hidden]) .btn, .topbar .nav-burger'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ id: b.id || b.className, h: b.getBoundingClientRect().height }))
      .filter((b) => b.h < 40),
  );
  record(`${tag}: primary controls are at least 40px tall`, small.length === 0, JSON.stringify(small));

  // protocol jump menu
  await go(page, base, '#/protocol', 'panel-protocol');
  record(`${tag}: protocol uses a jump menu`, (await page.locator('#protocol-toc-select').isVisible()) && (await page.locator('#protocol-toc-list').isHidden()));

  // upload on the phone
  await go(page, base, '#/verify?mode=evidence', 'panel-verify');
  await tap(page, '#manual-load-example-btn');
  const bundle = await page.inputValue('#manual-bundle-input');
  await uploadChecks(page, base, bundle, tag);
  const offenders = await overflowOffenders(page);
  record(`${tag}: results and errors fit the screen`, offenders.length === 0, offenders.join('; '));
  await ctx.close();
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
        if (size.width === 1440) {
          const title = await page.title();
          record(`${route.hash} sets its page title`, title === TITLES[route.panel], title);
          const anchorsShown = await page.locator('.topbar .nav-landing-anchor').first().isVisible();
          record(`${route.hash}: landing-section anchors ${route.panel === 'panel-home' ? 'shown' : 'hidden'}`, anchorsShown === (route.panel === 'panel-home'));
          const badLinks = await page.evaluate((panel) => {
            const scope = [document.querySelector('.topbar'), document.getElementById(panel), document.querySelector('footer')].filter(Boolean) as Element[];
            return scope.flatMap((root) => Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')))
              .filter((a) => a.target !== '_blank' || !/noopener/.test(a.rel))
              .map((a) => a.href)
              .slice(0, 5);
          }, route.panel);
          record(`${route.hash}: external links open in a new tab with noopener`, badLinks.length === 0, badLinks.join(' '));
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
    record('landing states THE SOLUTION', /the solution/i.test(solution) && /checkable/i.test(solution) && /does not show that this issuance was counted/i.test(solution));
    const heroCtas = (await page.locator('.hero .hero-ctas a').allInnerTexts()).map((t) => t.trim());
    const explain = (await page.textContent('.hero-cta-explain')) ?? '';
    record('landing distinguishes the live mint from the published-evidence re-check', JSON.stringify(heroCtas) === JSON.stringify(['Try the live mint', 'Re-check published evidence']) && /mints fresh ecash/i.test(explain) && /mints nothing/i.test(explain), heroCtas.join(' | '));
    await page.waitForFunction(() => /(LIVE RAILWAY MINT|CAPTURED REFERENCE RUN)/.test(document.getElementById('reserve-source')?.textContent ?? '') && /UTC/.test(document.getElementById('reserve-checked')?.textContent ?? ''), undefined, { timeout: 30000 }).catch(() => {});
    const reserveSrc = (await page.textContent('#reserve-source')) ?? '';
    const nostrSrc = (await page.textContent('#nostr-source')) ?? '';
    record('landing evidence is labelled live or captured, with times', /(LIVE RAILWAY MINT|CAPTURED REFERENCE RUN)/.test(reserveSrc) && /(LIVE RAILWAY MINT|CAPTURED REFERENCE RUN)/.test(nostrSrc) && /UTC/.test((await page.textContent('#reserve-checked')) ?? '') && /UTC/.test(nostrSrc), `${reserveSrc.slice(0, 60)} | ${nostrSrc.slice(0, 60)}`);
    const navText = (await page.locator('.topbar').innerText()).replace(/\s+/g, ' ');
    record('global navigation reaches Live mint, Verify, Protocol, Evidence and Docs', ['Live mint', 'Verify', 'Protocol', 'Evidence', 'Docs'].every((l) => navText.includes(l)), navText);
    record('landing says who it is BUILT FOR', /built for/i.test(builtFor) && /cashu wallets/i.test(builtFor) && /mint operators/i.test(builtFor));

    // ---- /verify: exactly two modes ----
    await go(page, base, '#/verify', 'panel-verify');
    const tabs = await page.locator('#panel-verify .mode-tab').allInnerTexts();
    record('/verify offers exactly Re-check published evidence + Verify evidence', JSON.stringify(tabs.map((t) => t.trim())) === JSON.stringify(['Re-check published evidence', 'Verify evidence']), tabs.join(' | '));

    // ---- live check ----
    await go(page, base, '#/verify?mode=live', 'panel-verify');
    const before = (await page.textContent('#live-status-time'))?.trim();
    await page.click('#run-verification-btn');
    await page.waitForFunction(() => (document.getElementById('decision-badge')?.textContent ?? '').trim().length > 0, undefined, { timeout: 60000 });
    const badge = (await page.textContent('#decision-badge'))?.trim() ?? '';
    const headline = (await page.textContent('#decision-headline'))?.trim() ?? '';
    const steps = await page.locator('#decision-chain .chain-step').count();
    const progressRows = await page.locator('#progress-steps .progress-step').count();
    const ids = (await page.textContent('#live-checked-ids')) ?? '';
    record('live check reaches a real decision', /^(✓ ACCEPT|✕ REFUSE|⟳ NOT ACCEPTED — COULD NOT COMPLETE)$/.test(badge), `${badge} — ${headline}`);
    record('live check: one compact progress line, one list (8 checks + decision)', steps === 9 && progressRows === 1 && (await page.locator('#progress-panel').isHidden()), `${steps} checks in the result, ${progressRows} progress row(s)`);
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
    const unsupportedBadge = (await page.textContent('#manual-decision-badge'))?.trim() ?? '';
    record('a plain Cashu token is an INPUT ERROR (unsupported mint), not a verdict', unsupportedBadge === 'INPUT ERROR' && /unsupported mint/i.test(unsupported), `${unsupportedBadge} — ${unsupported}`);

    // ---- uploads: valid, malformed, wrong type, empty, drag-and-drop ----
    await uploadChecks(page, base, loaded, '1440px');

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

    // ---- internal-link crawl of every rendered doc ----
    const docIds = await page.$$eval('#docs-mobile-select option', (os) => os.map((o) => (o as HTMLOptionElement).value));
    const broken: string[] = [];
    let crawled = 0;
    for (const id of docIds) {
      await go(page, base, `#/docs?doc=${id}`, 'panel-docs');
      const links = await page.$$eval('#docs-doc-content a[href], #docs-faq-content a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
      for (const href of links) {
        crawled++;
        if (href.startsWith('#/')) {
          const route = href.slice(2).split(/[?#]/)[0]!;
          const doc = /[?&]doc=([\w-]+)/.exec(href)?.[1];
          if (!APP_ROUTES.has(route) || (doc && !docIds.includes(doc))) broken.push(`${id}: ${href}`);
        } else if (href.startsWith('#')) {
          // in-page anchor
        } else if (!/^(https?:|mailto:)/.test(href)) {
          broken.push(`${id}: ${href} (unresolved relative link)`);
        }
      }
    }
    record('every in-app link in every rendered doc resolves', broken.length === 0, `${crawled} links; ${broken.slice(0, 5).join(', ')}`);

    // ---- protocol: section index lands below the sticky header; marker, deep links, back/forward ----
    await go(page, base, '#/protocol', 'panel-protocol');
    const tocItems = await page.locator('#protocol-toc-list a').count();
    const tocVisible = await page.locator('#protocol-toc-list').isVisible();
    const headerBottom = () => page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().bottom);
    const topOf = (id: string) => page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top);
    const activeToc = () => page.locator('#protocol-toc-list a.active').getAttribute('data-target');
    const badLandings: string[] = [];
    for (const id of await page.$$eval('#protocol-toc-list a[data-target]', (as) => as.map((a) => (a as HTMLAnchorElement).dataset.target!))) {
      await page.locator(`#protocol-toc-list a[data-target="${id}"]`).click();
      await page.waitForTimeout(700);
      const top = await topOf(id);
      const hb = await headerBottom();
      const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
      // A section near the page end cannot scroll to the top; it must still be below the header and marked.
      if (top < hb || (top > hb + 60 && !atBottom) || (await activeToc()) !== id) badLandings.push(`${id}: top ${Math.round(top)} vs header ${Math.round(hb)}, active ${await activeToc()}`);
    }
    record('protocol: every TOC entry lands its heading just below the sticky header, with the matching marker', tocVisible && tocItems >= 12 && badLandings.length === 0, badLandings.slice(0, 3).join('; ') || `${tocItems} entries`);
    record('protocol: choosing a section records #/protocol?section=…', /^#\/protocol\?section=p-[\w-]+$/.test(await page.evaluate(() => window.location.hash)));
    await page.locator('#protocol-toc-list a[data-target="p-reserve"]').click();
    await page.waitForTimeout(500);
    await page.locator('#protocol-toc-list a[data-target="p-omission"]').click();
    await page.waitForTimeout(500);
    await page.goBack();
    await page.waitForTimeout(800);
    record('protocol: back returns to the previous section', (await page.evaluate(() => window.location.hash)) === '#/protocol?section=p-reserve' && (await topOf('p-reserve')) >= (await headerBottom()) - 1 && (await topOf('p-reserve')) < (await headerBottom()) + 60);
    await page.goto(`${base}/#/protocol?section=p-nostr`);
    await page.waitForFunction(() => document.getElementById('panel-protocol')?.hidden === false);
    await page.waitForTimeout(800);
    record('protocol: a direct link to a section loads it below the header', (await topOf('p-nostr')) >= (await headerBottom()) - 1 && (await topOf('p-nostr')) < (await headerBottom()) + 60 && (await activeToc()) === 'p-nostr', `top ${Math.round(await topOf('p-nostr'))}, header ${Math.round(await headerBottom())}`);

    // ---- landing anchors: direct load, refresh, back/forward ----
    await page.goto(`${base}/#problem`);
    await page.waitForTimeout(900);
    const landingOk = async () =>
      (await page.locator('#panel-home').isVisible()) &&
      (await page.title()) === 'SOLVENT — Auditable Ecash' &&
      (await page.locator('.topbar .nav-landing-anchor').first().isVisible()) &&
      Math.abs((await page.locator('#problem').evaluate((el) => el.getBoundingClientRect().top)) - (await headerBottom())) < 40;
    record('landing anchor #problem loaded directly: landing page, its title, its anchors, the section in view', await landingOk(), `title ${await page.title()}`);
    await page.reload();
    await page.waitForTimeout(900);
    record('landing anchor survives a refresh', await landingOk());
    await page.goto(`${base}/#/mint`);
    await page.waitForFunction(() => document.getElementById('panel-mint')?.hidden === false);
    await page.goBack();
    await page.waitForTimeout(900);
    record('back to a landing anchor from another route renders the landing section', await landingOk(), await page.evaluate(() => window.location.hash));

    // ---- Evidence page reachable from the docs, with refresh and back/forward ----
    await go(page, base, '#/docs?doc=readme', 'panel-docs');
    const evLink = page.locator('#docs-doc-content a[href="#/publish"]').first();
    record('the README rendered in-app links the Evidence page in-app (#/publish)', (await evLink.count()) > 0);
    await evLink.click();
    await page.waitForFunction(() => document.getElementById('panel-publish')?.hidden === false, undefined, { timeout: 10000 });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('panel-publish')?.hidden === false, undefined, { timeout: 10000 });
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('panel-docs')?.hidden === false, undefined, { timeout: 10000 });
    await page.goForward();
    await page.waitForFunction(() => document.getElementById('panel-publish')?.hidden === false, undefined, { timeout: 10000 });
    record('Evidence link: lands on #/publish, survives refresh, back/forward work', (await page.evaluate(() => window.location.hash)) === '#/publish');
    await go(page, base, '#/docs?doc=readme', 'panel-docs');
    await page.locator('#docs-doc-content a[href="#evidence"]').first().click();
    await page.waitForTimeout(700);
    record('an in-page doc anchor (#evidence) scrolls within the doc without leaving the route', (await page.evaluate(() => window.location.hash)) === '#/docs?doc=readme' && (await page.locator('#panel-docs').isVisible()));

    // ---- hero: the reference example is labelled as such ----
    await go(page, base, '#/', 'panel-home');
    await page.waitForFunction(() => /decided .* UTC/.test(document.getElementById('hero-caption')?.textContent ?? ''), undefined, { timeout: 30000 }).catch(() => {});
    record('hero terminal is labelled a reference example with the time it was decided', /REFERENCE EXAMPLE/.test((await page.textContent('.terminal-scope')) ?? '') && /decided .* UTC/.test((await page.textContent('#hero-caption')) ?? ''));

    // ---- a verification result is bound to its exact input (typing, upload, drop) ----
    await go(page, base, '#/verify?mode=evidence', 'panel-verify');
    record('Verify evidence says drag-and-drop is supported', /drop a \.json file/i.test((await page.textContent('#bundle-drop')) ?? ''));
    const verifyExample = async () => {
      await go(page, base, '#/verify?mode=evidence', 'panel-verify');
      await page.click('#manual-load-example-btn');
      await page.click('#manual-verify-btn');
      await page.waitForFunction(() => !document.getElementById('manual-result')?.hidden && (document.getElementById('manual-decision-badge')?.textContent ?? '').length > 0, undefined, { timeout: 60000 });
      return page.inputValue('#manual-bundle-input');
    };
    const actionable = async () => !(await page.locator('#manual-result').isHidden()) && !(await page.isDisabled('#manual-accept-btn')) && (await page.getAttribute('#manual-result', 'data-stale')) !== 'true';
    const exampleText = await verifyExample();
    const firstBadge = ((await page.textContent('#manual-decision-badge')) ?? '').trim();
    await page.locator('#manual-bundle-input').press('End');
    await page.locator('#manual-bundle-input').type(' x');
    record('after a verification, typing into the evidence makes the old result stale and Accept unusable', !(await actionable()) && (await page.getAttribute('#manual-result', 'data-stale')) === 'true' && (await page.locator('#manual-stale-note').isVisible()), `first result ${firstBadge}`);
    await verifyExample();
    await page.setInputFiles('#manual-bundle-file', { name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(exampleText.replace('"keysetId": "', '"keysetId": "ff')) });
    await page.waitForTimeout(400);
    record('after a verification, uploading a different file invalidates the old result', !(await actionable()));
    await verifyExample();
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'dropped-other.json', { type: 'application/json' }));
      document.getElementById('bundle-drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, exampleText.replace('"keysetId": "', '"keysetId": "ee'));
    await page.waitForTimeout(400);
    record('after a verification, dropping a different file invalidates the old result', !(await actionable()));

    // ---- live mint: judge path + two-experience copy ----
    await go(page, base, '#/mint', 'panel-mint');
    const judge = (await page.locator('.judge-path').innerText()).replace(/\s+/g, ' ');
    record('live mint shows the judge path in order', /1\. Mint an honest issuance.*ACCEPT_VERIFIED.*2\. Break the promise.*REFUSE_ISSUANCE_OMITTED.*3\. Inspect the evidence.*4\. Real-Lightning proof/.test(judge), judge.slice(0, 120));

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

  // ---- phone pass, Chromium and WebKit ----
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][]) {
    let b;
    try {
      b = await type.launch();
    } catch (err) {
      record(`${name} 390px: browser available`, false, (err as Error).message.split('\n')[0]);
      continue;
    }
    try {
      await phoneSuite(b, base, name, shotsDir);
    } finally {
      await b.close();
    }
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
