// Publish / evidence-pipeline panel — v2 read-only view (PRD "do not fake
// a publisher UI" instruction). Shows the REAL last-captured evidence from
// `npm run gate5`/`gate6` (see evidence-data.ts), not a simulated publish
// action pretending to hit relay/chain infrastructure it doesn't.
import { NOSTR_EVIDENCE, RESERVE_EVIDENCE } from './evidence-data.js';
import { formatSats, truncateHex } from './format.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`publisher-panel: missing #${id}`);
  return el as T;
}

function summaryRows(rows: [string, string][]): string {
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

export function initPublisherPanel(): void {
  const nostrEl = byId<HTMLElement>('publisher-nostr');
  const reserveEl = byId<HTMLElement>('publisher-reserve');

  const content = JSON.parse(NOSTR_EVIDENCE.event.content) as { epoch_index: number; manifest_digest: string; outstanding_balance: number };
  nostrEl.innerHTML = summaryRows([
    ['Event id', truncateHex(NOSTR_EVIDENCE.event.id, 12, 8)],
    ['Kind', String(NOSTR_EVIDENCE.event.kind)],
    ['Epoch', String(content.epoch_index)],
    ['Manifest digest', truncateHex(content.manifest_digest, 12, 8)],
    ['Outstanding balance', formatSats(content.outstanding_balance)],
    ['Published to', NOSTR_EVIDENCE.successfulRelays.join(', ') || 'no relay acked this run'],
    ['Fetched back from', NOSTR_EVIDENCE.cases.fetched_event_count > 0 ? 'yes (independent re-query)' : 'no'],
  ]);

  const outpoint = RESERVE_EVIDENCE.liveAttestation.attestation.statement.outpoints[0];
  const chainState = RESERVE_EVIDENCE.liveAttestation.chainState as Record<string, { spent: boolean } | undefined>;
  const chainEntry = outpoint ? chainState[`${outpoint.txid}:${outpoint.vout}`] : undefined;
  reserveEl.innerHTML = summaryRows([
    ['Network', RESERVE_EVIDENCE.liveAttestation.attestation.statement.network],
    ['Txid', outpoint ? truncateHex(outpoint.txid, 12, 8) : '—'],
    ['Vout', outpoint ? String(outpoint.vout) : '—'],
    ['Value', outpoint ? formatSats(outpoint.value_sats) : '—'],
    ['Unspent', chainEntry?.spent === false ? 'YES' : 'unknown'],
    ['Verified reserve', formatSats(RESERVE_EVIDENCE.liveAttestation.result.verifiedReserveSats)],
    ['Coverage', RESERVE_EVIDENCE.liveAttestation.result.verified ? 'PASS' : 'SHORT'],
  ]);
}
