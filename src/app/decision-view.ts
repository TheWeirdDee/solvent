// How every verification result is presented — shared by /verify (Live
// check, Verify evidence) and the /lab reference mint. It only ever renders
// what the real pipeline returned (verify() + verifySubmission()'s
// independent live reserve/Nostr re-derivation); nothing here decides
// ACCEPT/REFUSE.
//
// Hierarchy rule: the badge is always the FINAL decision (ACCEPT or
// REFUSE) and the headline names why. Partial facts ("the token's
// cryptography is valid") are secondary rows under it, never a headline
// that could read as success when the decision is REFUSE.
import { maxAttestationAgeBlocks, RESERVE_FRESHNESS_POLICY } from '../reserve/evaluate.js';
import type { ReasonCode } from '../verifier/reasons.js';
import type { VerifyResult } from '../verifier/verify.js';
import { formatSats, truncateHex } from './format.js';
import type { NostrLiveStatus, ReserveLiveStatus } from './submission.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

// -------------------- the nine checks --------------------

export type StepState = 'ok' | 'fail' | 'na';

export const STEP_DEFS: { label: string; tech: string }[] = [
  { label: 'Token format', tech: 'Cashu proof parses' },
  { label: 'Mint origin / NUT-12', tech: 'keyset + DLEQ proof' },
  { label: 'PoL receipt', tech: 'signed liability receipt' },
  { label: 'Promised epoch', tech: 'target epoch is closed' },
  { label: 'Signed epoch manifest', tech: 'manifest signature + liability arithmetic' },
  { label: 'Liability inclusion', tech: 'sum-MMR inclusion proof' },
  { label: 'Public Nostr retrieval', tech: 'event fetched from public relays' },
  { label: 'Live reserve', tech: 'reserve UTXO re-queried now' },
  { label: 'Decision', tech: 'reason code' },
];

/** Steps 1-6: checked from the bundle alone, in verify()'s own order. */
function localChecks(result: VerifyResult): boolean[] {
  const c = result.checks;
  return [
    c.parses,
    c.supportedKeyset && c.dleqPresent && c.dleqValid,
    c.receiptValid,
    c.targetEpochClosed,
    c.manifestValid && c.liabilityArithmeticValid,
    c.inclusionValid,
  ];
}

/**
 * State of each of the nine steps. verify() stops at the first failing
 * local check, so the checks after it never ran and show as "not reached"
 * rather than as failures. Steps 7-8 are the live Nostr/reserve results,
 * which verifySubmission() establishes independently of the local chain.
 */
export function chainStates(result: VerifyResult, opts: { localOnly?: boolean } = {}): StepState[] {
  const local = localChecks(result);
  const firstFail = local.findIndex((ok) => !ok);
  const localStates: StepState[] = local.map((_, i) => (firstFail === -1 || i < firstFail ? 'ok' : i === firstFail ? 'fail' : 'na'));
  if (opts.localOnly) return [...localStates, 'na', 'na', 'na'];
  const tri = (v: boolean | null): StepState => (v === null ? 'na' : v ? 'ok' : 'fail');
  return [...localStates, tri(result.checks.nostrEvidence), tri(result.checks.reserveCoverage), result.decision === 'ACCEPT' ? 'ok' : 'fail'];
}

export function localCryptography(result: VerifyResult): { valid: boolean; failedStep: string | null } {
  const firstFail = localChecks(result).findIndex((ok) => !ok);
  return firstFail === -1 ? { valid: true, failedStep: null } : { valid: false, failedStep: STEP_DEFS[firstFail]!.label };
}

// -------------------- secondary facts --------------------

export type Tone = 'ok' | 'bad' | 'warn' | 'muted';

export interface DecisionFact {
  label: string;
  value: string;
  tone: Tone;
}

export function isReserveAttestationExpired(reserveLive: ReserveLiveStatus): boolean {
  return reserveLive.reasonCode === 'REFUSE_RESERVE_ATTESTATION_INVALID' && reserveLive.detail.toLowerCase().includes('stale');
}

function publicRetrievalFact(n: NostrLiveStatus): DecisionFact {
  const label = 'Public Nostr retrieval';
  if (!n.supplied) return { label, value: 'NO EVENT SUPPLIED', tone: 'bad' };
  if (n.publicationVerified) return { label, value: 'RETRIEVED AND VERIFIED', tone: 'ok' };
  if (!n.relayReachable) return { label, value: 'RELAYS UNAVAILABLE', tone: 'warn' };
  if (!n.eventFetched) return { label, value: 'NOT FOUND', tone: 'bad' };
  return { label, value: `REJECTED (${n.reasonCode ?? 'UNVERIFIED'})`, tone: 'bad' };
}

function reserveFact(r: ReserveLiveStatus): DecisionFact {
  const label = 'Live reserve';
  if (!r.supplied) return { label, value: 'NO ATTESTATION SUPPLIED', tone: 'bad' };
  if (!r.queryOk) return { label, value: 'UNAVAILABLE', tone: 'warn' };
  if (r.verified) return { label, value: `COVERED (${formatSats(r.verifiedReserveSats)})`, tone: 'ok' };
  if (isReserveAttestationExpired(r)) return { label, value: 'ATTESTATION EXPIRED', tone: 'bad' };
  const byCode: Partial<Record<NonNullable<ReserveLiveStatus['reasonCode']>, string>> = {
    REFUSE_RESERVE_UTXO_SPENT: 'SPENT',
    REFUSE_RESERVE_SHORT: 'SHORT',
    REFUSE_RESERVE_STATE_MISMATCH: 'STATE MISMATCH',
    REFUSE_RESERVE_ATTESTATION_INVALID: 'ATTESTATION INVALID',
  };
  return { label, value: (r.reasonCode && byCode[r.reasonCode]) ?? 'NOT VERIFIED', tone: 'bad' };
}

export function decisionFacts(result: VerifyResult, reserveLive: ReserveLiveStatus | null, nostrLive: NostrLiveStatus | null): DecisionFact[] {
  const local = localCryptography(result);
  const notChecked = (label: string): DecisionFact => ({ label, value: 'NOT CHECKED (local only)', tone: 'muted' });
  return [
    { label: 'Local cryptography', value: local.valid ? 'VALID' : `FAILED — ${local.failedStep}`, tone: local.valid ? 'ok' : 'bad' },
    nostrLive ? publicRetrievalFact(nostrLive) : notChecked('Public Nostr retrieval'),
    reserveLive ? reserveFact(reserveLive) : notChecked('Live reserve'),
  ];
}

// -------------------- headline + body --------------------

export interface DecisionCopy {
  title: string;
  body: string;
}

/** Where the result is shown — only changes wording, never the decision. */
export type DecisionContext = 'live' | 'evidence' | 'lab';

const UNSUPPORTED_MINT_CODES: ReasonCode[] = ['REFUSE_UNSUPPORTED_KEYSET', 'REFUSE_MALFORMED_TOKEN'];

export const UNSUPPORTED_MINT_BODY = 'This mint does not provide the SOLVENT-compatible liability evidence required for full verification.';

const TITLES: Partial<Record<ReasonCode, string>> = {
  REFUSE_ISSUANCE_OMITTED: 'BROKEN PROMISE.',
  REFUSE_RESERVE_SHORT: 'RESERVE SHORTFALL.',
  REFUSE_RESERVE_UTXO_SPENT: 'RESERVE SPENT.',
  REFUSE_RESERVE_STATE_MISMATCH: 'RESERVE STATE MISMATCH.',
  REFUSE_NOSTR_CONFLICT: 'CONFLICTING PUBLIC STATE.',
  REFUSE_NOSTR_STALE: 'PUBLIC EVIDENCE STALE.',
  REFUSE_NOSTR_STATE_MISMATCH: 'PUBLIC STATE MISMATCH.',
  REFUSE_NOSTR_SIGNATURE: 'INVALID PUBLIC EVIDENCE.',
};

export function decisionCopy(result: VerifyResult, reserveLive: ReserveLiveStatus, nostrLive: NostrLiveStatus, context: DecisionContext): DecisionCopy {
  const code = result.reasonCode;
  const localValid = localCryptography(result).valid;

  if (result.decision === 'ACCEPT') {
    return {
      title: 'ACCEPT VERIFIED.',
      body: "The token and its signatures are valid, the mint's signed promise is included in its closed accounting epoch, that state was independently retrieved from public Nostr relays, and the live Bitcoin reserve covers what the mint owes.",
    };
  }
  if (UNSUPPORTED_MINT_CODES.includes(code)) {
    return { title: 'UNSUPPORTED MINT.', body: `${UNSUPPORTED_MINT_BODY} ${result.reason}` };
  }
  if (code === 'REFUSE_ISSUANCE_OMITTED') {
    return { title: TITLES[code]!, body: 'The mint signed a receipt promising to include this issuance in this epoch. Its own signed, closed epoch omits it — two signed statements from the same mint that contradict each other.' };
  }
  if (code === 'REFUSE_RESERVE_SHORT') {
    return { title: TITLES[code]!, body: 'The issuance is correctly accounted for, but the independently verified reserve is below what the mint owes.' };
  }
  if (localValid && reserveLive.supplied && reserveLive.queried && !reserveLive.queryOk) {
    return {
      title: 'LIVE RESERVE UNAVAILABLE.',
      body: `SOLVENT could not reach the live reserve network just now (${reserveLive.detail}). Acceptance is blocked because the reserve cannot be independently checked — this is not a shortfall. Run the check again.`,
    };
  }
  if (isReserveAttestationExpired(reserveLive)) {
    return context === 'live'
      ? {
          title: 'LIVE EVIDENCE EXPIRED.',
          body: "The published reference case's reserve attestation is older than its freshness window, so SOLVENT will not rely on it. The verifier is working; the reference case needs to be regenerated and republished by its maintainer (npm run live-demo).",
        }
      : { title: 'RESERVE ATTESTATION EXPIRED.', body: "This bundle's reserve attestation is older than its freshness window, so SOLVENT will not rely on it. The mint needs to publish a fresh attestation." };
  }
  if (code === 'REFUSE_NOSTR_EVENT_NOT_FOUND') {
    return {
      title: 'PUBLIC EVIDENCE NOT FOUND.',
      body: localValid
        ? 'The token and supplied signatures are cryptographically valid, but SOLVENT could not independently retrieve the required accounting event from public relays. Acceptance is blocked.'
        : result.reason,
    };
  }
  if (code === 'REFUSE_NOSTR_UNAVAILABLE' || (code === 'REFUSE_UNVERIFIABLE' && nostrLive.supplied && !nostrLive.relayReachable)) {
    return {
      title: 'PUBLIC EVIDENCE UNAVAILABLE.',
      body: "SOLVENT could not reach any configured public Nostr relay, so it cannot independently retrieve the mint's accounting event. Acceptance is blocked until the public evidence can be checked — run the check again.",
    };
  }
  if (code === 'REFUSE_UNVERIFIABLE') {
    const missing = [!reserveLive.supplied ? 'no reserve attestation' : null, !nostrLive.supplied ? 'no Nostr evidence event' : null].filter(Boolean).join(' and ');
    return { title: 'UNVERIFIABLE.', body: missing ? `This bundle supplies ${missing}, so a required check cannot be independently verified. SOLVENT refuses rather than assume.` : result.reason };
  }
  return { title: TITLES[code] ?? `${code.replace(/^REFUSE_/, '').replace(/_/g, ' ')}.`, body: result.reason };
}

// -------------------- rendering --------------------

export interface DecisionElements {
  badge: HTMLElement;
  headline: HTMLElement;
  body: HTMLElement;
  facts: HTMLElement;
  chain: HTMLElement;
}

function chainStepHtml(label: string, tech: string, state: StepState, extraClass = ''): string {
  const icon = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '—';
  return `<div class="chain-step chain-step-${state}${extraClass}"><span class="chain-step-icon">${icon}</span><span class="chain-step-label">${label}<span class="chain-step-tech">${tech}</span></span></div>`;
}

export function factsHtml(facts: DecisionFact[]): string {
  return facts.map((f) => `<div class="decision-fact decision-fact-${f.tone}"><dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd></div>`).join('');
}

/**
 * `kind` is the verdict the badge states: the real ACCEPT/REFUSE decision,
 * or LOCAL for the lab's local-only check, which never reaches a decision.
 */
export function renderDecision(els: DecisionElements, view: { kind: 'ACCEPT' | 'REFUSE' | 'LOCAL'; copy: DecisionCopy; facts: DecisionFact[]; states: StepState[] }): void {
  const { kind } = view;
  els.badge.textContent = kind === 'ACCEPT' ? '✓ ACCEPT' : kind === 'REFUSE' ? '✕ REFUSE' : 'LOCAL CHECK ONLY';
  els.badge.className = `decision-badge ${kind === 'ACCEPT' ? 'green' : kind === 'REFUSE' ? 'red' : 'amber'}`;
  els.headline.textContent = view.copy.title;
  els.body.textContent = view.copy.body;
  els.facts.innerHTML = factsHtml(view.facts);
  const finalLabel = kind === 'LOCAL' ? 'No decision' : kind;
  els.chain.innerHTML = STEP_DEFS.map((def, i) =>
    i === STEP_DEFS.length - 1 ? chainStepHtml(finalLabel, def.tech, view.states[i] ?? 'na', ' chain-step-final') : chainStepHtml(`${i + 1}. ${def.label}`, def.tech, view.states[i] ?? 'na'),
  ).join('<div class="chain-connector" aria-hidden="true"></div>');
}

// -------------------- progress --------------------

export function renderProgressSteps(container: HTMLElement): HTMLElement[] {
  container.innerHTML = STEP_DEFS.map(
    (s, i) => `<div class="progress-step" data-step="${i}"><span class="step-icon"></span><span class="step-label">${i + 1}. ${s.label} <span class="step-label-tech">${s.tech}</span></span></div>`,
  ).join('');
  return Array.from(container.querySelectorAll<HTMLElement>('.progress-step'));
}

export async function revealProgress(rows: HTMLElement[], states: StepState[]): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await new Promise((r) => setTimeout(r, 70));
    const row = rows[i]!;
    const state = states[i] ?? 'na';
    row.classList.add('visible', state === 'ok' ? 'pass' : state === 'fail' ? 'fail' : 'na');
    row.querySelector('.step-icon')!.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '—';
  }
}

// -------------------- evidence detail blocks --------------------

// Never mainnet: the reserve is Bitcoin Signet (Mutinynet), and both links
// point at that network's own public viewers. See src/reserve/esplora.ts.
export function mutinynetTxUrl(txid: string): string {
  return `https://mutinynet.com/tx/${txid}`;
}

export function njumpUrl(eventId: string): string {
  return `https://njump.me/${eventId}`;
}

const NETWORK_NAMES: Record<string, string> = { 'bitcoin-signet-mutinynet': 'Mutinynet (Bitcoin Signet)' };

export function networkName(network: string): string {
  return NETWORK_NAMES[network] ?? network;
}

export function evidenceSection(title: string, rows: [string, string][], extraHtml = ''): string {
  return `<div class="evidence-section"><h3>${title}</h3><dl class="evidence-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${extraHtml}</div>`;
}

export function copyLinkRow(label: string, fullValue: string, explorerUrl: string, explorerLabel: string): string {
  const safe = escapeHtml(fullValue);
  return `<div class="evidence-links"><button type="button" class="btn btn-outline btn-sm copy-evidence-btn" data-copy="${safe}">${label}</button><a href="${explorerUrl}" target="_blank" rel="noreferrer" class="btn btn-outline btn-sm">${explorerLabel} ↗</a></div>`;
}

export function bindCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.copy-evidence-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.copy;
      if (val) void navigator.clipboard?.writeText(val);
    });
  });
}

/** The exact public identifiers a check used, in full, so anyone can look them up independently. */
export function checkedIdsHtml(eventId: string | null, outpoint: { txid: string; vout: number } | null): string {
  const rows: string[] = [];
  if (eventId) {
    rows.push(`<div class="checked-id"><span class="checked-id-label">Nostr event</span><code class="checked-id-value">${escapeHtml(eventId)}</code><a href="${njumpUrl(eventId)}" target="_blank" rel="noreferrer">View event ↗</a></div>`);
  }
  if (outpoint) {
    rows.push(`<div class="checked-id"><span class="checked-id-label">Reserve UTXO</span><code class="checked-id-value">${escapeHtml(outpoint.txid)}:${outpoint.vout}</code><a href="${mutinynetTxUrl(outpoint.txid)}" target="_blank" rel="noreferrer">View UTXO ↗</a></div>`);
  }
  return rows.join('');
}

export function mintIdentityBlock(fields: { masterPublicKeyHex: string; keysetId: string; amountLabel: string; amount: number; issuer: string }): string {
  return `<div class="mint-identity">
    <div class="mint-identity-row"><span class="mint-identity-label">Mint identity</span><span class="mint-identity-value mono">${truncateHex(fields.masterPublicKeyHex, 10, 6)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Keyset</span><span class="mint-identity-value mono">${escapeHtml(fields.keysetId)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">${escapeHtml(fields.amountLabel)}</span><span class="mint-identity-value">${formatSats(fields.amount)}</span></div>
    <div class="mint-identity-row"><span class="mint-identity-label">Issuer</span><span class="mint-identity-value">${escapeHtml(fields.issuer)}</span></div>
  </div>`;
}

/** Don't present a broken promise as a confusing "outstanding balance: 0" — show the explicit contradiction. */
export function contradictionCard(promisedSats: number, reportedSats: number): string {
  const omitted = promisedSats - reportedSats;
  return `<div class="contradiction-card">
    <p class="contradiction-title">The mint's own signed statements contradict each other</p>
    <dl class="evidence-rows">
      <dt>Receipt-promised issuance</dt><dd>${formatSats(promisedSats)}</dd>
      <dt>Manifest-reported issuance</dt><dd>${formatSats(reportedSats)}</dd>
      <dt>Omitted</dt><dd class="contradiction-omitted">${formatSats(Math.max(0, omitted))}</dd>
    </dl>
    <p class="contradiction-sentence">The mint signed a receipt promising to count ${formatSats(promisedSats)}. Its own signed closed-epoch manifest does not include it. SOLVENT refuses on that contradiction alone.</p>
  </div>`;
}

/** "Reserve checked and short" and "reserve unverified" are different claims. */
export function shortfallCard(liabilities: number, liveReserve: number): string {
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
    <p class="contradiction-sentence">SOLVENT re-queried the reserve UTXO just now and confirmed its real on-chain value. That value (${formatSats(liveReserve)}) is below what the mint owes (${formatSats(liabilities)}), so SOLVENT refuses.</p>
  </div>`;
}

// "Relay reachable" and "this exact event was retrieved" are different
// claims and are never compressed into one row. Signature/binding/freshness
// describe whatever was actually used for the decision.
export function nostrEvidenceRows(nostrEvent: { id: string; kind: number }, nostrLive: NostrLiveStatus): [string, string][] {
  return [
    ['Event id', truncateHex(nostrEvent.id, 12, 8)],
    ['Kind', String(nostrEvent.kind)],
    ['Schema', 'solvent/pol/v2'],
    ['Relay', nostrLive.relayReachable ? 'REACHABLE' : 'UNREACHABLE'],
    ['Exact event', nostrLive.eventFetched ? 'FOUND (public relay)' : 'NOT FOUND'],
    ['Supplied copy', nostrLive.providedCopyValid ? 'CRYPTOGRAPHICALLY VALID' : 'INVALID'],
    ['Signature (of what was actually used)', nostrLive.signatureValid ? 'VALID' : 'INVALID'],
    ['Freshness (of what was actually used)', nostrLive.freshnessValid ? 'VALID' : 'STALE / N-A'],
    ['Mint / manifest binding (of what was actually used)', nostrLive.bindingValid ? 'VALID' : 'INVALID'],
    ['Public retrieval', nostrLive.publicationVerified ? 'VERIFIED' : `NOT VERIFIED (${nostrLive.reasonCode ?? 'UNVERIFIED'})`],
  ];
}

export interface ReserveFreshness {
  maxAgeBlocks: number;
  secondsPerBlock: number;
  ageBlocks: number;
  blocksLeft: number;
  expiresAt: Date;
}

/** Tracks evaluateReserveAttestation()'s own network-aware budget (src/reserve/evaluate.ts), so the displayed expiry can never drift from what actually gates ACCEPT. */
export function reserveFreshness(network: string, attestedBlockHeight: number, tipHeight: number, now = Date.now()): ReserveFreshness {
  const maxAgeBlocks = maxAttestationAgeBlocks(network);
  const secondsPerBlock = RESERVE_FRESHNESS_POLICY.secondsPerBlockByNetwork[network] ?? RESERVE_FRESHNESS_POLICY.defaultSecondsPerBlock;
  const ageBlocks = tipHeight - attestedBlockHeight;
  const blocksLeft = maxAgeBlocks - ageBlocks;
  return { maxAgeBlocks, secondsPerBlock, ageBlocks, blocksLeft, expiresAt: new Date(now + blocksLeft * secondsPerBlock * 1000) };
}

export function formatDate(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function reserveEvidenceRows(
  outpoint: { txid: string; vout: number } | undefined,
  attestation: { network: string; block_height: number } | undefined,
  reserveLive: ReserveLiveStatus,
): [string, string][] {
  const rows: [string, string][] = [
    ['Network', attestation ? networkName(attestation.network) : '—'],
    ['Txid', outpoint ? truncateHex(outpoint.txid, 10, 6) : '—'],
    ['Vout', outpoint ? String(outpoint.vout) : '—'],
    ['Live network query', reserveLive.queried ? (reserveLive.queryOk ? 'SUCCEEDED' : 'FAILED') : 'NOT ATTEMPTED'],
    ['Live value (just fetched)', reserveLive.queried && reserveLive.queryOk ? formatSats(reserveLive.verifiedReserveSats) : '—'],
    ['Reserve signature / mint binding', reserveLive.reasonCode === 'REFUSE_RESERVE_ATTESTATION_INVALID' && !isReserveAttestationExpired(reserveLive) ? 'INVALID' : reserveLive.queryOk ? 'VALID' : 'UNCHECKED'],
    ['Coverage', reserveLive.queryOk ? (reserveLive.verified ? 'PASS' : 'NOT COVERED') : 'UNVERIFIABLE (network)'],
  ];
  if (attestation && reserveLive.tipHeight !== undefined) {
    const f = reserveFreshness(attestation.network, attestation.block_height, reserveLive.tipHeight);
    rows.push(['Attestation freshness', f.blocksLeft > 0 ? `FRESH — until approximately ${formatDate(f.expiresAt)}` : 'EXPIRED — needs regeneration']);
  }
  return rows;
}

export function rawJsonToggles(bundleJson: string, resultJson: string): string {
  return (
    `<details class="raw-json-toggle"><summary>View raw bundle</summary><pre class="raw-json">${escapeHtml(bundleJson)}</pre></details>` +
    `<details class="raw-json-toggle"><summary>View result JSON</summary><pre class="raw-json">${escapeHtml(resultJson)}</pre></details>`
  );
}
