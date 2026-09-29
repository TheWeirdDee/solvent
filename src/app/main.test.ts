// @vitest-environment jsdom
//
// No visual browser is available in this environment, so this exercises
// the real v2 index.html markup + main.ts/router.ts/verifier-panel.ts/
// publisher-panel.ts/hero-panel.ts/docs-panel.ts wiring end to end inside
// jsdom: real DOM elements, real event listeners, real blind signing, real
// BIP-340 signing/verification, real sum-MMR construction, and the real
// central verify() decision — via src/app/protocol-demo.ts. Only the two
// genuine network calls (live Nostr relay query, live Esplora reserve
// query) are mocked here, the same way the pre-v2 test suite mocked
// nostr-tools — everything else is the real code path a browser would run.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { generateSecretKey } from 'nostr-tools';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import liveAttestationEvidence from '../../evidence/reserves/live-attestation.json' with { type: 'json' };
import liveDemoEvidence from '../../evidence/nostr/live-demo.json' with { type: 'json' };
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../nostr/pol-event.js';

// Many tests here drive real verification scenarios (real blind signing, DLEQ,
// receipts, MMR proofs) through the real UI. Measured one file at a time,
// the slowest take ~1.1-2.1s. In the full parallel suite, CPU contention from
// the other workers slowed one of them 5.4x (the "ACCEPT scenario" test, 1.1s
// -> 6.04s), past Vitest's 5s default, so the file failed intermittently. The
// same A/B timing with and without the landing-page GSAP work showed no
// slowdown, so this is contention, not a regression. The fix is an explicit
// budget for this file (~5.4x contention over a ~2.1s worst case is ~11s,
// rounded up), not weaker assertions.
vi.setConfig({ testTimeout: 20_000 });

const mockState = vi.hoisted(() => ({
  /**
   * Controls fetchPolEvidence's mocked return. Defaults to the Live Public
   * Demo's OWN real event — the one identity `npm run live-demo` actually
   * published, so a mocked "relay fetch" for THAT specific identity
   * returning it is realistic, not a shortcut (evaluatePolEvidence's own
   * mint_identity/epoch filter means this default has no effect on other,
   * unrelated freshly-generated identities' queries — see the comment on
   * this mock's definition below). Tests exercising "nothing found" set
   * this to [] explicitly. (Set to the real value in beforeEach below,
   * not here — this runs before the live-demo JSON import is initialized.)
   */
  nostrEvents: [] as unknown[],
  /** Controls whether the mocked Esplora reserve query "succeeds" and what it reports. */
  reserveLive: { ok: true, spent: false },
  /** Controls whether the mocked relay fetch itself succeeds (network-level) — false simulates every relay being unreachable, not just "no matching event". */
  relayOk: true,
  /** When set, overrides the mocked fetchTipHeight()'s return value — lets a test simulate a chain tip far ahead of an attestation's block_height (staleness) deterministically, without waiting on a real clock or a real chain. */
  tipHeightOverride: null as number | null,
  /**
   * When set, fetchPolEvidence returns these results IN ORDER across
   * successive calls (call 1 = sequence[0], call 2 = sequence[1], ...) —
   * exercises submission.ts's bounded relay-fetch retry deterministically
   * (first-attempt-miss-then-hit, both-unreachable, conflicting-on-retry,
   * etc.) without a real network or a real wall-clock wait. null (the
   * default) means "ignore this, use the relayOk/nostrEvents behavior".
   */
  nostrFetchSequence: null as Array<{ events: unknown[]; relayReachable: boolean }> | null,
  /**
   * When set, controls whether each successive "round" of Esplora calls
   * (fetchTxOutScript + fetchOutspend + fetchTipHeight — the group
   * queryLiveChainState's bounded retry treats as one attempt) throws a
   * transport-level error: round i throws iff `esploraFailSequence[i]` is
   * true. `esploraRoundIndex` advances once per round (inside the
   * fetchTipHeight mock, called last in each round) — never touch it
   * directly. null (the default) means "ignore this, use the
   * reserveLive.ok-based behavior".
   */
  esploraFailSequence: null as boolean[] | null,
  esploraRoundIndex: 0,
}));

vi.mock('../nostr/pol-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nostr/pol-evidence.js')>();
  return {
    ...actual,
    fetchPolEvidence: vi.fn(async () => {
      if (mockState.nostrFetchSequence && mockState.nostrFetchSequence.length > 0) {
        const next = mockState.nostrFetchSequence.shift()!;
        return { ...next, queriedRelays: [] };
      }
      // Mirrors the real fetchPolEvidence's contract: it never throws on a
      // network-level failure (nostr-tools' querySync resolves regardless),
      // it reports reachability via a separate field. relayOk=false is
      // "every relay unreachable", not an exception.
      return { events: mockState.relayOk ? mockState.nostrEvents : [], queriedRelays: [], relayReachable: mockState.relayOk };
    }),
    // submission.ts's bounded relay-fetch retry (evaluateNostrIndependently)
    // waits on this exact export before its one extra attempt — overridden
    // to instant so tests never take a real 1.5s wall-clock hit (deterministic
    // and fast), while the browser/real CLI scripts get the real timer.
    realDelay: vi.fn(async () => {}),
  };
});

vi.mock('../reserve/esplora.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reserve/esplora.js')>();
  const outpoint = liveAttestationEvidence.attestation.statement.outpoints[0]!;
  return {
    ...actual,
    fetchTxOutScript: vi.fn(async (txid: string, vout: number) => {
      // fetchTxOutScript is always the FIRST call in a round (see
      // queryLiveChainState's fetchChainStateOnce) — the only one
      // guaranteed to run even when the round fails, so it alone decides
      // and advances the round index. If it doesn't throw, the round
      // succeeds and fetchOutspend/fetchTipHeight proceed normally below.
      if (mockState.esploraFailSequence) {
        const shouldFail = mockState.esploraFailSequence[mockState.esploraRoundIndex] ?? false;
        mockState.esploraRoundIndex++;
        if (shouldFail) throw new Error('mocked esplora transport failure');
      }
      if (!mockState.reserveLive.ok) throw new Error('mocked esplora failure');
      if (txid !== outpoint.txid || vout !== outpoint.vout) return null;
      return { value: outpoint.value_sats, scriptPubKeyHex: outpoint.script_pubkey_hex };
    }),
    fetchOutspend: vi.fn(async () => {
      if (!mockState.reserveLive.ok) throw new Error('mocked esplora failure');
      return { spent: mockState.reserveLive.spent };
    }),
    fetchTipHeight: vi.fn(async () => {
      if (!mockState.reserveLive.ok) throw new Error('mocked esplora failure');
      return mockState.tipHeightOverride ?? liveAttestationEvidence.tipHeight + 5;
    }),
    // submission.ts's bounded Esplora-fetch retry (queryLiveChainState)
    // waits on this exact export before its one extra attempt — see the
    // identical realDelay mock for '../nostr/pol-evidence.js' above.
    realDelay: vi.fn(async () => {}),
  };
});

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeAll(async () => {
  const indexHtmlPath = path.resolve(import.meta.dirname, '..', '..', 'index.html');
  const html = readFileSync(indexHtmlPath, 'utf8');
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  await import('./main.js');
  // The hero panel's runScenario('omitted') resolves asynchronously (it
  // does a live-status-style reserve re-query, and — since submission.ts's
  // Nostr leg now genuinely attempts a public relay fetch on every run too
  // — a real multi-relay query); this is a reliable "app finished mounting
  // and the hero rendered" signal. The longer timeout accounts for real
  // network latency across both live calls, not just one.
  await waitFor(() => byId<HTMLElement>('hero-result').textContent !== '', 25000);
}, 30000);

beforeEach(() => {
  mockState.nostrEvents = [liveDemoEvidence.bundle.nostrEvent];
  mockState.reserveLive = { ok: true, spent: false };
  mockState.relayOk = true;
  mockState.tipHeightOverride = null;
  mockState.nostrFetchSequence = null;
  mockState.esploraFailSequence = null;
  mockState.esploraRoundIndex = 0;
});

async function goHome() {
  window.location.hash = '#/';
  await waitFor(() => !byId<HTMLElement>('panel-home').hidden);
}

async function goToVerify() {
  window.location.hash = '#/verify';
  await waitFor(() => !byId<HTMLElement>('panel-verify').hidden);
}

async function goToPublish() {
  window.location.hash = '#/publish';
  await waitFor(() => !byId<HTMLElement>('panel-publish').hidden);
}

async function goToProtocol() {
  window.location.hash = '#/protocol';
  await waitFor(() => !byId<HTMLElement>('panel-protocol').hidden);
}

async function goToDocs() {
  window.location.hash = '#/docs';
  await waitFor(() => !byId<HTMLElement>('panel-docs').hidden);
}

async function switchToMode(mode: 'live' | 'evidence') {
  await goToVerify();
  document.querySelector<HTMLButtonElement>(`#panel-verify .mode-tab[data-mode="${mode}"]`)!.click();
  await waitFor(() => !byId<HTMLElement>(`mode-${mode}`).hidden);
}

/** Runs /verify's Live check and waits for THIS run's result (not a previous one still on screen). */
async function runLiveCheck() {
  await switchToMode('live');
  const runBtn = byId<HTMLButtonElement>('run-verification-btn');
  await waitFor(() => !runBtn.disabled);
  const before = byId<HTMLElement>('live-status-time').dataset.checkedAt;
  runBtn.click();
  await waitFor(() => !byId<HTMLElement>('result').hidden && byId<HTMLElement>('live-status-time').dataset.checkedAt !== before, 8000);
}

/** Pastes text into Verify evidence and verifies it. Parse errors render synchronously; real verifications resolve asynchronously. */
async function verifyPasted(text: string) {
  await switchToMode('evidence');
  byId<HTMLTextAreaElement>('manual-bundle-input').value = text;
  byId<HTMLButtonElement>('manual-verify-btn').click();
  await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
}

function chainStepClasses(chainId: string): string[] {
  return Array.from(byId<HTMLElement>(chainId).querySelectorAll('.chain-step')).map((s) => s.className);
}

function factValue(factsId: string, label: string): string {
  const fact = Array.from(byId<HTMLElement>(factsId).querySelectorAll('.decision-fact')).find((f) => f.querySelector('dt')?.textContent === label);
  return fact?.querySelector('dd')?.textContent ?? '';
}

/** Visible product copy of a panel: raw evidence the user can open (JSON, a pasted bundle) is data, not copy. */
function productText(panelId: string): string {
  const clone = byId<HTMLElement>(panelId).cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.raw-json, textarea').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

describe('SOLVENT web client (jsdom) — Verify evidence first-run state (must run before anything else touches that mode)', () => {
  it('shows a neutral, non-error first-run state — no premature "unsupported mint" before the user has pasted anything', async () => {
    await switchToMode('evidence');
    expect(byId<HTMLElement>('manual-status').textContent).toBe('');
    expect(byId<HTMLElement>('manual-result').hidden).toBe(true);
    expect(byId<HTMLTextAreaElement>('manual-bundle-input').value).toBe('');
  });
});

describe('SOLVENT web client (jsdom) — v2 landing page', () => {
  it('root route shows the landing hero with the v2 promise/epoch story, not the verifier or publisher', async () => {
    await goHome();
    expect(byId<HTMLElement>('panel-home').hidden).toBe(false);
    expect(byId<HTMLElement>('panel-verify').hidden).toBe(true);
    expect(byId<HTMLElement>('panel-publish').hidden).toBe(true);
    const hero = document.querySelector('.hero');
    expect(hero?.textContent).toMatch(/the mint/i);
    expect(hero?.textContent).toMatch(/made a promise/i);
    expect(hero?.textContent).toMatch(/did it keep it/i);
  });

  it('the hero terminal is powered by a real runScenario("omitted") call, not hardcoded decoration, and says it is an example', async () => {
    await goHome();
    expect(byId<HTMLElement>('hero-promised-epoch').textContent).toBe('12');
    expect(byId<HTMLElement>('hero-epoch-closed').textContent).toContain('CLOSED');
    expect(byId<HTMLElement>('hero-included').textContent).toContain('NO');
    const resultEl = byId<HTMLElement>('hero-result');
    expect(resultEl.textContent).toBe('REFUSE');
    expect(resultEl.className).toContain('red');
    expect(byId<HTMLElement>('hero-result-reason').textContent).toContain('REFUSE_ISSUANCE_OMITTED');
    expect(document.querySelector('.terminal-caption')?.textContent).toMatch(/example/i);
  });

  it('I. states the problem explicitly: a valid token does not prove the mint counted what it owes', async () => {
    await goHome();
    const section = byId<HTMLElement>('problem');
    expect(section.querySelector('.eyebrow')?.textContent).toMatch(/^the problem$/i);
    expect(section.querySelector('.section-heading')?.textContent).toMatch(/a valid cashu token\s*doesn.t prove the mint\s*counted what it owes/i);
    expect(section.textContent!.replace(/\s+/g, ' ')).toMatch(/a mint can issue valid ecash while omitting that obligation from its accounting/i);
    expect(section.textContent).toMatch(/valid token/i);
    expect(section.textContent).toMatch(/mint signature/i);
    expect(section.textContent).toMatch(/counted or omitted/i);
    expect(section.textContent).toMatch(/enough or not/i);
    expect(section.textContent).toMatch(/the gap/i);
    expect(section.textContent).toMatch(/wallets need a way to check the mint.s obligation before accepting the token/i);
    // Directly below the hero.
    expect(byId<HTMLElement>('panel-home').querySelector(':scope > section.hero')?.nextElementSibling).toBe(section);
  });

  it('I. follows the problem with the solution: issuance through to ACCEPT / REFUSE', async () => {
    await goHome();
    const section = byId<HTMLElement>('solution');
    expect(byId<HTMLElement>('problem').nextElementSibling).toBe(section);
    expect(section.querySelector('.eyebrow')?.textContent).toMatch(/^the solution$/i);
    expect(section.querySelector('.section-heading')?.textContent).toMatch(/solvent makes\s*the mint.s promise\s*checkable/i);
    const flow = Array.from(section.querySelectorAll('.solution-flow li')).map((li) => li.textContent?.trim());
    expect(flow).toEqual(['Issuance', 'Signed liability receipt', 'Closed accounting state', 'Public Nostr evidence', 'Live Bitcoin reserve', 'Accept / Refuse']);
    expect(section.textContent).toMatch(/valid token ≠ solvent mint\. solvent checks both\./i);
  });

  it('says who it is built for', async () => {
    await goHome();
    const section = byId<HTMLElement>('built-for');
    expect(section.textContent).toMatch(/built for/i);
    for (const who of ['Cashu wallets', 'Ecash apps', 'Mint operators', 'Users accepting ecash']) expect(section.textContent).toContain(who);
    expect(section.textContent).toMatch(/not only that ecash is authentic, but that the mint actually accounted for it/i);
  });

  it('the "what SOLVENT catches" section tells the broken-promise story, not the old v1 ratio-only story', async () => {
    await goHome();
    const section = byId<HTMLElement>('why');
    expect(section.textContent).toMatch(/signed promise/i);
    expect(section.textContent).toMatch(/promised epoch/i);
    expect(section.textContent).toMatch(/missing/i);
  });

  it('the how-it-works section presents the four real checks (origin/promise/accounting/reserve)', async () => {
    await goHome();
    const section = byId<HTMLElement>('how-it-works');
    expect(section.textContent).toMatch(/was this ecash really issued/i);
    expect(section.textContent).toMatch(/what did the mint promise/i);
    expect(section.textContent).toMatch(/did the closed epoch keep the promise/i);
    expect(section.textContent).toMatch(/can the mint cover its committed liability/i);
  });

  it('the reserve section shows the real, live-verified Signet reserve evidence', async () => {
    await goHome();
    const section = byId<HTMLElement>('reserve');
    expect(section.textContent).toMatch(/bitcoin-signet-mutinynet/i);
    expect(byId<HTMLElement>('reserve-utxo').textContent).not.toBe('unavailable');
    expect(byId<HTMLElement>('reserve-utxo-state').textContent).toBe('UNSPENT');
    expect(byId<HTMLElement>('reserve-coverage').textContent).toBe('PASS');
    expect(section.textContent).toMatch(/test network/i);
  });

  it('the Nostr section exposes real v2 evidence (kind 8181, schema, relays)', async () => {
    await goHome();
    expect(byId<HTMLElement>('nostr-kind').textContent).toBe('8181');
    expect(byId<HTMLElement>('nostr-schema').textContent).toBe('solvent/pol/v2');
    expect(byId<HTMLElement>('nostr-relays').textContent).toMatch(/relay\.damus\.io|nos\.lol|relay\.nostr\.band/);
    expect(byId<HTMLElement>('nostr-event-id').textContent).not.toBe('');
  });

  it('the attack corpus section reports 25/25 from the real evidence data, not a hardcoded string', async () => {
    await goHome();
    expect(byId<HTMLElement>('attack-count').textContent).toBe('25');
    expect(byId<HTMLElement>('attack-total').textContent).toBe('25');
    const grid = byId<HTMLElement>('attack-grid');
    expect(grid.children.length).toBeGreaterThan(0);
    expect(grid.textContent).toMatch(/refused/i);
  });

  it('the FAQ section is present, accessible, and expands on click', async () => {
    await goHome();
    const faq = byId<HTMLElement>('faq-list');
    expect(faq.children.length).toBeGreaterThan(0);
    const firstQuestion = faq.querySelector<HTMLButtonElement>('.faq-question')!;
    expect(firstQuestion.getAttribute('aria-expanded')).toBe('false');
    firstQuestion.click();
    expect(firstQuestion.getAttribute('aria-expanded')).toBe('true');
    const answer = document.getElementById(firstQuestion.getAttribute('aria-controls')!)!;
    expect(answer.hidden).toBe(false);
  });

  it('the "what SOLVENT proves" section is reframed and does not dominate the page', async () => {
    await goHome();
    const proves = document.querySelector('.proves-grid');
    expect(proves?.textContent).toMatch(/the mint signed the receipt/i);
    expect(proves?.textContent).toMatch(/remains custodial/i);
  });

  it('landing page does not expose raw technical JSON', async () => {
    await goHome();
    const landing = byId<HTMLElement>('panel-home');
    expect(landing.querySelector('.raw-json')).toBeNull();
    expect(landing.querySelector('pre')).toBeNull();
    expect(landing.textContent).not.toMatch(/"decision":|"checks":/);
  });

  it('landing page contains no fabricated customers or testimonials', async () => {
    await goHome();
    const landing = byId<HTMLElement>('panel-home');
    expect(landing.querySelector('blockquote')).toBeNull();
    expect(landing.querySelector('img')).toBeNull();
    expect(landing.textContent).not.toMatch(/testimonial|trusted by|our customers|\bco-?founder\b|\bceo\b|\bcto\b/i);
  });

  it('landing copy avoids hackathon-disclaimer phrasing in the primary flow', async () => {
    await goHome();
    const landing = byId<HTMLElement>('panel-home');
    expect(landing.textContent).not.toMatch(/not an official endorsement/i);
    expect(landing.textContent).not.toMatch(/hackathon/i);
  });

  it('the "Run the live check" hero CTA lands on Live check, even as an in-app same-document navigation (not just a fresh page load)', async () => {
    await switchToMode('evidence');
    await goHome();
    // A real click on an in-app <a href="#/verify?mode=live"> is a
    // same-document hash change, not a fresh page load — the deep link must
    // be re-synced on every arrival at /verify.
    document.querySelector<HTMLAnchorElement>('.hero a[href="#/verify?mode=live"]')!.click();
    await waitFor(() => !byId<HTMLElement>('panel-verify').hidden);
    expect(byId<HTMLElement>('mode-live').hidden).toBe(false);
    expect(byId<HTMLElement>('mode-evidence').hidden).toBe(true);
    expect(document.querySelector('#panel-verify .mode-tab.active')?.getAttribute('data-mode')).toBe('live');
  });

  it('old deep links still land on a real mode: ?mode=manual -> Verify evidence, ?mode=create -> Live check', async () => {
    window.location.hash = '#/verify?mode=manual';
    await waitFor(() => !byId<HTMLElement>('mode-evidence').hidden);
    await goHome();
    window.location.hash = '#/verify?mode=create';
    await waitFor(() => !byId<HTMLElement>('mode-live').hidden);
    expect(byId<HTMLElement>('mode-evidence').hidden).toBe(true);
  });

  it('nav links reflect the active route, including the Docs route', async () => {
    await goHome();
    expect(byId('nav-home').className).toContain('active');
    await goToVerify();
    expect(byId('nav-verify').className).toContain('active');
    expect(byId('nav-home').className).not.toContain('active');
    await goToProtocol();
    expect(byId('nav-protocol').className).toContain('active');
    await goToDocs();
    expect(byId('nav-docs').className).toContain('active');
  });
});

describe('SOLVENT web client (jsdom) — /verify has exactly two primary modes', () => {
  it('A. offers Live check and Verify evidence only — no "Create test ecash" tab or copy anywhere on /verify', async () => {
    await goToVerify();
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#panel-verify .mode-tab'));
    expect(tabs.map((t) => t.dataset.mode)).toEqual(['live', 'evidence']);
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Live check', 'Verify evidence']);
    expect(byId<HTMLElement>('panel-verify').textContent).not.toMatch(/create test ecash/i);
    expect(document.getElementById('mode-create')).toBeNull();
    expect(document.getElementById('create-ecash-btn')).toBeNull();
    expect(byId<HTMLElement>('mode-live').querySelector('.verify-intro-title')?.textContent).toBe('LIVE VERIFICATION');
    expect(byId<HTMLButtonElement>('run-verification-btn').textContent).toMatch(/run live check/i);
    expect(byId<HTMLElement>('mode-evidence').querySelector('.verify-intro-title')?.textContent).toBe('VERIFY YOUR EVIDENCE');
    expect(byId<HTMLButtonElement>('manual-verify-btn').textContent).toMatch(/verify bundle/i);
    expect(byId<HTMLButtonElement>('manual-load-example-btn').textContent).toMatch(/load live example/i);
  });

  it('the bundle input is a compact paste/upload area, not a giant JSON editor', async () => {
    await switchToMode('evidence');
    const input = byId<HTMLTextAreaElement>('manual-bundle-input');
    expect(Number(input.getAttribute('rows'))).toBeLessThanOrEqual(5);
    expect(document.querySelector('label[for="manual-bundle-input"]')?.textContent).toMatch(/verification bundle/i);
    expect(byId<HTMLInputElement>('manual-bundle-file').type).toBe('file');
  });
});

describe('SOLVENT web client (jsdom) — Live check', () => {
  it('does not run until RUN LIVE CHECK is clicked, and shows the reference case dates up front', async () => {
    await switchToMode('live');
    expect(byId<HTMLElement>('result').hidden).toBe(true);
    expect(byId<HTMLElement>('live-status-time').textContent).toBe('Not yet run');
    expect(byId<HTMLElement>('live-status-network').textContent).toBe('Mutinynet (Bitcoin Signet)');
    expect(byId<HTMLElement>('live-status').textContent).toMatch(/test-network coins have no monetary value/i);
    const dates = byId<HTMLElement>('live-dates').textContent!;
    expect(dates).toMatch(/Published/);
    expect(dates).toMatch(/Nostr event valid/);
    expect(dates).toMatch(new RegExp(`block ${liveDemoEvidence.bundle.reserveAttestation.statement.block_height.toLocaleString('en-US')}`));
    expect(dates).toMatch(/estimated/i);
  });

  it('a healthy reference case -> real public relay fetch finds the event -> ACCEPT, every step passes, Accept enabled', async () => {
    await runLiveCheck();
    expect(byId<HTMLElement>('decision-badge').textContent).toBe('✓ ACCEPT');
    expect(byId<HTMLElement>('decision-badge').className).toContain('green');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('ACCEPT VERIFIED.');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(false);
    const classes = chainStepClasses('decision-chain');
    expect(classes).toHaveLength(9);
    expect(classes.every((c) => c.includes('chain-step-ok'))).toBe(true);
    expect(byId<HTMLElement>('live-status-nostr').textContent).toBe('LIVE');
    expect(byId<HTMLElement>('live-status-reserve').textContent).toBe('LIVE');
    expect(byId<HTMLElement>('evidence-content').textContent).toMatch(/FOUND \(public relay\)/);
    expect(byId<HTMLElement>('live-dates').textContent).toMatch(/FRESH until/);
  });

  it('the nine checks use the new wording — "signed epoch manifest", never "published accounting record"', async () => {
    await runLiveCheck();
    const labels = Array.from(byId<HTMLElement>('progress-steps').querySelectorAll('.step-label')).map((s) => s.firstChild?.textContent?.trim());
    expect(labels).toEqual([
      '1. Token format',
      '2. Mint origin / NUT-12',
      '3. PoL receipt',
      '4. Promised epoch',
      '5. Signed epoch manifest',
      '6. Liability inclusion',
      '7. Public Nostr retrieval',
      '8. Live reserve',
      '9. Decision',
    ]);
    expect(byId<HTMLElement>('panel-verify').textContent).not.toMatch(/published accounting record/i);
  });

  it('shows the exact Nostr event id and reserve txid:vout it checked', async () => {
    await runLiveCheck();
    const ids = byId<HTMLElement>('live-checked-ids').textContent!;
    const outpoint = liveDemoEvidence.bundle.reserveAttestation.statement.outpoints[0]!;
    expect(ids).toContain(liveDemoEvidence.bundle.nostrEvent.id);
    expect(ids).toContain(`${outpoint.txid}:${outpoint.vout}`);
  });

  it('re-running re-fetches the evidence and updates "Last checked"', async () => {
    const { fetchPolEvidence } = await import('../nostr/pol-evidence.js');
    await runLiveCheck();
    const first = byId<HTMLElement>('live-status-time').dataset.checkedAt;
    vi.mocked(fetchPolEvidence).mockClear();
    await new Promise((r) => setTimeout(r, 5));
    byId<HTMLButtonElement>('run-again-btn').click();
    await waitFor(() => byId<HTMLElement>('live-status-time').dataset.checkedAt !== first && !byId<HTMLElement>('result').hidden, 8000);
    expect(vi.mocked(fetchPolEvidence)).toHaveBeenCalled();
  });

  it('never substitutes bundled data when the reserve query fails: REFUSE, "LIVE RESERVE UNAVAILABLE", reserve UNAVAILABLE', async () => {
    mockState.reserveLive = { ok: false, spent: false };
    await runLiveCheck();
    expect(byId<HTMLElement>('decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('LIVE RESERVE UNAVAILABLE.');
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_UNVERIFIABLE');
    expect(byId<HTMLElement>('live-status-reserve').textContent).toBe('UNAVAILABLE');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
  });

  it('when relays are unreachable: REFUSE, "PUBLIC EVIDENCE UNAVAILABLE", Nostr UNAVAILABLE', async () => {
    mockState.relayOk = false;
    await runLiveCheck();
    expect(byId<HTMLElement>('decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('PUBLIC EVIDENCE UNAVAILABLE.');
    expect(byId<HTMLElement>('live-status-nostr').textContent).toBe('UNAVAILABLE');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
  });

  it('when relays answer but no longer hold the event: REFUSE, "PUBLIC EVIDENCE NOT FOUND", Nostr NOT FOUND', async () => {
    mockState.nostrEvents = [];
    await runLiveCheck();
    expect(byId<HTMLElement>('decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('PUBLIC EVIDENCE NOT FOUND.');
    expect(byId<HTMLElement>('live-status-nostr').textContent).toBe('NOT FOUND');
  });

  it('shows REFUSE_RESERVE_UTXO_SPENT and Reserve SPENT when the live reserve query reports the UTXO spent', async () => {
    mockState.reserveLive = { ok: true, spent: true };
    await runLiveCheck();
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_RESERVE_UTXO_SPENT');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('RESERVE SPENT.');
    expect(byId<HTMLElement>('live-status-reserve').textContent).toBe('SPENT');
  });

  it('evidence details contain the required v2 sections, with raw JSON only behind collapsed developer toggles', async () => {
    await runLiveCheck();
    const evidence = byId<HTMLElement>('evidence-content');
    for (const section of ['Cashu', 'PoL receipt', 'Epoch / MMR', 'Nostr', 'Reserve', 'Decision']) expect(evidence.textContent).toContain(section);
    const toggles = Array.from(evidence.querySelectorAll<HTMLDetailsElement>('.raw-json-toggle'));
    expect(toggles.map((t) => t.querySelector('summary')?.textContent)).toEqual(['View raw bundle', 'View result JSON']);
    expect(toggles.every((t) => !t.open)).toBe(true);
    expect(byId<HTMLDetailsElement>('evidence').open).toBe(false);
  });

  it("the live check's status line lives inside its own mode and does not leak into Verify evidence", async () => {
    mockState.nostrEvents = [];
    await runLiveCheck();
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_NOSTR_EVENT_NOT_FOUND');
    expect(byId<HTMLElement>('mode-live').contains(byId<HTMLElement>('status'))).toBe(true);
    await switchToMode('evidence');
    expect(byId<HTMLElement>('mode-live').hidden).toBe(true);
  });
});

describe('SOLVENT web client (jsdom) — Gate 4 enforcement reaches the real acceptance boundary', () => {
  it('ACCEPT: clicking Accept calls the real accept function and visibly transitions to ACCEPTED', async () => {
    await runLiveCheck();
    const acceptBtn = byId<HTMLButtonElement>('accept-btn');
    expect(acceptBtn.disabled).toBe(false);
    acceptBtn.click();
    const acceptedPanel = byId<HTMLElement>('accepted-panel');
    await waitFor(() => !acceptedPanel.hidden);
    expect(acceptedPanel.textContent).toMatch(/accepted/i);
    expect(acceptedPanel.textContent).toContain('CALLED ONCE');
    expect(acceptBtn.hidden).toBe(true);
    expect(byId<HTMLElement>('evidence-content').textContent).toContain('accept() CALLED');
  });

  it('clicking Accept twice never calls the acceptance side effect twice (button is hidden after first accept)', async () => {
    await runLiveCheck();
    const acceptBtn = byId<HTMLButtonElement>('accept-btn');
    const acceptedPanel = byId<HTMLElement>('accepted-panel');
    acceptBtn.click();
    await waitFor(() => acceptBtn.hidden === true);
    acceptBtn.click();
    await waitFor(() => !acceptedPanel.hidden);
    expect(acceptedPanel.textContent?.match(/CALLED ONCE/g)?.length).toBe(1);
  });

  it('REFUSE: Accept is disabled and cannot reach the acceptance side effect', async () => {
    mockState.nostrEvents = [];
    await runLiveCheck();
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
    expect(byId<HTMLElement>('accepted-panel').hidden).toBe(true);
  });
});

describe('SOLVENT web client (jsdom) — Verify evidence', () => {
  it('B. "Load live example" loads the canonical, publicly published reference case — identical every time, never freshly generated', async () => {
    await switchToMode('evidence');
    const input = byId<HTMLTextAreaElement>('manual-bundle-input');
    byId<HTMLButtonElement>('manual-load-example-btn').click();
    const first = input.value;
    const parsed = JSON.parse(first);
    expect(parsed.nostrEvent.id).toBe(liveDemoEvidence.bundle.nostrEvent.id);
    expect(parsed.proof.secret).toBe(liveDemoEvidence.bundle.proof.secret);
    expect(parsed.masterPublicKeyHex).toBe(liveDemoEvidence.bundle.masterPublicKeyHex);
    expect(byId<HTMLElement>('manual-bundle-summary').textContent).toMatch(/live example loaded/i);
    byId<HTMLButtonElement>('manual-load-example-btn').click();
    expect(input.value).toBe(first);
  });

  it('C. "Load live example" then Verify runs the real verifier — a live relay fetch, and a different answer when the relay no longer has the event', async () => {
    const { fetchPolEvidence } = await import('../nostr/pol-evidence.js');
    await switchToMode('evidence');
    byId<HTMLButtonElement>('manual-load-example-btn').click();
    vi.mocked(fetchPolEvidence).mockClear();
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    expect(vi.mocked(fetchPolEvidence)).toHaveBeenCalledWith(liveDemoEvidence.bundle.masterPublicKeyHex, liveDemoEvidence.bundle.manifest.epoch_index);
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✓ ACCEPT');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('ACCEPT_VERIFIED');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(false);

    mockState.nostrEvents = [];
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('PUBLIC EVIDENCE NOT FOUND.');
  });

  it('D. a locally generated, never-published bundle cannot masquerade as public evidence', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const local = await createTestEcash();
    // The relay answers — with the real published reference event, the
    // only kind 8181 event it holds — but nothing for this bundle's own
    // (mint identity, epoch).
    await verifyPasted(submissionBundleToJson(local.submissionBundle));
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_NOSTR_EVENT_NOT_FOUND');
    expect(factValue('manual-decision-facts', 'Local cryptography')).toBe('VALID');
    expect(factValue('manual-decision-facts', 'Public Nostr retrieval')).toBe('NOT FOUND');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(true);
    expect(byId<HTMLElement>('manual-evidence-content').textContent).toMatch(/Public retrievalNOT VERIFIED/);
  });

  it('E. the signed epoch manifest can pass while public Nostr retrieval fails', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    await verifyPasted(submissionBundleToJson((await createTestEcash()).submissionBundle));
    const classes = chainStepClasses('manual-decision-chain');
    expect(classes[4]).toContain('chain-step-ok'); // 5. Signed epoch manifest
    expect(classes[6]).toContain('chain-step-fail'); // 7. Public Nostr retrieval
    expect(classes[7]).toContain('chain-step-ok'); // 8. Live reserve
    expect(classes[8]).toContain('chain-step-fail'); // 9. Decision
  });

  it('F. when public retrieval fails, the headline is the REFUSE decision, not "cryptographic check passed"', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    await verifyPasted(submissionBundleToJson((await createTestEcash()).submissionBundle));
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('PUBLIC EVIDENCE NOT FOUND.');
    expect(byId<HTMLElement>('manual-decision-body').textContent).toBe(
      'The token and supplied signatures are cryptographically valid, but SOLVENT could not independently retrieve the required accounting event from public relays. Acceptance is blocked.',
    );
    expect(byId<HTMLElement>('panel-verify').textContent).not.toMatch(/cryptographic check passed/i);
    // Valid local cryptography is reported only as a secondary fact under the decision.
    expect(factValue('manual-decision-facts', 'Local cryptography')).toBe('VALID');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).not.toMatch(/valid|passed/i);
  });

  it('D2. a bundle whose evidence genuinely is publicly retrievable reaches a real ACCEPT when pasted', async () => {
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const { loadCanonicalLiveDemoBundle } = await import('./submission.js');
    await verifyPasted(submissionBundleToJson(loadCanonicalLiveDemoBundle()));
    expect(byId<HTMLElement>('manual-decision-badge').className).toContain('green');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('ACCEPT_VERIFIED');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(false);
  });

  it('a pasted bundle cannot fake acceptance by asserting "verified" reserve/nostr claims — they are ignored and re-derived', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const bundle = JSON.parse(submissionBundleToJson((await createTestEcash()).submissionBundle));
    bundle.reserveAttestation = null;
    bundle.nostrEvent = null;
    bundle.reserve = { verified: true, reserveSats: 999_999_999 };
    bundle.nostr = { verified: true };
    await verifyPasted(JSON.stringify(bundle));
    expect(byId<HTMLElement>('manual-decision-badge').className).not.toContain('green');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('UNVERIFIABLE.');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_UNVERIFIABLE');
  });

  it('a broken promise shows the explicit contradiction, not a bare "0"', async () => {
    const { runScenario } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    await verifyPasted(submissionBundleToJson((await runScenario('omitted')).submissionBundle));
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('BROKEN PROMISE.');
    const classes = chainStepClasses('manual-decision-chain');
    expect(classes[5]).toContain('chain-step-fail'); // 6. Liability inclusion
    expect(classes[7]).toContain('chain-step-ok'); // reserve still healthy
    const evidence = byId<HTMLElement>('manual-evidence-content').textContent!;
    expect(evidence).toMatch(/receipt-promised issuance/i);
    expect(evidence).toMatch(/manifest-reported issuance/i);
    expect(evidence).toContain('70,000 sats');
  });

  it('a reserve shortfall shows the real, correctly computed shortfall — verified and insufficient, not "unverified"', async () => {
    const { runScenario } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    await verifyPasted(submissionBundleToJson((await runScenario('reserve-short')).submissionBundle));
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('RESERVE SHORTFALL.');
    expect(factValue('manual-decision-facts', 'Live reserve')).toBe('SHORT');
    const evidence = byId<HTMLElement>('manual-evidence-content').textContent!;
    expect(evidence).toMatch(/reserve verified/i);
    expect(evidence).toContain('1,500,000 sats');
    expect(evidence).toMatch(/500,000 sats/);
  });
});

describe('SOLVENT web client (jsdom) — Verify evidence error taxonomy', () => {
  it('INVALID JSON: unparseable text never runs verification and never accepts', async () => {
    await verifyPasted('{ this is not json ');
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid json/i);
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('manual-accepted-panel').hidden).toBe(true);
  });

  it('INVALID JSON: an empty input does not show a misleading "unsupported mint" message', async () => {
    await verifyPasted('');
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid json/i);
    expect(byId<HTMLElement>('manual-status').textContent).not.toMatch(/unsupported mint/i);
  });

  it('INCOMPLETE BUNDLE: valid JSON missing required fields is distinguished from invalid JSON', async () => {
    await verifyPasted('{ "not": "a real bundle" }');
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/incomplete bundle/i);
  });

  it('INVALID BUNDLE: every required field present, but one is malformed (not "unsupported mint")', async () => {
    await verifyPasted(
      JSON.stringify({
        proof: { id: 'x', amount: 'not-a-number', secret: 's', C: 'c' },
        receipt: {},
        manifest: { outstanding_balance: 0, issued_mmr_root_sum: 0, spent_mmr_root_sum: 0 },
        manifestSignature: '',
        masterPublicKeyHex: '',
        keysetId: '',
        amountPublicKeyHex: '',
        issuedMmrSize: 0,
        inclusionProof: null,
        reserveAttestation: null,
        nostrEvent: null,
        mint: 'x',
      }),
    );
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid bundle/i);
  });

  it('UNSUPPORTED MINT: a plain Cashu token carries no liability evidence', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    await verifyPasted((await createTestEcash()).token);
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('UNSUPPORTED MINT.');
    expect(byId<HTMLElement>('manual-decision-body').textContent).toMatch(/^This mint does not provide the SOLVENT-compatible liability evidence required for full verification\./);
  });

  it('UNSUPPORTED MINT: ecash JSON with none of the liability evidence', async () => {
    await verifyPasted(JSON.stringify({ proof: { id: '00ab', amount: 8, secret: 's', C: '02aa' }, mint: 'https://mint.example' }));
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('UNSUPPORTED MINT.');
  });

  it('UNSUPPORTED MINT: a fully-formed bundle whose keyset verify() itself rejects', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const ecash = await createTestEcash();
    await verifyPasted(submissionBundleToJson({ ...ecash.submissionBundle, keysetId: `${ecash.submissionBundle.keysetId}00` }));
    expect(byId<HTMLElement>('manual-decision-headline').textContent).toBe('UNSUPPORTED MINT.');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_UNSUPPORTED_KEYSET');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(true);
  });

  it('none of the error taxonomy branches ever call the acceptance side effect', async () => {
    for (const bad of ['not json', '{}', '{ "reserveAttestation": null }', 'cashuBnotreal']) {
      await verifyPasted(bad);
      expect(byId<HTMLElement>('manual-accept-btn').hidden).toBe(true);
      expect(byId<HTMLElement>('manual-accepted-panel').hidden).toBe(true);
    }
  });
});

describe('SOLVENT web client (jsdom) — reference mint lab (#/lab)', () => {
  async function goToLab() {
    window.location.hash = '#/lab';
    await waitFor(() => !byId<HTMLElement>('panel-lab').hidden);
  }

  async function issue(amount: number, omit = false) {
    const status = byId<HTMLElement>('lab-status');
    const select = byId<HTMLSelectElement>('lab-amount');
    select.value = String(amount);
    byId<HTMLInputElement>('lab-omit').checked = omit;
    const before = status.textContent;
    byId<HTMLButtonElement>('lab-issue-btn').click();
    await waitFor(() => status.textContent !== before && /^Issued/.test(status.textContent ?? ''), 8000);
  }

  function mintRow(label: string): string {
    const rows = Array.from(byId<HTMLElement>('lab-mint-rows').querySelectorAll('dt'));
    return rows.find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? '';
  }

  function issuanceRow(label: string): string {
    const rows = Array.from(byId<HTMLElement>('lab-issuance-rows').querySelectorAll('dt'));
    return rows.find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? '';
  }

  it('is not in the primary navigation, nor a /verify mode — only a footer link for developers', async () => {
    const headerLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.topbar a, #nav-drawer a')).map((a) => a.getAttribute('href'));
    expect(headerLinks).not.toContain('#/lab');
    expect(Array.from(document.querySelectorAll('#panel-verify .mode-tab')).some((t) => /lab|create/i.test(t.textContent ?? ''))).toBe(false);
    expect(document.querySelector('.site-footer a[href="#/lab"]')?.textContent).toMatch(/developers/i);
    await goToLab();
    expect(byId<HTMLElement>('panel-lab').querySelector('.page-heading')?.textContent).toBe('REFERENCE MINT LAB');
    expect(byId<HTMLElement>('panel-lab').textContent).toMatch(/Evidence generated here is not automatically published and is not a production mint\./);
  });

  it('keeps one mint identity and keyset across issuances; each issuance gets a new secret, receipt and epoch; the amount varies', async () => {
    await goToLab();
    byId<HTMLButtonElement>('lab-reset-btn').click();
    const identity = mintRow('Mint identity');
    const keyset = mintRow('Active keyset');
    await issue(10_000);
    const first = { secret: issuanceRow('Proof secret'), receipt: issuanceRow('Receipt signature'), epoch: issuanceRow('Promised epoch'), amount: issuanceRow('Amount') };
    await issue(250_000);
    const second = { secret: issuanceRow('Proof secret'), receipt: issuanceRow('Receipt signature'), epoch: issuanceRow('Promised epoch'), amount: issuanceRow('Amount') };
    expect(mintRow('Mint identity')).toBe(identity);
    expect(mintRow('Active keyset')).toBe(keyset);
    expect(second.secret).not.toBe(first.secret);
    expect(second.receipt).not.toBe(first.receipt);
    expect(Number(second.epoch)).toBe(Number(first.epoch) + 1);
    expect([first.amount, second.amount]).toEqual(['10,000 sats', '250,000 sats']);
    expect(mintRow('Outstanding liabilities')).toBe('260,000 sats');
    expect(issuanceRow('Published to Nostr')).toMatch(/^NO/);
  });

  it('the keyset changes only on explicit rotation', async () => {
    await goToLab();
    const identity = mintRow('Mint identity');
    const keyset = mintRow('Active keyset');
    await issue(1_000);
    expect(mintRow('Active keyset')).toBe(keyset);
    byId<HTMLButtonElement>('lab-rotate-btn').click();
    expect(mintRow('Active keyset')).not.toBe(keyset);
    expect(mintRow('Active keyset')).toMatch(/generation 2/);
    expect(mintRow('Mint identity')).toBe(identity);
  });

  it('CHECK LOCAL CRYPTOGRAPHY is its primary action — valid, and explicitly not a full verification', async () => {
    await goToLab();
    await issue(70_000);
    expect(byId<HTMLButtonElement>('lab-check-btn').textContent).toBe('Check local cryptography');
    expect(byId<HTMLElement>('panel-lab').textContent).not.toMatch(/verify ecash/i);
    byId<HTMLButtonElement>('lab-check-btn').click();
    expect(byId<HTMLElement>('lab-decision-badge').textContent).toBe('LOCAL CHECK ONLY');
    expect(byId<HTMLElement>('lab-decision-headline').textContent).toBe('LOCAL CRYPTOGRAPHY VALID.');
    expect(byId<HTMLElement>('lab-decision-body').textContent).toMatch(/not a full verification/i);
    expect(factValue('lab-decision-facts', 'Public Nostr retrieval')).toBe('NOT CHECKED (local only)');
    const classes = chainStepClasses('lab-decision-chain');
    expect(classes.slice(0, 6).every((c) => c.includes('chain-step-ok'))).toBe(true);
    expect(classes.slice(6).every((c) => c.includes('chain-step-na'))).toBe(true);
  });

  it('a full verification of lab evidence refuses as PUBLIC EVIDENCE NOT FOUND — it is never published', async () => {
    await goToLab();
    await issue(70_000);
    byId<HTMLButtonElement>('lab-full-btn').click();
    await waitFor(() => byId<HTMLElement>('lab-decision-badge').textContent === '✕ REFUSE', 8000);
    expect(byId<HTMLElement>('lab-decision-headline').textContent).toBe('PUBLIC EVIDENCE NOT FOUND.');
  });

  it('a broken promise is caught locally (liability inclusion) and by full verification (BROKEN PROMISE)', async () => {
    await goToLab();
    byId<HTMLButtonElement>('lab-reset-btn').click();
    await issue(70_000, true);
    expect(issuanceRow('In the closed epoch')).toMatch(/omitted/i);
    byId<HTMLButtonElement>('lab-check-btn').click();
    expect(byId<HTMLElement>('lab-decision-headline').textContent).toBe('LOCAL CHECK FAILED — LIABILITY INCLUSION.');
    byId<HTMLButtonElement>('lab-full-btn').click();
    await waitFor(() => byId<HTMLElement>('lab-decision-headline').textContent === 'BROKEN PROMISE.', 8000);
  });

  it('issuing past the 1,000,000-sat reserve produces a real RESERVE SHORTFALL', async () => {
    await goToLab();
    byId<HTMLButtonElement>('lab-reset-btn').click();
    await issue(1_000_000);
    await issue(70_000);
    expect(mintRow('Outstanding liabilities')).toBe('1,070,000 sats');
    byId<HTMLButtonElement>('lab-full-btn').click();
    await waitFor(() => byId<HTMLElement>('lab-decision-headline').textContent === 'RESERVE SHORTFALL.', 8000);
  });
});

describe('SOLVENT web client (jsdom) — primary routes use product language, not reference-lab/test language', () => {
  it('J. no primary route shows solvent-fixture-mint, "test environment", "fresh identity every time" (or similar) — even after running checks', async () => {
    const forbidden = [/solvent-fixture-mint/i, /test environment/i, /fresh identity every time/i, /\bfixture\b/i, /\btest mint\b/i, /demo scenario/i, /fresh demo identity/i, /create test ecash/i];
    await runLiveCheck();
    await switchToMode('evidence');
    byId<HTMLButtonElement>('manual-load-example-btn').click();
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    for (const panel of ['panel-home', 'panel-verify', 'panel-protocol']) {
      const text = productText(panel);
      for (const re of forbidden) expect(text, `${panel} must not contain ${re}`).not.toMatch(re);
    }
    // The network is named truthfully: a test network, not a "test mint".
    expect(productText('panel-verify')).toMatch(/Mutinynet \(Bitcoin Signet\)/);
  });
});

describe('SOLVENT web client (jsdom) — publish / evidence pipeline panel', () => {
  it('shows the real last-published Nostr evidence and real last-verified reserve evidence', async () => {
    await goToPublish();
    expect(byId<HTMLElement>('panel-publish').hidden).toBe(false);
    const nostrSummary = byId<HTMLElement>('publisher-nostr');
    expect(nostrSummary.textContent).toContain('Event id');
    expect(nostrSummary.textContent).toMatch(/damus|nos\.lol|nostr\.band/);
    const reserveSummary = byId<HTMLElement>('publisher-reserve');
    expect(reserveSummary.textContent).toContain('bitcoin-signet-mutinynet');
    expect(reserveSummary.textContent).toContain('PASS');
  });
});

describe('SOLVENT web client (jsdom) — protocol page', () => {
  it('presents a full technical overview with non-duplicated, consistent numbering', async () => {
    await goToProtocol();
    const article = document.querySelector('.protocol-doc')!;
    expect(article.textContent).toMatch(/threat model/i);
    expect(article.textContent).toMatch(/holder reconstruction|B.prime/i);
    expect(article.textContent).toMatch(/omission contradiction/i);
    expect(article.textContent).toMatch(/acceptance enforcement/i);
    expect(article.textContent).toMatch(/reason code/i);
    expect(article.textContent).toMatch(/attack model/i);
    expect(article.textContent).toMatch(/trust boundaries/i);
    // Every numbered section heading (1-9) appears exactly once.
    for (let n = 1; n <= 9; n++) {
      const matches = article.innerHTML.match(new RegExp(`>${n}\\. `, 'g')) ?? [];
      expect(matches.length, `expected exactly one section numbered "${n}."`).toBe(1);
    }
  });
});

describe('SOLVENT web client (jsdom) — mobile burger nav (keyboard/ARIA/close behavior, independent of the CSS breakpoint that shows it)', () => {
  it('toggles aria-expanded and opens/closes the drawer on click', async () => {
    await goHome();
    const burger = byId<HTMLButtonElement>('nav-burger');
    const drawer = byId<HTMLElement>('nav-drawer');
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.hidden).toBe(true);
    burger.click();
    expect(burger.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.hidden).toBe(false);
    burger.click();
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.hidden).toBe(true);
  });

  it('Escape closes the open drawer', async () => {
    await goHome();
    const burger = byId<HTMLButtonElement>('nav-burger');
    const drawer = byId<HTMLElement>('nav-drawer');
    burger.click();
    expect(drawer.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer.hidden).toBe(true);
    expect(burger.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the scrim closes the drawer', async () => {
    await goHome();
    const burger = byId<HTMLButtonElement>('nav-burger');
    const drawer = byId<HTMLElement>('nav-drawer');
    const scrim = byId<HTMLElement>('nav-drawer-scrim');
    burger.click();
    expect(drawer.hidden).toBe(false);
    scrim.click();
    expect(drawer.hidden).toBe(true);
  });

  it('clicking a nav link inside the drawer closes it (data-drawer-close) and actually navigates', async () => {
    await goHome();
    const burger = byId<HTMLButtonElement>('nav-burger');
    const drawer = byId<HTMLElement>('nav-drawer');
    burger.click();
    expect(drawer.hidden).toBe(false);
    const docsLink = drawer.querySelector<HTMLAnchorElement>('a[href="#/docs"]')!;
    docsLink.click();
    await waitFor(() => !byId<HTMLElement>('panel-docs').hidden);
    expect(drawer.hidden).toBe(true);
  });

  it('the drawer CTA links to Try/Verify with readable, non-empty text (regression: it previously rendered with invisible light-on-light text)', async () => {
    await goHome();
    const cta = document.querySelector<HTMLAnchorElement>('.nav-drawer-cta')!;
    expect(cta.textContent?.trim().length).toBeGreaterThan(0);
    expect(cta.getAttribute('href')).toBe('#/verify');
  });
});

describe('SOLVENT web client (jsdom) — public evidence links use the real, exact IDs (Part 21)', () => {
  it('the reserve UTXO link/copy button and the Nostr event link/copy button carry the exact real values, on the correct (non-mainnet) network', async () => {
    await runLiveCheck();
    const evidence = byId<HTMLElement>('evidence-content');
    const copyBtns = Array.from(evidence.querySelectorAll<HTMLButtonElement>('.copy-evidence-btn'));
    const txidBtn = copyBtns.find((b) => b.textContent?.includes('Copy txid'));
    const eventIdBtn = copyBtns.find((b) => b.textContent?.includes('Copy full event ID'));
    expect(txidBtn?.dataset.copy?.length).toBe(64); // a real 64-hex txid, not a placeholder
    expect(eventIdBtn?.dataset.copy?.length).toBe(64); // a real 64-hex Nostr event id

    const links = Array.from(evidence.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]'));
    const reserveLink = links.find((a) => a.textContent?.includes('View reserve UTXO'));
    const nostrLink = links.find((a) => a.textContent?.includes('View public event'));
    expect(reserveLink?.href).toContain('mutinynet.com/tx/');
    expect(reserveLink?.href).toContain(txidBtn?.dataset.copy ?? '\0');
    expect(reserveLink?.href).not.toMatch(/mempool\.space|blockstream\.info\/(?!.*signet)/); // never a mainnet explorer
    expect(nostrLink?.href).toContain('njump.me/');
    expect(nostrLink?.href).toContain(eventIdBtn?.dataset.copy ?? '\0');
    expect(reserveLink?.rel).toContain('noreferrer');
    expect(nostrLink?.rel).toContain('noreferrer');
  });
});

describe('SOLVENT web client (jsdom) — Nostr live relay fetch (submission.ts evaluateNostrIndependently)', () => {
  it('reports eventFetched:true and verified:true when a public relay genuinely returns the exact matching event', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { verifySubmission } = await import('./submission.js');
    const ecash = await createTestEcash();
    // Simulate the one case where this evidence really is publicly
    // retrievable: the mocked relay now has the exact same event the
    // bundle carries (a real BIP-340-signed NostrEvent, not a stub).
    mockState.nostrEvents = [ecash.submissionBundle.nostrEvent];
    const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
    expect(nostrLive.relayReachable).toBe(true);
    expect(nostrLive.eventFetched).toBe(true);
    expect(nostrLive.verified).toBe(true);
    expect(result.checks.nostrEvidence).toBe(true);
  });

  it('TEST H (critical): event not found (relay reachable) -> REFUSE_NOSTR_EVENT_NOT_FOUND specifically, accept() never reachable, even though the bundle\'s own private copy is cryptographically valid — a private signed copy does NOT bypass the public-publication requirement', async () => {
    const { createTestEcash, runEnforcement } = await import('./protocol-demo.js');
    const { verifySubmission } = await import('./submission.js');
    const ecash = await createTestEcash();
    mockState.nostrEvents = []; // no relay has this fresh, never-published event
    const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
    expect(nostrLive.relayReachable).toBe(true);
    expect(nostrLive.eventFetched).toBe(false);
    // The bundle's own copy is genuinely, cryptographically valid...
    expect(nostrLive.providedCopyValid).toBe(true);
    // ...but that must NOT satisfy the live public-acceptance gate.
    expect(nostrLive.publicationVerified).toBe(false);
    expect(nostrLive.verified).toBe(false);
    expect(result.checks.nostrEvidence).toBe(false);
    expect(result.decision).toBe('REFUSE');
    // Relay was reachable, so this is the specific "not found" code, never
    // the generic "unavailable" one (see the network-failure test below).
    expect(nostrLive.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
    expect(result.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
    // And the acceptance side effect must be provably unreachable from here.
    const { accepted } = await runEnforcement(ecash);
    expect(accepted).toBe(false);
  });

  it('irrelevant events a relay returns for a totally different mint identity are ignored, not mistaken for this bundle\'s own evidence, and still correctly refuse with REFUSE_NOSTR_EVENT_NOT_FOUND (relay was reachable, just had nothing relevant)', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { verifySubmission } = await import('./submission.js');
    const ecashA = await createTestEcash();
    const ecashB = await createTestEcash(); // a different, unrelated fresh identity
    mockState.nostrEvents = [ecashB.submissionBundle.nostrEvent!];
    const { nostrLive, result } = await verifySubmission(ecashA.submissionBundle);
    expect(nostrLive.eventFetched).toBe(false); // ecashB's event id != ecashA's
    expect(nostrLive.verified).toBe(false);
    expect(result.checks.nostrEvidence).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
  });

  it('live-demo refresh safety: an OLD, unrelated demo identity\'s event sitting alongside THIS bundle\'s own genuine event on a relay never causes a false REFUSE_NOSTR_CONFLICT — evaluatePolEvidence scopes strictly to this bundle\'s own (mint_identity, epoch) before any conflict grouping happens', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { verifySubmission } = await import('./submission.js');
    const current = await createTestEcash(); // "the newest identity" — what a freshly re-run npm run live-demo would publish
    const oldIdentity = await createTestEcash(); // "an old demo identity" — a leftover, permanently-immutable event from an earlier live-demo run, still discoverable on relays
    // A real relay would return BOTH events for a broad enough query — the
    // mock reflects that directly, so this test actually exercises the
    // identity/epoch scoping, not just an absence of noise.
    mockState.nostrEvents = [current.submissionBundle.nostrEvent!, oldIdentity.submissionBundle.nostrEvent!];
    const { nostrLive, result } = await verifySubmission(current.submissionBundle);
    expect(nostrLive.eventFetched).toBe(true);
    expect(nostrLive.verified).toBe(true);
    expect(nostrLive.reasonCode).toBeUndefined(); // specifically NOT REFUSE_NOSTR_CONFLICT
    expect(result.decision).toBe('ACCEPT');
  });

  it('a total relay network failure (every relay unreachable, not just "no match") is reported honestly, distinctly from "reachable but not found", and still refuses rather than crashing or silently reporting success', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { verifySubmission } = await import('./submission.js');
    const ecash = await createTestEcash();
    mockState.relayOk = false; // every relay unreachable
    const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
    expect(nostrLive.relayReachable).toBe(false);
    expect(nostrLive.eventFetched).toBe(false);
    expect(nostrLive.publicationVerified).toBe(false);
    expect(nostrLive.verified).toBe(false);
    expect(result.checks.nostrEvidence).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
  });

  describe('bounded relay-fetch retry (submission.ts evaluateNostrIndependently — one extra attempt, never more, never masks a genuine absence)', () => {
    it('A. first attempt empty, second attempt contains the exact event -> ACCEPT_VERIFIED (a transient first-attempt miss does not prevent a genuine second-attempt confirmation)', async () => {
      const { createTestEcash } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const ecash = await createTestEcash();
      mockState.nostrFetchSequence = [
        { events: [], relayReachable: true },
        { events: [ecash.submissionBundle.nostrEvent], relayReachable: true },
      ];
      const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
      expect(nostrLive.relayReachable).toBe(true);
      expect(nostrLive.eventFetched).toBe(true);
      expect(nostrLive.verified).toBe(true);
      expect(result.decision).toBe('ACCEPT');
      expect(result.reasonCode).toBe('ACCEPT_VERIFIED');
    });

    it('B. first attempt empty, second attempt ALSO empty -> REFUSE_NOSTR_EVENT_NOT_FOUND (the retry never manufactures a false pass for a genuinely unpublished event)', async () => {
      const { createTestEcash } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const ecash = await createTestEcash();
      mockState.nostrFetchSequence = [
        { events: [], relayReachable: true },
        { events: [], relayReachable: true },
      ];
      const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
      expect(nostrLive.relayReachable).toBe(true);
      expect(nostrLive.eventFetched).toBe(false);
      expect(nostrLive.verified).toBe(false);
      expect(nostrLive.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
      expect(result.reasonCode).toBe('REFUSE_NOSTR_EVENT_NOT_FOUND');
    });

    it('C. both attempts unreachable -> REFUSE_NOSTR_UNAVAILABLE (a real outage still refuses in bounded time — exactly two attempts, not an infinite retry)', async () => {
      const { createTestEcash } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const ecash = await createTestEcash();
      const fetchPolEvidenceMock = vi.mocked((await import('../nostr/pol-evidence.js')).fetchPolEvidence);
      fetchPolEvidenceMock.mockClear();
      mockState.nostrFetchSequence = [
        { events: [], relayReachable: false },
        { events: [], relayReachable: false },
      ];
      const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
      expect(nostrLive.relayReachable).toBe(false);
      expect(nostrLive.eventFetched).toBe(false);
      expect(nostrLive.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
      expect(result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
      expect(fetchPolEvidenceMock).toHaveBeenCalledTimes(2); // bounded: exactly one retry, never more
    });

    it('D. first attempt unreachable, second attempt genuinely reaches a relay and finds the event -> ACCEPT-capable (a transient first-attempt outage does not block a genuine subsequent confirmation)', async () => {
      const { createTestEcash } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const ecash = await createTestEcash();
      mockState.nostrFetchSequence = [
        { events: [], relayReachable: false },
        { events: [ecash.submissionBundle.nostrEvent], relayReachable: true },
      ];
      const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
      expect(nostrLive.relayReachable).toBe(true); // combined: reachable because attempt 2 reached a relay
      expect(nostrLive.eventFetched).toBe(true);
      expect(nostrLive.verified).toBe(true);
      expect(result.decision).toBe('ACCEPT');
    });

    it('E. a conflicting, differently-signed event for the same identity/epoch appears only on the retry -> REFUSE_NOSTR_CONFLICT (the retry\'s results are combined with, never substituted for, the first attempt\'s)', async () => {
      const { createTestEcash } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const ecash = await createTestEcash();
      const genuineEvent = ecash.submissionBundle.nostrEvent!;
      const genuineContent = JSON.parse(genuineEvent.content);
      const conflictingContent = buildPolEvidenceContent({
        mint: genuineContent.mint,
        mintIdentityHex: genuineContent.mint_identity,
        keysetId: genuineContent.keyset_id,
        epochIndex: genuineContent.epoch_index,
        manifestDigestHex: 'ee'.repeat(32), // deliberately different -> a distinct, conflicting valid state
        manifestSignature: genuineContent.manifest_signature,
        globalDigestHex: genuineContent.global_digest,
        issuedMmrRootHash: genuineContent.issued_mmr_root_hash,
        issuedMmrRootSum: genuineContent.issued_mmr_root_sum,
        spentMmrRootHash: genuineContent.spent_mmr_root_hash,
        spentMmrRootSum: genuineContent.spent_mmr_root_sum,
        outstandingBalance: genuineContent.outstanding_balance,
        reserveDigestHex: genuineContent.reserve_digest,
        reserveSats: genuineContent.reserve_sats,
        reserveNetwork: genuineContent.reserve_network,
        validitySeconds: 3600,
        proofUri: genuineContent.proof_uri,
        now: Math.floor(Date.now() / 1000),
      });
      const conflictingEvent = signPolEvidenceEvent(conflictingContent, generateSecretKey());
      mockState.nostrFetchSequence = [
        { events: [], relayReachable: true }, // attempt 1: nothing found yet (triggers the bounded retry)
        { events: [genuineEvent, conflictingEvent], relayReachable: true }, // attempt 2: the genuine event now indexed, ALONGSIDE a conflicting one — a relay-side equivocation, not a transient miss
      ];
      const { nostrLive, result } = await verifySubmission(ecash.submissionBundle);
      expect(nostrLive.verified).toBe(false);
      expect(nostrLive.reasonCode).toBe('REFUSE_NOSTR_CONFLICT');
      expect(result.reasonCode).toBe('REFUSE_NOSTR_CONFLICT');
    });
  });

  describe('bounded Esplora-fetch retry (submission.ts queryLiveChainState — transport failures only, never protocol results)', () => {
    it('A. attempt 1 is a transport failure, attempt 2 returns the correct state -> the query succeeds and (with everything else honest) verification reaches ACCEPT', async () => {
      const { runScenario, runEnforcement } = await import('./protocol-demo.js');
      mockState.esploraFailSequence = [true, false];
      const scenario = await runScenario('honest');
      expect(scenario.reserveLive.queryOk).toBe(true);
      expect(scenario.reserveLive.verified).toBe(true);
      expect(scenario.verifyResult.decision).toBe('ACCEPT');
      const { accepted } = await runEnforcement(scenario);
      expect(accepted).toBe(true);
    });

    it('B. both attempts are transport failures -> fails closed (queryOk: false), never a fabricated ACCEPT or a silently-assumed chain state', async () => {
      const { queryLiveChainState } = await import('./submission.js');
      const { fetchTxOutScript } = await import('../reserve/esplora.js');
      const fetchTxOutScriptMock = vi.mocked(fetchTxOutScript);
      fetchTxOutScriptMock.mockClear();
      mockState.esploraFailSequence = [true, true];
      const outpoint = liveAttestationEvidence.attestation.statement.outpoints[0]!;
      const live = await queryLiveChainState([{ txid: outpoint.txid, vout: outpoint.vout }]);
      expect(live.ok).toBe(false);
      expect(live.detail).toMatch(/failed after one retry/i);
      expect(fetchTxOutScriptMock).toHaveBeenCalledTimes(2); // bounded: exactly one retry, never more
    });

    it('single successful transport fetch is never retried, regardless of the protocol-level result it produces (covers C/D/E: spent, shortfall, and mismatch all resolve from ONE fetch — see reserve/evaluate.test.ts for those cases in isolation)', async () => {
      const { queryLiveChainState } = await import('./submission.js');
      const { fetchTxOutScript } = await import('../reserve/esplora.js');
      const fetchTxOutScriptMock = vi.mocked(fetchTxOutScript);
      fetchTxOutScriptMock.mockClear();
      const outpoint = liveAttestationEvidence.attestation.statement.outpoints[0]!;
      const live = await queryLiveChainState([{ txid: outpoint.txid, vout: outpoint.vout }]);
      expect(live.ok).toBe(true); // a successful fetch, whatever chain state it reports
      expect(fetchTxOutScriptMock).toHaveBeenCalledTimes(1); // no retry — nothing to retry, the transport succeeded
    });

    it('C. a real end-to-end spent-reserve case: single successful fetch reports spent -> REFUSE_RESERVE_UTXO_SPENT, no retry attempted', async () => {
      const { runScenario } = await import('./protocol-demo.js');
      const { fetchTxOutScript } = await import('../reserve/esplora.js');
      const fetchTxOutScriptMock = vi.mocked(fetchTxOutScript);
      fetchTxOutScriptMock.mockClear();
      mockState.reserveLive = { ok: true, spent: true };
      const scenario = await runScenario('honest');
      expect(scenario.reserveLive.queryOk).toBe(true);
      expect(scenario.reserveLive.reasonCode).toBe('REFUSE_RESERVE_UTXO_SPENT');
      expect(scenario.verifyResult.decision).toBe('REFUSE');
      expect(fetchTxOutScriptMock).toHaveBeenCalledTimes(1);
    });

    it('D. a real end-to-end reserve-shortfall case: single successful fetch reports insufficient coverage -> REFUSE_RESERVE_SHORT, no retry attempted', async () => {
      const { runScenario } = await import('./protocol-demo.js');
      const { verifySubmission } = await import('./submission.js');
      const { fetchTxOutScript } = await import('../reserve/esplora.js');
      const fetchTxOutScriptMock = vi.mocked(fetchTxOutScript);
      // runScenario builds the demo (its own live reserve query, to set a
      // real block_height) AND THEN independently verifies it (a second,
      // separate live reserve query) — clear the mock after building so
      // only the one verify-time query is counted below.
      const scenario = await runScenario('reserve-short');
      fetchTxOutScriptMock.mockClear();
      const { reserveLive, result } = await verifySubmission(scenario.submissionBundle);
      expect(reserveLive.queryOk).toBe(true);
      expect(reserveLive.reasonCode).toBe('REFUSE_RESERVE_SHORT');
      expect(result.decision).toBe('REFUSE');
      expect(fetchTxOutScriptMock).toHaveBeenCalledTimes(1);
    });
  });

  it('TEST I: the Live Public Demo\'s event genuinely IS found on a (mocked-as-real) public relay -> full live ACCEPT_VERIFIED, and accept() is reachable', async () => {
    const { runScenario, runEnforcement } = await import('./protocol-demo.js');
    const scenario = await runScenario('honest');
    expect(scenario.nostrLive.relayReachable).toBe(true);
    expect(scenario.nostrLive.eventFetched).toBe(true);
    expect(scenario.nostrLive.publicationVerified).toBe(true);
    expect(scenario.verifyResult.decision).toBe('ACCEPT');
    expect(scenario.verifyResult.reasonCode).toBe('ACCEPT_VERIFIED');
    const { accepted } = await runEnforcement(scenario);
    expect(accepted).toBe(true);
  });

  it('a reserve attestation whose block_height has fallen far behind the current tip (staleness) refuses with a distinct "expired demo evidence" reason, not a shortfall, mismatch, or generic REFUSE — and never ACCEPTs', async () => {
    const { runScenario, runEnforcement } = await import('./protocol-demo.js');
    // Force the mocked "current tip" to be comfortably past the network-aware
    // freshness budget (~19,830 blocks on Mutinynet's ~30.5s blocks for the
    // real ~1 week target — see maxAttestationAgeBlocks in
    // src/reserve/evaluate.ts) past the reference case's OWN attestation
    // block_height — deterministic staleness, not a real multi-day wait on
    // a real chain. It must be the attestation inside live-demo.json, the
    // one the live check verifies: `npm run live-demo` regenerates that file
    // but never evidence/reserves/live-attestation.json, so measuring from
    // the latter stops being "stale" as soon as the two drift apart (this
    // failed every scheduled refresh run once they were a day apart).
    mockState.tipHeightOverride = liveDemoEvidence.bundle.reserveAttestation.statement.block_height + 25_000;
    const scenario = await runScenario('honest');
    expect(scenario.reserveLive.queryOk).toBe(true);
    expect(scenario.reserveLive.verified).toBe(false);
    expect(scenario.reserveLive.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    expect(scenario.reserveLive.detail.toLowerCase()).toContain('stale');
    expect(scenario.verifyResult.decision).toBe('REFUSE');
    const { accepted } = await runEnforcement(scenario);
    expect(accepted).toBe(false);
  });

  it('the live check shows REFUSE / "LIVE EVIDENCE EXPIRED" (not a shortfall or generic REFUSE) when the reference case\'s reserve attestation is stale, and Accept stays disabled', async () => {
    // Same anchor as the test above — the live check's own attestation.
    mockState.tipHeightOverride = liveDemoEvidence.bundle.reserveAttestation.statement.block_height + 25_000;
    await runLiveCheck();
    expect(byId<HTMLElement>('decision-badge').textContent).toBe('✕ REFUSE');
    expect(byId<HTMLElement>('decision-headline').textContent).toBe('LIVE EVIDENCE EXPIRED.');
    expect(byId<HTMLElement>('decision-body').textContent).toMatch(/npm run live-demo/i);
    expect(factValue('decision-facts', 'Live reserve')).toBe('ATTESTATION EXPIRED');
    expect(byId<HTMLElement>('live-dates').textContent).toMatch(/EXPIRED \(/);
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
    expect(byId<HTMLElement>('accepted-panel').hidden).toBe(true);
  });
});

describe('SOLVENT web client (jsdom) — docs', () => {
  it('renders real documentation content from the actual markdown source files, with working sidebar navigation', async () => {
    await goToDocs();
    expect(byId<HTMLElement>('docs-nav').children.length).toBeGreaterThan(5);
    const content = byId<HTMLElement>('docs-doc-content');
    expect(content.textContent).toMatch(/SOLVENT/);
    const nostrLink = document.querySelector<HTMLButtonElement>('.docs-nav-link[data-doc="nostr-schema"]')!;
    nostrLink.click();
    await waitFor(() => window.location.hash.includes('nostr-schema'));
    await waitFor(() => byId<HTMLElement>('docs-doc-content').textContent!.includes('kind'));
    expect(byId<HTMLElement>('docs-doc-content').textContent).toMatch(/8181/);
  });

  it('renders the FAQ page from the shared FAQ data', async () => {
    window.location.hash = '#/docs?doc=faq';
    await waitFor(() => !byId<HTMLElement>('docs-faq-content').hidden);
    expect(byId<HTMLElement>('docs-faq-content').textContent).toMatch(/does solvent make a cashu mint trustless/i);
  });

  it('the sidebar lists every docs section, in order, and highlights the active one', async () => {
    window.location.hash = '#/docs?doc=trust-boundaries';
    await waitFor(() => byId<HTMLElement>('docs-doc-content').textContent!.includes('Trust boundaries'));
    const labels = Array.from(document.querySelectorAll('#docs-nav .docs-nav-link')).map((b) => b.textContent);
    expect(labels).toEqual(['Start here', 'Getting started', 'Protocol & architecture', 'Verification bundle schema', 'Nostr schema', 'Reserve attestation', 'Attack corpus', 'Trust boundaries', 'Draft alignment', 'Verify in 5 minutes', 'FAQ']);
    expect(document.querySelector('#docs-nav .docs-nav-link.active')?.textContent).toBe('Trust boundaries');
  });

  it('G. the desktop sidebar is sticky, and nothing above it silently disables sticky positioning', () => {
    // jsdom has no layout engine, so this checks the stylesheet itself; the
    // real scrolling behaviour is checked in a browser by verify-ui-browser.ts.
    const css = readFileSync(path.resolve(import.meta.dirname, 'style.css'), 'utf8');
    const sidebar = /\.docs-sidebar \{([^}]*)\}/.exec(css)![1]!;
    expect(sidebar).toMatch(/position: sticky/);
    expect(sidebar).toMatch(/align-self: start/);
    expect(sidebar).toMatch(/max-height: calc\(100vh/);
    expect(sidebar).toMatch(/overflow-y: auto/);
    expect(/\.docs-layout \{[^}]*grid-template-columns: (2[6-9]\d|300)px/.test(css)).toBe(true);
    // overflow-x: hidden on html+body makes body a scroll container that
    // never scrolls, which breaks every position: sticky beneath it.
    const root = /html,\s*body \{([^}]*)\}/.exec(css)![1]!;
    expect(root).toMatch(/overflow-x: clip;/);
    expect(root.lastIndexOf('overflow-x: clip')).toBeGreaterThan(root.lastIndexOf('overflow-x: hidden'));
  });

  it('H. the mobile docs menu (a labelled select) lists every section and navigates', async () => {
    await goToDocs();
    const select = byId<HTMLSelectElement>('docs-mobile-select');
    expect(document.querySelector('label[for="docs-mobile-select"]')?.textContent).toMatch(/docs menu/i);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['start-here', 'getting-started', 'protocol', 'verification-bundle', 'nostr-schema', 'reserve-attestation', 'attack-corpus', 'trust-boundaries', 'draft-alignment', 'verify-in-5', 'faq']);
    select.value = 'reserve-attestation';
    select.dispatchEvent(new Event('change'));
    await waitFor(() => window.location.hash.includes('reserve-attestation'));
    await waitFor(() => select.value === 'reserve-attestation' && byId<HTMLElement>('docs-doc-content').textContent!.length > 200);
    // Below 1024px the rail is hidden and this select replaces it — no
    // side-by-side sticky navigation on phones.
    const css = readFileSync(path.resolve(import.meta.dirname, 'style.css'), 'utf8');
    const narrow = /@media \(max-width: 1024px\) \{\s*\.docs-layout \{[\s\S]*?\.docs-mobile-select \{\s*display: block;/.exec(css)?.[0] ?? '';
    expect(narrow).toMatch(/\.docs-sidebar \{\s*position: static;/);
    expect(narrow).toMatch(/\.docs-nav \{\s*display: none;/);
  });
});
