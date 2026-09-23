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

async function selectAndRun(id: 'honest' | 'omitted' | 'reserve-short') {
  await goToVerify();
  const btn = document.querySelector<HTMLButtonElement>(`#mode-try .scenario-btn[data-scenario="${id}"]`);
  if (!btn) throw new Error(`missing scenario button for ${id}`);
  btn.click();
  const runBtn = byId<HTMLButtonElement>('run-verification-btn');
  await waitFor(() => !runBtn.disabled);
  runBtn.click();
  await waitFor(() => !byId<HTMLElement>('result').hidden, 8000);
}

describe('SOLVENT web client (jsdom) — manual verifier first-run state (Part 8, must run before anything else touches manual mode)', () => {
  it('shows a neutral, non-error first-run state — no premature "unsupported mint" before the user has pasted anything', async () => {
    await goToVerify();
    document.querySelector<HTMLButtonElement>('.mode-tab[data-mode="manual"]')!.click();
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

  it('the hero terminal is powered by a real runScenario("omitted") call, not hardcoded decoration', async () => {
    await goHome();
    expect(byId<HTMLElement>('hero-promised-epoch').textContent).toBe('12');
    expect(byId<HTMLElement>('hero-epoch-closed').textContent).toContain('CLOSED');
    expect(byId<HTMLElement>('hero-included').textContent).toContain('NO');
    const resultEl = byId<HTMLElement>('hero-result');
    expect(resultEl.textContent).toBe('REFUSE');
    expect(resultEl.className).toContain('red');
    expect(byId<HTMLElement>('hero-result-reason').textContent).toContain('REFUSE_ISSUANCE_OMITTED');
  });

  it('the problem section tells the broken-promise story, not the old v1 ratio-only story', async () => {
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

  it('the "Try with test ecash" hero CTA lands directly on the Create test ecash tab, even as an in-app same-document navigation (not just a fresh page load)', async () => {
    await goHome();
    // A real click on an in-app <a href="#/verify?mode=create"> is a
    // same-document hash change (hashchange event), not a fresh page load
    // — this specifically regression-tests that the deep link is re-synced
    // on every arrival at /verify, not only once at initial module load.
    document.querySelector<HTMLAnchorElement>('a[href="#/verify?mode=create"]')!.click();
    await waitFor(() => !byId<HTMLElement>('panel-verify').hidden);
    expect(byId<HTMLElement>('mode-create').hidden).toBe(false);
    expect(byId<HTMLElement>('mode-try').hidden).toBe(true);
    expect(document.querySelector('.mode-tab.active')?.getAttribute('data-mode')).toBe('create');
    const btn = byId<HTMLButtonElement>('create-ecash-btn');
    expect(btn.getBoundingClientRect).toBeDefined();
    expect(btn.hidden).toBe(false);
  });

  it('deep-linking into #/verify?mode=create a second time (from a different in-app starting point) still works', async () => {
    await goHome();
    document.querySelector<HTMLAnchorElement>('a[href="#/verify?mode=create"]')!.click();
    await waitFor(() => !byId<HTMLElement>('panel-verify').hidden);
    // Manually switch away, then navigate elsewhere and back in via the
    // same CTA hash again.
    document.querySelector<HTMLButtonElement>('.mode-tab[data-mode="manual"]')!.click();
    await goHome();
    document.querySelector<HTMLAnchorElement>('a[href="#/verify?mode=create"]')!.click();
    await waitFor(() => !byId<HTMLElement>('panel-verify').hidden);
    expect(document.querySelector('.mode-tab.active')?.getAttribute('data-mode')).toBe('create');
  });

  it('nav links reflect the active route, including the new Docs route', async () => {
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

describe('SOLVENT web client (jsdom) — verifier panel, "Try SOLVENT" mode, real v2 scenarios', () => {
  it('does not show a result until RUN VERIFICATION is explicitly clicked', async () => {
    await goToVerify();
    const btn = document.querySelector<HTMLButtonElement>('#mode-try .scenario-btn[data-scenario="honest"]')!;
    btn.click();
    expect(byId<HTMLElement>('result').hidden).toBe(true);
    expect(byId<HTMLButtonElement>('run-verification-btn').disabled).toBe(false);
  });

  it('HEALTHY / Live Public Demo case -> real public relay fetch finds the event -> ACCEPT_VERIFIED, enables Accept, all decision-chain steps pass', async () => {
    await selectAndRun('honest');
    const badge = byId<HTMLElement>('decision-badge');
    expect(badge.className).toContain('green');
    expect(byId<HTMLElement>('decision-headline').textContent).toContain('ACCEPT');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(false);
    const chain = byId<HTMLElement>('decision-chain');
    expect(chain.querySelectorAll('.chain-step-fail').length).toBe(0);
    // This specific case's ACCEPT rests on a genuine live relay fetch
    // finding the exact published event — not a privately-supplied copy.
    const evidence = byId<HTMLElement>('evidence-content');
    expect(evidence.textContent).toMatch(/FOUND \(public relay\)/);
    expect(evidence.textContent).toMatch(/REACHABLE/);
  });

  it('BROKEN PROMISE case -> REFUSE_ISSUANCE_OMITTED, Accept stays disabled, reserve/Nostr still show healthy', async () => {
    await selectAndRun('omitted');
    const badge = byId<HTMLElement>('decision-badge');
    expect(badge.className).toContain('red');
    expect(byId<HTMLElement>('decision-headline').textContent).toMatch(/broken promise/i);
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_ISSUANCE_OMITTED');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
    const chain = byId<HTMLElement>('decision-chain');
    const steps = Array.from(chain.querySelectorAll('.chain-step'));
    const mmrStep = steps.find((s) => s.textContent?.includes('Issuance included'));
    expect(mmrStep?.className).toContain('chain-step-fail');
    const reserveStep = steps.find((s) => s.textContent?.includes('Live reserve'));
    expect(reserveStep?.className).toContain('chain-step-ok');
    // Part 16: the contradiction must be shown explicitly, not as a bare "0".
    const evidence = byId<HTMLElement>('evidence-content');
    expect(evidence.textContent).toMatch(/receipt-promised issuance/i);
    expect(evidence.textContent).toMatch(/manifest-reported issuance/i);
    expect(evidence.textContent).toContain('70,000 sats');
  });

  it('RESERVE SHORTFALL case -> REFUSE_RESERVE_SHORT, issuance itself was correctly included', async () => {
    await selectAndRun('reserve-short');
    expect(byId<HTMLElement>('decision-headline').textContent).toMatch(/reserve shortfall/i);
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_RESERVE_SHORT');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
    const chain = byId<HTMLElement>('decision-chain');
    const steps = Array.from(chain.querySelectorAll('.chain-step'));
    const mmrStep = steps.find((s) => s.textContent?.includes('Issuance included'));
    expect(mmrStep?.className).toContain('chain-step-ok');
    // Part 17: reserve was VERIFIED (not "unverified") and simply insufficient.
    const evidence = byId<HTMLElement>('evidence-content');
    expect(evidence.textContent).toMatch(/reserve verified/i);
    expect(evidence.textContent).toMatch(/committed liabilities/i);
    expect(evidence.textContent).toMatch(/shortfall/i);
    expect(evidence.textContent).toMatch(/coverage/i);
    // The shortfall figures themselves must be the real, correctly computed
    // numbers (1,500,000 committed vs the real ~1,000,000-sat captured
    // reserve), not just present-but-arbitrary text.
    expect(evidence.textContent).toContain('1,500,000 sats');
    expect(evidence.textContent).toMatch(/500,000 sats/);
  });

  it('fails closed to REFUSE_UNVERIFIABLE when the live reserve query fails (never silently substitutes success)', async () => {
    mockState.reserveLive = { ok: false, spent: false };
    await selectAndRun('honest');
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_UNVERIFIABLE');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(true);
  });

  it('shows REFUSE_RESERVE_UTXO_SPENT when the live reserve query reports the UTXO spent', async () => {
    mockState.reserveLive = { ok: true, spent: true };
    await selectAndRun('honest');
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_RESERVE_UTXO_SPENT');
  });

  it('evidence drawer contains the required v2 sections (Cashu/PoL receipt/Epoch/Nostr/Reserve/Decision)', async () => {
    await selectAndRun('honest');
    const evidence = byId<HTMLElement>('evidence-content');
    expect(evidence.textContent).toContain('Cashu');
    expect(evidence.textContent).toContain('PoL receipt');
    expect(evidence.textContent).toContain('Epoch / MMR');
    expect(evidence.textContent).toContain('Nostr');
    expect(evidence.textContent).toContain('Reserve');
    expect(evidence.textContent).toContain('Decision');
    expect(evidence.querySelector('.raw-json-toggle')).not.toBeNull();
  });

  it('live status indicators reflect the mocked live reserve/Nostr checks, and Refresh evidence re-runs them (Part 13: this is public-infrastructure reachability, not a re-run of any decision)', async () => {
    await goToVerify();
    await waitFor(() => byId<HTMLElement>('live-status-reserve').textContent !== '…');
    expect(byId<HTMLElement>('live-status-reserve').textContent).toBe('REACHABLE');
    mockState.reserveLive = { ok: false, spent: false };
    byId<HTMLButtonElement>('refresh-evidence-btn').click();
    await waitFor(() => byId<HTMLElement>('live-status-reserve').textContent === 'UNREACHABLE');
  });
});

describe('SOLVENT web client (jsdom) — Gate 4 enforcement reaches the real acceptance boundary', () => {
  it('ACCEPT scenario: clicking Accept calls the real accept function and visibly transitions to ACCEPTED', async () => {
    await selectAndRun('honest');
    const acceptBtn = byId<HTMLButtonElement>('accept-btn');
    expect(acceptBtn.disabled).toBe(false);
    acceptBtn.click();
    const acceptedPanel = byId<HTMLElement>('accepted-panel');
    await waitFor(() => !acceptedPanel.hidden);
    expect(acceptedPanel.textContent).toMatch(/accepted/i);
    expect(acceptedPanel.textContent).toContain('CALLED ONCE');
    expect(acceptBtn.hidden).toBe(true);
    const evidence = byId<HTMLElement>('evidence-content');
    expect(evidence.textContent).toContain('accept() CALLED');
  });

  it('clicking Accept twice never calls the acceptance side effect twice (button is hidden after first accept)', async () => {
    await selectAndRun('honest');
    const acceptBtn = byId<HTMLButtonElement>('accept-btn');
    const acceptedPanel = byId<HTMLElement>('accepted-panel');
    acceptBtn.click();
    await waitFor(() => acceptBtn.hidden === true);
    // A hidden button cannot be clicked again by a real user; even a
    // programmatic click must not double-accept.
    acceptBtn.click();
    await waitFor(() => !acceptedPanel.hidden);
    expect(acceptedPanel.textContent?.match(/CALLED ONCE/g)?.length).toBe(1);
  });

  it('"Run another check" resets to the case-selection state without a full page reload', async () => {
    await selectAndRun('honest');
    byId<HTMLButtonElement>('run-again-btn').click();
    expect(byId<HTMLElement>('result').hidden).toBe(true);
    expect(byId<HTMLButtonElement>('run-verification-btn').disabled).toBe(true);
  });

  it('REFUSE scenario: Accept is disabled and cannot reach the acceptance side effect', async () => {
    await selectAndRun('omitted');
    const acceptBtn = byId<HTMLButtonElement>('accept-btn');
    expect(acceptBtn.disabled).toBe(true);
    const acceptedPanel = byId<HTMLElement>('accepted-panel');
    expect(acceptedPanel.hidden).toBe(true);
  });
});

async function switchToTab(mode: 'try' | 'create' | 'manual') {
  await goToVerify();
  document.querySelector<HTMLButtonElement>(`.mode-tab[data-mode="${mode}"]`)!.click();
  await waitFor(() => !byId<HTMLElement>(`mode-${mode}`).hidden);
}

describe('SOLVENT web client (jsdom) — Create test ecash (the real issuance/evidence journey)', () => {
  it('A. Create test ecash produces a real proof/token and a non-placeholder canonical verification bundle', async () => {
    await switchToTab('create');
    byId<HTMLButtonElement>('create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-ecash-result').hidden, 8000);

    const token = byId<HTMLElement>('create-token-value').textContent!;
    expect(token.startsWith('cashuB')).toBe(true);
    expect(byId<HTMLElement>('create-token-amount').textContent).toBe('70,000 sats');
    expect(byId<HTMLElement>('create-token-keyset').textContent).not.toBe('');
    expect(byId<HTMLElement>('create-token-mint').textContent).toMatch(/solvent-fixture-mint/);
    expect(byId<HTMLElement>('create-token-issued').textContent).not.toBe('');

    byId<HTMLButtonElement>('view-bundle-btn').click();
    const bundleText = byId<HTMLElement>('create-bundle-json').textContent!;
    const bundle = JSON.parse(bundleText);
    // Exactly the canonical SubmissionBundle shape — no invented UI-only fields.
    expect(bundle.proof).toBeDefined();
    expect(bundle.receipt).toBeDefined();
    expect(bundle.manifest).toBeDefined();
    expect(bundle.manifestSignature).toBeDefined();
    expect(bundle.masterPublicKeyHex).toBeDefined();
    expect(bundle.inclusionProof).toBeDefined();
    // Part 10: raw evidence only — never a pre-evaluated "this is already
    // verified" claim. A bundle a user can paste back in must not carry a
    // `reserve`/`nostr` verified boolean.
    expect(bundle.reserveAttestation).toBeDefined();
    expect(bundle.nostrEvent).toBeDefined();
    expect(bundle.reserve).toBeUndefined();
    expect(bundle.nostr).toBeUndefined();
  });

  it('B. Verifying the generated ecash passes every cryptographic gate, but cannot reach ACCEPT_VERIFIED because its fresh event was never publicly published (Part: two-tier Nostr verification)', async () => {
    await switchToTab('create');
    byId<HTMLButtonElement>('create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-ecash-result').hidden, 8000);
    byId<HTMLButtonElement>('create-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-result').hidden, 8000);

    // Every gate up to and including reserve coverage passed for real — only
    // the public-publication gate blocks this, and it must say so plainly,
    // not with a scary generic REFUSE. Relays WERE reachable (mocked as
    // such by default) but genuinely had nothing for this fresh identity —
    // REFUSE_NOSTR_EVENT_NOT_FOUND specifically, not REFUSE_NOSTR_UNAVAILABLE.
    expect(byId<HTMLElement>('create-decision-badge').textContent).toMatch(/publication not found/i);
    expect(byId<HTMLElement>('create-decision-headline').textContent).toMatch(/cryptographic check passed/i);
    const chain = byId<HTMLElement>('create-decision-chain');
    const steps = Array.from(chain.querySelectorAll('.chain-step'));
    const publicEvidenceStep = steps.find((s) => s.textContent?.includes('Public evidence'));
    expect(publicEvidenceStep?.className).toContain('chain-step-fail');
    // Every real crypto/accounting/reserve gate before it genuinely passed.
    for (const label of ['Token origin', 'Blind-signature proof', 'Mint receipt', 'Accounting period', 'Published accounting record', 'Issuance included', 'Live reserve']) {
      const step = steps.find((s) => s.textContent?.includes(label));
      expect(step?.className, `expected "${label}" to have passed`).toContain('chain-step-ok');
    }
    expect(byId<HTMLButtonElement>('create-accept-btn').disabled).toBe(true);
    // The evidence panel must show the honest breakdown, not just a badge.
    const evidence = byId<HTMLElement>('create-evidence-content');
    expect(evidence.textContent).toMatch(/NOT FOUND/);
    expect(evidence.textContent).toMatch(/CRYPTOGRAPHICALLY VALID/);
    expect(evidence.textContent).toMatch(/Public publication/i);
    expect(evidence.textContent).toMatch(/NOT VERIFIED/);
    // Relays were reachable but had nothing for this fresh identity — the
    // more specific REFUSE_NOSTR_EVENT_NOT_FOUND, never the generic
    // REFUSE_NOSTR_UNAVAILABLE (which means the relay layer itself failed).
    expect(evidence.textContent).toContain('REFUSE_NOSTR_EVENT_NOT_FOUND');
    // The cross-link to the real ACCEPT path must be offered.
    expect(byId<HTMLElement>('create-try-live-demo-btn').hidden).toBe(false);
  });

  it('C. UI: token visible, bundle viewable/copyable, Accept ecash stays disabled for fresh unpublished evidence, and "Try live public demo" reaches a real ACCEPT', async () => {
    await switchToTab('create');
    byId<HTMLButtonElement>('create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-ecash-result').hidden, 8000);
    // Accept must not exist/enable before verification has even run.
    expect(byId<HTMLElement>('create-result').hidden).toBe(true);

    byId<HTMLButtonElement>('create-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-result').hidden, 8000);
    const acceptBtn = byId<HTMLButtonElement>('create-accept-btn');
    expect(acceptBtn.disabled).toBe(true);

    byId<HTMLButtonElement>('create-try-live-demo-btn').click();
    await waitFor(() => byId<HTMLElement>('panel-verify').querySelector('.mode-tab[data-mode="try"]')?.classList.contains('active') === true);
    await waitFor(() => !byId<HTMLElement>('result').hidden, 8000);
    expect(byId<HTMLElement>('decision-badge').className).toContain('green');
    expect(byId<HTMLButtonElement>('accept-btn').disabled).toBe(false);
  });

  it('D. Manual round-trip: a bundle exported from Create test ecash is genuinely consumable by the manual verifier and reproduces the exact same PUBLICATION NOT FOUND outcome (not a fake ACCEPT)', async () => {
    await switchToTab('create');
    byId<HTMLButtonElement>('create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-ecash-result').hidden, 8000);
    byId<HTMLButtonElement>('view-bundle-btn').click();
    const exportedBundle = byId<HTMLElement>('create-bundle-json').textContent!;
    expect(exportedBundle.length).toBeGreaterThan(100);

    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = exportedBundle;
    byId<HTMLButtonElement>('manual-verify-btn').click();

    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    expect(byId<HTMLElement>('manual-decision-badge').className).not.toContain('green');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_NOSTR_EVENT_NOT_FOUND');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(true);
  });

  it('D2. Manual verifier reaches real ACCEPT_VERIFIED for a bundle whose evidence genuinely IS publicly retrievable (the Live Public Demo bundle, pasted manually)', async () => {
    const { runScenario } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const demo = await runScenario('honest');
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = submissionBundleToJson(demo.submissionBundle);
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    expect(byId<HTMLElement>('manual-decision-badge').className).toContain('green');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('ACCEPT_VERIFIED');
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(false);
  });

  it('F. a pasted bundle cannot fake acceptance by asserting fake reserve/nostr "verified" claims — verifySubmission() independently re-derives them and ignores the claim (Part 10)', async () => {
    await switchToTab('create');
    byId<HTMLButtonElement>('create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('create-ecash-result').hidden, 8000);
    byId<HTMLButtonElement>('view-bundle-btn').click();
    const exportedBundle = byId<HTMLElement>('create-bundle-json').textContent!;
    const bundle = JSON.parse(exportedBundle);
    // Strip the real (verifiable) reserve/Nostr evidence and replace it
    // with a bare, unbacked "already verified" claim — exactly the attack
    // Part 10 describes. If verify() ever trusted this, it would ACCEPT
    // with a fabricated 999,999,999-sat reserve.
    bundle.reserveAttestation = null;
    bundle.nostrEvent = null;
    bundle.reserve = { verified: true, reserveSats: 999_999_999 };
    bundle.nostr = { verified: true };

    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = JSON.stringify(bundle);
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);

    expect(byId<HTMLElement>('manual-decision-badge').className).not.toContain('green');
    expect(byId<HTMLElement>('manual-decision-headline').textContent).not.toContain('ACCEPT');
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_UNVERIFIABLE');
  });
});

describe('SOLVENT web client (jsdom) — verifier panel, "Verify your evidence" (manual) mode — error taxonomy (Part 9)', () => {
  it('INVALID JSON: unparseable text never runs verification and never accepts', async () => {
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = '{ this is not json ';
    byId<HTMLButtonElement>('manual-verify-btn').click();
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid json/i);
    expect(byId<HTMLElement>('manual-result').hidden).toBe(false);
    expect(byId<HTMLElement>('manual-accepted-panel').hidden).toBe(true);
  });

  it('INVALID JSON: an empty textarea does not show a misleading "unsupported mint" message', async () => {
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = '';
    byId<HTMLButtonElement>('manual-verify-btn').click();
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid json/i);
    expect(byId<HTMLElement>('manual-status').textContent).not.toMatch(/unsupported mint/i);
  });

  it('INCOMPLETE BUNDLE: valid JSON missing required fields is distinguished from invalid JSON', async () => {
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = '{ "not": "a real bundle" }';
    byId<HTMLButtonElement>('manual-verify-btn').click();
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/incomplete bundle/i);
    expect(byId<HTMLElement>('manual-result').hidden).toBe(false);
  });

  it('INVALID BUNDLE: every required field present, but one is malformed (not "unsupported mint")', async () => {
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = JSON.stringify({
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
    });
    byId<HTMLButtonElement>('manual-verify-btn').click();
    expect(byId<HTMLElement>('manual-status').textContent).toMatch(/invalid bundle/i);
    expect(byId<HTMLElement>('manual-result').hidden).toBe(false);
  });

  it('UNSUPPORTED MINT: a structurally valid, fully-formed bundle whose keyset verify() itself rejects (proof.id != keysetId) is labeled UNSUPPORTED MINT, not a generic REFUSE or a parse error', async () => {
    const { createTestEcash } = await import('./protocol-demo.js');
    const { submissionBundleToJson } = await import('./bundle-json.js');
    const ecash = await createTestEcash();
    const tampered = { ...ecash.submissionBundle, keysetId: `${ecash.submissionBundle.keysetId}00` };
    await switchToTab('manual');
    byId<HTMLTextAreaElement>('manual-bundle-input').value = submissionBundleToJson(tampered);
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 15000);
    expect(byId<HTMLElement>('manual-decision-badge').textContent).toMatch(/unsupported mint/i);
    expect(byId<HTMLElement>('manual-status').textContent).toContain('REFUSE_UNSUPPORTED_KEYSET');
    // Same as any other REFUSE_* case: the button stays visible but disabled
    // (only the pre-verify() parse-error branches hide it outright) — it
    // must never be enabled here.
    expect(byId<HTMLButtonElement>('manual-accept-btn').disabled).toBe(true);
  });

  it('none of the error taxonomy branches ever call the acceptance side effect', async () => {
    await switchToTab('manual');
    for (const bad of ['not json', '{}', '{ "reserveAttestation": null }']) {
      byId<HTMLTextAreaElement>('manual-bundle-input').value = bad;
      byId<HTMLButtonElement>('manual-verify-btn').click();
      expect(byId<HTMLElement>('manual-accept-btn').hidden).toBe(true);
      expect(byId<HTMLElement>('manual-accepted-panel').hidden).toBe(true);
    }
  });

  it('the "Don\'t have one?" cross-link switches to Create test ecash', async () => {
    await switchToTab('manual');
    byId<HTMLButtonElement>('manual-create-ecash-btn').click();
    await waitFor(() => !byId<HTMLElement>('mode-create').hidden);
    expect(byId<HTMLElement>('mode-manual').hidden).toBe(true);
  });

  it("Try SOLVENT's status line lives inside its own tab and does not leak a stale decision into Create/Manual tabs", async () => {
    await selectAndRun('reserve-short');
    expect(byId<HTMLElement>('status').textContent).toContain('REFUSE_RESERVE_SHORT');
    // #status must be a descendant of #mode-try specifically, not a
    // page-level element shared across all three tabs (it used to sit
    // after all three <section>s, so switching tabs left a stale REFUSE
    // message visible under a completely different mode's UI).
    expect(byId<HTMLElement>('mode-try').contains(byId<HTMLElement>('status'))).toBe(true);
    await switchToTab('manual');
    expect(byId<HTMLElement>('mode-try').hidden).toBe(true);
  });

  it('"Load example bundle" loads SOLVENT\'s stable Live Public Demo bundle (same real runScenario("honest") call the Try SOLVENT tab uses, not a hardcoded string) and it verifies to a real ACCEPT', async () => {
    await switchToTab('manual');
    byId<HTMLButtonElement>('manual-load-example-btn').click();
    await waitFor(() => byId<HTMLTextAreaElement>('manual-bundle-input').value.length > 100, 8000);
    const loaded = byId<HTMLTextAreaElement>('manual-bundle-input').value;
    const parsed = JSON.parse(loaded);
    expect(parsed.proof).toBeDefined();
    expect(parsed.nostrEvent).toBeDefined();
    byId<HTMLButtonElement>('manual-verify-btn').click();
    await waitFor(() => !byId<HTMLElement>('manual-result').hidden, 8000);
    expect(byId<HTMLElement>('manual-status').textContent).toContain('ACCEPT_VERIFIED');
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
    await selectAndRun('honest');
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
    // src/reserve/evaluate.ts) past this bundle's real attestation
    // block_height — deterministic staleness, not a real multi-day wait on
    // a real chain.
    mockState.tipHeightOverride = liveAttestationEvidence.attestation.statement.block_height + 25_000;
    const scenario = await runScenario('honest');
    expect(scenario.reserveLive.queryOk).toBe(true);
    expect(scenario.reserveLive.verified).toBe(false);
    expect(scenario.reserveLive.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    expect(scenario.reserveLive.detail.toLowerCase()).toContain('stale');
    expect(scenario.verifyResult.decision).toBe('REFUSE');
    const { accepted } = await runEnforcement(scenario);
    expect(accepted).toBe(false);
  });

  it('the UI shows "LIVE DEMO EVIDENCE EXPIRED" (not a shortfall or generic REFUSE) when the Live Public Demo\'s reserve attestation is stale, and Accept stays disabled', async () => {
    mockState.tipHeightOverride = liveAttestationEvidence.attestation.statement.block_height + 25_000;
    await selectAndRun('honest');
    expect(byId<HTMLElement>('decision-badge').textContent).toMatch(/live demo evidence expired/i);
    expect(byId<HTMLElement>('decision-headline').textContent).toMatch(/live demo evidence expired/i);
    expect(byId<HTMLElement>('decision-body').textContent).toMatch(/npm run live-demo/i);
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
});
