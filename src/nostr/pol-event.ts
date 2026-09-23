// Gate 5 — the v2 PoL evidence event (PRD §12.1). Distinct from the v1
// `solvent/v1` event in event.ts (kept unmodified so the existing v1 UI
// keeps working): this is the real evidence surface for the PR #388-style
// hero mechanism — it binds mint identity, epoch, manifest/global digest,
// issued/spent accounting, reserve evidence, and freshness, all signed with
// the same master key that signs epoch manifests.
//
// Kind 8181 (regular/immutable — NIP-01 range 1000-9999, not replaceable).
// Chosen per PRD §12.2's instruction to check the NIP registry before
// hard-coding a kind: as of this build, https://github.com/nostr-protocol
// /nips/blob/master/README.md does not list 8181 (nearby taken kinds are
// 8000, 8001, 9000, 9041, 9321, 9734/5, 9802 — see DECISIONS.md). Regular
// (not parameterized-replaceable) because §12.2 requires the audit record
// not depend on an addressable event a relay may discard/replace; this
// build does not implement the optional "latest state" pointer event.
import { finalizeEvent, verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools';

export const POL_EVENT_KIND = 8181;
export const POL_EVENT_SCHEMA = 'solvent/pol/v2';

export interface PolEvidenceContent {
  schema: 'solvent/pol/v2';
  mint: string;
  mint_identity: string; // manifest master public key hex — binds this event to the signing key that signs epoch manifests
  keyset_id: string;
  epoch_index: number;
  manifest_digest: string; // hex sha256 of the signed manifest message (manifestDigestHex)
  manifest_signature: string;
  global_digest: string; // hex — chains previous_global_digest + epoch_index + keyset Merkle root
  issued_mmr_root_hash: string;
  issued_mmr_root_sum: number;
  spent_mmr_root_hash: string;
  spent_mmr_root_sum: number;
  outstanding_balance: number;
  reserve_digest: string; // hex — commits the reserve attestation used for this epoch's decision
  reserve_sats: number;
  reserve_network: string;
  issued_at: number; // unix seconds
  valid_until: number; // unix seconds
  proof_uri: string;
}

export function buildPolEvidenceContent(params: {
  mint: string;
  mintIdentityHex: string;
  keysetId: string;
  epochIndex: number;
  manifestDigestHex: string;
  manifestSignature: string;
  globalDigestHex: string;
  issuedMmrRootHash: string;
  issuedMmrRootSum: number;
  spentMmrRootHash: string;
  spentMmrRootSum: number;
  outstandingBalance: number;
  reserveDigestHex: string;
  reserveSats: number;
  reserveNetwork: string;
  validitySeconds: number;
  proofUri: string;
  now?: number;
}): PolEvidenceContent {
  const issuedAt = params.now ?? Math.floor(Date.now() / 1000);
  return {
    schema: POL_EVENT_SCHEMA,
    mint: params.mint,
    mint_identity: params.mintIdentityHex,
    keyset_id: params.keysetId,
    epoch_index: params.epochIndex,
    manifest_digest: params.manifestDigestHex,
    manifest_signature: params.manifestSignature,
    global_digest: params.globalDigestHex,
    issued_mmr_root_hash: params.issuedMmrRootHash,
    issued_mmr_root_sum: params.issuedMmrRootSum,
    spent_mmr_root_hash: params.spentMmrRootHash,
    spent_mmr_root_sum: params.spentMmrRootSum,
    outstanding_balance: params.outstandingBalance,
    reserve_digest: params.reserveDigestHex,
    reserve_sats: params.reserveSats,
    reserve_network: params.reserveNetwork,
    issued_at: issuedAt,
    valid_until: issuedAt + params.validitySeconds,
    proof_uri: params.proofUri,
  };
}

/**
 * Signed with the Nostr identity secret key. This is deliberately a Nostr
 * keypair, not the Cashu master key — the event's `mint_identity` field is
 * what binds it back to the manifest signer; see docs/nostr-schema.md.
 *
 * Tag letters: per NIP-01, relays are only required to index single-letter
 * (a-zA-Z) tags — `#mint_identity`/`#epoch` style multi-character tag
 * filters are legal to send but most relays will not match on them, so
 * fetch-back would silently return nothing. `M`/`E`/`K` are chosen to avoid
 * the standardized `e`/`p`/`d`/`t` tags, whose values have their own
 * reserved semantics (`e`/`p` must be exact 64-hex ids/pubkeys; `d` implies
 * a parameterized-replaceable event, which this regular/immutable kind is
 * not).
 */
export function signPolEvidenceEvent(content: PolEvidenceContent, nostrSecretKey: Uint8Array): NostrEvent {
  const template: EventTemplate = {
    kind: POL_EVENT_KIND,
    created_at: content.issued_at,
    tags: [
      ['M', content.mint_identity],
      ['E', String(content.epoch_index)],
      ['K', content.keyset_id],
    ],
    content: JSON.stringify(content),
  };
  return finalizeEvent(template, nostrSecretKey);
}

export interface PolEventVerificationResult {
  signatureValid: boolean;
  contentParses: boolean;
  content?: PolEvidenceContent;
  reason?: string;
}

/** Local, offline checks only: event signature validity and content schema shape. Cross-referencing against the decision's own digests happens in evidence.ts. */
export function verifyPolEvidenceEvent(event: NostrEvent): PolEventVerificationResult {
  // Round-trip through JSON so nostr-tools' verifyEvent memoization (keyed
  // on object identity) can never leak a stale cached result from a
  // different object into this check — every real relay-delivered event
  // arrives via JSON anyway.
  const freshEvent = JSON.parse(JSON.stringify(event)) as NostrEvent;
  let signatureValid: boolean;
  try {
    signatureValid = verifyEvent(freshEvent);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { signatureValid: false, contentParses: false, reason: 'invalid Nostr event signature' };
  }
  if (event.kind !== POL_EVENT_KIND) {
    return { signatureValid, contentParses: false, reason: `unexpected event kind ${event.kind}, expected ${POL_EVENT_KIND}` };
  }
  try {
    const parsed = JSON.parse(event.content) as Partial<PolEvidenceContent>;
    if (parsed.schema !== POL_EVENT_SCHEMA) {
      return { signatureValid, contentParses: false, reason: `unexpected schema "${parsed.schema}"` };
    }
    if (
      typeof parsed.mint !== 'string' ||
      typeof parsed.mint_identity !== 'string' ||
      typeof parsed.keyset_id !== 'string' ||
      typeof parsed.epoch_index !== 'number' ||
      typeof parsed.manifest_digest !== 'string' ||
      typeof parsed.manifest_signature !== 'string' ||
      typeof parsed.global_digest !== 'string' ||
      typeof parsed.issued_mmr_root_hash !== 'string' ||
      typeof parsed.issued_mmr_root_sum !== 'number' ||
      typeof parsed.spent_mmr_root_hash !== 'string' ||
      typeof parsed.spent_mmr_root_sum !== 'number' ||
      typeof parsed.outstanding_balance !== 'number' ||
      typeof parsed.reserve_digest !== 'string' ||
      typeof parsed.reserve_sats !== 'number' ||
      typeof parsed.reserve_network !== 'string' ||
      typeof parsed.issued_at !== 'number' ||
      typeof parsed.valid_until !== 'number' ||
      typeof parsed.proof_uri !== 'string'
    ) {
      return { signatureValid, contentParses: false, reason: 'event content missing required solvent/pol/v2 fields' };
    }
    return { signatureValid, contentParses: true, content: parsed as PolEvidenceContent };
  } catch (err) {
    return { signatureValid, contentParses: false, reason: `event content is not valid JSON: ${(err as Error).message}` };
  }
}

export function isPolEvidenceFresh(content: Pick<PolEvidenceContent, 'issued_at' | 'valid_until'>, nowSeconds: number): boolean {
  return nowSeconds >= content.issued_at && nowSeconds <= content.valid_until;
}
