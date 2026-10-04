// #/mint — the primary real-backend flow: take ecash from a real patched CDK
// mint, show its signed promise, wait for the promised epoch to close and be
// published, then verify through the same verifySubmission() everything else
// uses. Nothing is decided in the browser: the NUT-06 identity, the Nostr
// event and the Bitcoin reserve are all fetched independently, and the
// Accept side effect goes through the real Gate 4 boundary
// (acceptance-store.ts).
//
// Broken-promise runs are race-free: the wallet builds its output first, so it
// knows the blinded message B_ before the mint does, and registers "omit
// exactly this issuance" with the evidence service BEFORE minting. The
// request therefore always exists before the issuance, and the epoch the
// issuance is promised to cannot close without it. A request the service
// refuses stops the run — a broken-promise click never quietly becomes an
// honest issuance.
//
// Configuration: VITE_SOLVENT_MINT_URL + VITE_SOLVENT_EVIDENCE_URL at build
// time (.env.production), or `#/mint?mint=<url>&evidence=<url>` at run time.
import { Mint, OutputData, Wallet, type Proof } from '@cashu/cashu-ts';
import { reconstruct, spentY } from '../cashu/reconstruct.js';
import { manifestDigestHex } from '../pol/manifest.js';
import { verifyIssuedReceipt } from '../pol/receipt.js';
import { acceptedRecord, enforce, type EnforcementOutcome } from './acceptance-store.js';
import { proofFromJson, proofToJson, submissionBundleFromJson } from './bundle-json.js';
import {
  bindCopyButtons,
  chainStates,
  copyWithFeedback,
  decisionCopy,
  decisionFacts,
  escapeHtml,
  formatUtc,
  lightningBackendLabel,
  mutinynetTxUrl,
  njumpUrl,
  nostrDiagnosticsHtml,
  primalUrl,
  renderDecision,
  resultClass,
} from './decision-view.js';
import { formatSats } from './format.js';
import { timeWithAgo } from './live-status.js';
import { relayAssistFor } from './relay-assist.js';
import { verifySubmission, type SubmissionVerification } from './submission.js';
import { checkMeltAccounting, checkSwapAccounting, executeMelt, executeSwap, proofStates, type MeltExecution, type OutputIssuance, type SpendResponse, type SwapExecution } from './live-swap.js';
import { invoicePaymentHash, invoiceTimes } from './bolt11.js';

export interface RealMintConfig {
  mintUrl: string;
  evidenceUrl: string;
}

interface Publishing {
  epoch_index: number;
  stage: 'observing-reserve' | 'publishing' | 'fetching-back';
  started_at: number;
  relays: string[];
  acked: string[];
  attempt: number;
}

interface SidecarStatus {
  mint_url: string;
  mint_identity_pubkey: string;
  lightning_backend: 'lnd' | 'ldk-node' | 'fakewallet';
  open_epoch: number;
  epoch_interval_seconds: number;
  next_close_at: number;
  demo_omission_enabled: boolean;
  demo_faucet_invoices?: boolean;
  spend_evidence?: boolean;
  last_publication?: { epoch_index: number; status: string; event_id: string | null; published_at: string; acked?: string[]; fetched_from?: string[] } | null;
  publishing?: Publishing | null;
  relays?: string[];
}

interface OmissionState {
  state: 'pending' | 'applied' | 'missed' | 'expired';
  epoch: number | null;
}

interface IssuanceResponse {
  state: 'EPOCH_OPEN' | 'EPOCH_CLOSED';
  target_epoch?: number;
  next_close_at?: number;
  omission?: OmissionState | null;
  publishing?: Publishing | null;
  publication_status?: 'published' | 'unpublished' | 'failed' | 'pending';
  publication_detail?: string;
  published_at?: string | null;
  publication_relays?: { acked: string[]; fetched_from: string[] } | null;
  evidence?: Record<string, unknown>;
}

/** What a run keeps so it can be re-verified (and restored after a reload) without minting again. */
interface MintRun {
  mode: 'honest' | 'omit';
  cfg: RealMintConfig;
  proof: ReturnType<typeof proofToJson>;
  publicKey: string;
  bm: string;
  epoch: number;
  startedAt: string;
}

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const AMOUNT = 64;
const RUN_KEY = 'solvent.mint.lastRun.v1';
const SWAP_KEY = 'solvent.mint.swaps.v1';
const MELT_KEY = 'solvent.mint.melts.v1';
const HONEST_KEY = 'solvent.mint.lastHonest.v1';
const MELT_INVOICE_SATS = 40;
const trim = (u: string) => u.replace(/\/+$/, '');

/** Run-time query overrides build-time configuration; both URLs are required. */
export function configFromLocation(hash: string, buildEnv: Record<string, string | undefined> = env): RealMintConfig | null {
  const q = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
  const mintUrl = q.get('mint') ?? buildEnv.VITE_SOLVENT_MINT_URL;
  const evidenceUrl = q.get('evidence') ?? buildEnv.VITE_SOLVENT_EVIDENCE_URL;
  if (!mintUrl || !evidenceUrl || !/^https?:\/\//.test(mintUrl) || !/^https?:\/\//.test(evidenceUrl)) return null;
  return { mintUrl: trim(mintUrl), evidenceUrl: trim(evidenceUrl) };
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let status: SidecarStatus | null = null;
let busy = false;
let current: { run: MintRun; evidence: IssuanceResponse | null; verification: SubmissionVerification | null } | null = null;

// -------------------- current-operation card --------------------

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Brings an element into view only if it is not already visible — never scroll-jacks a reader who looked away. */
function reveal(target: HTMLElement, block: ScrollLogicalPosition, withinTop = 1): void {
  const r = target.getBoundingClientRect();
  const topbar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
  // Already on screen (and, when asked, in the top part of it, so what follows it is readable too).
  if (r.top >= topbar && r.bottom <= window.innerHeight && r.top <= window.innerHeight * withinTop) return;
  target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block });
}

/** Is the reader watching the operation card (any part of it on screen)? */
function watchingOp(): boolean {
  const r = el('mint-op').getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

let opTimer: ReturnType<typeof setInterval> | null = null;
let opStarted = 0;

function opStart(title: string): void {
  const card = el('mint-op');
  card.hidden = false;
  card.dataset.state = 'running';
  el('mint-op-title').textContent = title;
  el('mint-steps').innerHTML = '';
  el('mint-steps').hidden = false;
  opDetail('');
  opStarted = Date.now();
  const tick = () => (el('mint-op-elapsed').textContent = `${Math.round((Date.now() - opStarted) / 1000)}s elapsed`);
  tick();
  if (opTimer) clearInterval(opTimer);
  opTimer = setInterval(tick, 1000);
  reveal(card, 'center');
}

function opDetail(text: string): void {
  el('mint-op-detail').textContent = text;
}

function opEnd(state: 'done' | 'failed'): void {
  if (opTimer) clearInterval(opTimer);
  opTimer = null;
  el('mint-op').dataset.state = state;
  el('mint-op-elapsed').textContent = `${Math.round((Date.now() - opStarted) / 1000)}s`;
}

function step(text: string, state: 'run' | 'ok' | 'fail' | 'info' = 'run'): HTMLElement {
  const li = document.createElement('li');
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
  const watching = watchingOp();
  el('mint-steps').appendChild(li);
  // Keep the newest step in view while the reader is following the operation.
  if (watching) reveal(li, 'nearest');
  return li;
}

function settle(li: HTMLElement, text: string, state: 'ok' | 'fail' | 'info'): void {
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
}

function setButtons(disabled: boolean, reason = ''): void {
  el<HTMLButtonElement>('mint-honest-btn').disabled = disabled;
  el<HTMLButtonElement>('mint-omit-btn').disabled = disabled;
  el('mint-busy-reason').textContent = disabled ? reason : '';
}

async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as T };
}

const host = (u: string) => u.replace(/^wss:\/\//, '').replace(/\/$/, '');

// -------------------- the mint + live status --------------------

function renderReality(cfg: RealMintConfig, info: { name?: string; version?: string; pubkey?: string }, s: SidecarStatus): void {
  const lightning = lightningBackendLabel(s.lightning_backend).text;
  const rows: [string, string][] = [
    ['Mint', `${info.name ?? 'Cashu mint'} — ${cfg.mintUrl}`],
    ['Evidence service', `${cfg.evidenceUrl} (closes and publishes epochs; reports the mint's status)`],
    ['Cashu mint', `Real CDK mint (${info.version ?? 'cdk-mintd'}), patched with SOLVENT's PoL receipts`],
    ['Mint identity (NUT-06)', info.pubkey ?? 'not advertised'],
    ['Liability accounting', `Real epochs, closed about every ${s.epoch_interval_seconds}s when they hold liabilities`],
    ['Public evidence', `Real public Nostr relays (kind 8181): ${(s.relays ?? []).map(host).join(', ') || 'configured relays'}`],
    ['Bitcoin reserve', 'Real Mutinynet (Bitcoin Signet) UTXO, re-queried when you verify'],
    ['Lightning settlement', lightning],
  ];
  el('mint-reality').innerHTML = rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
  renderLiveStatus(s);
}

/** Live Railway state — labelled as live, with real times, never mistaken for the captured reference case. */
function renderLiveStatus(s: SidecarStatus): void {
  const p = s.last_publication;
  const box = el('mint-live-status');
  const checked = `status checked ${timeWithAgo(Date.now())}`;
  box.innerHTML = p
    ? `<span class="live-tag">LIVE RAILWAY MINT</span> Last publication: epoch ${p.epoch_index} · ${escapeHtml(p.status)} · ${timeWithAgo(p.published_at)}${p.event_id ? ` · event <a href="${njumpUrl(p.event_id)}" target="_blank" rel="noopener noreferrer"><code>${p.event_id.slice(0, 12)}…</code> ↗</a>` : ''} · open epoch ${s.open_epoch} · ${checked}`
    : `<span class="live-tag">LIVE RAILWAY MINT</span> No epoch published yet — the first issuance closes one. Open epoch ${s.open_epoch} · ${checked}`;
}

/** Loads the mint and sidecar status each time the route is entered. */
export async function enterRealMintPanel(): Promise<void> {
  const cfg = configFromLocation(window.location.hash);
  el('mint-unconfigured').hidden = cfg !== null;
  el('mint-configured').hidden = cfg === null;
  if (!cfg || busy) return;
  setStatus('Connecting to the mint…');
  try {
    const [info, st] = await Promise.all([getJson<{ name?: string; version?: string; pubkey?: string }>(`${cfg.mintUrl}/v1/info`), getJson<SidecarStatus>(`${cfg.evidenceUrl}/v1/solvent/status`)]);
    status = st.body;
    document.documentElement.dataset.lightning = lightningBackendLabel(st.body.lightning_backend).real ? 'real' : 'demo';
    renderReality(cfg, info.body, st.body);
    el('mint-omit-btn').hidden = !st.body.demo_omission_enabled;
    el('mint-omit-note').hidden = !st.body.demo_omission_enabled;
    el('mint-attack').hidden = !st.body.demo_omission_enabled;
    setStatus(trim(st.body.mint_url) !== cfg.mintUrl ? `Warning: the evidence service is configured for ${st.body.mint_url}, not ${cfg.mintUrl}. Verification will refuse a mismatch.` : '');
  } catch (err) {
    setStatus(`Could not reach the mint or its evidence service: ${(err as Error).message}`);
  }
  if (!current) restoreLastRun(cfg);
  updateLifecycle();
}

function setStatus(text: string): void {
  el('mint-status').textContent = text;
}

// -------------------- where you are: the lifecycle, your ecash, the promise --------------------

type LcState = 'pending' | 'current' | 'done' | 'failed';
type StoredMelt = { verdict: string; ok: boolean; meltedAt: string; change?: { amount: number }[]; invoice?: string };

function lastHonest(): MintRun | null {
  try {
    return JSON.parse(localStorage.getItem(HONEST_KEY) ?? 'null') as MintRun | null;
  } catch {
    return null;
  }
}

function saveHonest(run: MintRun | null): void {
  try {
    if (run) localStorage.setItem(HONEST_KEY, JSON.stringify(run));
    else localStorage.removeItem(HONEST_KEY);
  } catch {
    /* not persisted */
  }
}

const unitText = () => (lightningBackendLabel(status?.lightning_backend).real ? 'test sats' : 'demo sats');
const payOffered = () => lightningBackendLabel(status?.lightning_backend).real && !!status?.demo_faucet_invoices;

/** Steps 1-5 of the honest journey, from what this browser holds. A broken-promise run never moves them. */
function updateLifecycle(): void {
  const cfg = configFromLocation(window.location.hash);
  const saved = lastHonest();
  const honest = current?.run.mode === 'honest' ? current.run : saved && saved.cfg.mintUrl === cfg?.mintUrl ? saved : null;
  const live = honest && current?.run.bm === honest.bm ? current : null;
  const accepted = honest ? acceptedRecord(proofFromJson(honest.proof)) : undefined;
  const refused = !accepted && live?.verification && resultClass(live.verification.result, live.verification.reserveLive, live.verification.nostrLive) === 'refusal';
  const swap = honest ? storedSwaps()[spentYOf(honest.proof)] : undefined;
  const melt = swap ? (storedMelts()[swap.exec.inputY] as StoredMelt | undefined) : undefined;
  const states: Record<string, LcState> = {
    mint: honest ? 'done' : 'current',
    verify: accepted ? 'done' : refused ? 'failed' : honest ? 'current' : 'pending',
    accept: accepted ? 'done' : refused ? 'failed' : 'pending',
    swap: swap?.ok ? 'done' : swap && swap.ok === false ? 'failed' : accepted && status?.spend_evidence ? 'current' : 'pending',
    pay: melt?.ok ? 'done' : melt && melt.verdict && !/checking/.test(melt.verdict) && !melt.ok ? 'failed' : swap?.ok && payOffered() ? 'current' : 'pending',
  };
  for (const li of Array.from(el('mint-lifecycle').querySelectorAll<HTMLElement>('li'))) {
    const st = states[li.dataset.step ?? ''] ?? 'pending';
    li.dataset.state = st;
    if (st === 'current') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }

  const wallet = el('mint-wallet');
  wallet.hidden = !honest;
  if (!honest) return;
  const unit = unitText();
  const trail = [`minted`];
  let amount = `${AMOUNT} ${unit}`;
  if (accepted) trail.push('ACCEPTED ✓');
  else if (refused) trail.push('NOT ACCEPTED ✕');
  else trail.push('verifying…');
  if (swap?.ok) {
    trail.push('SWAPPED ✓');
    amount = `${swap.exec.outputs.reduce((a, o) => a + o.amount, 0)} ${unit}`;
  }
  if (melt?.ok) {
    const left = (melt.change ?? []).reduce((a, c) => a + c.amount, 0);
    trail.push('PAID ✓');
    amount = `${left} ${unit} remaining`;
  }
  el('mint-wallet-amount').textContent = amount;
  el('mint-wallet-state').textContent = trail.join(' → ');
}

/** The mint's signed promise for this issuance, in plain words, before the evidence exists. */
function showPromise(run: MintRun, epochState: string): void {
  const card = el('mint-promise');
  card.hidden = false;
  card.querySelector('.step-kicker')!.textContent = run.mode === 'omit' ? 'The attack · verify' : 'Step 2 · Verify';
  el('mint-promise-line').textContent = `The mint promised to count this issuance in epoch ${run.epoch}.`;
  el('mint-promise-receipt').textContent = 'SIGNED ✓';
  el('mint-promise-epoch').textContent = String(run.epoch);
  el('mint-promise-status').textContent = epochState;
  el('mint-checks').hidden = true;
}

/** The eight checks, grouped into what a person asks: did the mint sign it, promise it, count it, publish it, cover it? */
function showChecks(v: SubmissionVerification): void {
  const st = chainStates(v.result);
  const groups: [string, number[]][] = [
    ['Mint signature', [1]],
    ['Promise (signed receipt)', [2]],
    ['Closed epoch', [3, 4]],
    ['Your issuance included', [5]],
    ['Public Nostr evidence', [6]],
    ['Reserve', [7]],
  ];
  el('mint-checks').innerHTML = groups
    .map(([label, idx]) => {
      const s2 = idx.map((i) => st[i] ?? 'na');
      const mark = s2.some((x) => x === 'fail') ? 'fail' : s2.every((x) => x === 'ok') ? 'ok' : 'na';
      return `<li data-state="${mark}"><span class="hl-mark" aria-hidden="true">${mark === 'ok' ? '✓' : mark === 'fail' ? '✕' : '–'}</span>${escapeHtml(label)}<span class="hl-word">${mark === 'ok' ? 'VALID' : mark === 'fail' ? (label === 'Your issuance included' ? 'MISSING' : 'FAILED') : 'NOT CHECKED'}</span></li>`;
    })
    .join('');
  el('mint-checks').hidden = false;
}

/** An honest run lives in steps 1-3; a broken-promise run plays out inside the attack section. */
function placeRun(mode: 'honest' | 'omit'): void {
  if (mode === 'omit') {
    el('mint-attack-flow').append(el('mint-op'), el('mint-promise'), el('mint-result'));
  } else {
    el('mint-step-mint').appendChild(el('mint-op'));
    el('mint-flow').append(el('mint-promise'), el('mint-result'));
  }
}

// -------------------- one run --------------------

async function activeKeyset(cfg: RealMintConfig): Promise<{ id: string; keys: Record<string, string> }> {
  const ks = (await new Mint(cfg.mintUrl).getKeys()).keysets.find((k) => k.unit === 'sat');
  if (!ks) throw new Error('the mint has no sat keyset');
  return { id: ks.id, keys: ks.keys as Record<string, string> };
}

async function obtainEcash(cfg: RealMintConfig, custom: OutputData | null): Promise<Proof> {
  const wallet = new Wallet(cfg.mintUrl);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(AMOUNT);
  const real = lightningBackendLabel(status?.lightning_backend).real;
  const pay = step(real ? '' : `The mint issued a ${AMOUNT}-sat invoice (demo fakewallet: it settles itself).`);
  // Real Lightning: the visitor funds the invoice. Nothing on this page or server pays it for them.
  const times = invoiceTimes(quote.request);
  const deadline = times ? times.expiresAt * 1000 : Date.now() + 600_000;
  if (real) {
    pay.innerHTML = `<div class="pay-box">
      <p class="pay-box-lead"><strong>Fund this test invoice over Mutinynet Lightning.</strong> These are test sats with no monetary value.</p>
      <dl class="pay-box-facts"><div><dt>Amount</dt><dd>${AMOUNT} sats (Mutinynet)</dd></div><div><dt>Expires</dt><dd><span id="mint-pay-expiry"></span></dd></div><div><dt>Status</dt><dd id="mint-pay-status">waiting for payment — checked every second</dd></div></dl>
      <code class="pay-box-invoice" id="mint-pay-invoice">${escapeHtml(quote.request)}</code>
      <button type="button" class="btn btn-solid btn-sm" id="mint-pay-copy">Copy invoice</button>
      <p class="pay-box-how">No Mutinynet wallet? Open <a href="https://faucet.mutinynet.com/" target="_blank" rel="noopener noreferrer">faucet.mutinynet.com</a>, sign in with GitHub, paste this invoice where it asks for a BOLT11 invoice, and pay. Any Mutinynet (signet) Lightning wallet works too.</p>
    </div>`;
    el('mint-pay-copy').addEventListener('click', (e) => void copyWithFeedback(e.currentTarget as HTMLButtonElement, quote.request));
  }
  opDetail(real ? 'Waiting for you to pay the invoice…' : 'Waiting for the invoice to be paid…');
  const tickExpiry = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const e = document.getElementById('mint-pay-expiry');
    if (e) e.textContent = `${formatUtc(new Date(deadline).toISOString())} (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left)`;
  };
  tickExpiry();
  let paid = false;
  while (Date.now() < deadline) {
    if ((await wallet.checkMintQuoteBolt11(quote.quote)).state === 'PAID') {
      paid = true;
      break;
    }
    tickExpiry();
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!paid) throw new Error('the invoice expired unpaid — nothing was minted');
  const statusEl = document.getElementById('mint-pay-status');
  if (statusEl) statusEl.textContent = 'paid — the mint saw the payment on its own Lightning node';
  if (real) pay.className = 'mint-step mint-step-ok';
  else settle(pay, `Invoice for ${AMOUNT} sats paid.`, 'ok');
  const proofs = custom
    ? await wallet.mintProofsBolt11(AMOUNT, quote.quote, undefined, { type: 'custom', data: [custom] })
    : await wallet.mintProofsBolt11(AMOUNT, quote.quote);
  return proofs.find((p) => Number(p.amount) === AMOUNT) ?? proofs[0]!;
}

function publishingText(p: Publishing): string {
  const acked = p.acked.length ? ` ACK from ${p.acked.map(host).join(', ')}.` : '';
  if (p.stage === 'observing-reserve') return `Epoch ${p.epoch_index} closed. Observing the Mutinynet reserve for its evidence…`;
  if (p.stage === 'publishing') return `Publishing epoch ${p.epoch_index}'s evidence to ${p.relays.length} public relays (attempt ${p.attempt}): ${p.acked.length}/${p.relays.length} acknowledged.${acked}`;
  return `Fetching epoch ${p.epoch_index}'s event back from the relays by id (attempt ${p.attempt})…${acked}`;
}

/** Polls until the promised epoch is closed AND its publication has settled. */
async function waitForEvidence(run: MintRun): Promise<IssuanceResponse> {
  const wait = step(`3. Waiting for epoch ${run.epoch} to close and be published…`);
  const deadline = Date.now() + ((status?.epoch_interval_seconds ?? 30) * 4 + 180) * 1000;
  while (Date.now() < deadline) {
    const r = (await getJson<IssuanceResponse>(`${run.cfg.evidenceUrl}/v1/solvent/issuance/${run.bm}`)).body;
    if (r.state === 'EPOCH_CLOSED' && r.publication_status !== 'pending') {
      el('mint-promise-status').textContent = r.publication_status === 'published' ? `EPOCH ${run.epoch} CLOSED ✓ · PUBLISHED TO NOSTR ✓` : `EPOCH ${run.epoch} CLOSED · NOT PUBLISHED`;
      const relays = r.publication_relays;
      settle(
        wait,
        `3. Epoch ${run.epoch} closed and ${r.publication_status === 'published' ? `published ${r.published_at ? formatUtc(r.published_at) : ''} — ACKed by ${relays?.acked.map(host).join(', ') || 'none'}; fetched back from ${relays?.fetched_from.map(host).join(', ') || 'none'}` : `NOT published (${r.publication_detail ?? r.publication_status})`}.`,
        r.publication_status === 'published' ? 'ok' : 'info',
      );
      return r;
    }
    el('mint-promise-status').textContent = r.state === 'EPOCH_OPEN' ? `WAITING FOR EPOCH ${run.epoch} TO CLOSE` : `EPOCH ${run.epoch} CLOSED · PUBLISHING`;
    if (r.state === 'EPOCH_OPEN') {
      const left = Math.max(0, (r.next_close_at ?? status?.next_close_at ?? 0) - Math.floor(Date.now() / 1000));
      opDetail(left > 0 ? `Waiting for epoch ${run.epoch} to close — expected in about ${left}s (epochs close about every ${status?.epoch_interval_seconds ?? 30}s).` : `Waiting for epoch ${run.epoch} to close — due now.`);
    } else {
      opDetail(r.publishing ? publishingText(r.publishing) : `Epoch ${run.epoch} closed; waiting for its public evidence to be published…`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  settle(wait, `3. Epoch ${run.epoch} was not closed and published in time.`, 'fail');
  throw new Error(`epoch ${run.epoch} was not closed and published in time — use Retry verification to check again without minting`);
}

async function verifyRun(run: MintRun, evidence: IssuanceResponse): Promise<SubmissionVerification> {
  opDetail('Checking the receipt, the closed accounting state, the public Nostr evidence and the live reserve…');
  const verifying = step('4. Verifying: receipt · closed accounting state · public evidence · reserve coverage…');
  const bundle = submissionBundleFromJson(JSON.stringify({ ...evidence.evidence, proof: run.proof, amountPublicKeyHex: run.publicKey }));
  const v = await verifySubmission(bundle, undefined, undefined, undefined, { assistedRelayFetch: relayAssistFor(run.cfg.evidenceUrl) });
  settle(verifying, `4. Verification finished: ${v.result.reasonCode}.`, v.result.decision === 'ACCEPT' ? 'ok' : 'fail');
  showChecks(v);
  return v;
}

function saveRun(run: MintRun): void {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch {
    /* not persisted: this page still works */
  }
}

async function run(mode: 'honest' | 'omit'): Promise<void> {
  const cfg = configFromLocation(window.location.hash);
  if (!cfg || busy) return;
  busy = true;
  current = null;
  el('mint-result').hidden = true;
  el('mint-promise').hidden = true;
  // A new honest issuance starts a new journey; the attack leaves the finished one in place.
  if (mode === 'honest') saveHonest(null);
  placeRun(mode);
  setButtons(true, mode === 'omit' ? 'A broken-promise run is in progress — see the operation below.' : 'An issuance is in progress — see the operation below.');
  opStart(mode === 'omit' ? 'Breaking the promise: minting ecash the mint will leave out of its books' : 'Minting an honest issuance and verifying it');
  try {
    const keyset = await activeKeyset(cfg);
    let custom: OutputData | null = null;
    let legacyOmit = false;
    if (mode === 'omit') {
      // Build the output first: its B_ is registered before the mint ever sees it.
      custom = OutputData.createSingleRandomData(AMOUNT, keyset.id);
      const bm = custom.blindedMessage.B_;
      opDetail('Registering the broken-promise request for this exact issuance…');
      const r = await getJson<{ error?: string; state?: string }>(`${cfg.evidenceUrl}/v1/solvent/demo/omit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blinded_message: bm }) });
      if (r.status === 404) {
        // An evidence service from before pre-registration: it only accepts a
        // request for an existing issuance, so register right after minting.
        legacyOmit = true;
        step('This evidence service accepts the broken-promise request only after issuance; it is sent right after minting.', 'info');
      } else if (r.status !== 202) {
        throw new Error(`the evidence service did not accept the broken-promise request (${r.body.error ?? `HTTP ${r.status}`}). Nothing was minted, so nothing ran as an honest issuance instead.`);
      } else {
        step(`Broken-promise request registered for issuance ${bm.slice(0, 12)}… — before minting, so the epoch cannot close without it.`, 'info');
      }
    }
    const proof = await obtainEcash(cfg, custom);
    const publicKey = keyset.keys[String(proof.amount)]!;
    step(`1. The mint gave you ${Number(proof.amount)} sats of ecash (keyset ${proof.id.slice(0, 16)}…).`, 'ok');

    const recon = reconstruct(proof, proof.id, publicKey);
    if (!recon.valid || !recon.bPrimeHex) throw new Error('the ecash carries no valid NUT-12 DLEQ proof');
    const bm = recon.bPrimeHex;
    if (custom && bm !== custom.blindedMessage.B_) throw new Error('the mint signed a different output than the one registered');
    const receipt = (await getJson<{ status: string; target_epoch?: number; signature?: string }>(`${cfg.mintUrl}/v1/solvent/pol-receipt/${bm}`)).body;
    if (receipt.status !== 'signed' || receipt.target_epoch === undefined || !verifyIssuedReceipt({ target_epoch: receipt.target_epoch, signature: receipt.signature! }, bm, publicKey)) {
      throw new Error(`the mint's liability receipt is missing or invalid (status ${receipt.status})`);
    }
    step(`2. The mint signed a promise to count this issuance in accounting epoch ${receipt.target_epoch}.`, 'ok');
    if (legacyOmit) {
      const r2 = await getJson<{ error?: string }>(`${cfg.evidenceUrl}/v1/solvent/demo/omit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blinded_message: bm }) });
      if (r2.status !== 202) throw new Error(`the evidence service did not accept the broken-promise request after minting (${r2.body.error ?? `HTTP ${r2.status}`}). This issuance was not made a broken promise, so it is not presented as one.`);
    }
    if (mode === 'omit') step(`Demo: the mint's real epoch closer will leave this issuance out of epoch ${receipt.target_epoch}.`, 'info');

    const r: MintRun = { mode, cfg, proof: proofToJson(proof), publicKey, bm, epoch: receipt.target_epoch, startedAt: new Date().toISOString() };
    saveRun(r);
    if (mode === 'honest') saveHonest(r);
    current = { run: r, evidence: null, verification: null };
    showPromise(r, `WAITING FOR EPOCH ${r.epoch} TO CLOSE`);
    updateLifecycle();
    const evidence = await waitForEvidence(r);
    current.evidence = evidence;
    // Older services do not report the request's state; the verdict alone then shows it.
    if (mode === 'omit' && evidence.omission !== undefined && evidence.omission?.state !== 'applied') {
      step(`This issuance was NOT omitted (request ${evidence.omission?.state ?? 'unknown'}): this run is not a broken promise. It is verified below as what it is.`, 'fail');
    }
    const v = await verifyRun(r, evidence);
    current.verification = v;
    opEnd('done');
    showResult();
  } catch (err) {
    step(`Stopped: ${(err as Error).message}`, 'fail');
    opEnd('failed');
    if (current?.run) showRetryOnly();
  } finally {
    busy = false;
    setButtons(false);
    updateLifecycle();
  }
}

async function retry(): Promise<void> {
  if (!current || busy) return;
  busy = true;
  // The shown result belongs to the previous check: withdraw it while this one runs.
  el('mint-result').hidden = true;
  setButtons(true, 'Re-verifying the same issuance…');
  opStart(`Retrying verification of the same issuance (epoch ${current.run.epoch}) — no new ecash is minted`);
  try {
    const r = (await getJson<IssuanceResponse>(`${current.run.cfg.evidenceUrl}/v1/solvent/issuance/${current.run.bm}`)).body;
    const evidence = r.state === 'EPOCH_CLOSED' && r.publication_status !== 'pending' ? r : await waitForEvidence(current.run);
    current.evidence = evidence;
    current.verification = await verifyRun(current.run, evidence);
    opEnd('done');
    showResult();
  } catch (err) {
    step(`Stopped: ${(err as Error).message}`, 'fail');
    opEnd('failed');
  } finally {
    busy = false;
    setButtons(false);
  }
}

function restoreLastRun(cfg: RealMintConfig): void {
  let saved: MintRun | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null') as MintRun | null;
  } catch {
    saved = null;
  }
  if (!saved || saved.cfg.mintUrl !== cfg.mintUrl) return;
  current = { run: saved, evidence: null, verification: null };
  placeRun(saved.mode);
  showPromise(saved, 'NOT RE-CHECKED YET — use Retry verification');
  const card = el('mint-op');
  card.hidden = false;
  card.dataset.state = 'restored';
  el('mint-op-title').textContent = `Your last issuance, restored from this browser (${saved.mode === 'omit' ? 'broken-promise run' : 'honest run'}, epoch ${saved.epoch}, ${formatUtc(saved.startedAt)})`;
  el('mint-op-elapsed').textContent = '';
  const rec = acceptedRecord(proofFromJson(saved.proof));
  opDetail(rec ? `Accepted ${formatUtc(rec.acceptedAt)} — accept function calls recorded: ${rec.acceptCalls}.` : 'Not accepted. Retry verification to check it again without minting.');
  el('mint-steps').innerHTML = '';
  showRetryOnly();
}

// -------------------- the result --------------------

function showRetryOnly(): void {
  el('mint-retry-btn').hidden = false;
  el('mint-result').hidden = true;
}

function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function publicEvidence(): Record<string, unknown> {
  const { run, evidence, verification } = current!;
  const e = evidence!.evidence as Record<string, unknown>;
  return {
    schema: 'solvent/public-evidence/v1',
    note: 'Public evidence only: no Cashu proof secret. Everything here is public or signed by the mint.',
    mint: run.cfg.mintUrl,
    evidence_service: run.cfg.evidenceUrl,
    blinded_message: run.bm,
    promised_epoch: run.epoch,
    receipt: e.receipt,
    delegation: e.delegation,
    manifest: e.manifest,
    manifest_signature: e.manifestSignature,
    manifest_key: e.masterPublicKeyHex,
    inclusion_proof: e.inclusionProof,
    nostr_event: e.nostrEvent,
    reserve_attestation: e.reserveAttestation,
    reserve_binding: e.reserveBinding,
    published_at: evidence!.published_at,
    decision: verification
      ? { decision: verification.result.decision, reason_code: verification.result.reasonCode, checked_at: verification.nostrLive.attemptedAt, nostr_retrieval: verification.nostrLive.retrievalPath, reserve: verification.reserveLive.detail }
      : null,
  };
}

function replayBundle(): Record<string, unknown> {
  const { run, evidence } = current!;
  return { ...(evidence!.evidence as Record<string, unknown>), proof: run.proof, amountPublicKeyHex: run.publicKey };
}

function enforcementHtml(o: EnforcementOutcome): string {
  const rows: [string, string][] =
    o.decision === 'ACCEPT'
      ? [
          ['Decision', o.reasonCode],
          ['Accept function calls (this issuance)', String(o.totalCalls)],
          ['Calls made by this verification', o.alreadyAccepted ? '0 — already accepted earlier; not accepted twice' : String(o.callsThisRun)],
          ['Accepted record stored', o.recordStored ? 'yes' : 'no'],
          ['Accepted at', o.acceptedAt ? formatUtc(o.acceptedAt) : '—'],
          ['Store records', `${o.storeSizeBefore} → ${o.storeSizeAfter}`],
        ]
      : [
          ['Decision', o.reasonCode],
          ['Accept function calls', String(o.callsThisRun)],
          ['Accepted record stored', o.recordStored ? 'yes (accepted earlier)' : 'no'],
          ['Store changed', o.storeSizeAfter === o.storeSizeBefore ? 'no' : 'YES'],
        ];
  return `<p class="enforce-title">Enforcement — what the verdict actually did</p>
    <dl class="evidence-rows">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
    <p class="enforce-scope">The acceptance store is SOLVENT's local reference application store in this browser. It proves the verdict gates a real side effect (real Cashu token encoding, committed once); it is not a universal Cashu wallet.</p>`;
}

function evidenceCardHtml(v: SubmissionVerification): string {
  const { run, evidence } = current!;
  const e = evidence!.evidence as { manifest: Parameters<typeof manifestDigestHex>[0]; nostrEvent?: { id: string } | null; reserveAttestation?: { statement: { outpoints: { txid: string; vout: number }[] } } | null; receipt: { target_epoch: number } };
  const eventId = e.nostrEvent?.id ?? null;
  const outpoint = e.reserveAttestation?.statement.outpoints[0] ?? null;
  const fetched = evidence!.publication_relays?.fetched_from ?? [];
  const rows: [string, string][] = [
    ['Mint identity (NUT-06)', v.mintIdentityLive?.pubkey ?? v.mintIdentityLive?.detail ?? '—'],
    ['Receipt target epoch', String(e.receipt.target_epoch)],
    ['Manifest digest', manifestDigestHex(e.manifest)],
    ['Nostr event', eventId ?? 'none'],
    ['Published', evidence!.published_at ? `${formatUtc(evidence!.published_at)} — ACKed and fetched back by the mint from ${fetched.map(host).join(', ') || 'no relay'}` : '—'],
    ['Retrieved by this browser', v.nostrLive.retrievalPath === 'direct' ? 'directly from public relays' : v.nostrLive.retrievalPath === 'evidence-service' ? 'via the HTTPS relay fetch (then verified here)' : 'not retrieved'],
    ['Reserve', outpoint ? `${outpoint.txid}:${outpoint.vout}` : '—'],
    ['Reserve amount', v.reserveLive.queryOk ? `${formatSats(v.reserveLive.verifiedReserveSats)} (just queried)` : 'not queried'],
    ['Checked at', v.nostrLive.attemptedAt ? formatUtc(v.nostrLive.attemptedAt) : formatUtc(new Date())],
    ['Final reason', v.result.reasonCode],
  ];
  const actions = [
    eventId ? `<a class="btn btn-outline btn-sm" href="${njumpUrl(eventId)}" target="_blank" rel="noopener noreferrer">Open Nostr event ↗</a>` : '',
    eventId ? `<a class="btn btn-outline btn-sm" href="${primalUrl(eventId)}" target="_blank" rel="noopener noreferrer">Alternate viewer ↗</a>` : '',
    outpoint ? `<a class="btn btn-outline btn-sm" href="${mutinynetTxUrl(outpoint.txid)}" target="_blank" rel="noopener noreferrer">Open reserve transaction ↗</a>` : '',
    eventId ? `<button type="button" class="btn btn-outline btn-sm copy-evidence-btn" data-copy="${escapeHtml(eventId)}">Copy event ID</button>` : '',
    `<button type="button" class="btn btn-outline btn-sm copy-evidence-btn" data-copy="${escapeHtml(JSON.stringify(e.receipt))}">Copy receipt</button>`,
    `<button type="button" class="btn btn-outline btn-sm" id="mint-dl-public">Download public evidence</button>`,
    `<button type="button" class="btn btn-outline btn-sm" id="mint-dl-replay">Download full replay bundle…</button>`,
  ].join('');
  return `<p class="enforce-title">Evidence for this issuance (${run.mode === 'omit' ? 'broken-promise run' : 'honest run'})</p>
    <dl class="evidence-rows evidence-rows-wrap">${rows.map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`).join('')}</dl>
    <div class="evidence-links">${actions}</div>
    <div id="mint-replay-warning" class="replay-warning" hidden>
      <p>This bundle contains the Cashu proof secret and can represent spendable ecash until the proof is spent. On this test-network mint it has no monetary value, but treat it as money on a mainnet mint.</p>
      <button type="button" class="btn btn-solid btn-sm" id="mint-dl-replay-confirm">Download it anyway</button>
    </div>
    <p class="explorer-note">External viewers can be unavailable; SOLVENT does not need them. The signed event it verified is below.</p>
    <details class="evidence"><summary>The signed Nostr event SOLVENT verified (raw)</summary><pre class="raw-json">${escapeHtml(JSON.stringify((evidence!.evidence as { nostrEvent?: unknown }).nostrEvent ?? null, null, 2))}</pre></details>
    <details class="evidence"><summary>Public retrieval, relay by relay</summary>${nostrDiagnosticsHtml(v.nostrLive)}</details>`;
}

function showResult(): void {
  const v = current!.verification!;
  const { result, reserveLive, nostrLive } = v;
  const cls = resultClass(result, reserveLive, nostrLive);
  renderDecision(
    { badge: el('mint-decision-badge'), headline: el('mint-decision-headline'), body: el('mint-decision-body'), facts: el('mint-decision-facts'), chain: el('mint-decision-chain') },
    { kind: result.decision, copy: decisionCopy(result, reserveLive, nostrLive, 'evidence'), facts: decisionFacts(result, reserveLive, nostrLive), states: chainStates(result), cls },
  );
  el('mint-result').dataset.reasonCode = result.reasonCode;
  el('mint-result').dataset.resultClass = cls;
  const omitRun = current!.run.mode === 'omit';
  el('mint-result-step').textContent = omitRun ? 'The attack · result' : 'Step 3 · Accept';
  if (result.reasonCode === 'ACCEPT_VERIFIED') el('mint-decision-body').textContent = 'The mint kept its accounting promise for this ecash.';
  if (result.reasonCode === 'REFUSE_ISSUANCE_OMITTED') {
    el('mint-decision-body').textContent = `The mint signed a promise to count this issuance in epoch ${current!.run.epoch}, then closed epoch ${current!.run.epoch} without it. Every signature is valid; the promise is broken.`;
  }
  const outcomeE = enforce(v.verifyInput);
  const line = el('mint-accept-line');
  line.dataset.ok = String(outcomeE.decision === 'ACCEPT');
  line.innerHTML =
    outcomeE.decision === 'ACCEPT'
      ? `<code>accept()</code> called exactly once${outcomeE.alreadyAccepted ? ' — this re-check called it 0 more times' : ''}`
      : `<code>accept()</code> NOT CALLED`;
  el('mint-promise-status').textContent = `EPOCH ${current!.run.epoch} CLOSED · CHECKED`;
  showChecks(v);
  el('mint-enforcement').innerHTML = enforcementHtml(outcomeE);
  el('mint-evidence-card').innerHTML = evidenceCardHtml(v);
  bindCopyButtons(el('mint-evidence-card'));
  el('mint-dl-public').addEventListener('click', () => download(`solvent-public-evidence-epoch-${current!.run.epoch}.json`, publicEvidence()));
  el('mint-dl-replay').addEventListener('click', () => (el('mint-replay-warning').hidden = false));
  el('mint-dl-replay-confirm').addEventListener('click', () => download(`solvent-replay-bundle-epoch-${current!.run.epoch}.json`, replayBundle()));
  el('mint-technical').innerHTML = `<details><summary>Raw verification result (JSON)</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`;
  // The op card's retry is for runs that could not complete; the result's own
  // retry re-checks a finished honest run (or a could-not-complete one) in place.
  el('mint-retry-btn').hidden = cls !== 'availability';
  el('mint-result-retry-btn').hidden = cls === 'refusal';
  el('mint-result-actions-note').textContent =
    cls === 'refusal'
      ? 'This refusal is proven from the published evidence, so re-checking it would give the same answer. Start again mints a new issuance.'
      : 'Retry re-checks this exact issuance against the public relays and the reserve now; it mints nothing and never accepts twice. Start again mints a new one.';
  el('mint-swap-steps').innerHTML = '';
  el('mint-swap-verdict').hidden = true;
  el('mint-swap-facts').hidden = true;
  el('mint-swap-checks').hidden = true;
  el('mint-pay-steps').innerHTML = '';
  el('mint-pay-verdict').hidden = true;
  el('mint-pay-facts').hidden = true;
  el('mint-pay-checks').hidden = true;
  showSwapSection(cls);
  el('mint-result').hidden = false;
  updateLifecycle();
  // The decision is the point of the run: bring its headline into view.
  reveal(el('mint-decision-badge'), 'start', 0.4);
}

// -------------------- spend it: the live NUT-03 swap --------------------

interface StoredSwap {
  exec: { inputY: string; inputAmount: number; fee: number; swappedAt: string; outputs: { blindedMessage: string; amount: number; y: string; proof: Record<string, unknown> }[] };
  verdict: string | null;
  ok: boolean | null;
}

function storedSwaps(): Record<string, StoredSwap> {
  try {
    return JSON.parse(localStorage.getItem(SWAP_KEY) ?? '{}') as Record<string, StoredSwap>;
  } catch {
    return {};
  }
}

function saveSwap(s: StoredSwap): void {
  try {
    localStorage.setItem(SWAP_KEY, JSON.stringify({ ...storedSwaps(), [s.exec.inputY]: s }));
  } catch {
    /* not persisted: the swap itself already happened at the mint */
  }
}

function swapStep(text: string, state: 'run' | 'ok' | 'fail' | 'info' = 'run'): HTMLElement {
  const li = document.createElement('li');
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
  el('mint-swap-steps').appendChild(li);
  return li;
}

/** Shown under an accepted honest result only; a proof that was already swapped shows what happened instead. */
function showSwapSection(cls: string): void {
  const run = current?.run;
  const accepted = run ? acceptedRecord(proofFromJson(run.proof)) : null;
  const section = el('mint-swap');
  // Only where the mint's books can be checked for it: an evidence service that serves spent-side evidence.
  section.hidden = !(run && run.mode === 'honest' && cls === 'accept' && accepted && status?.spend_evidence);
  if (section.hidden || !run) return;
  const prior = storedSwaps()[spentYOf(run.proof)];
  el<HTMLButtonElement>('mint-swap-btn').disabled = !!prior;
  el<HTMLButtonElement>('mint-swap-btn').textContent = prior ? 'Already swapped' : 'Swap ecash';
  if (prior && el('mint-swap-steps').childElementCount === 0) {
    swapStep(`Swapped ${formatUtc(prior.exec.swappedAt)}: 1 proof (${prior.exec.inputAmount} sats) → ${prior.exec.outputs.length} proofs (${prior.exec.outputs.map((o) => o.amount).join(' + ')}).`, 'info');
    if (prior.verdict) setSwapVerdict(prior.verdict, prior.ok === true);
  }
  showPaySection();
}

// -------------------- pay with it: a real NUT-05 melt (real-Lightning mints only) --------------------

function payStep(text: string, state: 'run' | 'ok' | 'fail' | 'info' = 'run'): HTMLElement {
  const li = document.createElement('li');
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
  el('mint-pay-steps').appendChild(li);
  return li;
}

function setPayVerdict(text: string, ok: boolean): void {
  const v = el('mint-pay-verdict');
  v.hidden = false;
  v.dataset.ok = String(ok);
  v.textContent = text;
}

function storedMelts(): Record<string, { verdict: string; ok: boolean; meltedAt: string }> {
  try {
    return JSON.parse(localStorage.getItem(MELT_KEY) ?? '{}') as Record<string, { verdict: string; ok: boolean; meltedAt: string }>;
  } catch {
    return {};
  }
}

/** Offered only on a mint whose Lightning is real, once its swap verified; on fakewallet a "payment" would not be one. */
function showPaySection(): void {
  const run = current?.run;
  const swap = run ? storedSwaps()[spentYOf(run.proof)] : undefined;
  const section = el('mint-pay');
  section.hidden = !(run && swap?.ok && lightningBackendLabel(status?.lightning_backend).real && status?.demo_faucet_invoices);
  if (section.hidden || !swap) return;
  const prior = storedMelts()[swap.exec.inputY];
  el<HTMLButtonElement>('mint-pay-btn').disabled = !!prior;
  el<HTMLButtonElement>('mint-pay-btn').textContent = prior ? 'Already paid' : 'Pay with ecash';
  if (prior && el('mint-pay-steps').childElementCount === 0) {
    payStep(`Paid ${formatUtc(prior.meltedAt)}.`, 'info');
    setPayVerdict(prior.verdict, prior.ok);
  }
}

async function payWithAccepted(): Promise<void> {
  if (!current || busy) return;
  const run = current.run;
  const swap = storedSwaps()[spentYOf(run.proof)];
  const delegation = (current.evidence?.evidence as { delegation?: { manifest_pubkey?: string } } | undefined)?.delegation;
  if (!swap?.ok || !delegation?.manifest_pubkey) return;
  busy = true;
  setButtons(true, 'A payment is in progress — see below.');
  const btn = el<HTMLButtonElement>('mint-pay-btn');
  btn.disabled = true;
  el('mint-pay-steps').innerHTML = '';
  el('mint-pay-verdict').hidden = true;
  el('mint-pay-facts').hidden = true;
  el('mint-pay-checks').hidden = true;
  let exec: MeltExecution | null = null;
  try {
    const s1 = payStep(`1. Getting a ${MELT_INVOICE_SATS}-sat Lightning invoice from the public Mutinynet faucet…`);
    const inv = await getJson<{ bolt11?: string; error?: string }>(`${run.cfg.evidenceUrl}/v1/solvent/demo/invoice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount_sats: MELT_INVOICE_SATS }) });
    if (inv.status !== 200 || !inv.body.bolt11) throw new Error(inv.body.error ?? `no invoice (HTTP ${inv.status})`);
    const invoice = inv.body.bolt11;
    settle(s1, `1. Invoice from the Mutinynet faucet: ${MELT_INVOICE_SATS} sats, payment hash ${invoicePaymentHash(invoice)?.slice(0, 16) ?? '?'}….`, 'ok');

    const s2 = payStep('2. Melting the swapped ecash at the mint (NUT-05) — the mint pays the invoice over Lightning…');
    const proofs = swap.exec.outputs.map((o) => proofFromJson(o.proof));
    exec = await executeMelt(run.cfg.mintUrl, proofs, invoice, (secs) => {
      s2.textContent = `2. The Lightning payment is still in flight (${secs}s) — following the mint's melt quote until it settles…`;
    });
    try {
      localStorage.setItem(MELT_KEY, JSON.stringify({ ...storedMelts(), [swap.exec.inputY]: { verdict: 'paid; checking…', ok: false, meltedAt: exec.meltedAt } }));
    } catch {
      /* not persisted */
    }
    settle(s2, `2. Paid ${exec.invoiceAmount} sats (fee reserve ${exec.feeReserve}); ${exec.change.length} change proof(s) returned (${exec.change.map((c) => c.amount).join(' + ') || 'none'}).`, 'ok');

    const s3 = payStep('3. Asking the mint (NUT-07) for the state of the spent inputs and the change…');
    const states = await proofStates(run.cfg.mintUrl, [...exec.inputs.map((i) => i.y), ...exec.change.map((c) => c.y)]);
    const inStates = exec.inputs.map((i) => states[i.y] ?? 'unknown');
    const chStates = exec.change.map((c) => states[c.y] ?? 'unknown');
    const statesOk = inStates.every((x) => x === 'SPENT') && chStates.every((x) => x === 'UNSPENT');
    settle(s3, `3. NUT-07: inputs ${[...new Set(inStates)].join('/')}; change ${[...new Set(chStates)].join('/') || '—'}.`, statesOk ? 'ok' : 'fail');

    const s4 = payStep('4. Waiting for the epoch that recorded the payment to close…');
    const spends: SpendResponse[] = [];
    for (const i of exec.inputs) {
      const r = await pollUntil(
        async () => getJson<SpendResponse & { error?: string }>(`${run.cfg.evidenceUrl}/v1/solvent/spend/${i.y}`),
        (x) => x.status !== 200 || x.body.state === 'EPOCH_CLOSED',
        ((status?.epoch_interval_seconds ?? 30) * 4 + 60) * 1000,
        (x) => (s4.textContent = `4. The payment is recorded in open epoch ${x.body.target_epoch}; waiting for it to close…`),
      );
      if (r.status !== 200) throw new Error(r.body.error ?? 'no spent-side evidence');
      spends.push(r.body);
    }
    settle(s4, `4. Epoch ${spends[0]!.target_epoch} closed.`, 'ok');

    const s5 = payStep('5. Checking the payment proof and the mint\u2019s accounting…');
    const issuances: Record<string, OutputIssuance> = {};
    for (const row of spends[0]!.operation.issued) issuances[row.blinded_message] = (await getJson<OutputIssuance>(`${run.cfg.evidenceUrl}/v1/solvent/issuance/${row.blinded_message}`)).body;
    const keyset = await activeKeyset(run.cfg);
    const acct = checkMeltAccounting(exec, spends, issuances, delegation.manifest_pubkey, keyset.keys);
    settle(s5, `5. ${acct.checks.filter((c) => c.ok).length}/${acct.checks.length} checks pass.`, acct.ok ? 'ok' : 'fail');

    const paidOk = acct.checks.some((c) => /^Invoice paid/.test(c.label) && c.ok);
    const changeSum = exec.change.reduce((a, c) => a + c.amount, 0);
    const facts: [string, string][] = [
      ['Lightning', `${paidOk ? 'PAID ✓' : 'NOT PROVEN ✕'} — ${exec.invoiceAmount} sats to the Mutinynet faucet; the preimage matches payment hash ${invoicePaymentHash(exec.invoice)?.slice(0, 16) ?? '—'}…`],
      ['Cashu inputs', `${exec.inputs.reduce((a, i) => a + i.amount, 0)} sats · ${[...new Set(inStates)].join('/')}`],
      ['Change', `RETURNED — ${changeSum} sats · ${[...new Set(chStates)].join('/') || '—'}`],
      ['Lightning fee', `${acct.feePaid} sats (reserve ${exec.feeReserve})`],
      ['Accounting', `${acct.ok ? 'UPDATED ✓' : 'NOT VERIFIED ✕'} — liability ${acct.liabilityBefore === null ? '—' : formatSats(acct.liabilityBefore)} → ${acct.liabilityAfter === null ? '—' : formatSats(acct.liabilityAfter)} (epoch ${acct.epoch}, signed)`],
      ['Remaining', `${changeSum} ${unitText()}`],
      ['Proof of payment', exec.paymentPreimage ? `preimage ${exec.paymentPreimage}` : 'no preimage returned'],
    ];
    el('mint-pay-facts').innerHTML = facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
    el('mint-pay-facts').hidden = false;
    el('mint-pay-check-list').innerHTML = acct.checks.map((c) => `<li>${c.ok ? '✓' : '✕'} ${escapeHtml(c.label)} — ${escapeHtml(c.detail)}</li>`).join('');
    el('mint-pay-checks').hidden = false;
    const ok = statesOk && acct.ok;
    setPayVerdict(
      ok
        ? 'PAYMENT COMPLETE — the mint paid a Mutinynet Lightning invoice with your ecash, returned your change, and its books fell by exactly what was paid.'
        : 'PAYMENT NOT VERIFIED — see the failing checks below.',
      ok,
    );
    try {
      localStorage.setItem(
        MELT_KEY,
        JSON.stringify({
          ...storedMelts(),
          [swap.exec.inputY]: {
            verdict: el('mint-pay-verdict').textContent ?? '', ok, meltedAt: exec.meltedAt,
            invoice: exec.invoice, preimage: exec.paymentPreimage, epoch: acct.epoch, feePaid: acct.feePaid,
            liabilityBefore: acct.liabilityBefore, liabilityAfter: acct.liabilityAfter,
            inputs: exec.inputs, change: exec.change.map((c) => ({ y: c.y, amount: c.amount, proof: proofToJson(c.proof) })),
          },
        }),
      );
    } catch {
      /* not persisted */
    }
  } catch (err) {
    payStep(`Stopped: ${(err as Error).message}`, 'fail');
    if (!exec) btn.disabled = false;
  } finally {
    busy = false;
    setButtons(false);
    btn.textContent = exec ? 'Already paid' : 'Pay with ecash';
    updateLifecycle();
  }
}

function spentYOf(proof: Record<string, unknown>): string {
  return spentY(String(proof.secret));
}

function setSwapVerdict(text: string, ok: boolean): void {
  const v = el('mint-swap-verdict');
  v.hidden = false;
  v.dataset.ok = String(ok);
  v.textContent = text;
}

async function pollUntil<T>(fetchOnce: () => Promise<T>, done: (t: T) => boolean, timeoutMs: number, onWait?: (t: T) => void): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await fetchOnce();
    if (done(t) || Date.now() > deadline) return t;
    onWait?.(t);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function swapAccepted(): Promise<void> {
  if (!current || busy) return;
  const run = current.run;
  const delegation = (current.evidence?.evidence as { delegation?: { manifest_pubkey?: string } } | undefined)?.delegation;
  if (!delegation?.manifest_pubkey) return;
  busy = true;
  setButtons(true, 'A swap is in progress — see below.');
  const btn = el<HTMLButtonElement>('mint-swap-btn');
  btn.disabled = true;
  el('mint-swap-steps').innerHTML = '';
  el('mint-swap-verdict').hidden = true;
  el('mint-swap-facts').hidden = true;
  el('mint-swap-checks').hidden = true;
  let exec: SwapExecution | null = null;
  try {
    const keyset = await activeKeyset(run.cfg);
    const keysets = (await getJson<{ keysets: { id: string; input_fee_ppk?: number }[] }>(`${run.cfg.mintUrl}/v1/keysets`)).body.keysets;
    const inputFeePpk = keysets.find((k) => k.id === keyset.id)?.input_fee_ppk ?? 0;
    const s1 = swapStep('1. Sending the accepted proof to the mint\'s /v1/swap with four new blinded outputs…');
    exec = await executeSwap(run.cfg.mintUrl, proofFromJson(run.proof), { ...keyset, inputFeePpk });
    const stored: StoredSwap = {
      exec: { ...exec, outputs: exec.outputs.map((o) => ({ blindedMessage: o.blindedMessage, amount: o.amount, y: o.y, proof: proofToJson(o.proof) })) },
      verdict: null,
      ok: null,
    };
    saveSwap(stored);
    settle(s1, `1. Swapped: 1 proof (${exec.inputAmount} sats) → ${exec.outputs.length} proofs (${exec.outputs.map((o) => o.amount).join(' + ')} sats), fee ${exec.fee}.`, 'ok');

    const s2 = swapStep('2. Asking the mint (NUT-07) for the state of the old and new proofs…');
    const states = await proofStates(run.cfg.mintUrl, [exec.inputY, ...exec.outputs.map((o) => o.y)]);
    const oldState = states[exec.inputY] ?? 'unknown';
    const newStates = exec.outputs.map((o) => states[o.y] ?? 'unknown');
    const statesOk = oldState === 'SPENT' && newStates.every((x) => x === 'UNSPENT');
    settle(s2, `2. NUT-07: old proof ${oldState}; replacements ${newStates.join(', ')}.`, statesOk ? 'ok' : 'fail');

    const s3 = swapStep('3. Waiting for the epoch that recorded the swap to close…');
    const spendUrl = `${run.cfg.evidenceUrl}/v1/solvent/spend/${exec.inputY}`;
    const spend = await pollUntil(
      async () => getJson<SpendResponse & { error?: string }>(spendUrl),
      (r) => r.status !== 200 || r.body.state === 'EPOCH_CLOSED',
      ((status?.epoch_interval_seconds ?? 30) * 4 + 60) * 1000,
      (r) => (s3.textContent = `3. The swap is recorded in open epoch ${r.body.target_epoch}; waiting for it to close…`),
    );
    if (spend.status !== 200) {
      const missing = spend.body.error === 'not found';
      settle(s3, missing ? '3. This evidence service does not serve spent-side evidence yet (/v1/solvent/spend).' : `3. ${spend.body.error ?? 'no spent-side evidence'}`, 'fail');
      setSwapVerdict(
        missing
          ? 'SWAP DONE, ACCOUNTING NOT CHECKABLE HERE — the swap is real (NUT-07 above), but this evidence service predates spent-side evidence, so the mint\'s books cannot be checked for it.'
          : 'SWAP DONE, ACCOUNTING CHECK FAILED — no spent-side record for this proof.',
        false,
      );
      saveSwap({ ...stored, verdict: el('mint-swap-verdict').textContent, ok: false });
      return;
    }
    settle(s3, `3. Epoch ${spend.body.target_epoch} closed.`, 'ok');

    const s4 = swapStep('4. Fetching each replacement output\'s receipt and inclusion proof…');
    const issuances: Record<string, OutputIssuance> = {};
    for (const o of exec.outputs) {
      issuances[o.blindedMessage] = (await getJson<OutputIssuance>(`${run.cfg.evidenceUrl}/v1/solvent/issuance/${o.blindedMessage}`)).body;
    }
    const acct = checkSwapAccounting(exec, spend.body, issuances, delegation.manifest_pubkey, keyset.keys);
    settle(s4, `4. Accounting: ${acct.checks.filter((c) => c.ok).length}/${acct.checks.length} checks pass.`, acct.ok ? 'ok' : 'fail');

    // Usable: the largest replacement proof goes through the full SOLVENT verification on its own.
    const biggest = exec.outputs.reduce((a, b) => (b.amount > a.amount ? b : a));
    const s5 = swapStep(`5. Verifying the ${biggest.amount}-sat replacement proof end to end (receipt, epoch, Nostr, reserve)…`);
    const issUrl = `${run.cfg.evidenceUrl}/v1/solvent/issuance/${biggest.blindedMessage}`;
    const iss = await pollUntil(
      async () => (await getJson<IssuanceResponse>(issUrl)).body,
      (r) => r.state === 'EPOCH_CLOSED' && r.publication_status !== 'pending',
      180_000,
      (r) => (s5.textContent = `5. Waiting for epoch ${r.target_epoch}'s public evidence (${r.publication_status ?? 'pending'})…`),
    );
    const bundle = submissionBundleFromJson(JSON.stringify({ ...iss.evidence, proof: proofToJson(biggest.proof), amountPublicKeyHex: keyset.keys[String(biggest.amount)] }));
    const rv = await verifySubmission(bundle, undefined, undefined, undefined, { assistedRelayFetch: relayAssistFor(run.cfg.evidenceUrl) });
    settle(s5, `5. Replacement proof: ${rv.result.reasonCode}.`, rv.result.decision === 'ACCEPT' ? 'ok' : 'fail');

    const after = exec.outputs.reduce((a, o) => a + o.amount, 0);
    const conserved = acct.operationNetLiability === -exec.fee;
    const spentRows = acct.checks.filter((c) => /spent sum-MMR/.test(c.label));
    const committed = spentRows.length > 0 && spentRows.every((c) => c.ok);
    const facts: [string, string][] = [
      ['Original proof', `${exec.inputAmount} sats · ${oldState}`],
      ['Replacement proofs', `${exec.outputs.map((o) => o.amount).join(' + ')} sats · ${[...new Set(newStates)].join('/')}`],
      ['Value', `${exec.inputAmount} sats before → ${after} sats after${exec.fee ? ` (fee ${exec.fee})` : ''}`],
      ['Liability', `${conserved ? 'CONSERVED ✓' : 'NOT CONSERVED ✕'} — ${acct.liabilityBefore === null ? '—' : formatSats(acct.liabilityBefore)} → ${acct.liabilityAfter === null ? '—' : formatSats(acct.liabilityAfter)} (epochs ${acct.epoch - 1} → ${acct.epoch}, signed)`],
      ['Spent accounting', `${committed ? 'COMMITTED ✓' : 'NOT COMMITTED ✕'} — the original proof is in epoch ${acct.epoch}'s signed spent commitment`],
      ['Replacement ecash', `${rv.result.reasonCode}`],
    ];
    el('mint-swap-facts').innerHTML = facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
    el('mint-swap-facts').hidden = false;
    el('mint-swap-check-list').innerHTML = acct.checks.map((c) => `<li>${c.ok ? '✓' : '✕'} ${escapeHtml(c.label)} — ${escapeHtml(c.detail)}</li>`).join('');
    el('mint-swap-checks').hidden = false;
    const ok = statesOk && acct.ok && rv.result.decision === 'ACCEPT';
    setSwapVerdict(
      ok
        ? 'SWAP COMPLETE — the original proof is spent, the replacements are usable, and the mint\'s books show the liability unchanged.'
        : 'SWAP NOT VERIFIED — see the failing checks below.',
      ok,
    );
    saveSwap({ ...stored, verdict: el('mint-swap-verdict').textContent, ok });
    showPaySection();
  } catch (err) {
    swapStep(`Stopped: ${(err as Error).message}`, 'fail');
    if (!exec) btn.disabled = false;
  } finally {
    busy = false;
    setButtons(false);
    btn.textContent = exec ? 'Already swapped' : 'Swap ecash';
    updateLifecycle();
  }
}

export function initRealMintPanel(): void {
  el('mint-swap-btn').addEventListener('click', () => void swapAccepted());
  el('mint-pay-btn').addEventListener('click', () => void payWithAccepted());
  el('mint-honest-btn').addEventListener('click', () => void run('honest'));
  el('mint-omit-btn').addEventListener('click', () => void run('omit'));
  el('mint-retry-btn').addEventListener('click', () => void retry());
  el('mint-result-retry-btn').addEventListener('click', () => void retry());
  el('mint-again-btn').addEventListener('click', () => {
    const wasHonest = current?.run.mode !== 'omit';
    current = null;
    try {
      localStorage.removeItem(RUN_KEY);
    } catch {
      /* ignore */
    }
    el('mint-result').hidden = true;
    el('mint-op').hidden = true;
    el('mint-promise').hidden = true;
    el('mint-retry-btn').hidden = true;
    placeRun('honest');
    updateLifecycle();
    reveal(wasHonest && !el('mint-attack').hidden ? el('mint-omit-btn') : el('mint-honest-btn'), 'center');
  });
}
