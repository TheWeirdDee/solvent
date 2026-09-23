// Gate 6 — real, independent Signet chain-state queries via a public
// Esplora-compatible block explorer API. No Node-only APIs beyond global
// `fetch` (available in Node >=18), so this stays usable from a browser
// build later if the UI needs it.
//
// Network choice: Mutinynet (https://mutinynet.com), a public Signet
// variant with a custom signing challenge tuned for ~30 second blocks
// instead of the default public signet's ~10 minute blocks. This build
// uses it specifically so a real faucet-funded UTXO can reach on-chain
// confirmation (and, for the "spent after attestation" negative case, a
// real subsequent spend can confirm) within one working session — the
// default public signet was reachable in this environment's connectivity
// probe but committing to ~10 minute block times per evidence-regeneration
// run was not practical. This is still genuinely Signet (same consensus
// mechanism, a different signing key), never mainnet or a private
// regtest. See docs/reserve-attestation.md and DECISIONS.md.
export const ESPLORA_BASE_URL = 'https://mutinynet.com/api';
export const RESERVE_NETWORK_LABEL = 'bitcoin-signet-mutinynet';

/** Injectable delay — lives here (not submission.ts) specifically so tests that already mock this module (main.test.ts's `vi.mock('../reserve/esplora.js', ...)`) can override this SAME export to make submission.ts's bounded Esplora-fetch retry instant, mirroring the identical pattern for the Nostr relay fetch in src/nostr/pol-evidence.ts. */
export type DelayFn = (ms: number) => Promise<void>;
export const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface EsploraOutspend {
  spent: boolean;
  txid?: string;
  vin?: number;
  status?: { confirmed: boolean; block_height?: number };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ESPLORA_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`esplora ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchAddressUtxos(address: string): Promise<EsploraUtxo[]> {
  return getJson<EsploraUtxo[]>(`/address/${address}/utxo`);
}

/** The scriptPubKey for a given outpoint, read from the funding transaction itself (never trust a caller-declared script without cross-checking it). */
export async function fetchTxOutScript(txid: string, vout: number): Promise<{ value: number; scriptPubKeyHex: string } | null> {
  const tx = await getJson<{ vout: { value: number; scriptpubkey: string }[] }>(`/tx/${txid}`);
  const out = tx.vout[vout];
  if (!out) return null;
  return { value: out.value, scriptPubKeyHex: out.scriptpubkey };
}

export async function fetchOutspend(txid: string, vout: number): Promise<EsploraOutspend> {
  return getJson<EsploraOutspend>(`/tx/${txid}/outspend/${vout}`);
}

export async function fetchTipHeight(): Promise<number> {
  const res = await fetch(`${ESPLORA_BASE_URL}/blocks/tip/height`);
  if (!res.ok) throw new Error(`esplora tip height -> HTTP ${res.status}`);
  return Number(await res.text());
}

export interface FaucetResult {
  ok: boolean;
  txid?: string;
  detail: string;
}

/**
 * Real faucet funding — Mutinynet's public onchain faucet, max 1,000,000
 * sats/request. As of this build the faucet's `/api/onchain` requires
 * either GitHub OAuth or an L402 Lightning payment (see DECISIONS.md's
 * Gate 6 blocker entry) — this build never initiates either on its own,
 * since both involve a real external account/payment decision that
 * belongs to whoever runs this, not to the script. If that person
 * completes the flow themselves (in a real browser) and hands back a
 * bearer token, pass it as `bearerToken` and this will use it.
 */
export async function requestFaucetFunds(address: string, sats = 100_000, bearerToken?: string): Promise<FaucetResult> {
  try {
    const res = await fetch('https://faucet.mutinynet.com/api/onchain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) },
      body: JSON.stringify({ address, sats }),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
    const body = (await res.json()) as { txid?: string };
    return { ok: true, txid: body.txid, detail: `faucet sent ${sats} sats, txid ${body.txid}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
