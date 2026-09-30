// /verify — the two real user tasks:
//
//   LIVE CHECK: run SOLVENT against the genuinely published reference case
//   (evidence/nostr/live-demo.json, published once by `npm run live-demo`).
//   Every run re-fetches its Nostr event from public relays and re-queries
//   its reserve UTXO, then runs the real verifier. Nothing is substituted
//   when a network request fails — the result is a REFUSE naming exactly
//   what could not be checked.
//
//   VERIFY EVIDENCE: paste or upload a SubmissionBundle and run it through
//   the same verifySubmission() -> verify() pipeline. "Load live example"
//   loads the canonical published bundle, never a privately generated one.
//
// Locally generated reference-mint evidence lives only in /lab (see
// lab-panel.ts): it is never published, so it could never pass step 7 here,
// and offering it beside these two modes made the product look broken.
// Neither mode decides ACCEPT/REFUSE itself or trusts a pre-evaluated claim
// inside a pasted bundle; both wire the real Gate 4 acceptance boundary to
// the Accept button.
import { createWalletStore, runAcceptGate } from '../enforcement/accept-gate.js';
import type { VerifyInput } from '../verifier/verify.js';
import { SUBMISSION_BUNDLE_REQUIRED_FIELDS, submissionBundleFromJson, submissionBundleToJson } from './bundle-json.js';
import {
  bindCopyButtons,
  chainStates,
  checkedIdsHtml,
  contradictionCard,
  copyLinkRow,
  decisionCopy,
  decisionFacts,
  escapeHtml,
  evidenceSection,
  formatAgo,
  formatDate,
  formatUtc,
  mintIdentityBlock,
  mutinynetTxUrl,
  networkName,
  njumpUrl,
  nostrEvidenceRows,
  rawJsonToggles,
  renderDecision,
  renderProgressSteps,
  reserveEvidenceRows,
  resultClass,
  reserveFreshness,
  revealProgress,
  shortfallCard,
  UNSUPPORTED_MINT_BODY,
  type DecisionContext,
  type DecisionElements,
} from './decision-view.js';
import { formatSats, truncateHex } from './format.js';
import { runEnforcement, runScenario, type ScenarioResult } from './protocol-demo.js';
import { loadCanonicalLiveDemoBundle, verifySubmission, type NostrLiveStatus, type ReserveLiveStatus, type SubmissionBundle } from './submission.js';
import liveDemoEvidence from '../../evidence/nostr/live-demo.json' with { type: 'json' };

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`verifier-panel: missing #${id}`);
  return el as T;
}

function decisionElements(prefix: string): DecisionElements {
  return {
    badge: byId(`${prefix}decision-badge`),
    headline: byId(`${prefix}decision-headline`),
    body: byId(`${prefix}decision-body`),
    facts: byId(`${prefix}decision-facts`),
    chain: byId(`${prefix}decision-chain`),
  };
}

const REFERENCE_ISSUER = 'SOLVENT reference mint — published reference case, not a production mint';

interface AcceptState {
  mint: string;
  amount: number;
  encodedToken: string | null;
}

function renderAcceptedState(container: HTMLElement, state: AcceptState): void {
  container.hidden = false;
  container.innerHTML = `
    <p class="accepted-title">✓ ACCEPTED</p>
    <p class="accepted-sub">Token committed to the local acceptance store.</p>
    <dl class="accepted-facts">
      <dt>Mint identity</dt><dd class="mono">${truncateHex(state.mint, 10, 6)}</dd>
      <dt>Amount</dt><dd>${formatSats(state.amount)}</dd>
      <dt>Token / proof fingerprint</dt><dd class="mono">${state.encodedToken ? truncateHex(state.encodedToken, 14, 8) : '—'}</dd>
      <dt>Accepted at</dt><dd>${formatDate(new Date())}</dd>
      <dt>Acceptance record</dt><dd>1 record in local acceptance store</dd>
      <dt>Side effect</dt><dd>CALLED ONCE</dd>
    </dl>
  `;
}

/** The detail sections under a result — the same for both modes. */
function evidenceDetailHtml(
  bundle: SubmissionBundle,
  verification: { result: import('../verifier/verify.js').VerifyResult; reserveLive: ReserveLiveStatus; nostrLive: NostrLiveStatus },
  opts: { issuer: string; bPrime?: string; accepted: boolean; encodedToken: string | null },
): string {
  const { result: r, reserveLive, nostrLive } = verification;
  const amount = bundle.manifest.outstanding_balance;
  const mint = mintIdentityBlock({ masterPublicKeyHex: bundle.masterPublicKeyHex, keysetId: bundle.keysetId, amountLabel: 'Outstanding liabilities', amount, issuer: opts.issuer });

  let special = '';
  const proofAmount = Number(bundle.proof.amount);
  if (r.reasonCode === 'REFUSE_ISSUANCE_OMITTED') special = contradictionCard(proofAmount, bundle.manifest.issued_mmr_root_sum);
  else if (r.reasonCode === 'REFUSE_RESERVE_SHORT') special = shortfallCard(bundle.manifest.outstanding_balance, reserveLive.verifiedReserveSats);

  const cashu = evidenceSection('Cashu', [
    ['Proof amount', formatSats(proofAmount)],
    ['Keyset', escapeHtml(bundle.keysetId)],
    ['NUT-12 / DLEQ', r.checks.dleqValid ? 'VALID' : 'INVALID'],
    ...(opts.bPrime ? ([['Reconstructed B′', truncateHex(opts.bPrime, 12, 8)]] as [string, string][]) : []),
  ]);
  const receipt = evidenceSection('PoL receipt', [
    ['Signature', r.checks.receiptValid ? 'VALID' : 'INVALID'],
    ['Promised epoch', String(bundle.receipt.target_epoch)],
    ['Raw signature', truncateHex(bundle.receipt.signature, 12, 8)],
  ]);
  const epoch = evidenceSection('Epoch / MMR', [
    ['Epoch', String(bundle.manifest.epoch_index)],
    ['Issued root / sum', `${truncateHex(bundle.manifest.issued_mmr_root_hash, 10, 6)} / ${formatSats(bundle.manifest.issued_mmr_root_sum)}`],
    ['Spent root / sum', `${truncateHex(bundle.manifest.spent_mmr_root_hash, 10, 6)} / ${formatSats(bundle.manifest.spent_mmr_root_sum)}`],
    ['Manifest signature', r.checks.manifestValid ? 'VALID' : 'INVALID'],
    ['Inclusion proof', bundle.inclusionProof ? (r.checks.inclusionValid ? 'VERIFIED' : 'INVALID') : 'NOT PRESENT (omitted)'],
    ['Outstanding balance', formatSats(bundle.manifest.outstanding_balance)],
  ]);
  const nostr = bundle.nostrEvent
    ? evidenceSection('Nostr (public evidence)', nostrEvidenceRows(bundle.nostrEvent, nostrLive), copyLinkRow('Copy full event ID', bundle.nostrEvent.id, njumpUrl(bundle.nostrEvent.id), 'View public event'))
    : evidenceSection('Nostr (public evidence)', [['Event', 'NOT SUPPLIED']]);
  const statement = bundle.reserveAttestation?.statement;
  const outpoint = statement?.outpoints[0];
  const reserve = statement
    ? evidenceSection('Reserve', reserveEvidenceRows(outpoint, statement, reserveLive), outpoint ? copyLinkRow('Copy txid', outpoint.txid, mutinynetTxUrl(outpoint.txid), 'View reserve UTXO') : '')
    : evidenceSection('Reserve', [['Attestation', 'NOT SUPPLIED']]);
  const decision = evidenceSection('Decision', [
    ['Reason code', r.reasonCode],
    ['Acceptance side effect', opts.accepted ? 'accept() CALLED' : 'accept() NOT CALLED'],
    ['Encoded token', opts.encodedToken ? truncateHex(opts.encodedToken, 14, 8) : '—'],
  ]);
  const resultJson = JSON.stringify({ decision: r.decision, reasonCode: r.reasonCode, checks: r.checks, reserveLive, nostrLive }, null, 2);
  return mint + special + cashu + receipt + epoch + nostr + reserve + decision + rawJsonToggles(submissionBundleToJson(bundle), resultJson);
}

function checkedIdsFor(bundle: SubmissionBundle): string {
  const outpoint = bundle.reserveAttestation?.statement.outpoints[0];
  return checkedIdsHtml(bundle.nostrEvent?.id ?? null, outpoint ? { txid: outpoint.txid, vout: outpoint.vout } : null);
}

function showDecision(els: DecisionElements, v: { result: import('../verifier/verify.js').VerifyResult; reserveLive: ReserveLiveStatus; nostrLive: NostrLiveStatus }, context: DecisionContext): void {
  renderDecision(els, {
    kind: v.result.decision,
    copy: decisionCopy(v.result, v.reserveLive, v.nostrLive, context),
    facts: decisionFacts(v.result, v.reserveLive, v.nostrLive),
    states: chainStates(v.result),
    cls: resultClass(v.result, v.reserveLive, v.nostrLive),
  });
}

// -------------------- LIVE CHECK --------------------

interface LiveCaseDates {
  publishedAt: string;
  nostrIssuedAt: number;
  nostrValidUntil: number;
  network: string;
  blockHeight: number;
  attestedAt: string;
}

function liveCaseDates(): LiveCaseDates {
  const bundle = loadCanonicalLiveDemoBundle();
  const content = JSON.parse(bundle.nostrEvent!.content) as { issued_at: number; valid_until: number };
  const statement = bundle.reserveAttestation!.statement;
  return {
    publishedAt: liveDemoEvidence.publishedAt,
    nostrIssuedAt: content.issued_at,
    nostrValidUntil: content.valid_until,
    network: statement.network,
    blockHeight: statement.block_height,
    attestedAt: statement.timestamp,
  };
}

/** Every date that bounds the reference case's validity, so a stale case is visible before anyone runs it. */
function renderLiveDates(container: HTMLElement, tipHeight: number | undefined): void {
  const d = liveCaseDates();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nostrState = nowSeconds > d.nostrValidUntil ? 'EXPIRED' : 'VALID';
  let reserveRow: string;
  if (tipHeight === undefined) {
    // Before a live query, estimate from the attestation's own timestamp.
    const f = reserveFreshness(d.network, d.blockHeight, d.blockHeight, new Date(d.attestedAt).getTime());
    reserveRow = `≈ ${formatDate(f.expiresAt)} (estimated — confirmed against the live chain tip on each check)`;
  } else {
    const f = reserveFreshness(d.network, d.blockHeight, tipHeight);
    reserveRow = f.blocksLeft > 0 ? `FRESH until ≈ ${formatDate(f.expiresAt)} (${f.blocksLeft.toLocaleString('en-US')} blocks left)` : `EXPIRED (${(-f.blocksLeft).toLocaleString('en-US')} blocks past its freshness window)`;
  }
  const bundle = loadCanonicalLiveDemoBundle();
  container.innerHTML = [
    ['Published', `${formatUtc(d.publishedAt)} (${formatAgo(d.publishedAt)})`],
    ['Event', `<a href="${njumpUrl(bundle.nostrEvent!.id)}" target="_blank" rel="noopener noreferrer"><code>${bundle.nostrEvent!.id.slice(0, 16)}…</code> ↗</a>`],
    ['Liability at that run', formatSats(bundle.manifest.outstanding_balance)],
    ['Nostr event valid', `${formatDate(d.nostrIssuedAt * 1000)} → ${formatDate(d.nostrValidUntil * 1000)} · ${nostrState}`],
    ['Reserve attested', `block ${d.blockHeight.toLocaleString('en-US')} · ${formatDate(d.attestedAt)}`],
    ['Reserve attestation', reserveRow],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

function nostrStatusLabel(n: NostrLiveStatus): { text: string; ok: boolean } {
  if (n.publicationVerified) return { text: 'LIVE', ok: true };
  if (!n.relayReachable) return { text: 'UNAVAILABLE', ok: false };
  if (!n.eventFetched) return { text: 'NOT FOUND', ok: false };
  return { text: `REJECTED (${n.reasonCode ?? 'UNVERIFIED'})`, ok: false };
}

function reserveStatusLabel(r: ReserveLiveStatus): { text: string; ok: boolean } {
  if (!r.queryOk) return { text: 'UNAVAILABLE', ok: false };
  if (r.reasonCode === 'REFUSE_RESERVE_UTXO_SPENT') return { text: 'SPENT', ok: false };
  if (r.reasonCode === 'REFUSE_RESERVE_STATE_MISMATCH') return { text: 'MISMATCH', ok: false };
  return { text: 'LIVE', ok: true };
}

function initLiveMode(): void {
  const runBtn = byId<HTMLButtonElement>('run-verification-btn');
  const runAgainBtn = byId<HTMLButtonElement>('run-again-btn');
  const progressPanel = byId<HTMLElement>('progress-panel');
  const progressSteps = byId<HTMLElement>('progress-steps');
  const resultCard = byId<HTMLElement>('result');
  const els = decisionElements('');
  const checkedIds = byId<HTMLElement>('live-checked-ids');
  const acceptBtn = byId<HTMLButtonElement>('accept-btn');
  const acceptedPanel = byId<HTMLElement>('accepted-panel');
  const evidenceEl = byId<HTMLElement>('evidence');
  const evidenceContent = byId<HTMLElement>('evidence-content');
  const statusEl = byId<HTMLElement>('status');
  const liveNostrEl = byId<HTMLElement>('live-status-nostr');
  const liveReserveEl = byId<HTMLElement>('live-status-reserve');
  const liveTimeEl = byId<HTMLElement>('live-status-time');
  const liveNetworkEl = byId<HTMLElement>('live-status-network');
  const datesEl = byId<HTMLElement>('live-dates');

  liveNetworkEl.textContent = networkName(liveCaseDates().network);
  renderLiveDates(datesEl, undefined);

  let current: ScenarioResult | null = null;
  let accepted = false;
  let running = false;

  async function runLiveCheck(): Promise<void> {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runAgainBtn.disabled = true;
    resultCard.hidden = true;
    acceptedPanel.hidden = true;
    accepted = false;
    progressPanel.hidden = false;
    liveNostrEl.textContent = 'checking…';
    liveNostrEl.className = '';
    liveReserveEl.textContent = 'checking…';
    liveReserveEl.className = '';
    statusEl.textContent = 'Fetching the reference case from public Nostr relays and re-querying its reserve UTXO…';
    const rows = renderProgressSteps(progressSteps);

    const scenario = await runScenario('honest');
    const verification = { result: scenario.verifyResult, reserveLive: scenario.reserveLive, nostrLive: scenario.nostrLive };
    current = scenario;
    await revealProgress(rows, chainStates(scenario.verifyResult));

    const nostr = nostrStatusLabel(scenario.nostrLive);
    liveNostrEl.textContent = nostr.text;
    liveNostrEl.className = nostr.ok ? 'live-ok' : 'live-bad';
    const reserve = reserveStatusLabel(scenario.reserveLive);
    liveReserveEl.textContent = reserve.text;
    liveReserveEl.className = reserve.ok ? 'live-ok' : 'live-bad';
    liveTimeEl.textContent = formatDate(new Date());
    liveTimeEl.dataset.checkedAt = new Date().toISOString();
    renderLiveDates(datesEl, scenario.reserveLive.tipHeight);

    progressPanel.hidden = true;
    resultCard.hidden = false;
    showDecision(els, verification, 'live');
    runAgainBtn.textContent = resultClass(scenario.verifyResult, scenario.reserveLive, scenario.nostrLive) === 'availability' ? 'Retry verification' : 'Run the live check again';
    checkedIds.innerHTML = checkedIdsFor(scenario.submissionBundle);
    acceptBtn.disabled = scenario.verifyResult.decision !== 'ACCEPT';
    acceptBtn.hidden = false;
    evidenceEl.hidden = false;
    evidenceContent.innerHTML = evidenceDetailHtml(scenario.submissionBundle, verification, { issuer: REFERENCE_ISSUER, bPrime: scenario.bPrime, accepted: false, encodedToken: null });
    bindCopyButtons(evidenceContent);
    statusEl.textContent = `Decision: ${scenario.verifyResult.decision} (${scenario.verifyResult.reasonCode}).`;
    runBtn.disabled = false;
    runAgainBtn.disabled = false;
    running = false;
  }

  acceptBtn.addEventListener('click', () => {
    void (async () => {
      if (!current || accepted) return;
      acceptBtn.disabled = true;
      const enforcement = await runEnforcement(current);
      accepted = enforcement.accepted;
      if (enforcement.accepted) {
        acceptBtn.hidden = true;
        renderAcceptedState(acceptedPanel, { mint: current.masterPublicKeyHex, amount: current.amount, encodedToken: enforcement.encodedToken });
        evidenceContent.innerHTML = evidenceDetailHtml(current.submissionBundle, { result: current.verifyResult, reserveLive: current.reserveLive, nostrLive: current.nostrLive }, { issuer: REFERENCE_ISSUER, bPrime: current.bPrime, accepted: true, encodedToken: enforcement.encodedToken });
        bindCopyButtons(evidenceContent);
      } else {
        acceptBtn.disabled = false;
      }
    })();
  });

  runBtn.addEventListener('click', () => void runLiveCheck());
  runAgainBtn.addEventListener('click', () => void runLiveCheck());
}

// -------------------- VERIFY EVIDENCE --------------------

type ManualErrorKind = 'INVALID_JSON' | 'INCOMPLETE_BUNDLE' | 'INVALID_BUNDLE' | 'UNSUPPORTED_MINT';

interface ManualError {
  kind: ManualErrorKind;
  message: string;
  technical: string;
}

const LIABILITY_FIELDS = ['receipt', 'manifest', 'manifestSignature', 'inclusionProof', 'reserveAttestation', 'nostrEvent'] as const;

/**
 * Parses and structurally classifies pasted input WITHOUT running any
 * verification. It never returns ACCEPT/REFUSE; that only ever comes from
 * the real verifySubmission() pipeline.
 */
function parseManualBundle(text: string): { bundle: SubmissionBundle } | { error: ManualError } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: { kind: 'INVALID_JSON', message: 'Paste a verification bundle, upload one, or load the live example.', technical: 'EMPTY_INPUT' } };
  }
  // A bare Cashu token carries a mint signature and nothing else — none of
  // the liability evidence SOLVENT checks.
  if (/^cashu[A-Za-z]/.test(trimmed)) {
    return { error: { kind: 'UNSUPPORTED_MINT', message: `${UNSUPPORTED_MINT_BODY} This is a plain Cashu token: it proves the mint signed it, but carries no liability receipt, accounting state or reserve evidence.`, technical: 'PLAIN_CASHU_TOKEN_WITHOUT_LIABILITY_EVIDENCE' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: { kind: 'INVALID_JSON', message: 'This is not valid JSON. Check for a missing brace, quote, or comma.', technical: (err as Error).message } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: { kind: 'INVALID_JSON', message: 'This is valid JSON, but not a JSON object.', technical: 'PARSED_VALUE_NOT_OBJECT' } };
  }
  const obj = parsed as Record<string, unknown>;
  const missing = SUBMISSION_BUNDLE_REQUIRED_FIELDS.filter((k) => !(k in obj));
  if (missing.length > 0) {
    const hasEcash = 'proof' in obj || 'token' in obj;
    if (hasEcash && LIABILITY_FIELDS.every((k) => !(k in obj))) {
      return { error: { kind: 'UNSUPPORTED_MINT', message: `${UNSUPPORTED_MINT_BODY} The input has ecash but none of the liability evidence (receipt, manifest, inclusion proof, reserve attestation, Nostr event).`, technical: `MISSING_FIELDS: ${missing.join(',')}` } };
    }
    return { error: { kind: 'INCOMPLETE_BUNDLE', message: `This bundle is missing required field(s): ${missing.join(', ')}. See the verification bundle schema for the full structure.`, technical: `MISSING_FIELDS: ${missing.join(',')}` } };
  }
  try {
    return { bundle: submissionBundleFromJson(trimmed) };
  } catch (err) {
    return {
      error: {
        kind: 'INVALID_BUNDLE',
        message: 'This bundle has all the required fields, but one or more are not structured the way SOLVENT expects (e.g. the proof amount or inclusion proof).',
        technical: (err as Error).message,
      },
    };
  }
}

function initEvidenceMode(): void {
  const input = byId<HTMLTextAreaElement>('manual-bundle-input');
  const fileInput = byId<HTMLInputElement>('manual-bundle-file');
  const drop = byId<HTMLElement>('bundle-drop');
  const summary = byId<HTMLElement>('manual-bundle-summary');
  const loadExampleBtn = byId<HTMLButtonElement>('manual-load-example-btn');
  const verifyBtn = byId<HTMLButtonElement>('manual-verify-btn');
  const statusEl = byId<HTMLElement>('manual-status');
  const progressPanel = byId<HTMLElement>('manual-progress-panel');
  const progressSteps = byId<HTMLElement>('manual-progress-steps');
  const resultCard = byId<HTMLElement>('manual-result');
  const els = decisionElements('manual-');
  const checkedIds = byId<HTMLElement>('manual-checked-ids');
  const acceptBtn = byId<HTMLButtonElement>('manual-accept-btn');
  const acceptedPanel = byId<HTMLElement>('manual-accepted-panel');
  const evidenceEl = byId<HTMLElement>('manual-evidence');
  const evidenceContent = byId<HTMLElement>('manual-evidence-content');

  let currentBundle: SubmissionBundle | null = null;
  let currentVerifyInput: VerifyInput | null = null;
  let accepted = false;

  function setLoaded(text: string, label: string): void {
    input.value = text;
    input.classList.add('is-loaded');
    summary.textContent = label;
    resultCard.hidden = true;
    progressPanel.hidden = true;
  }

  function showError(err: ManualError): void {
    progressPanel.hidden = true;
    resultCard.hidden = false;
    // An input problem says nothing about any mint: never shown as a REFUSE verdict.
    els.badge.textContent = 'INPUT ERROR';
    els.badge.className = 'decision-badge neutral';
    els.badge.dataset.resultClass = 'input';
    els.headline.textContent = `Could not verify this input — ${err.kind.replace(/_/g, ' ').toLowerCase()}.`;
    els.body.textContent = err.message;
    els.facts.innerHTML = '';
    els.chain.innerHTML = '';
    checkedIds.innerHTML = '';
    acceptBtn.hidden = true;
    acceptBtn.disabled = true;
    evidenceEl.hidden = false;
    evidenceContent.innerHTML = `<details class="raw-json-toggle"><summary>Technical detail</summary><pre class="raw-json">${escapeHtml(err.technical)}</pre></details>`;
    statusEl.textContent = `Input error (${err.kind.replace(/_/g, ' ').toLowerCase()}) — nothing was verified and nothing was accepted.`;
  }

  async function runManualVerification(): Promise<void> {
    resultCard.hidden = true;
    acceptedPanel.hidden = true;
    accepted = false;
    statusEl.textContent = '';
    currentBundle = null;
    currentVerifyInput = null;

    const parsed = parseManualBundle(input.value);
    if ('error' in parsed) {
      showError(parsed.error);
      return;
    }
    currentBundle = parsed.bundle;

    verifyBtn.disabled = true;
    progressPanel.hidden = false;
    const rows = renderProgressSteps(progressSteps);
    statusEl.textContent = 'Fetching the public Nostr evidence and re-querying the reserve, then running the verifier…';
    const verification = await verifySubmission(parsed.bundle);
    currentVerifyInput = verification.verifyInput;
    await revealProgress(rows, chainStates(verification.result));
    verifyBtn.disabled = false;

    progressPanel.hidden = true;
    resultCard.hidden = false;
    showDecision(els, verification, 'evidence');
    checkedIds.innerHTML = checkedIdsFor(parsed.bundle);
    acceptBtn.disabled = verification.result.decision !== 'ACCEPT';
    acceptBtn.hidden = false;
    evidenceEl.hidden = false;
    evidenceContent.innerHTML = evidenceDetailHtml(parsed.bundle, verification, { issuer: 'As supplied in this bundle', accepted: false, encodedToken: null });
    bindCopyButtons(evidenceContent);
    statusEl.textContent = `Decision: ${verification.result.decision} (${verification.result.reasonCode}).`;
  }

  acceptBtn.addEventListener('click', () => {
    // Pasted bundles don't come from runScenario(), so call the real Gate 4
    // boundary directly against the VerifyInput verifySubmission() rebuilt
    // from raw evidence — never against anything the JSON claimed.
    if (!currentVerifyInput || !currentBundle || accepted) return;
    const store = createWalletStore();
    const { accepted: didAccept } = runAcceptGate(currentVerifyInput, store);
    accepted = didAccept;
    if (didAccept) {
      acceptBtn.hidden = true;
      renderAcceptedState(acceptedPanel, { mint: currentBundle.masterPublicKeyHex, amount: Number(currentBundle.proof.amount), encodedToken: store.accepted[0]?.encodedToken ?? null });
    }
  });

  verifyBtn.addEventListener('click', () => void runManualVerification());

  loadExampleBtn.addEventListener('click', () => {
    // The canonical, genuinely published bundle — the same one Live check
    // verifies — never a freshly generated private one.
    const bundle = loadCanonicalLiveDemoBundle();
    setLoaded(
      submissionBundleToJson(bundle),
      `Live example loaded · published reference case · ${formatDate(liveDemoEvidence.publishedAt)} · event ${truncateHex(bundle.nostrEvent!.id, 8, 6)}`,
    );
    statusEl.textContent = 'Live example loaded. Verify it: SOLVENT will fetch its public Nostr event and re-query its reserve now.';
  });

  input.addEventListener('input', () => {
    input.classList.remove('is-loaded');
    summary.textContent = '';
  });

  async function loadFile(file: File): Promise<void> {
    const looksJson = /\.json$/i.test(file.name) || file.type === 'application/json' || file.type === '';
    if (!looksJson) {
      showError({ kind: 'INVALID_JSON', message: `"${file.name}" is not a .json file. Upload a SOLVENT verification bundle (JSON).`, technical: `FILE_TYPE: ${file.type || 'unknown'}` });
      return;
    }
    if (file.size === 0) {
      showError({ kind: 'INVALID_JSON', message: `"${file.name}" is empty.`, technical: 'EMPTY_FILE' });
      return;
    }
    const text = await file.text();
    setLoaded(text, `${file.name} · ${(file.size / 1024).toFixed(1)} KB`);
    resultCard.hidden = true;
    statusEl.textContent = 'Bundle file loaded. Verify it to run every check.';
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
}

// -------------------- mode switching --------------------

export type VerifyMode = 'live' | 'evidence';

/** Older deep links (#/verify?mode=try|manual|create) still land somewhere sensible. */
const LEGACY_MODES: Record<string, VerifyMode> = { try: 'live', create: 'live', manual: 'evidence' };

let switchToMode: ((mode: VerifyMode) => void) | null = null;

/**
 * Deep links: #/verify?mode=live|evidence. Clicking one from inside the SPA
 * is a same-document hash change, not a page load, so main.ts calls this on
 * every arrival at /verify rather than once at init.
 */
export function syncModeFromHash(): void {
  const match = /[?&]mode=([a-z]+)/i.exec(window.location.hash);
  if (!match) return;
  const requested = match[1]!.toLowerCase();
  const mode = requested === 'live' || requested === 'evidence' ? requested : LEGACY_MODES[requested];
  if (mode) switchToMode?.(mode);
}

function initModeTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#panel-verify .mode-tab'));
  const modes: Record<VerifyMode, HTMLElement> = { live: byId('mode-live'), evidence: byId('mode-evidence') };

  function switchTo(mode: VerifyMode): void {
    tabs.forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    (Object.keys(modes) as VerifyMode[]).forEach((key) => {
      modes[key].hidden = key !== mode;
    });
  }

  switchToMode = switchTo;
  tabs.forEach((tab) => tab.addEventListener('click', () => switchTo((tab.dataset.mode as VerifyMode | undefined) ?? 'live')));
  syncModeFromHash();
}

export function initVerifierPanel(): void {
  initModeTabs();
  initLiveMode();
  initEvidenceMode();
}
