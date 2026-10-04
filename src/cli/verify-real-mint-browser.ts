// npm run verify:real-mint:browser -- <site-url> <mint-url> <evidence-url> [--screenshots <dir>] [--browser chromium|webkit] [--width 1440|390] [--skip-transient] [--swap [--melt]] [--pay-ldk <dashboard>] [--evidence-out <file>]
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
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { invoicePaymentHash as paymentHash } from '../app/bolt11.js';
import path from 'node:path';
import { SimplePool, verifyEvent, type NostrEvent } from 'nostr-tools';
import { chromium, webkit, type Page } from 'playwright';
import { POL_RELAYS } from '../nostr/pol-evidence.js';
import { hexToBytes, spentLeaf, verifyInclusionProof } from '../pol/mmr.js';
import { inclusionProofFromJson } from '../app/bundle-json.js';

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
  // Web fonts arriving late reflow the page (seen in WebKit): click only once the target has stopped moving.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let last = '';
  for (let i = 0; i < 20; i++) {
    const now = await page.$eval(sel, (e) => {
      e.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      const r = e.getBoundingClientRect();
      return `${Math.round(r.top)}:${Math.round(r.left)}`;
    });
    if (now === last) break;
    last = now;
    await page.waitForTimeout(150);
  }
  await page.click(sel);
}

/** The lifecycle as "mint:done verify:done …", and the YOUR ECASH strip's text. */
async function journey(page: Page): Promise<{ lc: string; wallet: string; overflow: number }> {
  return page.evaluate(() => ({
    lc: Array.from(document.querySelectorAll<HTMLElement>('#mint-lifecycle li')).map((li) => `${li.dataset.step}:${li.dataset.state}`).join(' '),
    wallet: (document.getElementById('mint-wallet')?.hidden ? '' : document.getElementById('mint-wallet')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
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

/** The evidence card's label/value rows. */
async function evidenceRows(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries(await page.$$eval('#mint-evidence-card dt', (dts) => dts.map((dt) => [dt.textContent?.trim() ?? '', (dt.nextElementSibling?.textContent ?? '').trim()])));
}

/**
 * Outside the browser and the app: fetch the event the page reported straight from the public relays
 * and check it with nostr-tools' own verifyEvent (id = hash of the content, valid Schnorr signature),
 * then compare what it commits to with what the page showed.
 */
async function independentEventCheck(rows: Record<string, string>, mintUrl: string): Promise<{ ok: boolean; detail: string }> {
  const id = rows['Nostr event'] ?? '';
  if (!/^[0-9a-f]{64}$/.test(id)) return { ok: false, detail: `no event id on the page (${id})` };
  const pool = new SimplePool();
  try {
    const events: NostrEvent[] = await pool.querySync(POL_RELAYS, { ids: [id] }, { maxWait: 8000 });
    const ev = events.find((e) => e.id === id);
    if (!ev) return { ok: false, detail: `event ${id.slice(0, 12)}… not served by any of ${POL_RELAYS.length} relays` };
    const content = JSON.parse(ev.content) as { mint?: string; epoch_index?: number; manifest_digest?: string };
    const problems = [
      !verifyEvent(ev) && 'signature/id invalid',
      ev.kind !== 8181 && `kind ${ev.kind}`,
      content.manifest_digest !== rows['Manifest digest'] && `manifest digest ${content.manifest_digest} vs page ${rows['Manifest digest']}`,
      String(content.epoch_index) !== rows['Receipt target epoch'] && `epoch ${content.epoch_index} vs receipt ${rows['Receipt target epoch']}`,
      mintUrl !== '-' && content.mint?.replace(/\/$/, '') !== mintUrl.replace(/\/$/, '') && `mint ${content.mint}`,
    ].filter(Boolean);
    return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `event ${id} kind 8181, signature valid, epoch ${content.epoch_index}, manifest digest ${content.manifest_digest} matches the page` };
  } finally {
    pool.close(POL_RELAYS);
  }
}

/** A copy button must say whether it worked; where the browser lets the test read the clipboard, the copied text must be exact. */
async function copyCheck(page: Page, label: string, canReadClipboard: boolean): Promise<{ ok: boolean; detail: string }> {
  // A handle, not a text locator: the label itself changes when the copy is confirmed.
  const btn = (await page.locator('#mint-evidence-card .copy-evidence-btn', { hasText: label }).first().elementHandle())!;
  const expected = (await btn.getAttribute('data-copy')) ?? '';
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForTimeout(300);
  const feedback = ((await btn.textContent()) ?? '').trim();
  const copied = canReadClipboard ? await page.evaluate(() => navigator.clipboard.readText()).catch(() => null) : null;
  const ok = /^Copied ✓$|^Copy failed/.test(feedback) && (!canReadClipboard || (feedback === 'Copied ✓' && copied === expected));
  return { ok, detail: `"${feedback}"${canReadClipboard ? `, clipboard ${copied === expected ? 'holds exactly the value' : 'differs'}` : ' (clipboard not readable in this engine)'}` };
}

/**
 * --pay-ldk <dashboard url>: pays the invoice the page shows from a separate,
 * real Lightning node (a CDK LDK-node dashboard on localhost), standing in for
 * the visitor's own wallet. The payment is a real Lightning payment; the mint
 * learns of it only from its own Lightning backend.
 */
/**
 * --pay-faucet <token file>: pays the invoice the page shows through the public
 * Mutinynet faucet's Lightning node (Faucet LND), exactly what a judge does on
 * faucet.mutinynet.com. The token file holds a faucet session; it is read here
 * and never printed.
 */
async function payViaFaucet(page: Page, tokenFile: string): Promise<string> {
  const invoice = await page
    .waitForFunction(() => /(lntbs|lntb|lnbcrt)[0-9a-z]+/i.exec(document.getElementById('mint-steps')?.textContent ?? '')?.[0] ?? null, undefined, { timeout: 120_000 })
    .then((h) => h.jsonValue() as Promise<string>);
  const token = readFileSync(tokenFile, 'utf8').trim();
  let last = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch('https://faucet.mutinynet.com/api/lightning', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ bolt11: invoice }),
    });
    last = `HTTP ${res.status} ${(await res.text()).replace(token, '<token>').slice(0, 200)}`;
    if (res.ok) return invoice;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`the faucet did not pay: ${last}`);
}

async function payShownInvoice(page: Page, dashboard: string): Promise<string> {
  const invoice = await page
    .waitForFunction(() => /(lntbs|lntb|lnbcrt)[0-9a-z]+/i.exec(document.getElementById('mint-steps')?.textContent ?? '')?.[0] ?? null, undefined, { timeout: 120_000 })
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(async (err: Error) => {
      const state = await page.evaluate(() => ({
        op: document.getElementById('mint-op')?.dataset.state ?? '(none)',
        title: document.getElementById('mint-op-title')?.textContent ?? '',
        steps: document.getElementById('mint-steps')?.textContent ?? '',
        status: document.getElementById('mint-status')?.textContent ?? '',
      }));
      await page.screenshot({ path: `invoice-wait-failure-${Date.now()}.png`, fullPage: true }).catch(() => {});
      throw new Error(`no invoice appeared: ${JSON.stringify(state)} (${err.message.split('\n')[0]})`);
    });
  // A real wallet retries a payment that found no route (e.g. its own peer link was momentarily down);
  // the mint still issues only once its own Lightning node has seen the payment settle.
  let res: Response | null = null;
  let html = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    res = await fetch(`${dashboard.replace(/\/$/, '')}/payments/bolt11`, {
      method: 'POST',
      headers: { cookie: `ldk_node_dashboard_csrf=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, invoice, amount_btc: '' }),
    });
    html = await res.text();
    if (res.ok && !/<title>[^<]*Payment Error/i.test(html)) break;
    if (attempt < 8) await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!res) throw new Error('payer node not reached');
  // The dashboard titles its result page "Payment Error" on any failure (cdk-ldk-node web/handlers/payments.rs).
  if (!res.ok || /<title>[^<]*Payment Error/i.test(html)) throw new Error(`payer node did not pay: HTTP ${res.status} ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  return invoice;
}

/** --evidence-out: one machine-readable record of the runs, public values only (no proof secrets). */
const evidenceRecord: Record<string, unknown> = {};

async function main() {
  const [site, mint, evidence] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--screenshots', '--browser', '--width', '--height', '--pay-ldk', '--pay-faucet', '--evidence-out'].includes(all[i - 1] ?? ''));
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
    const height = Number(opt('--height') ?? (width <= 430 ? '844' : '1000'));
    const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, ...(width <= 430 ? { hasTouch: true, isMobile: which !== 'webkit' ? true : undefined } : {}) });
    const canReadClipboard = which === 'chromium';
    if (canReadClipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => (document.getElementById('mint-reality')?.textContent ?? '').length > 0, undefined, { timeout: 30_000 });
    const reality = (await page.textContent('#mint-reality')) ?? '';
    check(`[${tag}] the page shows the mint, its NUT-06 identity and an honest Lightning label`, /Real CDK mint/.test(reality) && /NUT-06/.test(reality) && /(Real Lightning|Demo fakewallet)/.test(reality));
    check(`[${tag}] the page names both backends: the mint and its evidence service`, /Evidence service/.test(reality) && /https?:\/\//.test(reality.split('Evidence service')[1] ?? ''));
    check(`[${tag}] live status is labelled LIVE with a real time`, /LIVE RAILWAY MINT/.test((await page.textContent('#mint-live-status')) ?? '') && /UTC/.test((await page.textContent('#mint-live-status')) ?? ''));
    const interval = 300_000;

    // ---- A. honest
    await tap(page, '#mint-honest-btn');
    const payLdk = opt('--pay-ldk');
    const payFaucet = opt('--pay-faucet');
    const pay = async (p: Page) => (payFaucet ? payViaFaucet(p, payFaucet) : payShownInvoice(p, payLdk!));
    if (payLdk || payFaucet) {
      const inv = await pay(page);
      evidenceRecord.honest_invoice = { bolt11: inv, payment_hash: paymentHash(inv), paid_by: payFaucet ? 'Mutinynet faucet (Faucet LND)' : 'test payer node' };
      check(`[${tag}] A. the honest run's real Lightning invoice was paid by a separate node`, /^ln/.test(inv), `payment hash ${paymentHash(inv)}`);
    }
    await page.waitForTimeout(800);
    check(`[${tag}] A. progress appears in the viewport immediately`, await inViewport(page, '#mint-op'));
    check(`[${tag}] A. disabled buttons say why`, ((await page.textContent('#mint-busy-reason')) ?? '').length > 0 && (await page.isDisabled('#mint-omit-btn')));
    if (await page.locator('#mint-op').isHidden()) {
      const diag = await page.evaluate(() => {
        const b = document.getElementById('mint-honest-btn') as HTMLButtonElement;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return `button top ${Math.round(r.top)} disabled ${b.disabled}; under its centre: ${hit?.id || hit?.className || hit?.tagName}; scrollY ${Math.round(window.scrollY)}; status "${document.getElementById('mint-status')?.textContent ?? ''}"`;
      });
      throw new Error(`the honest run did not start: ${diag}`);
    }
    const details = new Set<string>();
    const sampler = setInterval(() => void page.textContent('#mint-op-detail').then((t) => t && details.add(t)).catch(() => {}), 700);
    await waitResult(page, interval);
    clearInterval(sampler);
    const a = await outcome(page);
    check(`[${tag}] A. progress named the epoch wait or publishing stage`, [...details].some((d) => /Waiting for epoch \d+ to close|Publishing epoch|Fetching epoch|Observing the Mutinynet reserve|closed; waiting for its public evidence/.test(d)), [...details].slice(0, 3).join(' | '));
    check(`[${tag}] A. honest -> ACCEPT_VERIFIED`, a.code === 'ACCEPT_VERIFIED', `${a.badge} (${a.code})`);
    const promise = ((await page.textContent('#mint-promise')) ?? '').replace(/\s+/g, ' ');
    check(`[${tag}] A. the mint's promise is shown in words: receipt SIGNED, promised epoch, epoch closed`, (await page.isVisible('#mint-promise')) && /promised to count this issuance in epoch \d+/.test(promise) && /SIGNED ✓/.test(promise) && /CLOSED/.test(promise), promise.slice(0, 160));
    const hl = await page.$$eval('#mint-checks li', (els) => els.map((e) => `${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}`));
    check(`[${tag}] A. plain-language checks lead, all VALID (signature, promise, closed epoch, included, Nostr, reserve)`, hl.length === 6 && hl.every((x) => /VALID$/.test(x)), hl.join(' | '));
    check(`[${tag}] A. "accept() called exactly once" is stated under the verdict`, /accept\(\) called exactly once/.test((await page.textContent('#mint-accept-line')) ?? ''), (await page.textContent('#mint-accept-line')) ?? '');
    const jA = await journey(page);
    check(`[${tag}] A. lifecycle: Mint, Verify, Accept completed; YOUR ECASH shows ACCEPTED ✓`, /^mint:done verify:done accept:done swap:(current|pending) pay:pending$/.test(jA.lc) && /ACCEPTED ✓/.test(jA.wallet) && !/secret/i.test(jA.wallet), `${jA.lc} | ${jA.wallet}`);
    check(`[${tag}] A. no horizontal page overflow`, jA.overflow <= 0, `${jA.overflow}px`);
    check(`[${tag}] A. Nostr retrieval passed`, /RETRIEVED/.test(a.facts['Public Nostr retrieval'] ?? ''), a.facts['Public Nostr retrieval']);
    check(`[${tag}] A. accept function called once, record stored`, a.enforcement['Accept function calls (this issuance)'] === '1' && a.enforcement['Accepted record stored'] === 'yes', JSON.stringify(a.enforcement));
    check(`[${tag}] A. evidence actions: explorer links + downloads`, (await page.$$('#mint-evidence-card a[target="_blank"][rel~="noopener"]')).length >= 2 && (await page.isVisible('#mint-dl-public')));
    // A smooth scroll may still be running when the result appears: allow it to finish.
    const decisionInView = await page
      .waitForFunction(() => { const r = document.getElementById('mint-decision-badge')!.getBoundingClientRect(); return r.top >= 0 && r.top <= window.innerHeight * 0.4; }, undefined, { timeout: 2000 })
      .then(() => true, () => false);
    const where = await page.$eval('#mint-decision-badge', (b) => `badge top ${Math.round(b.getBoundingClientRect().top)}, scrollY ${Math.round(window.scrollY)}, viewport ${window.innerHeight}`);
    check(`[${tag}] A. the decision is brought into the top part of the screen when reached`, decisionInView, where);
    // After the in-view check: a full-page screenshot resizes the page and resets its scroll.
    await shot(page, 'honest');
    const aRows = await evidenceRows(page);
    evidenceRecord.honest = { decision: a.code, facts: a.facts, enforcement: a.enforcement, evidence: aRows, steps: a.steps };
    const aInd = await independentEventCheck(aRows, mint);
    check(`[${tag}] A. independent check of the fresh event (Node + nostr-tools, outside the app)`, aInd.ok, aInd.detail);
    for (const label of ['Copy event ID', 'Copy receipt']) {
      const cc = await copyCheck(page, label, canReadClipboard);
      check(`[${tag}] A. "${label}" gives visible feedback`, cc.ok, cc.detail);
    }
    // Same-issuance retry, immediately — no refresh, no new mint, no second acceptance.
    check(`[${tag}] A. "Retry verification (same issuance)" is offered on the result right away`, await page.isVisible('#mint-result-retry-btn'));
    await tap(page, '#mint-result-retry-btn');
    await waitResult(page, interval);
    const a2 = await outcome(page);
    check(`[${tag}] A. immediate retry: same issuance, still ACCEPT, no new invoice, accept calls still 1`, a2.code === 'ACCEPT_VERIFIED' && a2.enforcement['Accept function calls (this issuance)'] === '1' && /already accepted/.test(a2.enforcement['Calls made by this verification'] ?? '') && !a2.steps.some((s) => /issued a \d+-sat invoice/.test(s)), JSON.stringify(a2.enforcement));
    const dl = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('#mint-dl-public')]).then(([d]) => d).catch(() => null);
    check(`[${tag}] A. public evidence downloads`, !!dl && /solvent-public-evidence/.test(dl.suggestedFilename()), dl?.suggestedFilename());
    await tap(page, '#mint-dl-replay');
    check(`[${tag}] A. full replay bundle warns before downloading the proof secret`, await page.isVisible('#mint-replay-warning'));
    // Confirming completes the download (Playwright keeps it in a temporary file, deleted with the browser; it is never saved here).
    const replay = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), tap(page, '#mint-dl-replay-confirm')]).then(([d]) => d).catch(() => null);
    const replayOk = !!replay && /solvent-replay-bundle-epoch-\d+\.json/.test(replay.suggestedFilename()) && (await replay.failure()) === null;
    check(`[${tag}] A. after the warning, the replay bundle download completes`, replayOk, replay?.suggestedFilename());
    const publicOk = !!dl && (await dl.failure()) === null;
    check(`[${tag}] A. the public evidence download completed (not just started)`, publicOk);

    // A swap/payment is offered only where the mint's books can be checked for it (and paying only on real Lightning).
    const evBase = (await page.evaluate(() => JSON.parse(localStorage.getItem('solvent.mint.lastRun.v1') ?? '{}').cfg?.evidenceUrl)) as string;
    const evStatus = (await (await fetch(`${evBase}/v1/solvent/status`)).json()) as { spend_evidence?: boolean; lightning_backend?: string; demo_faucet_invoices?: boolean };
    if (!evStatus.spend_evidence) check(`[${tag}] A2. no swap is offered when the evidence service cannot show the mint's books for it`, await page.locator('#mint-swap').isHidden());
    if (evStatus.lightning_backend === 'fakewallet') check(`[${tag}] A3. no "payment" is offered on a fakewallet mint`, await page.locator('#mint-pay').isHidden());

    // ---- A2. spend it: the live NUT-03 swap (--swap), checked from outside the browser too
    if (process.argv.includes('--swap')) {
      const mintBase = (await page.evaluate(() => JSON.parse(localStorage.getItem('solvent.mint.lastRun.v1') ?? '{}').cfg)) as { mintUrl: string; evidenceUrl: string };
      check(`[${tag}] A2. "Swap ecash" is offered directly under the accepted result`, await page.isVisible('#mint-swap-btn'));
      await tap(page, '#mint-swap-btn');
      await page.waitForFunction(() => !document.getElementById('mint-swap-verdict')?.hidden || /Stopped:/.test(document.getElementById('mint-swap-steps')?.textContent ?? ''), undefined, { timeout: 600_000 });
      const verdict = ((await page.textContent('#mint-swap-verdict')) ?? '').trim();
      const swapSteps = await page.$$eval('#mint-swap-steps li', (els) => els.map((e) => e.textContent ?? ''));
      check(`[${tag}] A2. swap verdict`, /^SWAP COMPLETE/.test(verdict), verdict || swapSteps.join(' | '));
      const stored = (await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('solvent.mint.swaps.v1') ?? '{}'))[0])) as
        | { exec: { inputY: string; inputAmount: number; outputs: { y: string; amount: number }[] } }
        | undefined;
      if (stored) {
        // NUT-07 straight from the mint, not through the app.
        const ys = [stored.exec.inputY, ...stored.exec.outputs.map((o) => o.y)];
        const states = (await (await fetch(`${mintBase.mintUrl}/v1/checkstate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Ys: ys }) })).json()) as { states: { Y: string; state: string }[] };
        const st = Object.fromEntries(states.states.map((x) => [x.Y, x.state]));
        check(
          `[${tag}] A2. independent NUT-07: original SPENT, every replacement UNSPENT`,
          st[stored.exec.inputY] === 'SPENT' && stored.exec.outputs.every((o) => st[o.y] === 'UNSPENT'),
          `original ${st[stored.exec.inputY]}; replacements ${stored.exec.outputs.map((o) => `${o.amount}:${st[o.y]}`).join(', ')}`,
        );
        // The spent sum-MMR inclusion, recomputed here from the evidence service's raw response.
        const sp = (await (await fetch(`${mintBase.evidenceUrl}/v1/solvent/spend/${stored.exec.inputY}`)).json()) as {
          state: string; target_epoch: number; operation: { consumed_sum: number; issued_sum: number; issued: unknown[] };
          evidence?: { manifest: { spent_mmr_root_hash: string; spent_mmr_root_sum: number; outstanding_balance: number }; spentMmrSize: number; inclusionProof: Parameters<typeof inclusionProofFromJson>[0]; previous: { manifest: { outstanding_balance: number } } | null };
        };
        evidenceRecord.swap = {
          verdict,
          original: { y: stored.exec.inputY, amount: stored.exec.inputAmount, nut07_state: st[stored.exec.inputY] },
          replacements: stored.exec.outputs.map((o) => ({ y: o.y, amount: o.amount, nut07_state: st[o.y] })),
          epoch: sp.target_epoch,
          operation: sp.operation,
          liability_before: sp.evidence?.previous?.manifest.outstanding_balance ?? null,
          liability_after: sp.evidence?.manifest.outstanding_balance ?? null,
        };
        const ip = sp.evidence ? inclusionProofFromJson(sp.evidence.inclusionProof) : null;
        const inSpent = !!ip && !!sp.evidence && verifyInclusionProof(spentLeaf(stored.exec.inputY, stored.exec.inputAmount), ip, sp.evidence.spentMmrSize, hexToBytes(sp.evidence.manifest.spent_mmr_root_hash), BigInt(sp.evidence.manifest.spent_mmr_root_sum));
        check(
          `[${tag}] A2. independent spent-side check: in the signed spent sum-MMR, operation conserves value`,
          sp.state === 'EPOCH_CLOSED' && inSpent && sp.operation.consumed_sum === sp.operation.issued_sum && sp.operation.issued.length === stored.exec.outputs.length,
          `epoch ${sp.target_epoch}; consumed ${sp.operation.consumed_sum}, issued ${sp.operation.issued_sum} in ${sp.operation.issued.length} outputs; outstanding ${sp.evidence?.previous?.manifest.outstanding_balance ?? '—'} -> ${sp.evidence?.manifest.outstanding_balance ?? '—'}`,
        );
      } else check(`[${tag}] A2. the swap was recorded in this browser`, false);
      const swapFacts = ((await page.textContent('#mint-swap-facts')) ?? '').replace(/\s+/g, ' ');
      check(`[${tag}] A2. SWAP COMPLETE shows original SPENT, replacements UNSPENT, liability CONSERVED ✓, spent accounting COMMITTED ✓`, /SPENT/.test(swapFacts) && /UNSPENT/.test(swapFacts) && /CONSERVED ✓/.test(swapFacts) && /COMMITTED ✓/.test(swapFacts), swapFacts.slice(0, 200));
      const jS = await journey(page);
      check(`[${tag}] A2. lifecycle: Swap completed; YOUR ECASH shows SWAPPED ✓`, /swap:done/.test(jS.lc) && /SWAPPED ✓/.test(jS.wallet), `${jS.lc} | ${jS.wallet}`);
      await shot(page, 'swap');

      // ---- A3. pay with it: a real NUT-05 melt (--melt; real-Lightning mints only)
      if (process.argv.includes('--melt')) {
        check(`[${tag}] A3. "Pay with ecash" is offered directly after the verified swap`, await page.isVisible('#mint-pay-btn'));
        await tap(page, '#mint-pay-btn');
        await page.waitForFunction(() => !document.getElementById('mint-pay-verdict')?.hidden || /Stopped:/.test(document.getElementById('mint-pay-steps')?.textContent ?? ''), undefined, { timeout: 600_000 });
        const payVerdict = ((await page.textContent('#mint-pay-verdict')) ?? '').trim();
        const paySteps = await page.$$eval('#mint-pay-steps li', (els) => els.map((e) => e.textContent ?? ''));
        check(`[${tag}] A3. payment verdict`, /^PAYMENT COMPLETE/.test(payVerdict), payVerdict || paySteps.join(' | '));
        const melt = (await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('solvent.mint.melts.v1') ?? '{}'))[0])) as
          | { invoice: string; preimage: string | null; epoch: number; feePaid: number; liabilityBefore: number | null; liabilityAfter: number | null; inputs: { y: string; amount: number }[]; change: { y: string; amount: number }[] }
          | undefined;
        if (melt?.invoice) {
          // Proof of payment, recomputed here: sha256(preimage) must be the invoice's own payment hash.
          const hash = paymentHash(melt.invoice);
          const preOk = !!melt.preimage && createHash('sha256').update(Buffer.from(melt.preimage, 'hex')).digest('hex') === hash;
          check(`[${tag}] A3. independent proof of payment: sha256(preimage) = invoice payment hash`, preOk, `payment hash ${hash}`);
          const ys = [...melt.inputs.map((i) => i.y), ...melt.change.map((c) => c.y)];
          const states = (await (await fetch(`${mintBase.mintUrl}/v1/checkstate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Ys: ys }) })).json()) as { states: { Y: string; state: string }[] };
          const st = Object.fromEntries(states.states.map((x) => [x.Y, x.state]));
          check(
            `[${tag}] A3. independent NUT-07: every input SPENT, every change proof UNSPENT`,
            melt.inputs.every((i) => st[i.y] === 'SPENT') && melt.change.every((c) => st[c.y] === 'UNSPENT'),
            `inputs ${melt.inputs.map((i) => `${i.amount}:${st[i.y]}`).join(', ')}; change ${melt.change.map((c) => `${c.amount}:${st[c.y]}`).join(', ') || 'none'}`,
          );
          evidenceRecord.melt = {
            verdict: payVerdict,
            invoice: { bolt11: melt.invoice, payment_hash: hash, payee: 'Mutinynet faucet (faucet.mutinynet.com)' },
            payment_preimage: melt.preimage,
            inputs: melt.inputs.map((i) => ({ y: i.y, amount: i.amount, nut07_state: st[i.y] })),
            change: melt.change.map((c) => ({ y: c.y, amount: c.amount, nut07_state: st[c.y] })),
            lightning_fee_paid: melt.feePaid,
            epoch: melt.epoch,
            liability_before: melt.liabilityBefore,
            liability_after: melt.liabilityAfter,
          };
        } else check(`[${tag}] A3. the payment was recorded in this browser`, false);
        const payFacts = ((await page.textContent('#mint-pay-facts')) ?? '').replace(/\s+/g, ' ');
        check(`[${tag}] A3. PAYMENT COMPLETE shows Lightning PAID ✓, inputs SPENT, change RETURNED, accounting UPDATED ✓`, /PAID ✓/.test(payFacts) && /SPENT/.test(payFacts) && /RETURNED/.test(payFacts) && /UPDATED ✓/.test(payFacts), payFacts.slice(0, 200));
        const jP = await journey(page);
        check(`[${tag}] A3. lifecycle: all five completed; YOUR ECASH shows what remains`, jP.lc === 'mint:done verify:done accept:done swap:done pay:done' && /\d+ test sats remaining/.test(jP.wallet), `${jP.lc} | ${jP.wallet}`);
        check(`[${tag}] A3. no horizontal page overflow`, jP.overflow <= 0, `${jP.overflow}px`);
        await shot(page, 'melt');
      }
    }

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
    if (payLdk || payFaucet) {
      const inv = await pay(page);
      evidenceRecord.broken_promise_invoice = { bolt11: inv, payment_hash: paymentHash(inv), paid_by: payFaucet ? 'Mutinynet faucet (Faucet LND)' : 'test payer node' };
      check(`[${tag}] C. the broken-promise run's real Lightning invoice was paid by a separate node`, /^ln/.test(inv), `payment hash ${paymentHash(inv)}`);
    }
    await waitResult(page, interval);
    const c = await outcome(page);
    await shot(page, 'broken-promise');
    check(`[${tag}] C. the omission was registered before minting`, c.steps.some((s) => /registered for issuance .* before minting|sent right after minting/.test(s)));
    check(`[${tag}] C. broken promise -> REFUSE_ISSUANCE_OMITTED`, c.code === 'REFUSE_ISSUANCE_OMITTED' && c.cls === 'refusal', `${c.badge} (${c.code})`);
    const onlyInclusion =
      c.facts['Receipt signature'] === 'VALID' && /^VALID/.test(c.facts['Epoch manifest'] ?? '') && /^VALID/.test(c.facts['Manifest key delegation'] ?? '') &&
      /RETRIEVED/.test(c.facts['Public Nostr retrieval'] ?? '') && /COVERED/.test(c.facts['Live reserve'] ?? '') && /MISSING/.test(c.facts['Promised issuance'] ?? '');
    check(`[${tag}] C. everything valid except the promised issuance`, onlyInclusion, JSON.stringify(c.facts));
    check(`[${tag}] C. a proven refusal offers no "retry" (retry is for availability failures)`, !(await page.isVisible('#mint-retry-btn')) && !(await page.isVisible('#mint-result-retry-btn')));
    check(`[${tag}] C. the note under a refusal does not mention a Retry that is not offered`, !/Retry/.test((await page.textContent('#mint-result-actions-note')) ?? ''), (await page.textContent('#mint-result-actions-note')) ?? '');
    const cRows = await evidenceRows(page);
    evidenceRecord.broken_promise = { decision: c.code, facts: c.facts, enforcement: c.enforcement, evidence: cRows, steps: c.steps };
    const cInd = await independentEventCheck(cRows, mint);
    check(`[${tag}] C. independent check of the broken-promise event (Node + nostr-tools, outside the app)`, cInd.ok, cInd.detail);
    check(`[${tag}] C. the attack plays out in its own section, saying "accept() NOT CALLED"`, (await page.$('#mint-attack #mint-result')) !== null && /accept\(\) NOT CALLED/.test((await page.textContent('#mint-accept-line')) ?? ''), (await page.textContent('#mint-accept-line')) ?? '');
    const hlC = await page.$$eval('#mint-checks li', (els) => els.map((e) => `${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}`));
    check(`[${tag}] C. plain-language checks: only "Your issuance included" fails (MISSING)`, hlC.filter((x) => /MISSING$/.test(x)).length === 1 && /included/.test(hlC.find((x) => /MISSING$/.test(x)) ?? '') && hlC.filter((x) => /VALID$/.test(x)).length === 5, hlC.join(' | '));
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
      if (payLdk || payFaucet) await pay(blocked);
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
  const outFile = opt('--evidence-out');
  if (outFile) {
    const info = mint === '-' ? null : ((await (await fetch(`${mint}/v1/info`)).json()) as { name?: string; version?: string; pubkey?: string });
    const st = evidence === '-' ? null : ((await (await fetch(`${evidence}/v1/solvent/status`)).json()) as Record<string, unknown>);
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          schema: 'solvent/browser-run-evidence/v1',
          note: 'Public values only. No Cashu proof secret, key or mnemonic is recorded.',
          generated_at: new Date().toISOString(),
          git_commit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
          working_tree_clean: execSync('git status --porcelain', { encoding: 'utf8' }).trim() === '',
          site,
          mint: { url: mint, name: info?.name, version: info?.version, nut06_identity: info?.pubkey },
          evidence_service: { url: evidence, lightning_backend: st?.lightning_backend, manifest_pubkey: st?.manifest_pubkey, reserve_outpoint: st?.reserve_outpoint, reserve_network: st?.reserve_network, relays: st?.relays },
          browser: `${opt('--browser') ?? 'chromium'}-${opt('--width') ?? '1440'}`,
          checks_failed: failures,
          ...evidenceRecord,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`evidence written to ${outFile}`);
  }
  console.log(failures === 0 ? '\nREAL MINT BROWSER FLOW VERIFIED' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-real-mint-browser crashed:', err);
  process.exit(1);
});
