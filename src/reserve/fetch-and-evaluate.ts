// Gate 6 — real network orchestration: independently re-queries the
// declared Signet outpoints via a public Esplora API and feeds the result
// into the pure evaluator. This is the "verifier independently queries the
// named signet/testnet network" requirement (PRD §11.2 item 4) — never
// trust the statement's own declared value/script without cross-checking
// the live chain state.
import { fetchOutspend, fetchTipHeight, fetchTxOutScript } from './esplora.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation, type ReserveEvaluationResult } from './evaluate.js';

export async function fetchChainState(statement: ReserveAttestation['statement']): Promise<Map<string, ChainStateEntry>> {
  const chainState = new Map<string, ChainStateEntry>();
  for (const o of statement.outpoints) {
    const key = `${o.txid}:${o.vout}`;
    try {
      const out = await fetchTxOutScript(o.txid, o.vout);
      if (!out) {
        chainState.set(key, { exists: false, confirmed: false, value: 0, scriptPubKeyHex: '', spent: false });
        continue;
      }
      const outspend = await fetchOutspend(o.txid, o.vout);
      chainState.set(key, { exists: true, confirmed: true, value: out.value, scriptPubKeyHex: out.scriptPubKeyHex, spent: outspend.spent });
    } catch {
      chainState.set(key, { exists: false, confirmed: false, value: 0, scriptPubKeyHex: '', spent: false });
    }
  }
  return chainState;
}

export async function fetchAndEvaluateReserve(attestation: ReserveAttestation, outstandingBalance: number): Promise<ReserveEvaluationResult & { tipHeight: number }> {
  const [chainState, tipHeight] = await Promise.all([fetchChainState(attestation.statement), fetchTipHeight()]);
  return { ...evaluateReserveAttestation(attestation, chainState, outstandingBalance, tipHeight), tipHeight };
}
