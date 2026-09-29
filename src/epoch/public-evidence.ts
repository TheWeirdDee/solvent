// SOLVENT Phase 3B — public solvency evidence for one real closed epoch.
//
// Everything comes from the real Phase 3A database (issuanceEvidence,
// loadClosedEpoch) plus independently supplied public inputs; nothing is
// taken from fixtures. Four keys, four jobs — never interchangeable:
//
//   mint identity (NUT-06)  -> manifest key delegation   (authority)
//   manifest key            -> epoch manifest             (accounting integrity)
//   reserve-control key     -> reserve statement          (control of the UTXO)
//   manifest key            -> reserve binding            (this reserve <-> this epoch)
//   Nostr key               -> transport event            (publication integrity only)
//
// See docs/phase3b-public-evidence.md.
import type { DatabaseSync } from 'node:sqlite';
import { getPubKeyFromPrivKey, type Proof } from '@cashu/cashu-ts';
import type { NostrEvent } from 'nostr-tools';
import { computeGlobalDigestHex, type SubmissionBundle } from '../app/submission.js';
import { buildPolEvidenceContent, signPolEvidenceEvent, type PolEvidenceContent } from '../nostr/pol-event.js';
import { bytesToHex, manifestDigestHex, type ManifestFields } from '../pol/manifest.js';
import { signReserveBinding as signReserveBindingV1, reserveBindingDigestHex, type ReserveBinding } from '../reserve/binding.js';
import { RESERVE_NETWORK_LABEL } from '../reserve/esplora.js';
import type { ReserveAttestation } from '../reserve/evaluate.js';
import { reserveStatementDigestHex, signReserveBinding as signLegacyReserveBinding, signReserveStatement, type ReserveStatement } from '../reserve/statement.js';
import { issuanceEvidence, loadClosedEpoch, rfc3339Seconds } from './closer.js';
import { delegationDigestHex, verifyManifestKeyDelegation, type ManifestKeyDelegation } from './delegation.js';

/** Default public-evidence validity. Deliberately independent of the epoch cadence (docs/phase3b-public-evidence.md). */
export const DEFAULT_EVIDENCE_VALIDITY_SECONDS = 3600;

export function evidenceValiditySeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SOLVENT_EVIDENCE_VALIDITY_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_EVIDENCE_VALIDITY_SECONDS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 60) throw new Error('SOLVENT_EVIDENCE_VALIDITY_SECONDS must be an integer >= 60');
  return n;
}

export class UnsupportedMultiKeysetState extends Error {
  readonly reasonCode = 'REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE';
}

/** A live observation of the reserve outpoint (never a configured number). */
export interface ReserveObservation {
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  spent: boolean;
  tipHeight: number;
}

export interface ReserveControlKey {
  /** x-only Taproot output key — the on-chain `reserve_pubkey`. */
  outputPublicKeyXOnlyHex: string;
  tweakedPrivateKeyHex: string;
}

/** Everything needed to publish one closed epoch, independent of any holder. */
export interface EpochEvidenceInputs {
  db: DatabaseSync;
  epochIndex: number;
  mintUrl: string;
  manifestPrivateKeyHex: string;
  delegation: ManifestKeyDelegation;
  reserveKey: ReserveControlKey;
  reserve: ReserveObservation;
  nostrSecretKey: Uint8Array;
  validitySeconds: number;
  proofUri: string;
  now?: Date;
}

/** The public, per-epoch evidence a mint publishes (not holder-specific). */
export interface EpochPublicEvidence {
  epochIndex: number;
  keysetId: string;
  keysetCount: number;
  manifest: ManifestFields;
  manifestSignature: string;
  manifestPubkey: string;
  content: PolEvidenceContent;
  event: NostrEvent;
  reserveStatement: ReserveStatement;
  reserveAttestation: ReserveAttestation;
  reserveBinding: ReserveBinding;
  delegationDigest: string;
  reserveBindingDigest: string;
}

export function buildEpochPublicEvidence(i: EpochEvidenceInputs): EpochPublicEvidence {
  const now = i.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const closed = loadClosedEpoch(i.db, i.epochIndex);
  if (!closed) throw new Error(`epoch ${i.epochIndex} is not closed`);
  if (closed.keysets.length !== 1) {
    throw new UnsupportedMultiKeysetState(`epoch ${closed.epochIndex} spans ${closed.keysets.length} keysets; multi-keyset aggregation is not implemented`);
  }
  const { manifest, manifestSignature } = closed.keysets[0]!;

  const manifestPubkey = bytesToHex(getPubKeyFromPrivKey(hexBytes(i.manifestPrivateKeyHex)));
  if (manifestPubkey !== closed.manifestPubkey) throw new Error('the supplied manifest key did not sign this closed epoch');
  const delegationCheck = verifyManifestKeyDelegation(i.delegation, {
    mintUrl: i.mintUrl,
    mintIdentityPubkey: i.delegation.mint_identity_pubkey,
    manifestPubkey,
    epochIndex: closed.epochIndex,
  });
  if (!delegationCheck.ok) throw new Error(`the delegation does not authorize this manifest key for epoch ${closed.epochIndex}: ${delegationCheck.detail}`);
  if (computeGlobalDigestHex(manifest) !== closed.globalDigest) throw new Error('single-keyset global digest does not recompute');

  if (i.reserve.spent) throw new Error('the observed reserve outpoint is spent');
  const reserveStatement: ReserveStatement = {
    network: RESERVE_NETWORK_LABEL,
    reserve_pubkey: i.reserveKey.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: i.reserve.txid, vout: i.reserve.vout, value_sats: i.reserve.valueSats, script_pubkey_hex: i.reserve.scriptPubKeyHex }],
    timestamp: rfc3339Seconds(now),
    block_height: i.reserve.tipHeight,
  };
  const statementDigest = reserveStatementDigestHex(reserveStatement);
  const reserveAttestation: ReserveAttestation = {
    statement: reserveStatement,
    statementSignature: signReserveStatement(reserveStatement, i.reserveKey.tweakedPrivateKeyHex),
    // The existing (epoch-agnostic) key binding, kept so the one reserve
    // verifier checks it as before; the epoch-scoped binding is below.
    bindingSignature: signLegacyReserveBinding(reserveStatement.reserve_pubkey, statementDigest, i.manifestPrivateKeyHex),
    masterPublicKeyHex: manifestPubkey,
  };

  const manifestDigest = manifestDigestHex(manifest);
  const reserveBinding = signReserveBindingV1(
    {
      mint_url: i.mintUrl,
      mint_identity_pubkey: i.delegation.mint_identity_pubkey,
      epoch_index: closed.epochIndex,
      manifest_digest: manifestDigest,
      global_digest: closed.globalDigest,
      reserve_statement_digest: statementDigest,
      reserve_pubkey: reserveStatement.reserve_pubkey,
      reserve_network: RESERVE_NETWORK_LABEL,
      created_at: nowSeconds,
      valid_until: nowSeconds + i.validitySeconds,
    },
    i.manifestPrivateKeyHex,
  );
  const delegationDigest = delegationDigestHex(i.delegation);
  const bindingDigest = reserveBindingDigestHex(reserveBinding);

  const content = buildPolEvidenceContent({
    mint: i.mintUrl,
    mintIdentityHex: manifestPubkey,
    keysetId: manifest.keyset_id,
    epochIndex: closed.epochIndex,
    manifestDigestHex: manifestDigest,
    manifestSignature,
    globalDigestHex: closed.globalDigest,
    issuedMmrRootHash: manifest.issued_mmr_root_hash,
    issuedMmrRootSum: manifest.issued_mmr_root_sum,
    spentMmrRootHash: manifest.spent_mmr_root_hash,
    spentMmrRootSum: manifest.spent_mmr_root_sum,
    outstandingBalance: manifest.outstanding_balance,
    reserveDigestHex: statementDigest,
    reserveSats: i.reserve.valueSats,
    reserveNetwork: RESERVE_NETWORK_LABEL,
    validitySeconds: i.validitySeconds,
    proofUri: i.proofUri,
    now: nowSeconds,
    phase3b: {
      mintNut06Pubkey: i.delegation.mint_identity_pubkey,
      manifestKeyDelegationDigest: delegationDigest,
      reserveBindingDigest: bindingDigest,
      previousGlobalDigest: closed.previousGlobalDigest,
      keysetCount: closed.keysets.length,
    },
  });
  const event = signPolEvidenceEvent(content, i.nostrSecretKey);

  return {
    epochIndex: closed.epochIndex,
    keysetId: manifest.keyset_id,
    keysetCount: closed.keysets.length,
    manifest,
    manifestSignature,
    manifestPubkey,
    content,
    event,
    reserveStatement,
    reserveAttestation,
    reserveBinding,
    delegationDigest,
    reserveBindingDigest: bindingDigest,
  };
}

/** The holder-specific parts for one issuance under an epoch's already-built public evidence. */
export function holderBundle(
  db: DatabaseSync,
  blindedMessageHex: string,
  proof: Proof,
  amountPublicKeyHex: string,
  mintUrl: string,
  delegation: ManifestKeyDelegation,
  epoch: EpochPublicEvidence,
): SubmissionBundle {
  const ev = issuanceEvidence(db, blindedMessageHex);
  if (ev.state !== 'EPOCH_CLOSED') throw new Error(`epoch ${ev.receipt.target_epoch} is still open`);
  if (ev.receipt.target_epoch !== epoch.epochIndex) throw new Error(`issuance was promised to epoch ${ev.receipt.target_epoch}, not ${epoch.epochIndex}`);
  return {
    proof,
    mint: mintUrl,
    keysetId: ev.keysetId,
    amountPublicKeyHex,
    receipt: ev.receipt,
    manifest: ev.manifest,
    manifestSignature: ev.manifestSignature,
    masterPublicKeyHex: epoch.manifestPubkey,
    issuedMmrSize: ev.issuedMmrSize,
    inclusionProof: ev.inclusionProof,
    reserveAttestation: epoch.reserveAttestation,
    nostrEvent: epoch.event,
    delegation,
    reserveBinding: epoch.reserveBinding,
    epochKeysetCount: epoch.keysetCount,
  };
}

export interface Phase3bEvidenceInputs {
  db: DatabaseSync;
  /** The holder's proof and the blinded message they reconstructed from it (NUT-12). */
  proof: Proof;
  blindedMessageHex: string;
  mintUrl: string;
  amountPublicKeyHex: string;
  manifestPrivateKeyHex: string;
  delegation: ManifestKeyDelegation;
  reserveKey: ReserveControlKey;
  reserve: ReserveObservation;
  nostrSecretKey: Uint8Array;
  validitySeconds: number;
  proofUri: string;
  now?: Date;
}

export interface Phase3bEvidence {
  bundle: SubmissionBundle;
  content: PolEvidenceContent;
  event: NostrEvent;
  reserveStatement: ReserveStatement;
  reserveBinding: ReserveBinding;
  delegationDigest: string;
  reserveBindingDigest: string;
  epochIndex: number;
}

/** Public evidence for the epoch an issuance was promised to, plus that holder's verification bundle. */
export function buildPhase3bEvidence(i: Phase3bEvidenceInputs): Phase3bEvidence {
  const ev = issuanceEvidence(i.db, i.blindedMessageHex);
  if (ev.state !== 'EPOCH_CLOSED') throw new Error(`epoch ${ev.receipt.target_epoch} is still open`);
  const epoch = buildEpochPublicEvidence({ ...i, epochIndex: ev.receipt.target_epoch });
  const bundle = holderBundle(i.db, i.blindedMessageHex, i.proof, i.amountPublicKeyHex, i.mintUrl, i.delegation, epoch);
  return {
    bundle,
    content: epoch.content,
    event: epoch.event,
    reserveStatement: epoch.reserveStatement,
    reserveBinding: epoch.reserveBinding,
    delegationDigest: epoch.delegationDigest,
    reserveBindingDigest: epoch.reserveBindingDigest,
    epochIndex: epoch.epochIndex,
  };
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
