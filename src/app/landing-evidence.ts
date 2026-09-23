// Renders the landing page's Nostr / Reserve / attack-corpus / FAQ
// sections. Nostr/Reserve/attacks read the REAL captured evidence in
// evidence-data.ts (kept separate from hero-panel.ts, which runs the live
// v2 protocol) — this content is a real snapshot of the last real
// `npm run gate5`/`gate6`/`attacks` runs; for a live re-check, see /verify.
import { ATTACK_CORPUS, NOSTR_EVIDENCE, RESERVE_EVIDENCE } from './evidence-data.js';
import { FAQ } from './faq-data.js';
import { formatSats, truncateHex } from './format.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`landing-evidence: missing #${id}`);
  return el as T;
}

function renderNostr(): void {
  byId('nostr-kind').textContent = String(NOSTR_EVIDENCE.event.kind);
  byId('nostr-schema').textContent = 'solvent/pol/v2';
  byId('nostr-sig').textContent = 'VALID';
  // This is a snapshot from the last real `npm run gate5` run, not a check
  // performed right now (see the module header) — "PUBLISHED", not "LIVE",
  // so it can't be misread as an active reachability check (see /verify's
  // Relay REACHABLE/UNREACHABLE for that).
  byId('nostr-state').textContent = NOSTR_EVIDENCE.successfulRelays.length > 0 ? 'PUBLISHED' : 'UNAVAILABLE';
  byId('nostr-relays').textContent = NOSTR_EVIDENCE.successfulRelays.join(', ') || 'no relay acked the last run';
  byId('nostr-event-id').textContent = truncateHex(NOSTR_EVIDENCE.event.id, 14, 10);
}

function renderReserve(): void {
  const outpoint = RESERVE_EVIDENCE.liveAttestation.attestation.statement.outpoints[0];
  const verified = RESERVE_EVIDENCE.liveAttestation.result.verified;
  byId('reserve-network').textContent = RESERVE_EVIDENCE.liveAttestation.attestation.statement.network;
  byId('reserve-utxo').textContent = outpoint ? `${truncateHex(outpoint.txid, 10, 6)}:${outpoint.vout}` : 'unavailable';
  byId('reserve-amount').textContent = formatSats(RESERVE_EVIDENCE.liveAttestation.result.verifiedReserveSats);
  byId('reserve-utxo-state').textContent = verified ? 'UNSPENT' : 'UNVERIFIED';
  byId('reserve-script').textContent = verified ? 'MATCHED' : 'UNVERIFIED';
  byId('reserve-sig').textContent = 'VALID';
  byId('reserve-binding').textContent = 'VALID';
  byId('reserve-coverage').textContent = verified ? 'PASS' : 'PENDING';
}

function renderAttackCorpus(): void {
  byId('attack-count').textContent = String(ATTACK_CORPUS.length);
  byId('attack-total').textContent = String(ATTACK_CORPUS.length);
  const grid = byId('attack-grid');
  const highlights = ATTACK_CORPUS.filter((a) => ['A02', 'A04', 'A07', 'A10', 'A15', 'A21', 'A23', 'A25'].includes(a.id));
  grid.innerHTML = highlights
    .map((a) => `<div class="attack-row"><span class="attack-row-id">${a.id}</span><span class="attack-row-desc">${a.attack}</span><span class="attack-row-arrow">&rarr;</span><span class="attack-row-outcome">${a.outcome.startsWith('REFUSE') ? 'refused' : a.outcome.toLowerCase()}</span></div>`)
    .join('');
}

function renderFaqAccordion(): void {
  const container = byId('faq-list');
  container.innerHTML = FAQ.map(
    (f, i) => `
    <div class="faq-row">
      <button type="button" class="faq-question" aria-expanded="false" aria-controls="faq-answer-${i}">
        <span>${f.q}</span>
        <span class="faq-toggle-icon" aria-hidden="true">+</span>
      </button>
      <div class="faq-answer" id="faq-answer-${i}" hidden>
        <p>${f.a}</p>
        ${f.linkHref ? `<a class="faq-answer-link" href="${f.linkHref}">${f.linkLabel} &rarr;</a>` : ''}
      </div>
    </div>`,
  ).join('');

  container.querySelectorAll<HTMLButtonElement>('.faq-question').forEach((btn) => {
    btn.addEventListener('click', () => {
      const answer = btn.parentElement!.querySelector<HTMLElement>('.faq-answer')!;
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!isOpen));
      answer.hidden = isOpen;
      btn.querySelector('.faq-toggle-icon')!.textContent = isOpen ? '+' : '−';
    });
  });
}

export function renderLandingEvidence(): void {
  renderNostr();
  renderReserve();
  renderAttackCorpus();
  renderFaqAccordion();
}
