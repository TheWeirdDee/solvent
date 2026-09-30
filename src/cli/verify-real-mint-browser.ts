// npm run verify:real-mint:browser -- <site-url> <mint-url> <evidence-url> [--screenshots <dir>] [--browser chromium|webkit] [--width 1440|390] [--skip-transient]
//   (<mint-url> and <evidence-url> both `-`: the site's built-in backend)
//
// Drives the real-backend flow (#/mint) in a real browser, exactly as a judge
// would: no console, no JSON pasting. Everything behind the page is real: the
// patched CDK mint, its epochs, public Nostr relays and the Mutinynet reserve.
//
//   A. honest issuance        -> ACCEPT_VERIFIED, accept function called once
//   B. reload + retry         -> the run is restored; retry does NOT accept again
//   C. broken promise         -> REFUSE_ISSUANCE_OMITTED with every other check valid, 0 accept calls
//   D. transient relay outage -> "could not complete" + Retry verification; after
//      the outage ends, retry of the SAME issuance -> ACCEPT_VERIFIED (no new mint)
//
// D blocks the browser's relay WebSockets and the HTTPS relay fetch inside
// this test browser only (Playwright routing) — nothing on the servers changes.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, webkit, type Page } from 'playwright';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Outcome {
  code: string;
  cls: string;
  badge: string;
  facts: Record<string, string>;
  enforcement: Record<string, string>;
  steps: string[];
}

async function outcome(page: Page): Promise<Outcome> {
  const code = (await page.getAttribute('#mint-result', 'data-reason-code')) ?? '';
  const cls = (await page.getAttribute('#mint-result', 'data-result-class')) ?? '';
  const badge = ((await page.textContent('#mint-decision-badge')) ?? '').trim();
  const pairs = async (sel: string) =>
    Object.fromEntries(await page.$$eval(`${sel} dt`, (dts) => dts.map((dt) => [dt.textContent?.trim() ?? '', (dt.nextElementSibling?.textContent ?? '').trim()])));
  return { code, cls, badge, facts: await pairs('#mint-decision-facts'), enforcement: await pairs('#mint-enforcement'), steps: await page.$$eval('#mint-steps li', (els) => els.map((e) => e.textContent ?? '')) };
}

/** Click after an instant scroll: the site's smooth scrolling can otherwise move a target under the click point (seen in WebKit). */
async function tap(page: Page, sel: string): Promise<void> {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }));
  await page.click(sel);
}

async function waitResult(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => !document.getElementById('mint-result')?.hidden || document.getElementById('mint-op')?.dataset.state === 'failed', undefined, { timeout: timeoutMs });
}

async function inViewport(page: Page, sel: string): Promise<boolean> {
  return page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return !(el as HTMLElement).hidden && r.top < window.innerHeight && r.bottom > 0;
  });
}

async function main() {
  const [site, mint, evidence] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--screenshots', '--browser', '--width'].includes(all[i - 1] ?? ''));
  const shots = opt('--screenshots');
  const which = opt('--browser') ?? 'chromium';
  const width = Number(opt('--width') ?? '1440');
  if (!site || !mint || !evidence) throw new Error('usage: verify-real-mint-browser.ts <site-url> <mint-url> <evidence-url> [--screenshots <dir>] [--browser chromium|webkit] [--width N]');
  if (shots) mkdirSync(shots, { recursive: true });
  const base = site.endsWith('/') ? site : `${site}/`;
  const url = mint === '-' && evidence === '-' ? `${base}#/mint` : `${base}#/mint?mint=${encodeURIComponent(mint)}&evidence=${encodeURIComponent(evidence)}`;
  const tag = `${which}-${width}`;
  const shot = async (page: Page, name: string) => shots && page.screenshot({ path: path.join(shots, `${tag}-${name}.png`), fullPage: true });

  const browser = await (which === 'webkit' ? webkit : chromium).launch();
  try {
    const ctx = await browser.newContext({ viewport: { width, height: width <= 430 ? 844 : 1000 }, acceptDownloads: true, ...(width <= 430 ? { hasTouch: true, isMobile: which !== 'webkit' ? true : undefined } : {}) });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
    const reality = (await page.textContent('#mint-reality')) ?? '';
    check(`[${tag}] the page shows the mint, its NUT-06 identity and an honest Lightning label`, /Real CDK mint/.test(reality) && /NUT-06/.test(reality) && /(Real Lightning|Demo fakewallet)/.test(reality));
    check(`[${tag}] live status is labelled LIVE with a real time`, /LIVE RAILWAY MINT/.test((await page.textContent('#mint-live-status')) ?? '') && /UTC/.test((await page.textContent('#mint-live-status')) ?? ''));
    const interval = 300_000;

    // ---- A. honest
    await tap(page, '#mint-honest-btn');
    await page.waitForTimeout(800);
    check(`[${tag}] A. progress appears in the viewport immediately`, await inViewport(page, '#mint-op'));
    check(`[${tag}] A. disabled buttons say why`, ((await page.textContent('#mint-busy-reason')) ?? '').length > 0 && (await page.isDisabled('#mint-omit-btn')));
    const details = new Set<string>();
    const sampler = setInterval(() => void page.textContent('#mint-op-detail').then((t) => t && details.add(t)).catch(() => {}), 700);
    await waitResult(page, interval);
    clearInterval(sampler);
    const a = await outcome(page);
    await shot(page, 'honest');
    check(`[${tag}] A. progress named the epoch wait or publishing stage`, [...details].some((d) => /Waiting for epoch \d+ to close|Publishing epoch|Fetching epoch|Observing the Mutinynet reserve|closed; waiting for its public evidence/.test(d)), [...details].slice(0, 3).join(' | '));
    check(`[${tag}] A. honest -> ACCEPT_VERIFIED`, a.code === 'ACCEPT_VERIFIED', `${a.badge} (${a.code})`);
    check(`[${tag}] A. Nostr retrieval passed`, /RETRIEVED/.test(a.facts['Public Nostr retrieval'] ?? ''), a.facts['Public Nostr retrieval']);
    check(`[${tag}] A. accept function called once, record stored`, a.enforcement['Accept function calls (this issuance)'] === '1' && a.enforcement['Accepted record stored'] === 'yes', JSON.stringify(a.enforcement));
    check(`[${tag}] A. evidence actions: explorer links + downloads`, (await page.$$('#mint-evidence-card a[target="_blank"][rel~="noopener"]')).length >= 2 && (await page.isVisible('#mint-dl-public')));
    const dl = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('#mint-dl-public')]).then(([d]) => d).catch(() => null);
    check(`[${tag}] A. public evidence downloads`, !!dl && /solvent-public-evidence/.test(dl.suggestedFilename()), dl?.suggestedFilename());
    await tap(page, '#mint-dl-replay');
    check(`[${tag}] A. full replay bundle warns before downloading the proof secret`, await page.isVisible('#mint-replay-warning'));

    // ---- B. reload restores; retry never accepts twice
    await page.reload();
    await page.waitForFunction(() => document.getElementById('mint-op')?.dataset.state === 'restored', undefined, { timeout: 30_000 });
    check(`[${tag}] B. reload restores the issuance and its accepted state`, /calls recorded: 1/.test((await page.textContent('#mint-op-detail')) ?? ''), (await page.textContent('#mint-op-detail')) ?? '');
    await tap(page, '#mint-retry-btn');
    await waitResult(page, interval);
    const b = await outcome(page);
    check(`[${tag}] B. retry of the accepted issuance: still ACCEPT, accept calls still 1`, b.code === 'ACCEPT_VERIFIED' && b.enforcement['Accept function calls (this issuance)'] === '1' && /already accepted/.test(b.enforcement['Calls made by this verification'] ?? ''), JSON.stringify(b.enforcement));

    // ---- C. broken promise
    await tap(page, '#mint-again-btn');
    await tap(page, '#mint-omit-btn');
    await waitResult(page, interval);
    const c = await outcome(page);
    await shot(page, 'broken-promise');
    check(`[${tag}] C. the omission was registered before minting`, c.steps.some((s) => /registered for issuance .* before minting|sent right after minting/.test(s)));
    check(`[${tag}] C. broken promise -> REFUSE_ISSUANCE_OMITTED`, c.code === 'REFUSE_ISSUANCE_OMITTED' && c.cls === 'refusal', `${c.badge} (${c.code})`);
    const onlyInclusion =
      c.facts['Receipt signature'] === 'VALID' && /^VALID/.test(c.facts['Epoch manifest'] ?? '') && /^VALID/.test(c.facts['Manifest key delegation'] ?? '') &&
      /RETRIEVED/.test(c.facts['Public Nostr retrieval'] ?? '') && /COVERED/.test(c.facts['Live reserve'] ?? '') && /MISSING/.test(c.facts['Promised issuance'] ?? '');
    check(`[${tag}] C. everything valid except the promised issuance`, onlyInclusion, JSON.stringify(c.facts));
    check(`[${tag}] C. a proven refusal offers no "retry" (retry is for availability failures)`, !(await page.isVisible('#mint-retry-btn')));
    check(`[${tag}] C. accept function not called, store unchanged`, c.enforcement['Accept function calls'] === '0' && c.enforcement['Store changed'] === 'no', JSON.stringify(c.enforcement));

    // ---- D. transient relay outage, then retry of the same issuance
    if (!process.argv.includes('--skip-transient')) {
      await tap(page, '#mint-again-btn');
      // A page whose relay WebSockets can never connect and whose HTTPS relay
      // fetch fails — this test browser only; the servers are untouched.
      const blocked = await ctx.newPage();
      // Plain JS string: a compiled TS class would reference bundler helpers
      // that do not exist inside the page.
      await blocked.addInitScript(`
        class DeadSocket extends EventTarget {
          constructor(u) { super(); this.url = u; this.readyState = 3;
            setTimeout(() => { this.onerror && this.onerror(new Event('error')); this.onclose && this.onclose({ code: 1006, reason: 'blocked by test', wasClean: false }); }, 50); }
          send() {} close() {}
        }
        window.WebSocket = DeadSocket;
      `);
      await blocked.route('**/v1/solvent/nostr/event/**', (r) => r.abort());
      await blocked.goto(url);
      await blocked.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
      await tap(blocked, '#mint-honest-btn');
      await waitResult(blocked, interval);
      const d1 = await outcome(blocked);
      await shot(blocked, 'relay-outage');
      check(`[${tag}] D. relay outage -> "could not complete", not a mint refusal`, d1.cls === 'availability' && /COULD NOT COMPLETE/.test(d1.badge), `${d1.badge} (${d1.code})`);
      check(`[${tag}] D. Retry verification is offered; nothing accepted`, (await blocked.isVisible('#mint-retry-btn')) && d1.enforcement['Accept function calls'] === '0', JSON.stringify(d1.enforcement));
      const epochBefore = d1.steps.find((s) => /accounting epoch \d+/.test(s))?.match(/epoch (\d+)/)?.[1];
      await blocked.close();
      // The outage ends: a normal page restores the same issuance from storage and retries it.
      const page2 = await ctx.newPage();
      await page2.goto(url);
      await page2.waitForFunction(() => document.getElementById('mint-op')?.dataset.state === 'restored', undefined, { timeout: 30_000 });
      const epochRestored = (await page2.textContent('#mint-op-title'))?.match(/epoch (\d+)/)?.[1];
      await tap(page2, '#mint-retry-btn');
      await waitResult(page2, interval);
      const d2 = await outcome(page2);
      check(`[${tag}] D. retry of the SAME issuance after the outage -> ACCEPT_VERIFIED, accepted once, nothing minted`, d2.code === 'ACCEPT_VERIFIED' && d2.enforcement['Accept function calls (this issuance)'] === '1' && !!epochBefore && epochBefore === epochRestored && !d2.steps.some((s) => /issued a \d+-sat invoice/.test(s)), `${d2.code}, epoch ${epochBefore} -> ${epochRestored}`);
      await page2.close();
    }

    if (width > 430) {
      const m = await ctx.newPage();
      await m.setViewportSize({ width: 390, height: 844 });
      await m.goto(url);
      await m.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`[${tag}] 390px: the real-mint page has no horizontal overflow`, overflow <= 0, `${overflow}px`);
      await m.close();
    } else {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`[${tag}] ${width}px: no horizontal overflow after the runs`, overflow <= 0, `${overflow}px`);
    }
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nREAL MINT BROWSER FLOW VERIFIED' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-real-mint-browser crashed:', err);
  process.exit(1);
});
