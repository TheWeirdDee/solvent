// The /lab reference mint: SOLVENT's reference Cashu mint, running in this
// browser, for protocol inspection by developers. Not a production mint and
// not the published reference case (evidence/nostr/live-demo.json) —
// nothing issued here is ever published to Nostr, so its evidence can pass
// every local check but never public retrieval.
//
// It follows a real mint's lifecycle rather than minting a throwaway
// identity per click: one master key and one active keyset persist (in this
// browser's localStorage) until the user explicitly rotates the keyset or
// starts a new identity. Each issuance gets a fresh proof secret, a fresh
// blind signature and signed receipt, and closes a new epoch whose issued
// sum-MMR holds every issuance on the active keyset so far — so liabilities
// accumulate, and issuing past the 1,000,000-sat reserve really does
// produce a shortfall.
import { createRandomSecretKey, getEncodedToken, getPubKeyFromPrivKey, type Token } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools';
import { bytesToHex, generateFixtureKeyset, hexToBytes, issue, type MintKeyset } from '../cashu/keys.js';
import { reconstruct } from '../cashu/reconstruct.js';
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../nostr/pol-event.js';
import { manifestDigestHex, signManifest, ZERO_DIGEST_HEX, type ManifestFields } from '../pol/manifest.js';
import { append, emptyMmr, getInclusionProof, issuedLeaf, root, type Mmr } from '../pol/mmr.js';
import { signIssuedReceipt, type PolReceipt } from '../pol/receipt.js';
import { verify, type VerifyInput, type VerifyResult } from '../verifier/verify.js';
import { fetchLiveReserveState, signReserveAttestation } from './protocol-demo.js';
import { computeGlobalDigestHex, type SubmissionBundle } from './submission.js';
import liveAttestationEvidence from '../../evidence/reserves/live-attestation.json' with { type: 'json' };

export const LAB_MINT_LABEL = 'solvent-reference-lab';
export const LAB_AMOUNTS = [1_000, 10_000, 70_000, 250_000, 1_000_000];
const STORAGE_KEY = 'solvent-reference-mint-lab-v1';

interface LabLeaf {
  bPrime: string;
  amount: number;
  /** false when the mint broke its promise and left this issuance out of the epoch it closed. */
  included: boolean;
}

export interface LabMintState {
  masterPrivHex: string;
  masterPubHex: string;
  nostrSecretHex: string;
  keyset: MintKeyset;
  /** 1 for the identity's first keyset; +1 on each explicit rotation. */
  keysetGeneration: number;
  /** Index of the last closed epoch (0 = none closed yet). Continues across keyset rotations. */
  epoch: number;
  previousGlobalDigest: string;
  /** Issuances on the ACTIVE keyset, in order. */
  leaves: LabLeaf[];
  createdAt: string;
}

export interface LabIssuance {
  amount: number;
  secret: string;
  bPrime: string;
  receipt: PolReceipt;
  epoch: number;
  included: boolean;
  issuedAt: string;
  token: string;
  bundle: SubmissionBundle;
}

function newKeyset(): MintKeyset {
  return generateFixtureKeyset(LAB_AMOUNTS);
}

export function createLabMint(): LabMintState {
  const masterPriv = createRandomSecretKey();
  return {
    masterPrivHex: bytesToHex(masterPriv),
    masterPubHex: bytesToHex(getPubKeyFromPrivKey(masterPriv)),
    nostrSecretHex: bytesToHex(generateSecretKey()),
    keyset: newKeyset(),
    keysetGeneration: 1,
    epoch: 0,
    previousGlobalDigest: ZERO_DIGEST_HEX,
    leaves: [],
    createdAt: new Date().toISOString(),
  };
}

function isLabMintState(v: unknown): v is LabMintState {
  const s = v as Partial<LabMintState> | null;
  return !!s && typeof s.masterPrivHex === 'string' && typeof s.masterPubHex === 'string' && typeof s.nostrSecretHex === 'string' && !!s.keyset && typeof s.epoch === 'number' && Array.isArray(s.leaves) && LAB_AMOUNTS.every((a) => !!s.keyset!.amounts[a]);
}

/** Browser storage can be unavailable (private mode, blocked site data) — the lab then keeps its mint for this page load only. */
export function loadLabMint(): LabMintState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isLabMintState(parsed)) return parsed;
    }
  } catch {
    /* fall through to a new identity */
  }
  const fresh = createLabMint();
  saveLabMint(fresh);
  return fresh;
}

export function saveLabMint(state: LabMintState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — in-memory only */
  }
}

/** Explicit keyset rotation: a new keyset with its own empty issued MMR. The master identity and epoch counter carry on. */
export function rotateLabKeyset(state: LabMintState): LabMintState {
  const next = { ...state, keyset: newKeyset(), keysetGeneration: state.keysetGeneration + 1, leaves: [] };
  saveLabMint(next);
  return next;
}

export function outstandingOf(state: LabMintState): number {
  return state.leaves.filter((l) => l.included).reduce((s, l) => s + l.amount, 0);
}

export const LAB_RESERVE_SATS = liveAttestationEvidence.result.verifiedReserveSats;

function buildIssuedMmr(leaves: LabLeaf[]): Mmr {
  let mmr = emptyMmr();
  for (const leaf of leaves) if (leaf.included) mmr = append(mmr, issuedLeaf(leaf.bPrime, leaf.amount));
  return mmr;
}

/**
 * Issues one proof and closes the next epoch. With `omitFromEpoch`, the mint
 * still signs a receipt promising the issuance for that epoch but leaves it
 * out of the epoch it closes — a broken promise verify() catches locally.
 */
export async function issueFromLab(state: LabMintState, amount: number, omitFromEpoch: boolean): Promise<{ state: LabMintState; issuance: LabIssuance }> {
  const key = state.keyset.amounts[amount];
  if (!key) throw new Error(`reference-mint: no key for amount ${amount}`);
  const epoch = state.epoch + 1;
  const secret = bytesToHex(createRandomSecretKey());
  const { proof } = issue(state.keyset, amount, secret);
  const recon = reconstruct(proof, state.keyset.keysetId, key.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('reference-mint: reconstruction failed');
  const bPrime = recon.bPrimeHex;
  const receipt = signIssuedReceipt(bPrime, epoch, key.privateKeyHex);

  const leaves = [...state.leaves, { bPrime, amount, included: !omitFromEpoch }];
  const issuedMmr = buildIssuedMmr(leaves);
  const issuedRoot = root(issuedMmr);
  const spentRoot = root(emptyMmr());
  const issuedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest: ManifestFields = {
    keyset_id: state.keyset.keysetId,
    unit: 'sat',
    epoch_index: epoch,
    timestamp: issuedAt,
    previous_global_digest: state.previousGlobalDigest,
    issued_mmr_size: issuedMmr.leaves.length,
    issued_mmr_root_hash: bytesToHex(issuedRoot.hash),
    issued_mmr_root_sum: Number(issuedRoot.sum),
    spent_mmr_size: 0,
    spent_mmr_root_hash: bytesToHex(spentRoot.hash),
    spent_mmr_root_sum: Number(spentRoot.sum),
    outstanding_balance: Number(issuedRoot.sum - spentRoot.sum),
    active: true,
    deactivation_epoch: 999,
  };
  const manifestSignature = signManifest(manifest, state.masterPrivHex);
  const globalDigestHex = computeGlobalDigestHex(manifest);
  const inclusionProof = omitFromEpoch ? null : getInclusionProof(issuedMmr, issuedMmr.leaves.length - 1);

  const live = await fetchLiveReserveState();
  const { attestation, reserveDigestHex } = signReserveAttestation(state.masterPrivHex, state.masterPubHex, live);
  const content = buildPolEvidenceContent({
    mint: LAB_MINT_LABEL,
    mintIdentityHex: state.masterPubHex,
    keysetId: manifest.keyset_id,
    epochIndex: epoch,
    manifestDigestHex: manifestDigestHex(manifest),
    manifestSignature,
    globalDigestHex,
    issuedMmrRootHash: manifest.issued_mmr_root_hash,
    issuedMmrRootSum: manifest.issued_mmr_root_sum,
    spentMmrRootHash: manifest.spent_mmr_root_hash,
    spentMmrRootSum: manifest.spent_mmr_root_sum,
    outstandingBalance: manifest.outstanding_balance,
    reserveDigestHex,
    reserveSats: LAB_RESERVE_SATS,
    reserveNetwork: attestation.statement.network,
    validitySeconds: 3600,
    proofUri: 'local://solvent-reference-lab',
    now: Math.floor(Date.now() / 1000),
  });
  const nostrEvent = signPolEvidenceEvent(content, hexToBytes(state.nostrSecretHex));

  const bundle: SubmissionBundle = {
    proof,
    mint: LAB_MINT_LABEL,
    keysetId: state.keyset.keysetId,
    amountPublicKeyHex: key.publicKeyHex,
    receipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: state.masterPubHex,
    issuedMmrSize: manifest.issued_mmr_size,
    inclusionProof,
    reserveAttestation: attestation,
    nostrEvent,
  };
  const next: LabMintState = { ...state, epoch, previousGlobalDigest: globalDigestHex, leaves };
  saveLabMint(next);
  const token = getEncodedToken({ mint: LAB_MINT_LABEL, proofs: [proof] } as Token);
  return { state: next, issuance: { amount, secret, bPrime, receipt, epoch, included: !omitFromEpoch, issuedAt, token, bundle } };
}

/**
 * Steps 1-6 only — the checks that need nothing but the bundle itself. No
 * reserve or Nostr input is supplied, so verify() can never ACCEPT here: a
 * bundle that passes every local check ends at REFUSE_UNVERIFIABLE, which is
 * exactly the point — local validity is not full verification.
 */
export function checkLocalCryptography(bundle: SubmissionBundle): VerifyResult {
  const input: VerifyInput = {
    proof: bundle.proof,
    mint: bundle.mint,
    keysetId: bundle.keysetId,
    amountPublicKeyHex: bundle.amountPublicKeyHex,
    receipt: bundle.receipt,
    manifest: bundle.manifest,
    manifestSignature: bundle.manifestSignature,
    masterPublicKeyHex: bundle.masterPublicKeyHex,
    issuedMmrSize: bundle.issuedMmrSize,
    inclusionProof: bundle.inclusionProof,
  };
  return verify(input);
}
