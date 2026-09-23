// Real captured evidence, imported at build time from the same evidence/
// directory "npm run gate5"/"gate6"/"attacks" write to -- not fabricated
// numbers. Rebuilding the UI ("npm run build") picks up whatever the
// evidence/ directory currently holds; re-run the gate CLIs first to
// refresh it. See docs/trust-boundaries.md.
import nostrEvent from '../../evidence/nostr/event.json' with { type: 'json' };
import nostrCases from '../../evidence/nostr/cases.json' with { type: 'json' };
import nostrPublishResult from '../../evidence/nostr/publish-result.json' with { type: 'json' };
import reserveLiveAttestation from '../../evidence/reserves/live-attestation.json' with { type: 'json' };
import reserveCases from '../../evidence/reserves/cases.json' with { type: 'json' };

export const NOSTR_EVIDENCE = {
  event: nostrEvent,
  cases: nostrCases,
  successfulRelays: nostrPublishResult.filter((r) => r.ok).map((r) => r.relay),
  allRelays: nostrPublishResult.map((r) => r.relay),
};

export const RESERVE_EVIDENCE = {
  liveAttestation: reserveLiveAttestation,
  cases: reserveCases,
};

export type AttackOutcome = 'ACCEPT' | string;

export interface AttackEntry {
  id: string;
  attack: string;
  outcome: AttackOutcome;
}

/**
 * Mirrors ATTACKS.md's table (25/25 implemented). Kept as a small typed
 * array rather than parsed from the markdown file — the facts here (ids,
 * one-line descriptions, expected reason codes) are stable and the same
 * ones ATTACKS.md documents; "npm run attacks" is the actual source of
 * truth and regenerates the evidence/attacks/ directory on every run.
 */
export const ATTACK_CORPUS: AttackEntry[] = [
  { id: 'A01', attack: 'valid token, valid receipt, included issuance, covered reserve', outcome: 'ACCEPT' },
  { id: 'A02', attack: 'promised issuance omitted', outcome: 'REFUSE_ISSUANCE_OMITTED' },
  { id: 'A03', attack: 'issuance included with wrong value', outcome: 'REFUSE_MMR_PROOF_INVALID' },
  { id: 'A04', attack: 'forged receipt signature', outcome: 'REFUSE_RECEIPT_INVALID' },
  { id: 'A05', attack: 'receipt epoch modified after signing', outcome: 'REFUSE_RECEIPT_INVALID' },
  { id: 'A06', attack: 'reconstructed B′ tampered', outcome: 'REFUSE_INVALID_DLEQ' },
  { id: 'A07', attack: 'invalid DLEQ', outcome: 'REFUSE_INVALID_DLEQ' },
  { id: 'A08', attack: 'missing blinding factor r', outcome: 'REFUSE_MISSING_BLINDING_FACTOR' },
  { id: 'A09', attack: 'wrong mint/keyset public key', outcome: 'REFUSE_INVALID_DLEQ' },
  { id: 'A10', attack: 'tampered MMR sibling hash', outcome: 'REFUSE_MMR_PROOF_INVALID' },
  { id: 'A11', attack: 'tampered MMR sibling sum', outcome: 'REFUSE_MMR_PROOF_INVALID' },
  { id: 'A12', attack: 'reordered / wrong positional proof', outcome: 'REFUSE_MMR_PROOF_INVALID' },
  { id: 'A13', attack: 'manifest signature flipped', outcome: 'REFUSE_MANIFEST_INVALID' },
  { id: 'A14', attack: 'manifest liability arithmetic inconsistent', outcome: 'REFUSE_LIABILITY_ARITHMETIC' },
  { id: 'A15', attack: 'conflicting signed manifests, same epoch', outcome: 'REFUSE_NOSTR_CONFLICT' },
  { id: 'A16', attack: 'stale Nostr state', outcome: 'REFUSE_NOSTR_STALE' },
  { id: 'A17', attack: 'one relay unavailable, second has valid state', outcome: 'ACCEPT (deterministic)' },
  { id: 'A18', attack: 'both relays unavailable', outcome: 'REFUSE_NOSTR_UNAVAILABLE' },
  { id: 'A19', attack: 'Nostr event digest differs from proof bundle', outcome: 'REFUSE_NOSTR_STATE_MISMATCH' },
  { id: 'A20', attack: 'invalid reserve signature', outcome: 'REFUSE_RESERVE_ATTESTATION_INVALID' },
  { id: 'A21', attack: 'reserve outpoint spent after attestation', outcome: 'REFUSE_RESERVE_UTXO_SPENT' },
  { id: 'A22', attack: 'reserve value/script mismatch', outcome: 'REFUSE_RESERVE_STATE_MISMATCH' },
  { id: 'A23', attack: 'reserve below liabilities', outcome: 'REFUSE_RESERVE_SHORT' },
  { id: 'A24', attack: 'refused token attempts acceptance', outcome: 'accept() called zero times' },
  { id: 'A25', attack: 'signed accounting event, correctly signed, never publicly published', outcome: 'REFUSE_NOSTR_EVENT_NOT_FOUND' },
];
