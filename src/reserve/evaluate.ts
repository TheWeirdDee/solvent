// Gate 6 — pure evaluation of checks 11-13 of the PRD §14 decision rule
// against an already-fetched chain-state snapshot. Exported separately
// from the network calls (src/reserve/esplora.ts) so every adversarial
// case (missing/wrong/spent/mismatched/stale/malformed) is deterministically
// unit-testable without a live chain query — same split as Gate 5's
// evaluatePolEvidence.
//
// Reason-code mapping (PRD §11.1's eight required properties onto the four
// reserve reason codes already defined in src/verifier/reasons.ts — there
// is no dedicated "reserve" gate 6 code list beyond these four):
//   - malformed statement / bad reserve-key signature / bad master binding
//     -> REFUSE_RESERVE_ATTESTATION_INVALID
//   - stale attestation (block_height too far behind the current tip)
//     -> REFUSE_RESERVE_ATTESTATION_INVALID (an expired attestation is not
//        a trustworthy one — see docs/reserve-attestation.md)
//   - declared outpoint not found on chain ("wrong UTXO"), or its real
//     on-chain value/script differs from what the statement declared
//     ("amount mismatch" / wrong script) -> REFUSE_RESERVE_STATE_MISMATCH
//   - declared outpoint has since been spent -> REFUSE_RESERVE_UTXO_SPENT
//   - verified reserve total is below outstanding liabilities
//     -> REFUSE_RESERVE_SHORT
//   - no attestation/chain state available at all is handled by verify()
//     itself: omitting `reserve` from VerifyInput already fails closed
//     with REFUSE_UNVERIFIABLE (the "missing evidence" case).
import {
  reserveBindingMessage,
  reserveStatementDigestHex,
  verifyReserveBinding,
  verifyReserveStatementSignature,
  type ReserveStatement,
} from './statement.js';

export interface ReserveAttestation {
  statement: ReserveStatement;
  statementSignature: string;
  bindingSignature: string;
  masterPublicKeyHex: string;
}

export interface ChainStateEntry {
  exists: boolean;
  confirmed: boolean;
  value: number;
  scriptPubKeyHex: string;
  spent: boolean;
}

export type ReserveReasonCode = 'REFUSE_RESERVE_ATTESTATION_INVALID' | 'REFUSE_RESERVE_UTXO_SPENT' | 'REFUSE_RESERVE_STATE_MISMATCH' | 'REFUSE_RESERVE_SHORT';

export interface ReserveEvaluationResult {
  verified: boolean;
  reasonCode?: ReserveReasonCode;
  detail: string;
  verifiedReserveSats: number;
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/**
 * The reserve attestation's actual security intent — see docs/reserve-attestation.md
 * — is a generous WALL-CLOCK freshness bound (~1 week), not a fixed block
 * count. 1008 is that intent expressed as a block budget under Bitcoin's
 * standard ~10-minute block target (7 days * 144 blocks/day = 1008,
 * exactly). Block height (independently re-queried from a live chain tip,
 * never a self-reported timestamp on the statement) is still the right
 * staleness clock — a mint could freely misstate its own `timestamp`
 * field, but it cannot misstate how far the real chain has actually
 * advanced. The bug this policy object fixes: a single global block count
 * is not a network-portable unit. Mutinynet, chosen for this build
 * specifically for its fast ~30.5s blocks (see docs/reserve-attestation.md's
 * "Network" section — chosen so real on-chain confirmation fits in one
 * working session, unrelated to the staleness policy), would silently
 * enforce a ~68x SHORTER window than intended (~8.5 hours instead of ~1
 * week) if the same raw 1008 were reused as-is. This was caught and fixed
 * during the build — see DECISIONS.md.
 */
export interface ReserveFreshnessPolicy {
  /** The actual intended security property: how old an attestation's block_height may be, in real elapsed time. */
  targetSeconds: number;
  /** Empirically-measured or well-known block cadence per `statement.network` value. */
  secondsPerBlockByNetwork: Record<string, number>;
  /** Used for a network not in the table above — deliberately the conservative (slowest, i.e. smallest resulting block budget) assumption, never a fast-network guess, so an unrecognized network fails toward stricter staleness checking, not laxer. */
  defaultSecondsPerBlock: number;
}

export const RESERVE_FRESHNESS_POLICY: ReserveFreshnessPolicy = {
  targetSeconds: 7 * 24 * 3600,
  secondsPerBlockByNetwork: {
    'bitcoin-mainnet': 600,
    'bitcoin-signet': 600, // the default public Bitcoin Signet also targets ~10-minute blocks
    'bitcoin-signet-mutinynet': 30.5, // empirically measured — 10 real consecutive block timestamps from mutinynet.com's own Esplora API; see docs/trust-boundaries.md
  },
  defaultSecondsPerBlock: 600,
};

/** How many blocks of headroom `network` gets under `policy` — the network-aware replacement for a single flat MAX_ATTESTATION_AGE_BLOCKS constant. */
export function maxAttestationAgeBlocks(network: string, policy: ReserveFreshnessPolicy = RESERVE_FRESHNESS_POLICY): number {
  const secondsPerBlock = policy.secondsPerBlockByNetwork[network] ?? policy.defaultSecondsPerBlock;
  return Math.floor(policy.targetSeconds / secondsPerBlock);
}

export function evaluateReserveAttestation(
  attestation: ReserveAttestation,
  chainState: Map<string, ChainStateEntry>,
  outstandingBalance: number,
  currentTipHeight: number,
  freshnessPolicy: ReserveFreshnessPolicy = RESERVE_FRESHNESS_POLICY,
): ReserveEvaluationResult {
  const { statement, statementSignature, bindingSignature, masterPublicKeyHex } = attestation;

  if (statement.outpoints.length === 0 || statement.reserve_pubkey.length !== 64 || !Number.isFinite(statement.block_height)) {
    return { verified: false, reasonCode: 'REFUSE_RESERVE_ATTESTATION_INVALID', detail: 'Reserve statement is structurally malformed.', verifiedReserveSats: 0 };
  }

  if (!verifyReserveStatementSignature(statement, statementSignature)) {
    return { verified: false, reasonCode: 'REFUSE_RESERVE_ATTESTATION_INVALID', detail: 'Reserve statement signature does not verify against reserve_pubkey.', verifiedReserveSats: 0 };
  }

  const digest = reserveStatementDigestHex(statement);
  if (!verifyReserveBinding(statement.reserve_pubkey, digest, bindingSignature, masterPublicKeyHex)) {
    return {
      verified: false,
      reasonCode: 'REFUSE_RESERVE_ATTESTATION_INVALID',
      detail: `Mint master-key binding signature does not verify over ${reserveBindingMessage(statement.reserve_pubkey, digest)}.`,
      verifiedReserveSats: 0,
    };
  }

  const maxAgeBlocks = maxAttestationAgeBlocks(statement.network, freshnessPolicy);
  if (currentTipHeight - statement.block_height > maxAgeBlocks) {
    return {
      verified: false,
      reasonCode: 'REFUSE_RESERVE_ATTESTATION_INVALID',
      detail: `Attestation block_height=${statement.block_height} is stale relative to tip=${currentTipHeight} (max age ${maxAgeBlocks} blocks for network "${statement.network}", targeting ~${(freshnessPolicy.targetSeconds / 3600).toFixed(1)}h of real freshness).`,
      verifiedReserveSats: 0,
    };
  }

  let verifiedReserveSats = 0;
  for (const o of statement.outpoints) {
    const state = chainState.get(outpointKey(o.txid, o.vout));
    if (!state || !state.exists) {
      return { verified: false, reasonCode: 'REFUSE_RESERVE_STATE_MISMATCH', detail: `Declared outpoint ${o.txid}:${o.vout} was not found on-chain.`, verifiedReserveSats: 0 };
    }
    if (state.spent) {
      return { verified: false, reasonCode: 'REFUSE_RESERVE_UTXO_SPENT', detail: `Outpoint ${o.txid}:${o.vout} has been spent since attestation.`, verifiedReserveSats: 0 };
    }
    if (state.value !== o.value_sats || state.scriptPubKeyHex !== o.script_pubkey_hex) {
      return {
        verified: false,
        reasonCode: 'REFUSE_RESERVE_STATE_MISMATCH',
        detail: `Outpoint ${o.txid}:${o.vout} on-chain value/script (${state.value}, ${state.scriptPubKeyHex}) does not match the declared statement (${o.value_sats}, ${o.script_pubkey_hex}).`,
        verifiedReserveSats: 0,
      };
    }
    verifiedReserveSats += state.value;
  }

  if (verifiedReserveSats < outstandingBalance) {
    return {
      verified: false,
      reasonCode: 'REFUSE_RESERVE_SHORT',
      detail: `Verified reserve ${verifiedReserveSats} sats is below outstanding balance ${outstandingBalance} sats.`,
      verifiedReserveSats,
    };
  }

  return { verified: true, detail: `Verified reserve ${verifiedReserveSats} sats covers outstanding balance ${outstandingBalance} sats.`, verifiedReserveSats };
}
