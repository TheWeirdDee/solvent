// #/mint — the primary real-backend flow: take ecash from a real patched CDK
// mint, show its signed promise, wait for the promised epoch to close and be
// published, then verify through the same verifySubmission() everything else
// uses. Nothing is decided in the browser: the NUT-06 identity, the Nostr
// event and the Bitcoin reserve are all fetched independently.
//
// Configuration: VITE_SOLVENT_MINT_URL + VITE_SOLVENT_EVIDENCE_URL at build
// time, or `#/mint?mint=<url>&evidence=<url>` at run time. Without either,
// the page says plainly that no real mint is connected.
import { Mint, Wallet, type Proof } from '@cashu/cashu-ts';
import { reconstruct } from '../cashu/reconstruct.js';
import { verifyIssuedReceipt } from '../pol/receipt.js';
import { proofToJson, submissionBundleFromJson } from './bundle-json.js';
import { chainStates, decisionCopy, decisionFacts, escapeHtml, renderDecision } from './decision-view.js';
import { verifySubmission, type SubmissionVerification } from './submission.js';

export interface RealMintConfig {
  mintUrl: string;
  evidenceUrl: string;
}

interface SidecarStatus {
  mint_url: string;
  mint_identity_pubkey: string;
  lightning_backend: 'lnd' | 'fakewallet';
  open_epoch: number;
  epoch_interval_seconds: number;
  next_close_at: number;
  demo_omission_enabled: boolean;
}

interface IssuanceResponse {
  state: 'EPOCH_OPEN' | 'EPOCH_CLOSED';
  publication_status?: 'published' | 'unpublished' | 'failed' | 'pending';
  evidence?: Record<string, unknown>;
}

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const AMOUNT = 64;
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

function setStatus(text: string): void {
  el('mint-status').textContent = text;
}

function step(text: string, state: 'run' | 'ok' | 'fail' | 'info' = 'run'): HTMLElement {
  const list = el('mint-steps');
  list.hidden = false;
  const li = document.createElement('li');
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
  list.appendChild(li);
  return li;
}

function settle(li: HTMLElement, text: string, state: 'ok' | 'fail' | 'info'): void {
  li.className = `mint-step mint-step-${state}`;
  li.textContent = text;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as T };
}

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
    ['Public evidence', 'Real public Nostr relays (kind 8181)'],
    ['Bitcoin reserve', 'Real Mutinynet (Bitcoin Signet) UTXO, re-queried when you verify'],
    ['Lightning settlement', lightning],
  ];
  el('mint-reality').innerHTML = rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
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
    if (trim(st.body.mint_url) !== cfg.mintUrl) {
      setStatus(`Warning: the evidence service is configured for ${st.body.mint_url}, not ${cfg.mintUrl}. Verification will refuse a mismatch.`);
    } else {
      setStatus('');
    }
  } catch (err) {
    setStatus(`Could not reach the mint or its evidence service: ${(err as Error).message}`);
  }
}

async function obtainEcash(cfg: RealMintConfig): Promise<{ proof: Proof; publicKey: string }> {
  const wallet = new Wallet(cfg.mintUrl);
  await wallet.loadMint();
  const keys = (await new Mint(cfg.mintUrl).getKeys()).keysets.find((k) => k.unit === 'sat')!;
  const quote = await wallet.createMintQuoteBolt11(AMOUNT);
  const pay = step(
    status?.lightning_backend === 'lnd'
      ? `Pay this Lightning invoice for ${AMOUNT} sats: ${quote.request}`
      : `The mint issued a ${AMOUNT}-sat invoice (demo fakewallet: it settles itself).`,
  );
  for (let i = 0; i < 600; i++) {
    if ((await wallet.checkMintQuoteBolt11(quote.quote)).state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  settle(pay, `Invoice for ${AMOUNT} sats paid.`, 'ok');
  const proofs = await wallet.mintProofsBolt11(AMOUNT, quote.quote);
  const proof = proofs.find((p) => Number(p.amount) === AMOUNT) ?? proofs[0]!;
  return { proof, publicKey: keys.keys[String(proof.amount)]! };
}

async function run(omit: boolean): Promise<void> {
  const cfg = configFromLocation(window.location.hash);
  if (!cfg || busy) return;
  busy = true;
  el('mint-steps').innerHTML = '';
  el('mint-result').hidden = true;
  el<HTMLButtonElement>('mint-honest-btn').disabled = true;
  el<HTMLButtonElement>('mint-omit-btn').disabled = true;
  try {
    const { proof, publicKey } = await obtainEcash(cfg);
    step(`1. The mint gave you ${Number(proof.amount)} sats of ecash (keyset ${proof.id.slice(0, 16)}…).`, 'ok');

    const recon = reconstruct(proof, proof.id, publicKey);
    if (!recon.valid || !recon.bPrimeHex) throw new Error('the ecash carries no valid NUT-12 DLEQ proof');
    const bm = recon.bPrimeHex;
    const receipt = (await getJson<{ status: string; target_epoch?: number; signature?: string }>(`${cfg.mintUrl}/v1/solvent/pol-receipt/${bm}`)).body;
    if (receipt.status !== 'signed' || receipt.target_epoch === undefined || !verifyIssuedReceipt({ target_epoch: receipt.target_epoch, signature: receipt.signature! }, bm, publicKey)) {
      throw new Error(`the mint's liability receipt is missing or invalid (status ${receipt.status})`);
    }
    const epoch = receipt.target_epoch;
    step(`2. The mint signed a promise to count this issuance in accounting epoch ${epoch}.`, 'ok');

    if (omit) {
      const r = await getJson<{ error?: string }>(`${cfg.evidenceUrl}/v1/solvent/demo/omit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blinded_message: bm }) });
      step(
        r.status === 202
          ? `Demo: the mint's real epoch closer will leave this issuance out of epoch ${epoch}.`
          : `Demo request not applied (${r.body.error ?? r.status}); this run stays honest.`,
        r.status === 202 ? 'info' : 'fail',
      );
    }

    const wait = step(`3. Waiting for epoch ${epoch} to close and be published…`);
    let evidence: IssuanceResponse | null = null;
    const deadline = Date.now() + ((status?.epoch_interval_seconds ?? 30) * 4 + 120) * 1000;
    while (Date.now() < deadline) {
      const r = (await getJson<IssuanceResponse>(`${cfg.evidenceUrl}/v1/solvent/issuance/${bm}`)).body;
      if (r.state === 'EPOCH_CLOSED' && r.publication_status !== 'pending') {
        evidence = r;
        break;
      }
      const left = Math.max(0, (status?.next_close_at ?? 0) - Math.floor(Date.now() / 1000));
      wait.textContent = `3. Waiting for epoch ${epoch} to close and be published… ${r.state === 'EPOCH_OPEN' && left > 0 ? `closes in about ${left}s` : 'publishing'}`;
      await new Promise((res) => setTimeout(res, 3000));
      status = (await getJson<SidecarStatus>(`${cfg.evidenceUrl}/v1/solvent/status`)).body;
    }
    if (!evidence?.evidence) throw new Error(`epoch ${epoch} was not closed and published in time`);
    settle(wait, `3. Epoch ${epoch} closed; the mint says its evidence is ${evidence.publication_status}.`, evidence.publication_status === 'published' ? 'ok' : 'info');

    const verifying = step('4. Checking the epoch, public Nostr evidence and the live Bitcoin reserve…');
    const bundle = submissionBundleFromJson(JSON.stringify({ ...evidence.evidence, proof: proofToJson(proof), amountPublicKeyHex: publicKey }));
    const v = await verifySubmission(bundle);
    settle(verifying, `4. Verification finished: ${v.result.reasonCode}.`, v.result.decision === 'ACCEPT' ? 'ok' : 'fail');
    showResult(v, bm);
  } catch (err) {
    step(`Stopped: ${(err as Error).message}`, 'fail');
  } finally {
    busy = false;
    el<HTMLButtonElement>('mint-honest-btn').disabled = false;
    el<HTMLButtonElement>('mint-omit-btn').disabled = false;
  }
}

function showResult(v: SubmissionVerification, bm: string): void {
  const { result, reserveLive, nostrLive } = v;
  renderDecision(
    { badge: el('mint-decision-badge'), headline: el('mint-decision-headline'), body: el('mint-decision-body'), facts: el('mint-decision-facts'), chain: el('mint-decision-chain') },
    {
      kind: result.decision,
      copy: decisionCopy(result, reserveLive, nostrLive, 'evidence'),
      facts: decisionFacts(result, reserveLive, nostrLive),
      states: chainStates(result),
    },
  );
  const rows: [string, string][] = [
    ['Reason code', result.reasonCode],
    ['Your issuance (B_)', bm],
    ['Mint identity (NUT-06, fetched from the mint)', v.mintIdentityLive?.pubkey ?? v.mintIdentityLive?.detail ?? '—'],
    ['Delegation to the manifest key', result.checks.delegationValid ? 'valid' : 'not valid'],
    ['Nostr event', nostrLive.eventFetched ? 'fetched from a public relay' : nostrLive.detail],
    ['Reserve', reserveLive.detail],
  ];
  el('mint-technical').innerHTML = `<dl class="evidence-rows">${rows.map(([k, val]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd></div>`).join('')}</dl>
    <details><summary>Raw verification result (JSON)</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`;
  el('mint-result').hidden = false;
}

export function initRealMintPanel(): void {
  el('mint-honest-btn').addEventListener('click', () => void run(false));
  el('mint-omit-btn').addEventListener('click', () => void run(true));
  el('mint-again-btn').addEventListener('click', () => {
    el('mint-result').hidden = true;
    el('mint-steps').innerHTML = '';
    el('mint-steps').hidden = true;
  });
}
