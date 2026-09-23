// The hero fraud evidence object (PRD §10.6 / §"Cryptographic Fraud
// Challenges", challenge type 1: leaf_omission_or_mismatch). Self-contained:
// a verifier (or the CLI) can recompute the decision from this object plus
// the public mint/keyset inputs, without trusting the frontend.
import type { PolReceipt } from './receipt.js';
import type { ManifestFields } from './manifest.js';

export interface FraudEvidence {
  type: 'leaf_omission_or_mismatch';
  mint: string;
  keyset_id: string;
  amount: number;
  reconstructed_b_prime: string;
  pol_receipt: PolReceipt;
  manifest: ManifestFields & { mint_signature: string };
  inclusion_status: 'missing' | 'included';
  decision: 'ACCEPT' | 'REFUSE';
  reason_code: string;
}

export function buildFraudEvidence(params: {
  mint: string;
  keysetId: string;
  amount: number;
  reconstructedBPrime: string;
  receipt: PolReceipt;
  manifest: ManifestFields;
  mintSignature: string;
  included: boolean;
}): FraudEvidence {
  return {
    type: 'leaf_omission_or_mismatch',
    mint: params.mint,
    keyset_id: params.keysetId,
    amount: params.amount,
    reconstructed_b_prime: params.reconstructedBPrime,
    pol_receipt: params.receipt,
    manifest: { ...params.manifest, mint_signature: params.mintSignature },
    inclusion_status: params.included ? 'included' : 'missing',
    decision: params.included ? 'ACCEPT' : 'REFUSE',
    reason_code: params.included ? 'ACCEPT_VERIFIED' : 'REFUSE_ISSUANCE_OMITTED',
  };
}
