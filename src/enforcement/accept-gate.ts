// Gate 4 — the real acceptance action boundary. Proves SOLVENT does not
// merely return a recommendation: ACCEPT invokes a real, observable state
// mutation; REFUSE invokes nothing.
//
// WHAT "ACCEPTANCE" MEANS IN THIS PHASE 1 BUILD: the verified proof is
// serialized with the real @cashu/cashu-ts token-encoding path
// (getEncodedToken — the same function a real wallet uses to produce a
// token string) and committed to a local accepted-proof store. This is a
// genuine, spy-testable state mutation using real library code, not a
// stub function that just returns true. It is deliberately NOT a live
// mint-swap network round trip: that would require running an actual
// Cashu mint HTTP server, which PRD §12/§22 explicitly rules out ("do not
// build a full wallet"; "use a controlled local/test mint" only if a live
// mint/network is genuinely needed for the side effect — it is not needed
// here, since the side effect being proven is "SOLVENT's own gate commits
// the proof," not "the mint's swap endpoint accepted it"). See
// docs/trust-boundaries.md.
import { getEncodedToken, type Proof, type Token } from '@cashu/cashu-ts';
import { verify, type VerifyInput, type VerifyResult } from '../verifier/verify.js';

export interface AcceptedRecord {
  proof: Proof;
  encodedToken: string;
  acceptedAt: string;
}

export interface WalletStore {
  accepted: AcceptedRecord[];
}

export function createWalletStore(): WalletStore {
  return { accepted: [] };
}

/** The real acceptance side effect: real token serialization + commit to the local accepted-proof store. */
export function acceptProof(store: WalletStore, mint: string, proof: Proof): AcceptedRecord {
  const token: Token = { mint, proofs: [proof] };
  const encodedToken = getEncodedToken(token);
  const record: AcceptedRecord = { proof, encodedToken, acceptedAt: new Date().toISOString() };
  store.accepted.push(record);
  return record;
}

export interface AcceptGateResult {
  result: VerifyResult;
  accepted: boolean;
}

/**
 * The load-bearing property Gate 4 exists to prove: ACCEPT invokes the real
 * acceptance function exactly once; REFUSE invokes it zero times.
 * `acceptFn` is injectable so tests can spy on call count without
 * re-testing `acceptProof`'s internals every time.
 */
export function runAcceptGate(
  input: VerifyInput,
  store: WalletStore,
  acceptFn: (store: WalletStore, mint: string, proof: Proof) => AcceptedRecord = acceptProof,
): AcceptGateResult {
  const result = verify(input);
  if (result.decision === 'ACCEPT') {
    acceptFn(store, input.mint, input.proof);
    return { result, accepted: true };
  }
  return { result, accepted: false };
}
