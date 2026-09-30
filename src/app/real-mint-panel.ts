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
import { reconstruct } from '../cashu/reconstruct.js';
import { manifestDigestHex } from '../pol/manifest.js';
import { verifyIssuedReceipt } from '../pol/receipt.js';
import { acceptedRecord, enforce, type EnforcementOutcome } from './acceptance-store.js';
import { proofFromJson, proofToJson, submissionBundleFromJson } from './bundle-json.js';
import {
  bindCopyButtons,
  chainStates,
  decisionCopy,
  decisionFacts,
  escapeHtml,
  formatAgo,
  formatUtc,
  mutinynetTxUrl,
  njumpUrl,
  nostrDiagnosticsHtml,
  renderDecision,
  resultClass,
} from './decision-view.js';
import { formatSats } from './format.js';
import { verifySubmission, type AssistedRelayFetchResult, type SubmissionVerification } from './submission.js';

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
  lightning_backend: 'lnd' | 'fakewallet';
  open_epoch: number;
  epoch_interval_seconds: number;
  next_close_at: number;
  demo_omission_enabled: boolean;
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
  const r = card.getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight - 120) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  el('mint-steps').appendChild(li);
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
  const lightning =
    s.lightning_backend === 'lnd'
      ? 'Real Lightning (LND) — invoices must actually be paid'
      : 'Demo fakewallet — invoices settle automatically; no real Lightning payment';
  const rows: [string, string][] = [
    ['Mint', `${info.name ?? 'Cashu mint'} — ${cfg.mintUrl}`],
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
  const checked = `checked ${formatUtc(new Date())}`;
  box.innerHTML = p
    ? `<span class="live-tag">LIVE RAILWAY MINT</span> Last publication: epoch ${p.epoch_index} · ${escapeHtml(p.status)} · ${formatUtc(p.published_at)} (${formatAgo(p.published_at)})${p.event_id ? ` · event <a href="${njumpUrl(p.event_id)}" target="_blank" rel="noopener noreferrer"><code>${p.event_id.slice(0, 12)}…</code> ↗</a>` : ''} · open epoch ${s.open_epoch} · ${checked}`
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
    renderReality(cfg, info.body, st.body);
    el('mint-omit-btn').hidden = !st.body.demo_omission_enabled;
    el('mint-omit-note').hidden = !st.body.demo_omission_enabled;
    setStatus(trim(st.body.mint_url) !== cfg.mintUrl ? `Warning: the evidence service is configured for ${st.body.mint_url}, not ${cfg.mintUrl}. Verification will refuse a mismatch.` : '');
  } catch (err) {
    setStatus(`Could not reach the mint or its evidence service: ${(err as Error).message}`);
  }
  if (!current) restoreLastRun(cfg);
}

function setStatus(text: string): void {
  el('mint-status').textContent = text;
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
  const pay = step(
    status?.lightning_backend === 'lnd'
      ? `Pay this Lightning invoice for ${AMOUNT} sats: ${quote.request}`
      : `The mint issued a ${AMOUNT}-sat invoice (demo fakewallet: it settles itself).`,
  );
  opDetail('Waiting for the invoice to be paid…');
  for (let i = 0; i < 600; i++) {
    if ((await wallet.checkMintQuoteBolt11(quote.quote)).state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  settle(pay, `Invoice for ${AMOUNT} sats paid.`, 'ok');
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
      const relays = r.publication_relays;
      settle(
        wait,
        `3. Epoch ${run.epoch} closed and ${r.publication_status === 'published' ? `published ${r.published_at ? formatUtc(r.published_at) : ''} — ACKed by ${relays?.acked.map(host).join(', ') || 'none'}; fetched back from ${relays?.fetched_from.map(host).join(', ') || 'none'}` : `NOT published (${r.publication_detail ?? r.publication_status})`}.`,
        r.publication_status === 'published' ? 'ok' : 'info',
      );
      return r;
    }
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

async function assistedFetch(cfg: RealMintConfig, eventId: string): Promise<AssistedRelayFetchResult> {
  const r = await getJson<{ events: AssistedRelayFetchResult['events']; per_relay: AssistedRelayFetchResult['perRelay']; fetched_at: string }>(`${cfg.evidenceUrl}/v1/solvent/nostr/event/${eventId}`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return { events: r.body.events, perRelay: r.body.per_relay, fetchedAt: r.body.fetched_at, source: new URL(cfg.evidenceUrl).host };
}

async function verifyRun(run: MintRun, evidence: IssuanceResponse): Promise<SubmissionVerification> {
  opDetail('Checking the receipt, the closed accounting state, the public Nostr evidence and the live reserve…');
  const verifying = step('4. Verifying: receipt · closed accounting state · public evidence · reserve coverage…');
  const bundle = submissionBundleFromJson(JSON.stringify({ ...evidence.evidence, proof: run.proof, amountPublicKeyHex: run.publicKey }));
  const v = await verifySubmission(bundle, undefined, undefined, undefined, { assistedRelayFetch: (id) => assistedFetch(run.cfg, id) });
  settle(verifying, `4. Verification finished: ${v.result.reasonCode}.`, v.result.decision === 'ACCEPT' ? 'ok' : 'fail');
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
    current = { run: r, evidence: null, verification: null };
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
  }
}

async function retry(): Promise<void> {
  if (!current || busy) return;
  busy = true;
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
      <p>This bundle contains the Cashu proof secret and can represent spendable ecash until the proof is spent. On this demo mint (fakewallet) it has no monetary value, but treat it as money on a real mint.</p>
      <button type="button" class="btn btn-solid btn-sm" id="mint-dl-replay-confirm">Download it anyway</button>
    </div>
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
  el('mint-enforcement').innerHTML = enforcementHtml(enforce(v.verifyInput));
  el('mint-evidence-card').innerHTML = evidenceCardHtml(v);
  bindCopyButtons(el('mint-evidence-card'));
  el('mint-dl-public').addEventListener('click', () => download(`solvent-public-evidence-epoch-${current!.run.epoch}.json`, publicEvidence()));
  el('mint-dl-replay').addEventListener('click', () => (el('mint-replay-warning').hidden = false));
  el('mint-dl-replay-confirm').addEventListener('click', () => download(`solvent-replay-bundle-epoch-${current!.run.epoch}.json`, replayBundle()));
  el('mint-technical').innerHTML = `<details><summary>Raw verification result (JSON)</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`;
  el('mint-retry-btn').hidden = cls !== 'availability';
  el('mint-result').hidden = false;
  el('mint-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function initRealMintPanel(): void {
  el('mint-honest-btn').addEventListener('click', () => void run('honest'));
  el('mint-omit-btn').addEventListener('click', () => void run('omit'));
  el('mint-retry-btn').addEventListener('click', () => void retry());
  el('mint-again-btn').addEventListener('click', () => {
    current = null;
    try {
      localStorage.removeItem(RUN_KEY);
    } catch {
      /* ignore */
    }
    el('mint-result').hidden = true;
    el('mint-op').hidden = true;
    el('mint-retry-btn').hidden = true;
    el('mint-honest-btn').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
