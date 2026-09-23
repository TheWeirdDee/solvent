// Verifier panel — three modes: "Try SOLVENT" (pick an understandable test
// case, run the real v2 protocol live, including independent live/crypto
// re-verification of reserve and Nostr evidence), "Create test ecash"
// (issue one real SOLVENT-compatible token and its raw evidence bundle,
// then verify it — the user-driven issuance/evidence journey, built on the
// exact same createTestEcash()/verifyEcash() the HEALTHY scenario uses),
// and "Verify your evidence" (paste a SubmissionBundle — including one
// exported from Create test ecash — and run it through the exact same
// verifySubmission() -> verify() pipeline). No mode decides ACCEPT/REFUSE
// itself, and no mode trusts a pre-evaluated claim inside a pasted bundle
// (see submission.ts) — all three only render whatever the real pipeline
// returns, and all three wire the real Gate 4 acceptance boundary to the
// Accept button.
import { createWalletStore, runAcceptGate } from '../enforcement/accept-gate.js';
import { maxAttestationAgeBlocks, RESERVE_FRESHNESS_POLICY } from '../reserve/evaluate.js';
import type { ReasonCode } from '../verifier/reasons.js';
import { type VerifyResult } from '../verifier/verify.js';
import { SUBMISSION_BUNDLE_REQUIRED_FIELDS, submissionBundleFromJson, submissionBundleToJson } from './bundle-json.js';
import { formatSats, truncateHex } from './format.js';
import { verifySubmission, type NostrLiveStatus, type ReserveLiveStatus, type SubmissionBundle } from './submission.js';
import {
  checkLiveNostrRelayStatus,
  createTestEcash,
  fetchLiveReserveState,
  runEnforcement,
  runScenario,
  verifyEcash,
  type ScenarioId,
  type ScenarioResult,
  type SolventEcash,
} from './protocol-demo.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`verifier-panel: missing #${id}`);
  return el as T;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
}

// -------------------- explorer / evidence-viewer links --------------------
// Never mainnet — this build's reserve evidence is real Bitcoin Signet
// (Mutinynet), and its Nostr evidence is real public-relay-format events.
// Both links point at the correct network's own public viewer. See
// src/reserve/esplora.ts (ESPLORA_BASE_URL) and docs/trust-boundaries.md.
function mutinynetTxUrl(txid: string): string {
  return `https://mutinynet.com/tx/${txid}`;
}
function njumpUrl(eventId: string): string {
  return `https://njump.me/${eventId}`;
}

interface DecisionCopy {
  badge: string;
  headline: string;
  body: string;
}

const SCENARIO_COPY: Record<ScenarioId, Partial<Record<ReasonCode, DecisionCopy>>> = {
  honest: {
    ACCEPT_VERIFIED: {
      badge: 'ACCEPT VERIFIED',
      headline: 'ACCEPT VERIFIED.',
      body: "The token is valid, the mint's receipt is valid, the promised issuance appears in the closed epoch, the published state is consistent, and the live reserve covers the committed liability.",
    },
  },
  omitted: {
    REFUSE_ISSUANCE_OMITTED: {
      badge: 'REFUSE',
      headline: 'BROKEN PROMISE.',
      body: 'The mint signed a receipt promising to include this issuance in this epoch. The epoch closed without it — even though reserve and public state both check out.',
    },
  },
  'reserve-short': {
    REFUSE_RESERVE_SHORT: {
      badge: 'REFUSE',
      headline: 'RESERVE SHORTFALL.',
      body: 'The issuance was correctly accounted for, but the verified reserve is below committed liabilities.',
    },
  },
};

const UNSUPPORTED_MINT_CODES: ReasonCode[] = ['REFUSE_UNSUPPORTED_KEYSET', 'REFUSE_MALFORMED_TOKEN'];

/**
 * True when every real protocol gate passed (proof, receipt, epoch,
 * manifest, inclusion, reserve) and the ONLY reason this refused is a
 * Nostr publication problem — never true for REFUSE_NOSTR_CONFLICT/
 * STATE_MISMATCH, which are genuine adversarial findings, not "couldn't
 * check publication".
 */
function isPublicationGateOnlyFailure(result: VerifyResult): boolean {
  const c = result.checks;
  return (
    (result.reasonCode === 'REFUSE_NOSTR_EVENT_NOT_FOUND' || result.reasonCode === 'REFUSE_NOSTR_UNAVAILABLE') &&
    c.parses && c.supportedKeyset && c.dleqPresent && c.dleqValid && c.receiptValid &&
    c.targetEpochClosed && c.manifestValid && c.liabilityArithmeticValid && c.inclusionValid &&
    c.reserveCoverage === true
  );
}

/**
 * Distinct, non-scary copy for the expected Create Test Ecash outcome:
 * relays were reachable, but this fresh identity's evidence was never
 * published anywhere — a materially different fact from being unable to
 * reach relays at all (see publicEvidenceUnavailableCopy below).
 */
function publicationNotFoundCopy(): DecisionCopy {
  return {
    badge: 'PUBLICATION NOT FOUND',
    headline: 'CRYPTOGRAPHIC CHECK PASSED.',
    body:
      "The token, receipt, manifest, inclusion proof, and reserve are all valid. Public relays were reachable, but none returned the required accounting event for this mint and epoch — this fresh test event was never published. SOLVENT won't cross the live acceptance boundary on a private copy alone. Try the Live Public Demo to see the same checks pass against genuinely published evidence.",
  };
}

/** Distinct copy for a genuine relay-layer network failure — SOLVENT could not even attempt to check publication, which is not the same claim as "checked and not found". */
function publicEvidenceUnavailableCopy(): DecisionCopy {
  return {
    badge: 'PUBLIC EVIDENCE COULD NOT BE CHECKED',
    headline: 'PUBLIC EVIDENCE COULD NOT BE CHECKED.',
    body: 'SOLVENT could not reach a configured public relay, so it cannot establish public publication one way or the other. This is a network problem, not a refusal on the merits — try again.',
  };
}

function genericCopy(result: VerifyResult): DecisionCopy {
  if (UNSUPPORTED_MINT_CODES.includes(result.reasonCode)) {
    return { badge: 'UNSUPPORTED MINT', headline: 'UNSUPPORTED MINT.', body: result.reason };
  }
  if (isPublicationGateOnlyFailure(result)) {
    return result.reasonCode === 'REFUSE_NOSTR_EVENT_NOT_FOUND' ? publicationNotFoundCopy() : publicEvidenceUnavailableCopy();
  }
  const isAccept = result.decision === 'ACCEPT';
  return { badge: isAccept ? 'ACCEPT VERIFIED' : 'REFUSE', headline: isAccept ? 'ACCEPT VERIFIED.' : 'REFUSE.', body: result.reason };
}

/** True when a REFUSE_UNVERIFIABLE was caused by a live network check that could not currently run — not by missing evidence or a failed gate. Renders as "NETWORK VERIFICATION UNAVAILABLE" instead of a generic REFUSE. */
function isNetworkUnavailable(result: VerifyResult, reserveLive: ReserveLiveStatus, nostrLive: NostrLiveStatus): boolean {
  return result.reasonCode === 'REFUSE_UNVERIFIABLE' && ((reserveLive.supplied && reserveLive.queried && !reserveLive.queryOk) || false);
}

/**
 * True when the reserve leg refused specifically because the attestation's
 * declared block_height has fallen too far behind the current chain tip
 * (MAX_ATTESTATION_AGE_BLOCKS in the locked src/reserve/evaluate.ts — see
 * docs/trust-boundaries.md's "Effective expiry"). This is a demo-evidence
 * freshness problem, not a verifier failure or an adversarial finding —
 * most relevant to the Live Public Demo, whose evidence is a stable file
 * that needs periodic regeneration (`npm run live-demo`), but detected
 * generically for any bundle in this state.
 */
function isReserveAttestationExpired(reserveLive: ReserveLiveStatus): boolean {
  return reserveLive.reasonCode === 'REFUSE_RESERVE_ATTESTATION_INVALID' && reserveLive.detail.toLowerCase().includes('stale');
}

function liveDemoExpiredCopy(): DecisionCopy {
  return {
    badge: 'LIVE DEMO EVIDENCE EXPIRED',
    headline: 'LIVE DEMO EVIDENCE EXPIRED.',
    body: 'The public demo evidence needs to be refreshed (its reserve attestation has aged past its freshness window). This is a demo-evidence freshness failure, not a verifier problem — the maintainer needs to run `npm run live-demo` to regenerate and republish it.',
  };
}

interface ChainStep {
  plain: string;
  tech: string;
  state: 'ok' | 'fail' | 'na';
}

const STEP_DEFS: { plain: string; tech: string }[] = [
  { plain: 'Token origin', tech: 'NUT-12 / keyset' },
  { plain: 'Blind-signature proof', tech: 'DLEQ / NUT-12' },
  { plain: 'Mint receipt', tech: 'PoL receipt' },
  { plain: 'Accounting period', tech: 'Epoch' },
  { plain: 'Published accounting record', tech: 'Signed manifest' },
  { plain: 'Issuance included', tech: 'MMR / inclusion proof' },
  { plain: 'Public evidence', tech: 'Nostr' },
  { plain: 'Live reserve', tech: 'Bitcoin reserve' },
];
const DECISION_STEP = { plain: 'Decision', tech: 'reason code' };

function decisionChainSteps(result: VerifyResult): ChainStep[] {
  const c = result.checks;
  const na = (v: boolean | null): 'ok' | 'fail' | 'na' => (v === null ? 'na' : v ? 'ok' : 'fail');
  const states: ('ok' | 'fail' | 'na')[] = [
    c.parses && c.supportedKeyset ? 'ok' : 'fail',
    c.dleqPresent && c.dleqValid ? 'ok' : 'fail',
    c.receiptValid ? 'ok' : 'fail',
    c.targetEpochClosed ? 'ok' : 'fail',
    c.manifestValid && c.liabilityArithmeticValid ? 'ok' : 'fail',
    c.inclusionValid ? 'ok' : 'fail',
    na(c.nostrEvidence),
    na(c.reserveCoverage),
  ];
  return STEP_DEFS.map((def, i) => ({ ...def, state: states[i]! }));
}

function evidenceSection(title: string, rows: [string, string][], extraHtml = ''): string {
  return `<div class="evidence-section"><h3>${title}</h3><dl class="evidence-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${extraHtml}</div>`;
}

function copyLinkRow(label: string, fullValue: string, explorerUrl: string, explorerLabel: string): string {
  const safe = escapeHtml(fullValue);
  return `<div class="evidence-links"><button type="button" class="btn btn-outline btn-sm copy-evidence-btn" data-copy="${safe}">${label}</button><a href="${explorerUrl}" target="_blank" rel="noreferrer" class="btn btn-outline btn-sm">${explorerLabel} ↗</a></div>`;
}

/** Mint identity — shown prominently at the top of every verification result, never buried in raw JSON (see Part 14 of the product pass). */
function mintIdentityBlock(fields: { mint: string; masterPublicKeyHex: string; keysetId: string; amount: number }): string {
  return `<div class="mint-identity">
    <div class="mint-identity-row"><span class="mint-identity-label">Mint</span><span class="mint-identity-value">${escapeHtml(fields.mint)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Master key</span><span class="mint-identity-value mono">${truncateHex(fields.masterPublicKeyHex, 10, 6)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Keyset</span><span class="mint-identity-value mono">${escapeHtml(fields.keysetId)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Amount</span><span class="mint-identity-value">${formatSats(fields.amount)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Environment</span><span class="mint-identity-value">SOLVENT test mint — not a production mint</span></div>
  </div>`;
}

/** Part 16: don't present the Broken Promise scenario as a confusing "Outstanding balance: 0". Show the explicit contradiction. */
function contradictionCard(promisedSats: number, reportedSats: number): string {
  const omitted = promisedSats - reportedSats;
  return `<div class="contradiction-card">
    <p class="contradiction-title">The mint's own signed statements contradict each other</p>
    <dl class="evidence-rows">
      <dt>Receipt-promised issuance</dt><dd>${formatSats(promisedSats)}</dd>
      <dt>Manifest-reported issuance</dt><dd>${formatSats(reportedSats)}</dd>
      <dt>Omitted</dt><dd class="contradiction-omitted">${formatSats(omitted)}</dd>
    </dl>
    <p class="contradiction-sentence">The mint signed a receipt promising to count ${formatSats(promisedSats)}. Its own signed closed-epoch manifest reports only ${formatSats(reportedSats)}. SOLVENT refuses on that contradiction alone.</p>
  </div>`;
}

/** Part 17: don't conflate "reserve checked and short" with "reserve unverified" — they are different claims. */
function shortfallCard(liabilities: number, liveReserve: number): string {
  const shortfall = Math.max(0, liabilities - liveReserve);
  const coverage = liabilities > 0 ? (liveReserve / liabilities) * 100 : 0;
  return `<div class="contradiction-card">
    <p class="contradiction-title">Reserve was independently verified — and found insufficient</p>
    <dl class="evidence-rows">
      <dt>Reserve verified</dt><dd>YES</dd>
      <dt>Committed liabilities</dt><dd>${formatSats(liabilities)}</dd>
      <dt>Live reserve</dt><dd>${formatSats(liveReserve)}</dd>
      <dt>Shortfall</dt><dd class="contradiction-omitted">${formatSats(shortfall)}</dd>
      <dt>Coverage</dt><dd>${coverage.toFixed(1)}%</dd>
    </dl>
    <p class="contradiction-sentence">SOLVENT independently re-queried the reserve UTXO right now and confirmed its real on-chain value. That real value (${formatSats(liveReserve)}) is below what the mint owes (${formatSats(liabilities)}), so SOLVENT refuses.</p>
  </div>`;
}

// Part 12 of the mobile/verification pass: "Relay reachable" and "this
// exact event is live-retrievable" are different claims and must never be
// compressed into one "Nostr LIVE" badge. Every row below reflects a real,
// independently-checked fact — a real relay fetch attempt was made for
// every verification (see submission.ts's evaluateNostrIndependently),
// "Event" honestly reports NOT FOUND for demo-generated evidence that was
// never published anywhere (expected — see the FOUND/NOT FOUND note in the
// evidence panel), and Signature/Binding/Freshness are independently
// re-checked from whatever was actually used for the decision (the fetched
// relay copy when found, the bundle's own signed copy otherwise).
function nostrEvidenceRows(nostrEvent: { id: string; kind: number }, nostrLive: NostrLiveStatus): [string, string][] {
  return [
    ['Event id', truncateHex(nostrEvent.id, 12, 8)],
    ['Kind', String(nostrEvent.kind)],
    ['Schema', 'solvent/pol/v2'],
    ['Relay', nostrLive.relayReachable ? 'REACHABLE' : 'UNREACHABLE'],
    ['Exact event', nostrLive.eventFetched ? 'FOUND (public relay)' : 'NOT FOUND'],
    ['Provided copy', nostrLive.providedCopyValid ? 'CRYPTOGRAPHICALLY VALID' : 'INVALID'],
    ['Signature (of what was actually used)', nostrLive.signatureValid ? 'VALID' : 'INVALID'],
    ['Freshness (of what was actually used)', nostrLive.freshnessValid ? 'VALID' : 'STALE / N-A'],
    ['Mint / manifest binding (of what was actually used)', nostrLive.bindingValid ? 'VALID' : 'INVALID'],
    ['Public publication', nostrLive.publicationVerified ? 'VERIFIED' : `NOT VERIFIED (${nostrLive.reasonCode ?? 'UNVERIFIED'})`],
  ];
}

function reserveEvidenceRows(outpoint: { txid: string; vout: number; value_sats: number; script_pubkey_hex: string; block_height?: number; network?: string } | undefined, reserveLive: ReserveLiveStatus): [string, string][] {
  const rows: [string, string][] = [
    ['Txid', outpoint ? truncateHex(outpoint.txid, 10, 6) : '—'],
    ['Vout', outpoint ? String(outpoint.vout) : '—'],
    ['Live network query', reserveLive.queried ? (reserveLive.queryOk ? 'SUCCEEDED' : 'FAILED') : 'NOT ATTEMPTED'],
    ['Live value (just fetched)', reserveLive.queried && reserveLive.queryOk ? formatSats(reserveLive.verifiedReserveSats) : '—'],
    ['Reserve signature / mint binding', reserveLive.reasonCode === 'REFUSE_RESERVE_ATTESTATION_INVALID' ? 'INVALID' : reserveLive.queryOk ? 'VALID' : 'UNCHECKED'],
    ['Coverage', reserveLive.queryOk ? (reserveLive.verified ? 'PASS' : 'SHORT') : 'UNVERIFIABLE (network)'],
  ];
  if (outpoint?.block_height !== undefined && outpoint.network !== undefined && reserveLive.tipHeight !== undefined) {
    // Network-aware — must track evaluateReserveAttestation()'s own budget
    // in src/reserve/evaluate.ts (RESERVE_FRESHNESS_POLICY /
    // maxAttestationAgeBlocks) so this display can never silently drift
    // from what actually gates ACCEPT. See docs/trust-boundaries.md's
    // "Effective expiry" section for why a flat block count isn't
    // network-portable.
    const maxAgeBlocks = maxAttestationAgeBlocks(outpoint.network);
    const secondsPerBlock = RESERVE_FRESHNESS_POLICY.secondsPerBlockByNetwork[outpoint.network] ?? RESERVE_FRESHNESS_POLICY.defaultSecondsPerBlock;
    const ageBlocks = reserveLive.tipHeight - outpoint.block_height;
    const blocksLeft = maxAgeBlocks - ageBlocks;
    const expiresAt = new Date(Date.now() + blocksLeft * secondsPerBlock * 1000);
    rows.push(['Attestation freshness', blocksLeft > 0 ? `FRESH — until approximately ${expiresAt.toLocaleString()}` : 'EXPIRED — needs regeneration']);
  }
  return rows;
}

function renderScenarioEvidence(
  scenario: SolventEcash & { verifyResult: VerifyResult; reserveLive: ReserveLiveStatus; nostrLive: NostrLiveStatus; id?: ScenarioId },
  enforcement: { accepted: boolean; encodedToken: string | null },
): string {
  const r = scenario.verifyResult;
  const mint = mintIdentityBlock({ mint: scenario.submissionBundle.mint, masterPublicKeyHex: scenario.masterPublicKeyHex, keysetId: scenario.keyset.keysetId, amount: scenario.amount });
  // A tiny, non-sensitive marker identifying which canonical Live Public
  // Demo evidence version this deployed build is actually serving — lets
  // CI and judges confirm a deployed site picked up a refresh, without
  // exposing anything secret (event id and publish timestamp are already
  // public on the relay). Technical evidence area only, never primary UI.
  const canonicalMarker =
    scenario.id === 'honest'
      ? `<p class="canonical-evidence-marker">Canonical live demo event <span class="mono">${truncateHex(scenario.nostrEvent.id, 8, 6)}</span> · published ${new Date(scenario.issuedAt).toLocaleString()}</p>`
      : '';

  let special = '';
  if (r.reasonCode === 'REFUSE_ISSUANCE_OMITTED') {
    special = contradictionCard(scenario.amount, scenario.manifest.issued_mmr_root_sum);
  } else if (r.reasonCode === 'REFUSE_RESERVE_SHORT') {
    special = shortfallCard(scenario.manifest.outstanding_balance, scenario.reserveLive.verifiedReserveSats);
  }

  const cashu = evidenceSection('Cashu', [
    ['Proof amount', formatSats(scenario.amount)],
    ['Keyset', scenario.keyset.keysetId],
    ['NUT-12 / DLEQ', r.checks.dleqValid ? 'VALID' : 'INVALID'],
    ['Reconstructed B′', truncateHex(scenario.bPrime, 12, 8)],
  ]);
  const receipt = evidenceSection('PoL receipt', [
    ['Signature', r.checks.receiptValid ? 'VALID' : 'INVALID'],
    ['Issuance value', formatSats(scenario.amount)],
    ['Promised epoch', String(scenario.receipt.target_epoch)],
    ['Raw signature', truncateHex(scenario.receipt.signature, 12, 8)],
  ]);
  const epoch = evidenceSection('Epoch / MMR', [
    ['Issued root / sum', `${truncateHex(scenario.manifest.issued_mmr_root_hash, 10, 6)} / ${formatSats(scenario.manifest.issued_mmr_root_sum)}`],
    ['Spent root / sum', `${truncateHex(scenario.manifest.spent_mmr_root_hash, 10, 6)} / ${formatSats(scenario.manifest.spent_mmr_root_sum)}`],
    ['Global digest', truncateHex(scenario.globalDigestHex, 12, 8)],
    ['Manifest signature', r.checks.manifestValid ? 'VALID' : 'INVALID'],
    ['Inclusion proof', scenario.inclusionProof ? (r.checks.inclusionValid ? 'VERIFIED' : 'INVALID') : 'NOT PRESENT (omitted)'],
    ['Outstanding balance', formatSats(scenario.manifest.outstanding_balance)],
  ]);
  const nostr = evidenceSection(
    'Nostr (public evidence)',
    nostrEvidenceRows(scenario.nostrEvent, scenario.nostrLive),
    copyLinkRow('Copy full event ID', scenario.nostrEvent.id, njumpUrl(scenario.nostrEvent.id), 'View public event'),
  );
  const outpoint = scenario.reserveAttestation.statement.outpoints[0];
  const outpointWithHeight = outpoint ? { ...outpoint, block_height: scenario.reserveAttestation.statement.block_height, network: scenario.reserveAttestation.statement.network } : undefined;
  const reserve = evidenceSection(
    'Reserve',
    reserveEvidenceRows(outpointWithHeight, scenario.reserveLive),
    outpoint ? copyLinkRow('Copy txid', outpoint.txid, mutinynetTxUrl(outpoint.txid), 'View reserve UTXO') : '',
  );
  const decision = evidenceSection('Decision', [
    ['Reason code', r.reasonCode],
    ['Acceptance side effect', enforcement.accepted ? 'accept() CALLED' : 'accept() NOT CALLED'],
    ['Encoded token', enforcement.encodedToken ? truncateHex(enforcement.encodedToken, 14, 8) : '—'],
  ]);
  const inputJson = submissionBundleToJson(scenario.submissionBundle);
  const resultJson = JSON.stringify({ decision: r.decision, reasonCode: r.reasonCode, checks: r.checks, reserveLive: scenario.reserveLive, nostrLive: scenario.nostrLive }, null, 2);
  return (
    mint + special + cashu + receipt + epoch + nostr + reserve + decision +
    `<details class="raw-json-toggle"><summary>View input evidence bundle</summary><pre class="raw-json">${escapeHtml(inputJson)}</pre></details>` +
    `<details class="raw-json-toggle"><summary>View verification result JSON</summary><pre class="raw-json">${escapeHtml(resultJson)}</pre></details>` +
    canonicalMarker
  );
}

function renderProgressSteps(container: HTMLElement): HTMLElement[] {
  container.innerHTML = [...STEP_DEFS, DECISION_STEP]
    .map((s, i) => `<div class="progress-step" data-step="${i}"><span class="step-icon"></span><span class="step-label">${i + 1}. ${s.plain} <span class="step-label-tech">(${s.tech})</span></span></div>`)
    .join('');
  return Array.from(container.querySelectorAll<HTMLElement>('.progress-step'));
}

async function revealProgress(rows: HTMLElement[], result: VerifyResult): Promise<void> {
  const chain = decisionChainSteps(result);
  const states: ('ok' | 'fail' | 'na')[] = [...chain.map((c) => c.state), result.decision === 'ACCEPT' ? 'ok' : 'fail'];
  for (let i = 0; i < rows.length; i++) {
    await new Promise((r) => setTimeout(r, 70));
    const row = rows[i]!;
    const state = states[i] ?? 'na';
    row.classList.add('visible', state === 'ok' ? 'pass' : state === 'fail' ? 'fail' : 'na');
    row.querySelector('.step-icon')!.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '—';
  }
}

interface DecisionElements {
  decisionBadge: HTMLElement;
  decisionHeadline: HTMLElement;
  decisionBody: HTMLElement;
  decisionChain: HTMLElement;
}

/** Shared by every mode that shows a full decision result. Returns whether the decision was ACCEPT. */
function applyDecision(els: DecisionElements, result: VerifyResult, copy: DecisionCopy): boolean {
  const isAccept = result.decision === 'ACCEPT';
  els.decisionBadge.textContent = (isAccept ? '✓ ' : '✕ ') + copy.badge;
  els.decisionBadge.className = `decision-badge ${isAccept ? 'green' : 'red'}`;
  els.decisionHeadline.textContent = copy.headline;
  els.decisionBody.textContent = copy.body;
  els.decisionChain.innerHTML =
    decisionChainSteps(result)
      .map(
        (s) =>
          `<div class="chain-step chain-step-${s.state}"><span class="chain-step-icon">${s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : '—'}</span><span class="chain-step-label">${s.plain}<span class="chain-step-tech">${s.tech}</span></span></div>`,
      )
      .join('<div class="chain-connector" aria-hidden="true"></div>') +
    `<div class="chain-connector" aria-hidden="true"></div><div class="chain-step chain-step-final chain-step-${isAccept ? 'ok' : 'fail'}"><span class="chain-step-icon">${isAccept ? '✓' : '✕'}</span><span class="chain-step-label">${result.decision}<span class="chain-step-tech">${DECISION_STEP.tech}</span></span></div>`;
  return isAccept;
}

interface AcceptState {
  accepted: boolean;
  mint: string | null;
  amount: number | null;
  encodedToken: string | null;
  acceptedAt: string | null;
}

function renderAcceptedState(container: HTMLElement, state: AcceptState): void {
  if (!state.accepted) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <p class="accepted-title">✓ ACCEPTED</p>
    <p class="accepted-sub">Token committed to the acceptance store.</p>
    <dl class="accepted-facts">
      <dt>Mint</dt><dd>${state.mint ? escapeHtml(state.mint) : '—'}</dd>
      <dt>Amount</dt><dd>${state.amount !== null ? formatSats(state.amount) : '—'}</dd>
      <dt>Token / proof fingerprint</dt><dd class="mono">${state.encodedToken ? truncateHex(state.encodedToken, 14, 8) : '—'}</dd>
      <dt>Accepted at</dt><dd>${state.acceptedAt ?? '—'}</dd>
      <dt>Acceptance record</dt><dd>1 record in local acceptance store</dd>
      <dt>Side effect</dt><dd>CALLED ONCE</dd>
    </dl>
  `;
}

function bindCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.copy-evidence-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.copy;
      if (val) void navigator.clipboard?.writeText(val);
    });
  });
}

// -------------------- Try SOLVENT mode --------------------

function initTryMode(): void {
  const scenarioBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#mode-try .scenario-btn'));
  const runBtn = byId<HTMLButtonElement>('run-verification-btn');
  const progressPanel = byId<HTMLElement>('progress-panel');
  const progressSteps = byId<HTMLElement>('progress-steps');
  const resultCard = byId<HTMLElement>('result');
  const decisionBadge = byId<HTMLElement>('decision-badge');
  const decisionHeadline = byId<HTMLElement>('decision-headline');
  const decisionBody = byId<HTMLElement>('decision-body');
  const decisionChain = byId<HTMLElement>('decision-chain');
  const acceptBtn = byId<HTMLButtonElement>('accept-btn');
  const acceptedPanel = byId<HTMLElement>('accepted-panel');
  const evidenceEl = byId<HTMLElement>('evidence');
  const evidenceContent = byId<HTMLElement>('evidence-content');
  const statusEl = byId<HTMLElement>('status');
  const runAgainBtn = byId<HTMLButtonElement>('run-again-btn');
  const liveNostrEl = byId<HTMLElement>('live-status-nostr');
  const liveReserveEl = byId<HTMLElement>('live-status-reserve');
  const liveTimeEl = byId<HTMLElement>('live-status-time');
  const refreshBtn = byId<HTMLButtonElement>('refresh-evidence-btn');

  let selected: ScenarioId | null = null;
  let current: ScenarioResult | null = null;
  let accepted = false;

  function selectCard(id: ScenarioId) {
    selected = id;
    scenarioBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.scenario === id));
    runBtn.disabled = false;
    resultCard.hidden = true;
    acceptedPanel.hidden = true;
    progressPanel.hidden = true;
  }

  // "Refresh evidence" only ever re-checks whether public infrastructure is
  // currently reachable (a real relay query, a real Esplora query) — it
  // does not re-run any accept/refuse decision. Labeled accordingly.
  async function refreshLiveStatus(): Promise<void> {
    liveNostrEl.textContent = 'checking…';
    liveReserveEl.textContent = 'checking…';
    const [nostrStatus, reserveStatus] = await Promise.all([checkLiveNostrRelayStatus(), fetchLiveReserveState()]);
    liveNostrEl.textContent = nostrStatus.ok && nostrStatus.eventFound ? 'REACHABLE' : nostrStatus.ok ? 'REACHABLE (no matching event)' : 'UNREACHABLE';
    liveNostrEl.className = nostrStatus.ok && nostrStatus.eventFound ? 'live-ok' : 'live-bad';
    if (!reserveStatus.ok) {
      liveReserveEl.textContent = 'UNREACHABLE';
      liveReserveEl.className = 'live-bad';
    } else {
      const entry = [...reserveStatus.chainState.values()][0];
      liveReserveEl.textContent = entry ? (entry.spent ? 'REACHABLE (UTXO SPENT)' : 'REACHABLE') : 'REACHABLE (UTXO NOT FOUND)';
      liveReserveEl.className = entry && !entry.spent ? 'live-ok' : 'live-bad';
    }
    liveTimeEl.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
  }

  async function runVerification(): Promise<void> {
    if (!selected) return;
    runBtn.disabled = true;
    resultCard.hidden = true;
    acceptedPanel.hidden = true;
    accepted = false;
    progressPanel.hidden = false;
    statusEl.textContent = 'Running the real v2 protocol — live blind signing, a live reserve re-query, and a live public-relay fetch for this evidence…';
    const rows = renderProgressSteps(progressSteps);

    const scenario = await runScenario(selected);
    current = scenario;
    await revealProgress(rows, scenario.verifyResult);

    const isNetworkDown = isNetworkUnavailable(scenario.verifyResult, scenario.reserveLive, scenario.nostrLive);
    const copy = isNetworkDown
      ? { badge: 'NETWORK VERIFICATION UNAVAILABLE', headline: 'NETWORK VERIFICATION UNAVAILABLE.', body: `SOLVENT could not reach the live reserve network just now (${scenario.reserveLive.detail}). This is not a shortfall — it is an inability to check right now. Try again.` }
      : isReserveAttestationExpired(scenario.reserveLive)
        ? liveDemoExpiredCopy()
        : SCENARIO_COPY[scenario.id][scenario.verifyResult.reasonCode] ?? genericCopy(scenario.verifyResult);
    resultCard.hidden = false;
    const isAccept = applyDecision({ decisionBadge, decisionHeadline, decisionBody, decisionChain }, scenario.verifyResult, copy);

    acceptBtn.disabled = !isAccept;
    acceptBtn.hidden = false;
    evidenceEl.hidden = false;
    evidenceContent.innerHTML = renderScenarioEvidence(scenario, { accepted: false, encodedToken: null });
    bindCopyButtons(evidenceContent);
    statusEl.textContent = `Decision: ${scenario.verifyResult.decision} (${scenario.verifyResult.reasonCode}).`;
    runBtn.disabled = false;
  }

  acceptBtn.addEventListener('click', () => {
    void (async () => {
      if (!current || accepted) return;
      acceptBtn.disabled = true;
      const enforcement = await runEnforcement(current);
      accepted = enforcement.accepted;
      if (enforcement.accepted) {
        acceptBtn.hidden = true;
        renderAcceptedState(acceptedPanel, { accepted: true, mint: current.submissionBundle.mint, amount: current.amount, encodedToken: enforcement.encodedToken, acceptedAt: new Date().toLocaleString() });
        evidenceContent.innerHTML = renderScenarioEvidence(current, enforcement);
        bindCopyButtons(evidenceContent);
      } else {
        acceptBtn.disabled = false;
      }
    })();
  });

  runAgainBtn.addEventListener('click', () => {
    selected = null;
    current = null;
    accepted = false;
    scenarioBtns.forEach((btn) => btn.classList.remove('active'));
    runBtn.disabled = true;
    resultCard.hidden = true;
    acceptedPanel.hidden = true;
    progressPanel.hidden = true;
    statusEl.textContent = '';
  });

  refreshBtn.addEventListener('click', () => void refreshLiveStatus());

  scenarioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.scenario as ScenarioId | undefined;
      if (id) selectCard(id);
    });
  });

  runBtn.addEventListener('click', () => void runVerification());

  void refreshLiveStatus();
}

// -------------------- Create test ecash mode --------------------

function initCreateMode(): void {
  const createBtn = byId<HTMLButtonElement>('create-ecash-btn');
  const createStatus = byId<HTMLElement>('create-status');
  const ecashResult = byId<HTMLElement>('create-ecash-result');
  const tokenValue = byId<HTMLElement>('create-token-value');
  const tokenAmount = byId<HTMLElement>('create-token-amount');
  const tokenKeyset = byId<HTMLElement>('create-token-keyset');
  const tokenMint = byId<HTMLElement>('create-token-mint');
  const tokenIssued = byId<HTMLElement>('create-token-issued');
  const copyTokenBtn = byId<HTMLButtonElement>('copy-token-btn');
  const viewBundleBtn = byId<HTMLButtonElement>('view-bundle-btn');
  const copyBundleBtn = byId<HTMLButtonElement>('copy-bundle-btn');
  const bundleJson = byId<HTMLElement>('create-bundle-json');
  const verifyBtn = byId<HTMLButtonElement>('create-verify-btn');
  const progressPanel = byId<HTMLElement>('create-progress-panel');
  const progressSteps = byId<HTMLElement>('create-progress-steps');
  const resultCard = byId<HTMLElement>('create-result');
  const decisionBadge = byId<HTMLElement>('create-decision-badge');
  const decisionHeadline = byId<HTMLElement>('create-decision-headline');
  const decisionBody = byId<HTMLElement>('create-decision-body');
  const decisionChain = byId<HTMLElement>('create-decision-chain');
  const acceptBtn = byId<HTMLButtonElement>('create-accept-btn');
  const acceptedPanel = byId<HTMLElement>('create-accepted-panel');
  const tryLiveDemoBtn = byId<HTMLButtonElement>('create-try-live-demo-btn');
  const evidenceEl = byId<HTMLElement>('create-evidence');
  const evidenceContent = byId<HTMLElement>('create-evidence-content');
  const againBtn = byId<HTMLButtonElement>('create-again-btn');

  let current: SolventEcash | null = null;
  let verified: (SolventEcash & { verifyResult: VerifyResult; reserveLive: ReserveLiveStatus; nostrLive: NostrLiveStatus }) | null = null;
  let accepted = false;

  function reset() {
    current = null;
    verified = null;
    accepted = false;
    ecashResult.hidden = true;
    resultCard.hidden = true;
    progressPanel.hidden = true;
    bundleJson.hidden = true;
    tryLiveDemoBtn.hidden = true;
    createStatus.textContent = '';
  }

  async function onCreate(): Promise<void> {
    reset();
    createBtn.disabled = true;
    createStatus.textContent =
      'Issuing real SOLVENT-compatible ecash — blind signing, a signed receipt, a closed epoch, Nostr evidence, and a live reserve re-query…';
    const ecash = await createTestEcash();
    current = ecash;

    tokenValue.textContent = ecash.token;
    tokenAmount.textContent = formatSats(ecash.amount);
    tokenKeyset.textContent = ecash.keyset.keysetId;
    tokenMint.textContent = `${ecash.submissionBundle.mint} (test environment)`;
    tokenIssued.textContent = new Date(ecash.issuedAt).toLocaleString();
    bundleJson.textContent = submissionBundleToJson(ecash.submissionBundle);
    ecashResult.hidden = false;
    createStatus.textContent = 'Ecash created. Inspect it below, then verify it.';
    createBtn.disabled = false;
  }

  async function onVerify(): Promise<void> {
    if (!current) return;
    verifyBtn.disabled = true;
    resultCard.hidden = true;
    progressPanel.hidden = false;
    const rows = renderProgressSteps(progressSteps);
    const { result: verifyResult, reserveLive, nostrLive } = await verifyEcash(current);
    await revealProgress(rows, verifyResult);
    verified = { ...current, verifyResult, reserveLive, nostrLive };

    const isNetworkDown = isNetworkUnavailable(verifyResult, reserveLive, nostrLive);
    const copy = isNetworkDown
      ? { badge: 'NETWORK VERIFICATION UNAVAILABLE', headline: 'NETWORK VERIFICATION UNAVAILABLE.', body: `SOLVENT could not reach the live reserve network just now (${reserveLive.detail}). This is not a shortfall — it is an inability to check right now. Try again.` }
      : isReserveAttestationExpired(reserveLive)
        ? liveDemoExpiredCopy()
        : SCENARIO_COPY.honest[verifyResult.reasonCode] ?? genericCopy(verifyResult);
    resultCard.hidden = false;
    const isAccept = applyDecision({ decisionBadge, decisionHeadline, decisionBody, decisionChain }, verifyResult, copy);
    acceptBtn.disabled = !isAccept;
    acceptBtn.hidden = false;
    tryLiveDemoBtn.hidden = !(!isNetworkDown && isPublicationGateOnlyFailure(verifyResult));
    evidenceEl.hidden = false;
    evidenceContent.innerHTML = renderScenarioEvidence(verified, { accepted: false, encodedToken: null });
    bindCopyButtons(evidenceContent);
    verifyBtn.disabled = false;
  }

  copyTokenBtn.addEventListener('click', () => {
    if (current) void navigator.clipboard?.writeText(current.token);
  });
  viewBundleBtn.addEventListener('click', () => {
    bundleJson.hidden = !bundleJson.hidden;
  });
  copyBundleBtn.addEventListener('click', () => {
    if (current) void navigator.clipboard?.writeText(submissionBundleToJson(current.submissionBundle));
  });

  acceptBtn.addEventListener('click', () => {
    void (async () => {
      if (!verified || accepted) return;
      acceptBtn.disabled = true;
      const enforcement = await runEnforcement(verified);
      accepted = enforcement.accepted;
      if (enforcement.accepted) {
        acceptBtn.hidden = true;
        renderAcceptedState(acceptedPanel, { accepted: true, mint: verified.submissionBundle.mint, amount: verified.amount, encodedToken: enforcement.encodedToken, acceptedAt: new Date().toLocaleString() });
        evidenceContent.innerHTML = renderScenarioEvidence(verified, enforcement);
        bindCopyButtons(evidenceContent);
      } else {
        acceptBtn.disabled = false;
      }
    })();
  });

  tryLiveDemoBtn.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('.mode-tab[data-mode="try"]')?.click();
    document.querySelector<HTMLButtonElement>('#mode-try .scenario-btn[data-scenario="honest"]')?.click();
    byId<HTMLButtonElement>('run-verification-btn').click();
  });
  againBtn.addEventListener('click', reset);
  createBtn.addEventListener('click', () => void onCreate());
  verifyBtn.addEventListener('click', () => void onVerify());
}

// -------------------- Verify your evidence (manual) mode --------------------

type ManualErrorKind = 'INVALID_JSON' | 'INCOMPLETE_BUNDLE' | 'INVALID_BUNDLE' | 'NETWORK_UNAVAILABLE' | 'LIVE_DEMO_EVIDENCE_EXPIRED';

interface ManualError {
  kind: ManualErrorKind;
  message: string;
  technical: string;
}

const EXAMPLE_BUNDLE_NOTE =
  'This calls the exact same runScenario("honest") the Try SOLVENT tab uses — it is not a hardcoded fixture pasted into this file.';

/** Parses and structurally classifies pasted input WITHOUT running any verification — this only ever distinguishes "can't even read this" (INVALID JSON), "missing pieces" (INCOMPLETE BUNDLE), and "pieces present but malformed" (INVALID BUNDLE). It never returns ACCEPT/REFUSE; that only ever comes from the real verifySubmission() pipeline. */
function parseManualBundle(text: string): { bundle: SubmissionBundle } | { error: ManualError } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: { kind: 'INVALID_JSON', message: 'Paste a verification bundle above, or load the example.', technical: 'EMPTY_INPUT' } };
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
  const missing = SUBMISSION_BUNDLE_REQUIRED_FIELDS.filter((k) => !(k in (parsed as Record<string, unknown>)));
  if (missing.length > 0) {
    return {
      error: {
        kind: 'INCOMPLETE_BUNDLE',
        message: `This bundle is missing required field(s): ${missing.join(', ')}. See the verification bundle schema for the full structure.`,
        technical: `MISSING_FIELDS: ${missing.join(',')}`,
      },
    };
  }
  try {
    const bundle = submissionBundleFromJson(trimmed);
    return { bundle };
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

function initManualMode(): void {
  const input = byId<HTMLTextAreaElement>('manual-bundle-input');
  const loadExampleBtn = byId<HTMLButtonElement>('manual-load-example-btn');
  const verifyBtn = byId<HTMLButtonElement>('manual-verify-btn');
  const statusEl = byId<HTMLElement>('manual-status');
  const resultCard = byId<HTMLElement>('manual-result');
  const decisionBadge = byId<HTMLElement>('manual-decision-badge');
  const decisionHeadline = byId<HTMLElement>('manual-decision-headline');
  const decisionBody = byId<HTMLElement>('manual-decision-body');
  const decisionChain = byId<HTMLElement>('manual-decision-chain');
  const acceptBtn = byId<HTMLButtonElement>('manual-accept-btn');
  const acceptedPanel = byId<HTMLElement>('manual-accepted-panel');
  const evidenceContent = byId<HTMLElement>('manual-evidence-content');

  let currentBundle: SubmissionBundle | null = null;
  let currentVerifyInput: import('../verifier/verify.js').VerifyInput | null = null;
  let accepted = false;

  function showError(err: ManualError): void {
    resultCard.hidden = false;
    decisionBadge.textContent = `✕ ${err.kind.replace(/_/g, ' ')}`;
    decisionBadge.className = 'decision-badge red';
    decisionHeadline.textContent = err.kind.replace(/_/g, ' ') + '.';
    decisionBody.textContent = err.message;
    decisionChain.innerHTML = '';
    acceptBtn.hidden = true;
    acceptBtn.disabled = true;
    evidenceContent.innerHTML = `<details class="raw-json-toggle" open><summary>Technical detail</summary><pre class="raw-json">${escapeHtml(err.technical)}</pre></details>`;
    statusEl.textContent = `${err.kind.replace(/_/g, ' ')} — no verification side effect occurred.`;
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
    statusEl.textContent = 'Independently re-verifying reserve and Nostr evidence, then running verify()…';
    const { verifyInput, result, reserveLive, nostrLive } = await verifySubmission(parsed.bundle);
    currentVerifyInput = verifyInput;
    verifyBtn.disabled = false;

    if (isNetworkUnavailable(result, reserveLive, nostrLive)) {
      showError({ kind: 'NETWORK_UNAVAILABLE', message: `SOLVENT could not reach the live reserve network just now (${reserveLive.detail}). This bundle was not accepted or refused on the merits — try again. It is not a reserve shortfall.`, technical: reserveLive.detail });
      return;
    }
    if (isReserveAttestationExpired(reserveLive)) {
      showError({ kind: 'LIVE_DEMO_EVIDENCE_EXPIRED', message: liveDemoExpiredCopy().body, technical: reserveLive.detail });
      return;
    }

    const isAccept = result.decision === 'ACCEPT';
    const copy = genericCopy(result);

    resultCard.hidden = false;
    decisionBadge.textContent = (isAccept ? '✓ ' : '✕ ') + copy.badge;
    decisionBadge.className = `decision-badge ${isAccept ? 'green' : 'red'}`;
    decisionHeadline.textContent = copy.headline;
    decisionBody.textContent = copy.body;
    decisionChain.innerHTML = decisionChainSteps(result)
      .map((s) => `<div class="chain-step chain-step-${s.state}"><span class="chain-step-icon">${s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : '—'}</span><span class="chain-step-label">${s.plain}<span class="chain-step-tech">${s.tech}</span></span></div>`)
      .join('<div class="chain-connector" aria-hidden="true"></div>');

    acceptBtn.disabled = !isAccept;
    acceptBtn.hidden = false;

    const mint = mintIdentityBlock({ mint: parsed.bundle.mint, masterPublicKeyHex: parsed.bundle.masterPublicKeyHex, keysetId: parsed.bundle.keysetId, amount: parsed.bundle.manifest.outstanding_balance });
    let special = '';
    if (result.reasonCode === 'REFUSE_ISSUANCE_OMITTED') special = contradictionCard(parsed.bundle.manifest.issued_mmr_root_sum > 0 ? parsed.bundle.manifest.issued_mmr_root_sum : parsed.bundle.manifest.outstanding_balance, parsed.bundle.manifest.issued_mmr_root_sum);
    if (result.reasonCode === 'REFUSE_RESERVE_SHORT') special = shortfallCard(parsed.bundle.manifest.outstanding_balance, reserveLive.verifiedReserveSats);
    const nostr = parsed.bundle.nostrEvent ? evidenceSection('Nostr (public evidence)', nostrEvidenceRows(parsed.bundle.nostrEvent, nostrLive), copyLinkRow('Copy full event ID', parsed.bundle.nostrEvent.id, njumpUrl(parsed.bundle.nostrEvent.id), 'View public event')) : '';
    const reserveOutpoint = parsed.bundle.reserveAttestation?.statement.outpoints[0];
    const reserveOutpointWithHeight = reserveOutpoint && parsed.bundle.reserveAttestation ? { ...reserveOutpoint, block_height: parsed.bundle.reserveAttestation.statement.block_height, network: parsed.bundle.reserveAttestation.statement.network } : undefined;
    const reserve = parsed.bundle.reserveAttestation
      ? evidenceSection('Reserve', reserveEvidenceRows(reserveOutpointWithHeight, reserveLive), reserveOutpoint ? copyLinkRow('Copy txid', reserveOutpoint.txid, mutinynetTxUrl(reserveOutpoint.txid), 'View reserve UTXO') : '')
      : '';
    const inputJson = submissionBundleToJson(parsed.bundle);
    const resultJson = JSON.stringify({ decision: result.decision, reasonCode: result.reasonCode, checks: result.checks, reserveLive, nostrLive }, null, 2);
    evidenceContent.innerHTML =
      mint + special + nostr + reserve +
      `<details class="raw-json-toggle"><summary>View input evidence bundle</summary><pre class="raw-json">${escapeHtml(inputJson)}</pre></details>` +
      `<details class="raw-json-toggle" open><summary>View verification result JSON</summary><pre class="raw-json">${escapeHtml(resultJson)}</pre></details>`;
    bindCopyButtons(evidenceContent);
    statusEl.textContent = `Decision: ${result.decision} (${result.reasonCode}).`;
  }

  acceptBtn.addEventListener('click', () => {
    // Manual bundles don't come from runScenario(), so there's no
    // ScenarioResult to hand to runEnforcement() — call the real Gate 4
    // boundary directly against the independently-reconstructed VerifyInput
    // (from verifySubmission(), never against anything the pasted JSON
    // itself claimed was already verified).
    if (!currentVerifyInput || !currentBundle || accepted) return;
    const store = createWalletStore();
    const { accepted: didAccept } = runAcceptGate(currentVerifyInput, store);
    accepted = didAccept;
    if (didAccept) {
      acceptBtn.hidden = true;
      renderAcceptedState(acceptedPanel, { accepted: true, mint: currentBundle.mint, amount: currentBundle.manifest.outstanding_balance, encodedToken: store.accepted[0]?.encodedToken ?? null, acceptedAt: new Date().toLocaleString() });
    }
  });

  verifyBtn.addEventListener('click', () => void runManualVerification());

  loadExampleBtn.addEventListener('click', () => {
    void (async () => {
      loadExampleBtn.disabled = true;
      statusEl.textContent = `Loading SOLVENT's Live Public Demo bundle — its evidence is genuinely published; verifying it will fetch it live from public relays… ${EXAMPLE_BUNDLE_NOTE}`;
      const scenario = await runScenario('honest');
      input.value = submissionBundleToJson(scenario.submissionBundle);
      statusEl.textContent = 'Live Public Demo bundle loaded — not a static fixture, and its evidence is real and genuinely publicly retrievable. Click "Verify bundle" to run it.';
      loadExampleBtn.disabled = false;
    })();
  });

  // Cross-link into "Create test ecash" for anyone who doesn't have a
  // bundle yet — reuses the same tab switch a real click would trigger.
  byId<HTMLButtonElement>('manual-create-ecash-btn').addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('.mode-tab[data-mode="create"]')?.click();
  });
}

// -------------------- mode switching --------------------

/**
 * Deep link support: the landing page's "Try with test ecash"/"Create test
 * ecash" CTAs link to #/verify?mode=create so a first-time visitor lands
 * directly in that flow instead of having to find the tab themselves.
 *
 * Clicking such a link from anywhere already inside the SPA is a
 * same-document hash change (a `hashchange` event, not a fresh page load),
 * so this can't be a one-shot check at module-init time — it has to re-run
 * every time the app arrives at the /verify route, which is why
 * initSyncModeFromHash() is exported and called from main.ts's own
 * route-change handler (see initRouting()), not just once here.
 */
let switchToMode: ((mode: string) => void) | null = null;

export function syncModeFromHash(): void {
  const match = /[?&]mode=([a-z]+)/i.exec(window.location.hash);
  if (match) switchToMode?.(match[1]!);
}

function initModeTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-tab'));
  const modes: Record<string, HTMLElement> = {
    try: byId<HTMLElement>('mode-try'),
    create: byId<HTMLElement>('mode-create'),
    manual: byId<HTMLElement>('mode-manual'),
  };

  function switchTo(mode: string): void {
    if (!modes[mode]) return;
    const tab = tabs.find((t) => t.dataset.mode === mode) ?? tabs[0];
    if (!tab) return;
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    for (const key of Object.keys(modes)) modes[key]!.hidden = key !== mode;
  }

  switchToMode = switchTo;

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTo(tab.dataset.mode ?? 'try'));
  });

  syncModeFromHash();
}

export function initVerifierPanel(): void {
  initModeTabs();
  initTryMode();
  initCreateMode();
  initManualMode();
}
