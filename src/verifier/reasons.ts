// Stable, machine-readable reason codes (PRD §19). Names match actual
// implemented behavior — see docs/draft-alignment.md for which checks are
// wired in this build vs. deferred to a later gate.
export type ReasonCode =
  | 'ACCEPT_VERIFIED'
  | 'REFUSE_MALFORMED_TOKEN'
  | 'REFUSE_UNSUPPORTED_KEYSET'
  | 'REFUSE_MISSING_DLEQ'
  | 'REFUSE_MISSING_BLINDING_FACTOR'
  | 'REFUSE_INVALID_DLEQ'
  | 'REFUSE_RECEIPT_INVALID'
  | 'REFUSE_RECEIPT_CONTEXT_MISMATCH'
  | 'REFUSE_TARGET_EPOCH_OPEN'
  | 'REFUSE_MANIFEST_INVALID'
  | 'REFUSE_ISSUANCE_OMITTED'
  | 'REFUSE_ISSUANCE_VALUE_MISMATCH'
  | 'REFUSE_MMR_PROOF_INVALID'
  | 'REFUSE_LIABILITY_ARITHMETIC'
  | 'REFUSE_RESERVE_ATTESTATION_INVALID'
  | 'REFUSE_RESERVE_UTXO_SPENT'
  | 'REFUSE_RESERVE_STATE_MISMATCH'
  | 'REFUSE_RESERVE_SHORT'
  | 'REFUSE_NOSTR_SIGNATURE'
  | 'REFUSE_NOSTR_STATE_MISMATCH'
  | 'REFUSE_NOSTR_STALE'
  | 'REFUSE_NOSTR_CONFLICT'
  | 'REFUSE_NOSTR_UNAVAILABLE'
  | 'REFUSE_NOSTR_EVENT_NOT_FOUND'
  | 'REFUSE_UNVERIFIABLE';

export const REASON_TEXT: Record<ReasonCode, string> = {
  ACCEPT_VERIFIED:
    "The mint's receipt verifies, this issuance is present in the promised liability epoch, and the checks implemented in this build passed.",
  REFUSE_MALFORMED_TOKEN: 'The received token does not parse as a supported Cashu proof.',
  REFUSE_UNSUPPORTED_KEYSET: 'This proof uses a keyset/curve SOLVENT does not support in Phase 1.',
  REFUSE_MISSING_DLEQ: "This ecash does not include the NUT-12 data SOLVENT needs for independent holder verification. It has not been accepted.",
  REFUSE_MISSING_BLINDING_FACTOR: 'The proof carries no blinding factor r; the holder cannot independently reconstruct the issuance offline.',
  REFUSE_INVALID_DLEQ: "This proof's DLEQ data does not verify against the mint's keyset.",
  REFUSE_RECEIPT_INVALID: "The mint's signed liability-epoch receipt for this issuance does not verify.",
  REFUSE_RECEIPT_CONTEXT_MISMATCH: 'The receipt does not commit to the exact reconstructed issuance and amount presented.',
  REFUSE_TARGET_EPOCH_OPEN: 'The epoch this receipt promised has not closed yet, so the promise cannot be checked.',
  REFUSE_MANIFEST_INVALID: "The signed epoch manifest for the promised epoch does not verify.",
  REFUSE_ISSUANCE_OMITTED:
    'This mint signed a promise to account for this liability in the target epoch, but its signed epoch accounting omits it.',
  REFUSE_ISSUANCE_VALUE_MISMATCH: 'The promised issuance appears in the epoch, but with the wrong committed value.',
  REFUSE_MMR_PROOF_INVALID: 'The inclusion proof for this issuance does not verify against the signed epoch root.',
  REFUSE_LIABILITY_ARITHMETIC: "The signed manifest's outstanding balance does not equal issued minus spent.",
  REFUSE_RESERVE_ATTESTATION_INVALID: "The reserve statement's signature or mint binding does not verify.",
  REFUSE_RESERVE_UTXO_SPENT: 'A previously attested reserve UTXO has since been spent.',
  REFUSE_RESERVE_STATE_MISMATCH: 'The independently queried chain state does not match the attested reserve outpoint(s).',
  REFUSE_RESERVE_SHORT: "Verified reserves do not cover the mint's committed outstanding liabilities.",
  REFUSE_NOSTR_SIGNATURE: 'The published Nostr evidence event does not have a valid signature.',
  REFUSE_NOSTR_STATE_MISMATCH: 'The Nostr event does not commit to the same manifest/reserve evidence used for this decision.',
  REFUSE_NOSTR_STALE: 'The published evidence is stale.',
  REFUSE_NOSTR_CONFLICT: 'Conflicting valid signed state was found for the same epoch/reporting scope.',
  REFUSE_NOSTR_UNAVAILABLE: 'No configured relay could be reached to check for public evidence.',
  REFUSE_NOSTR_EVENT_NOT_FOUND: 'Public relays were reachable, but none returned the required accounting event for this mint and epoch.',
  REFUSE_UNVERIFIABLE: 'A required check could not be independently verified in this build.',
};
