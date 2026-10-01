// #/publish — the judge-facing Evidence page. Every value shown is read from
// a committed evidence file (bundled at build time) or, for the live Railway
// demo, fetched from the running service when the page opens; nothing here is
// typed in by hand. Four kinds, never mixed: real-LND CI evidence, public
// Railway evidence (live), and captured reference evidence — see
// evidence/README.md.
import accept3b from '../../evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-accept.json' with { type: 'json' };
import omission3b from '../../evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-omission-refuse.json' with { type: 'json' };
import publication3b from '../../evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-nostr-publication.json' with { type: 'json' };
import omissionPublication3b from '../../evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-omission-nostr-publication.json' with { type: 'json' };
import reserve3b from '../../evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-reserve.json' with { type: 'json' };
import nut05 from '../../evidence/real-pol/ci-36619816959-lnd/nut05/nut05-melt.json' with { type: 'json' };
import liveDemo from '../../evidence/nostr/live-demo.json' with { type: 'json' };
import { escapeHtml, formatAgo, formatUtc, mutinynetTxUrl, njumpUrl } from './decision-view.js';
import { NOSTR_EVIDENCE, RESERVE_EVIDENCE } from './evidence-data.js';
import { formatSats, truncateHex } from './format.js';
import { REPO_URL } from './markdown.js';

const RUN = (id: number | string) => `https://github.com/TheWeirdDee/solvent/actions/runs/${id}`;
const FILE = (repoPath: string) => `${REPO_URL}/blob/main/${repoPath}`;
const P3B = 'evidence/real-pol/ci-36614823173-lnd/phase3b';
const NUT05 = 'evidence/real-pol/ci-36619816959-lnd/nut05/nut05-melt.json';
/** The Railway mint's funded reserve, shown if its evidence service does not report it. */
const RAILWAY_RESERVE = '809e5190a63ea454d35fbb0b86919d6799fa65a6fe4385baa63eb180711308c2:1';

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const ext = (href: string, label: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}&nbsp;&#8599;</a>`;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`publisher-panel: missing #${id}`);
  return el as T;
}

function card(title: string, verdict: string | null, rows: [string, string][], links: string[]): string {
  return `<article class="evidence-card">
    <p class="evidence-card-title">${title}</p>
    ${verdict ? `<p class="evidence-verdict">${verdict}</p>` : ''}
    <dl class="evidence-rows evidence-rows-wrap">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="evidence-links">${links.join('')}</div>
  </article>`;
}

function checksSummary(checks: Record<string, boolean>): string {
  const all = Object.entries(checks);
  const failed = all.filter(([, v]) => v !== true).map(([k]) => k);
  return failed.length === 0 ? `${all.length}/${all.length} checks true` : `${all.length - failed.length}/${all.length} true; false: <code>${failed.join(', ')}</code>`;
}

function summaryRows(rows: [string, string][]): string {
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderPhase3b(): void {
  const replay = `<code>npm run verify:phase3b-evidence -- ${P3B}</code>`;
  byId('ev-phase3b').innerHTML =
    card(
      'Honest issuance',
      `<span class="ok">${escapeHtml(accept3b.reason_code)}</span>`,
      [
        ['Lightning', `<code>${escapeHtml(accept3b.lightning_backend)}</code> (real)`],
        ['Checks', checksSummary(accept3b.checks as Record<string, boolean>)],
        ['Nostr event', ext(njumpUrl(publication3b.event_id), `<code>${truncateHex(publication3b.event_id, 10, 6)}</code>`)],
        ['Recorded', formatUtc(accept3b.generated_at)],
      ],
      [ext(FILE(`${P3B}/phase3-accept.json`), 'phase3-accept.json'), ext(RUN(36614823173), 'CI run 36614823173')],
    ) +
    card(
      'Broken promise',
      `<span class="bad">${escapeHtml(omission3b.reason_code)}</span>`,
      [
        ['Lightning', `<code>${escapeHtml(omission3b.lightning_backend)}</code> (real)`],
        ['Checks', checksSummary(omission3b.checks as Record<string, boolean>)],
        ['Nostr event', ext(njumpUrl(omissionPublication3b.event_id), `<code>${truncateHex(omissionPublication3b.event_id, 10, 6)}</code>`)],
        ['Recorded', formatUtc(omission3b.generated_at)],
      ],
      [ext(FILE(`${P3B}/phase3-omission-refuse.json`), 'phase3-omission-refuse.json'), ext(RUN(36614823173), 'CI run 36614823173')],
    ) +
    card(
      'Reserve and replay',
      null,
      [
        ['Reserve', ext(mutinynetTxUrl(reserve3b.observation.txid), `<code>${truncateHex(reserve3b.observation.txid, 10, 6)}:${reserve3b.observation.vout}</code>`)],
        ['Amount', `${formatSats(reserve3b.observation.valueSats)} (${escapeHtml(reserve3b.network)})`],
        ['Published to', publication3b.relays.filter((r) => r.ok).map((r) => escapeHtml(r.relay.replace('wss://', ''))).join(', ')],
        ['Replay offline', replay],
      ],
      [ext(`${REPO_URL}/tree/main/${P3B}`, 'Full package (18 files)'), ext(FILE('evidence/README.md'), 'Evidence index')],
    );
}

function renderNut05(): void {
  byId('ev-nut05').innerHTML = card(
    'Real Lightning payment by melting ecash',
    `<span class="ok">${nut05.pass ? 'PASS' : 'FAIL'}</span>`,
    [
      ['Lightning', `<code>${escapeHtml(nut05.lightning_backend)}</code> (real)`],
      ['Paid over Lightning', formatSats(nut05.lightning_amount_sat)],
      ['Inputs spent', `${nut05.inputs.count} proofs, ${formatSats(nut05.inputs.total_sat)} → consumed liabilities`],
      ['Change', `${nut05.change.count} outputs, ${formatSats(nut05.change.total_sat)} → issued liabilities, receipts signed`],
      ['Epoch', `${nut05.epoch} (outstanding ${formatSats(nut05.outstanding_before_sat)} → ${formatSats(nut05.outstanding_after_sat)})`],
      ['Recorded', formatUtc(nut05.generated_at)],
    ],
    [ext(FILE(NUT05), 'nut05-melt.json'), ext(RUN(36619816959), 'CI run 36619816959'), ext(FILE('docs/nut05-melt-accounting.md'), 'How it is accounted')],
  );
}

function renderCi(): void {
  const rows: [string, string][] = [
    [RUN(36614823173), 'Real Cashu + SOLVENT Integration · real LND · Phase 3A + Phase 3B (honest ACCEPT, broken-promise REFUSE)'],
    [RUN(36619816959), 'Real Cashu + SOLVENT Integration · real LND · NUT-05 melt, plus Phase 3A/3B again'],
    [RUN(36150315347), 'Real Cashu + SOLVENT Integration · real LND · NUT-03 swap accounting'],
    ['https://github.com/TheWeirdDee/solvent/actions/workflows/deploy-stack-check.yml?query=branch%3Amain+is%3Asuccess', 'Deploy Stack Check · latest successful runs · Railway image + Compose stack, real browser flows, restart'],
    ['https://github.com/TheWeirdDee/solvent/actions/workflows/refresh-live-demo.yml?query=is%3Asuccess', 'Refresh Live Evidence · twice daily · republishes and re-verifies the reference case'],
  ];
  byId('ev-ci').innerHTML = rows.map(([href, label]) => `<li>${ext(href, href.includes('/runs/') ? `Run ${href.split('/').pop()}` : 'Workflow')} — ${label}</li>`).join('');
}

async function renderLive(): Promise<void> {
  const box = byId('ev-live');
  const evidenceUrl = env.VITE_SOLVENT_EVIDENCE_URL?.replace(/\/+$/, '');
  const mintUrl = env.VITE_SOLVENT_MINT_URL?.replace(/\/+$/, '');
  if (!evidenceUrl || !mintUrl) {
    box.innerHTML = '<p class="evidence-block-sub">This build is not connected to a live mint.</p>';
    return;
  }
  try {
    const [info, st] = await Promise.all([
      fetch(`${mintUrl}/v1/info`).then((r) => r.json() as Promise<{ pubkey?: string; version?: string }>),
      fetch(`${evidenceUrl}/v1/solvent/status`).then((r) => r.json() as Promise<{ open_epoch: number; lightning_backend: string; reserve_outpoint?: string | null; last_publication?: { epoch_index: number; event_id: string | null; published_at: string; status: string } | null }>),
    ]);
    const p = st.last_publication;
    const outpoint = st.reserve_outpoint ?? RAILWAY_RESERVE;
    const [txid, vout] = outpoint.split(':');
    box.innerHTML = card(
      `<span class="live-tag">LIVE</span> Railway mint · checked ${formatUtc(new Date())}`,
      null,
      [
        ['Mint', `<code>${escapeHtml(mintUrl)}</code> · ${escapeHtml(info.version ?? '')}`],
        ['NUT-06 identity', `<code>${escapeHtml(info.pubkey ?? 'not advertised')}</code>`],
        ['Lightning', `<code>${escapeHtml(st.lightning_backend)}</code> — demo; invoices settle by themselves`],
        ['Latest epoch', p ? `${p.epoch_index} (${escapeHtml(p.status)}) · open epoch ${st.open_epoch}` : `none published yet · open epoch ${st.open_epoch}`],
        ['Last publication', p ? `${formatUtc(p.published_at)} (${formatAgo(p.published_at)})` : '—'],
        ['Latest Nostr event', p?.event_id ? ext(njumpUrl(p.event_id), `<code>${truncateHex(p.event_id, 10, 6)}</code>`) : '—'],
        ['Reserve', ext(mutinynetTxUrl(txid!), `<code>${truncateHex(txid!, 10, 6)}:${vout}</code>`)],
      ],
      [`<a href="#/mint">Run it yourself on the live mint</a>`],
    );
  } catch (err) {
    box.innerHTML = `<p class="evidence-block-sub">The live mint could not be reached just now (${escapeHtml((err as Error).message)}). The committed evidence above does not depend on it.</p>`;
  }
}

function renderReference(): void {
  const ev = liveDemo.bundle.nostrEvent;
  const o = liveDemo.bundle.reserveAttestation.statement.outpoints[0]!;
  byId('ev-reference').innerHTML = card(
    `<span class="ref-tag">CAPTURED REFERENCE RUN</span> The case behind “Re-check published evidence”`,
    null,
    [
      ['Published', `${formatUtc(liveDemo.publishedAt)} (${formatAgo(liveDemo.publishedAt)}) — republished twice a day`],
      ['Nostr event', ext(njumpUrl(ev.id), `<code>${truncateHex(ev.id, 10, 6)}</code>`)],
      ['Reserve', ext(mutinynetTxUrl(o.txid), `<code>${truncateHex(o.txid, 10, 6)}:${o.vout}</code>`)],
      ['Purpose', 'a stable, published mechanism example — not a fresh issuance'],
    ],
    [`<a href="#/verify?mode=live">Re-check it now</a>`, ext(FILE('evidence/nostr/live-demo.json'), 'live-demo.json')],
  );

  const content = JSON.parse(NOSTR_EVIDENCE.event.content) as { epoch_index: number; manifest_digest: string; outstanding_balance: number };
  byId('publisher-nostr-title').innerHTML = `Gate 5 — Nostr publication <span class="ref-tag">CAPTURED ${formatUtc(NOSTR_EVIDENCE.event.created_at * 1000)}</span>`;
  byId('publisher-nostr').innerHTML = summaryRows([
    ['Event id', ext(njumpUrl(NOSTR_EVIDENCE.event.id), truncateHex(NOSTR_EVIDENCE.event.id, 12, 8))],
    ['Kind', String(NOSTR_EVIDENCE.event.kind)],
    ['Epoch', String(content.epoch_index)],
    ['Manifest digest', truncateHex(content.manifest_digest, 12, 8)],
    ['Outstanding balance', formatSats(content.outstanding_balance)],
    ['Published to', NOSTR_EVIDENCE.successfulRelays.join(', ') || 'no relay acked this run'],
    ['Fetched back', NOSTR_EVIDENCE.cases.fetched_event_count > 0 ? 'yes (independent re-query, at capture)' : 'no'],
  ]);

  const outpoint = RESERVE_EVIDENCE.liveAttestation.attestation.statement.outpoints[0];
  const chainState = RESERVE_EVIDENCE.liveAttestation.chainState as Record<string, { spent: boolean } | undefined>;
  const chainEntry = outpoint ? chainState[`${outpoint.txid}:${outpoint.vout}`] : undefined;
  byId('publisher-reserve-title').innerHTML = `Gate 6 — Signet reserve attestation <span class="ref-tag">CAPTURED ${formatUtc(RESERVE_EVIDENCE.liveAttestation.attestation.statement.timestamp)}</span>`;
  byId('publisher-reserve').innerHTML = summaryRows([
    ['Network', RESERVE_EVIDENCE.liveAttestation.attestation.statement.network],
    ['Txid', outpoint ? ext(mutinynetTxUrl(outpoint.txid), truncateHex(outpoint.txid, 12, 8)) : '—'],
    ['Vout', outpoint ? String(outpoint.vout) : '—'],
    ['Value', outpoint ? formatSats(outpoint.value_sats) : '—'],
    ['Unspent (at capture)', chainEntry?.spent === false ? 'YES' : 'unknown'],
    ['Verified reserve (at capture)', formatSats(RESERVE_EVIDENCE.liveAttestation.result.verifiedReserveSats)],
    ['Coverage (at capture)', RESERVE_EVIDENCE.liveAttestation.result.verified ? 'PASS' : 'SHORT'],
  ]);
}

export function initPublisherPanel(): void {
  renderPhase3b();
  renderNut05();
  renderCi();
  renderReference();
  void renderLive();
}
