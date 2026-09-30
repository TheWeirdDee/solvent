// #/lab — REFERENCE MINT LAB, for developers. Deliberately not in the
// primary navigation and not a peer of /verify's two modes: evidence made
// here is never published, so it can pass every local check but never
// public retrieval. Its primary action is therefore CHECK LOCAL
// CRYPTOGRAPHY; "full verification" is offered too, and honestly refuses.
import { submissionBundleToJson } from './bundle-json.js';
import {
  chainStates,
  decisionCopy,
  decisionFacts,
  escapeHtml,
  formatDate,
  localCryptography,
  renderDecision,
  resultClass,
  type DecisionElements,
} from './decision-view.js';
import { formatSats, truncateHex } from './format.js';
import {
  checkLocalCryptography,
  createLabMint,
  issueFromLab,
  LAB_AMOUNTS,
  LAB_RESERVE_SATS,
  loadLabMint,
  outstandingOf,
  rotateLabKeyset,
  saveLabMint,
  type LabIssuance,
  type LabMintState,
} from './reference-mint.js';
import { verifySubmission } from './submission.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`lab-panel: missing #${id}`);
  return el as T;
}

function rows(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

export function initLabPanel(): void {
  const mintRows = byId<HTMLElement>('lab-mint-rows');
  const amountSelect = byId<HTMLSelectElement>('lab-amount');
  const omitBox = byId<HTMLInputElement>('lab-omit');
  const issueBtn = byId<HTMLButtonElement>('lab-issue-btn');
  const rotateBtn = byId<HTMLButtonElement>('lab-rotate-btn');
  const resetBtn = byId<HTMLButtonElement>('lab-reset-btn');
  const statusEl = byId<HTMLElement>('lab-status');
  const issuanceCard = byId<HTMLElement>('lab-issuance');
  const issuanceRows = byId<HTMLElement>('lab-issuance-rows');
  const checkBtn = byId<HTMLButtonElement>('lab-check-btn');
  const fullBtn = byId<HTMLButtonElement>('lab-full-btn');
  const copyBtn = byId<HTMLButtonElement>('lab-copy-bundle-btn');
  const bundlePre = byId<HTMLElement>('lab-bundle-json');
  const resultCard = byId<HTMLElement>('lab-result');
  const els: DecisionElements = {
    badge: byId('lab-decision-badge'),
    headline: byId('lab-decision-headline'),
    body: byId('lab-decision-body'),
    facts: byId('lab-decision-facts'),
    chain: byId('lab-decision-chain'),
  };

  amountSelect.innerHTML = LAB_AMOUNTS.map((a) => `<option value="${a}"${a === 70_000 ? ' selected' : ''}>${formatSats(a)}</option>`).join('');

  // Loaded on first visit to #/lab, not at app start: the lab is a
  // developer route, and creating a mint identity nobody asked for on the
  // landing page would be wasted work.
  let state: LabMintState | null = null;
  let latest: LabIssuance | null = null;

  function mint(): LabMintState {
    state ??= loadLabMint();
    return state;
  }

  function renderMint(): void {
    const s = mint();
    const outstanding = outstandingOf(s);
    mintRows.innerHTML = rows([
      ['Mint identity', `<span class="mono">${truncateHex(s.masterPubHex, 10, 6)}</span>`],
      ['Active keyset', `<span class="mono">${escapeHtml(s.keyset.keysetId)}</span> · generation ${s.keysetGeneration}`],
      ['Created', formatDate(s.createdAt)],
      ['Closed epochs', String(s.epoch)],
      ['Issuances on active keyset', `${s.leaves.length}${s.leaves.some((l) => !l.included) ? ` (${s.leaves.filter((l) => !l.included).length} omitted)` : ''}`],
      ['Outstanding liabilities', formatSats(outstanding)],
      ['Reserve UTXO (Signet)', `${formatSats(LAB_RESERVE_SATS)}${outstanding > LAB_RESERVE_SATS ? ' — below liabilities' : ''}`],
    ]);
  }

  function clearIssuance(): void {
    latest = null;
    issuanceCard.hidden = true;
    resultCard.hidden = true;
  }

  async function onIssue(): Promise<void> {
    issueBtn.disabled = true;
    resultCard.hidden = true;
    statusEl.textContent = 'Issuing: blind signing, signing the receipt, closing the next epoch, and re-querying the reserve tip…';
    const amount = Number(amountSelect.value);
    const { state: next, issuance } = await issueFromLab(mint(), amount, omitBox.checked);
    state = next;
    latest = issuance;
    renderMint();
    issuanceRows.innerHTML = rows([
      ['Amount', formatSats(issuance.amount)],
      ['Proof secret', `<span class="mono">${truncateHex(issuance.secret, 10, 6)}</span>`],
      ['Reconstructed B′', `<span class="mono">${truncateHex(issuance.bPrime, 12, 8)}</span>`],
      ['Receipt signature', `<span class="mono">${truncateHex(issuance.receipt.signature, 12, 8)}</span>`],
      ['Promised epoch', String(issuance.epoch)],
      ['In the closed epoch', issuance.included ? 'YES' : 'NO — omitted by the mint'],
      ['Issued', formatDate(issuance.issuedAt)],
      ['Token', `<span class="mono">${truncateHex(issuance.token, 16, 8)}</span>`],
      ['Published to Nostr', 'NO — lab evidence is never published'],
    ]);
    bundlePre.textContent = submissionBundleToJson(issuance.bundle);
    issuanceCard.hidden = false;
    statusEl.textContent = `Issued ${formatSats(issuance.amount)} and closed epoch ${issuance.epoch}.`;
    issueBtn.disabled = false;
  }

  function onCheckLocal(): void {
    if (!latest) return;
    const result = checkLocalCryptography(latest.bundle);
    const local = localCryptography(result);
    resultCard.hidden = false;
    renderDecision(els, {
      kind: 'LOCAL',
      copy: {
        title: local.valid ? 'LOCAL CRYPTOGRAPHY VALID.' : `LOCAL CHECK FAILED — ${local.failedStep!.toUpperCase()}.`,
        body: local.valid
          ? 'Steps 1-6 pass using only this bundle: the proof, its NUT-12 origin, the signed receipt, the closed epoch, the signed manifest and the inclusion proof. This is not a full verification — public Nostr retrieval and the live reserve were not checked, and lab evidence is never published.'
          : `${result.reason} This was found from the bundle alone, before any public evidence was consulted.`,
      },
      facts: decisionFacts(result, null, null),
      states: chainStates(result, { localOnly: true }),
    });
  }

  async function onFullVerification(): Promise<void> {
    if (!latest) return;
    fullBtn.disabled = true;
    const v = await verifySubmission(latest.bundle);
    resultCard.hidden = false;
    renderDecision(els, {
      kind: v.result.decision,
      copy: decisionCopy(v.result, v.reserveLive, v.nostrLive, 'lab'),
      facts: decisionFacts(v.result, v.reserveLive, v.nostrLive),
      states: chainStates(v.result),
      cls: resultClass(v.result, v.reserveLive, v.nostrLive),
    });
    fullBtn.disabled = false;
  }

  issueBtn.addEventListener('click', () => void onIssue());
  checkBtn.addEventListener('click', onCheckLocal);
  fullBtn.addEventListener('click', () => void onFullVerification());
  copyBtn.addEventListener('click', () => {
    if (latest) void navigator.clipboard?.writeText(submissionBundleToJson(latest.bundle));
  });
  rotateBtn.addEventListener('click', () => {
    state = rotateLabKeyset(mint());
    clearIssuance();
    renderMint();
    statusEl.textContent = `Keyset rotated — generation ${state.keysetGeneration}, new keyset ${state.keyset.keysetId}.`;
  });
  resetBtn.addEventListener('click', () => {
    state = createLabMint();
    saveLabMint(state);
    clearIssuance();
    renderMint();
    statusEl.textContent = 'New reference mint identity created.';
  });

  window.addEventListener('hashchange', () => {
    if (window.location.hash.startsWith('#/lab')) renderMint();
  });
  if (window.location.hash.startsWith('#/lab')) renderMint();
}
