// Renders the landing page's Nostr / Reserve / attack-corpus / FAQ
// sections. Nostr and Reserve show the LIVE Railway mint, observed when the
// page loads (with the observation time); if it cannot be reached they fall
// back to the captured reference run in evidence-data.ts, labelled as such
// with its capture date. The attack corpus is the recorded `npm run attacks`
// outcome set.
import { verifyPolEvidenceEvent } from '../nostr/pol-event.js';
import { fetchOutspend, fetchTxOutScript } from '../reserve/esplora.js';
import { escapeHtml, formatAgo, formatUtc, mutinynetTxUrl, njumpUrl } from './decision-view.js';
import { ATTACK_CORPUS, NOSTR_EVIDENCE, RESERVE_EVIDENCE } from './evidence-data.js';
import { FAQ } from './faq-data.js';
import { formatSats, truncateHex } from './format.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`landing-evidence: missing #${id}`);
  return el as T;
}

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;

interface LiveStatus {
  last_publication: { epoch_index: number; status: string; event_id: string | null; published_at: string; acked?: string[]; outstanding_balance?: number | null } | null;
  reserve_outpoint?: string | null;
  reserve_network?: string;
}

const host = (u: string) => u.replace(/^wss:\/\//, '').replace(/\/$/, '');

/** The captured reference run: real, but a snapshot — labelled with its own date, never as current status. */
function renderCapturedNostr(reason: string): void {
  byId('nostr-source').innerHTML = `<span class="ref-tag">CAPTURED REFERENCE RUN</span> Published ${formatUtc(NOSTR_EVIDENCE.event.created_at * 1000)} · purpose: mechanism example · ${escapeHtml(reason)}`;
  byId('nostr-kind').textContent = String(NOSTR_EVIDENCE.event.kind);
  byId('nostr-sig').textContent = 'VALID (at capture)';
  byId('nostr-state').textContent = NOSTR_EVIDENCE.successfulRelays.length > 0 ? `PUBLISHED ${formatUtc(NOSTR_EVIDENCE.event.created_at * 1000)}` : 'UNAVAILABLE';
  byId('nostr-relays').textContent = NOSTR_EVIDENCE.successfulRelays.join(', ') || 'no relay acked that run';
  byId('nostr-event-id').textContent = truncateHex(NOSTR_EVIDENCE.event.id, 14, 10);
}

function renderCapturedReserve(reason: string): void {
  const a = RESERVE_EVIDENCE.liveAttestation.attestation.statement;
  const outpoint = a.outpoints[0];
  byId('reserve-source').innerHTML = `<span class="ref-tag">CAPTURED REFERENCE RUN</span> Attested ${formatUtc(a.timestamp)} · ${escapeHtml(reason)}`;
  byId('reserve-network').textContent = a.network;
  byId('reserve-utxo').textContent = outpoint ? `${truncateHex(outpoint.txid, 10, 6)}:${outpoint.vout}` : 'unavailable';
  byId('reserve-amount').textContent = formatSats(RESERVE_EVIDENCE.liveAttestation.result.verifiedReserveSats);
  byId('reserve-utxo-state').textContent = RESERVE_EVIDENCE.liveAttestation.result.verified ? 'UNSPENT (at capture)' : 'UNVERIFIED';
  byId('reserve-liabilities').textContent = '—';
  byId('reserve-coverage').textContent = RESERVE_EVIDENCE.liveAttestation.result.verified ? 'COVERED (at capture)' : 'UNVERIFIED';
  byId('reserve-checked').textContent = `captured ${formatUtc(a.timestamp)} — not a current observation`;
}

/**
 * The live Railway mint's latest publication and reserve, observed now: the
 * event is fetched back from public relays (through the HTTPS relay fetch)
 * and its signature verified here; the reserve UTXO is queried on chain.
 * Every status carries the time it was observed.
 */
async function renderLive(): Promise<void> {
  const evidenceUrl = env.VITE_SOLVENT_EVIDENCE_URL?.replace(/\/+$/, '');
  if (!evidenceUrl) {
    renderCapturedNostr('this build has no live mint configured');
    renderCapturedReserve('this build has no live mint configured');
    return;
  }
  let st: LiveStatus;
  try {
    st = (await (await fetch(`${evidenceUrl}/v1/solvent/status`)).json()) as LiveStatus;
  } catch {
    renderCapturedNostr('the live mint could not be reached just now');
    renderCapturedReserve('the live mint could not be reached just now');
    return;
  }
  const p = st.last_publication;
  if (p?.event_id && p.status === 'published') {
    byId('nostr-source').innerHTML = `<span class="live-tag">LIVE RAILWAY MINT</span> Epoch ${p.epoch_index} · published ${formatUtc(p.published_at)} (${formatAgo(p.published_at)})`;
    byId('nostr-relays').textContent = (p.acked ?? []).map(host).join(', ') || '—';
    byId('nostr-event-id').innerHTML = `<a href="${njumpUrl(p.event_id)}" target="_blank" rel="noopener noreferrer">${truncateHex(p.event_id, 14, 10)} ↗</a>`;
    try {
      const r = (await (await fetch(`${evidenceUrl}/v1/solvent/nostr/event/${p.event_id}`)).json()) as { events: Parameters<typeof verifyPolEvidenceEvent>[0][]; fetched_from: string[]; fetched_at: string };
      const ev = r.events.find((e) => e.id === p.event_id);
      const v = ev ? verifyPolEvidenceEvent(ev) : null;
      byId('nostr-sig').textContent = v?.signatureValid ? `VALID (verified here, ${formatUtc(new Date())})` : ev ? 'INVALID' : 'NOT RETRIEVED';
      byId('nostr-state').textContent = ev ? `ON ${r.fetched_from.map(host).join(', ')} — checked ${formatUtc(r.fetched_at)}` : `NOT FOUND ON RELAYS — checked ${formatUtc(r.fetched_at)}`;
    } catch {
      byId('nostr-sig').textContent = 'NOT CHECKED (relay fetch failed)';
      byId('nostr-state').textContent = `PUBLISHED ${formatUtc(p.published_at)}`;
    }
  } else {
    renderCapturedNostr('the live mint has not published an epoch yet');
  }

  const [txid, vout] = (st.reserve_outpoint ?? '').split(':');
  if (!txid || vout === undefined) {
    renderCapturedReserve('the live mint did not report its reserve outpoint');
    return;
  }
  byId('reserve-source').innerHTML = '<span class="live-tag">LIVE RAILWAY MINT</span> Reserve observed on chain by this page';
  byId('reserve-network').textContent = st.reserve_network ?? 'bitcoin-signet-mutinynet';
  byId('reserve-utxo').innerHTML = `<a href="${mutinynetTxUrl(txid)}" target="_blank" rel="noopener noreferrer">${truncateHex(txid, 10, 6)}:${vout} ↗</a>`;
  try {
    const [out, spend] = await Promise.all([fetchTxOutScript(txid, Number(vout)), fetchOutspend(txid, Number(vout))]);
    const checked = new Date();
    if (!out) throw new Error('outpoint not found');
    byId('reserve-amount').textContent = formatSats(out.value);
    byId('reserve-utxo-state').textContent = spend.spent ? 'SPENT' : 'UNSPENT';
    const owed = p?.outstanding_balance;
    byId('reserve-liabilities').textContent = typeof owed === 'number' ? `${formatSats(owed)} (epoch ${p!.epoch_index})` : '—';
    byId('reserve-coverage').textContent = typeof owed === 'number' ? (!spend.spent && out.value >= owed ? 'COVERED' : 'NOT COVERED') : '—';
    byId('reserve-checked').textContent = `${formatUtc(checked)} (${formatAgo(checked)})`;
    setInterval(() => (byId('reserve-checked').textContent = `${formatUtc(checked)} (${formatAgo(checked)})`), 15_000);
  } catch (err) {
    byId('reserve-amount').textContent = '—';
    byId('reserve-utxo-state').textContent = `NOT CHECKED (${(err as Error).message})`;
    byId('reserve-coverage').textContent = '—';
    byId('reserve-checked').textContent = formatUtc(new Date());
  }
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
  void renderLive();
  renderAttackCorpus();
  renderFaqAccordion();
}
