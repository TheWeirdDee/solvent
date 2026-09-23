// Pure, network-free core of `npm run verify:submission` (PRD §16's
// five-minute judge verifier). Split out from the CLI wrapper
// (verify-submission.ts) specifically so its fail-closed logic is unit
// testable — see tests/cli/verify-submission.test.ts — without needing a
// live Nostr relay or Signet explorer for every check.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools';
import { generateFixtureKeyset, issue } from '../cashu/keys.js';
import { runGate0Spike } from '../cashu/gate0.js';
import { reconstruct, spentY } from '../cashu/reconstruct.js';
import { createWalletStore, runAcceptGate } from '../enforcement/accept-gate.js';
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../nostr/pol-event.js';
import { evaluatePolEvidence, type NostrEvidenceExpectation } from '../nostr/pol-evidence.js';
import { globalDigest, keysetMerkleRoot, manifestDigestHex, signManifest, sortKeysets, ZERO_DIGEST_HEX, type KeysetManifestEntry, type ManifestFields } from '../pol/manifest.js';
import { append, bytesToHex, emptyMmr, getInclusionProof, issuedLeaf, root, spentLeaf } from '../pol/mmr.js';
import { signIssuedReceipt } from '../pol/receipt.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation } from '../reserve/evaluate.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../reserve/statement.js';
import { generateSignetReserveKey } from '../reserve/taproot.js';
import { verify, type VerifyInput } from '../verifier/verify.js';

export interface SubmissionLine {
  label: string;
  ok: boolean;
  required: boolean;
  extra: string;
}

/** Externally-observed state this pure core cannot determine on its own (reads files / spawns processes — done by the CLI wrapper). */
export interface ExternalEvidenceStatus {
  /** From evidence/attacks/: null if it couldn't be determined at all (treated as a required failure). */
  attackCorpus: { passed: number; total: number; expectedTotal: number } | null;
  /** From evidence/nostr/cases.json's `pass` field, if present — HISTORICAL Gate 5 mechanism evidence (last `npm run gate5` run), not the live browser-facing demo. */
  nostrLiveEvidencePass: boolean | null;
  /** From evidence/reserves/cases.json's `live_verified` field, if present — HISTORICAL Gate 6 mechanism evidence (last `npm run gate6` run), not the live browser-facing demo. */
  reserveLiveVerified: boolean | null;
  /**
   * A REAL, right-now call to verifyCanonicalLiveDemo() (src/app/submission.ts)
   * — the exact same function the browser's "Live Public Demo" case and
   * `npm run verify:live-demo` use. Never substituted with the historical
   * Gate 5/6 fields above: this is the one thing that can make
   * `npm run verify:submission` report SUBMISSION READY while the actual
   * headline demo a judge would click is stale, unreachable, mismatched, or
   * not ACCEPT_VERIFIED — so it is its own required, independent line.
   * null if it could not be run/determined at all.
   */
  canonicalLiveDemo: { ok: boolean; reasonCode: string; detail: string } | null;
}

function closeEpoch(includeOmitted: boolean, reserveSats: number) {
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
  const AMOUNT_HONEST = 30_000;
  const AMOUNT_OMITTED = 70_000;
  const keyset = generateFixtureKeyset([AMOUNT_HONEST, AMOUNT_OMITTED]);

  const honest = issue(keyset, AMOUNT_HONEST, `sub-honest-${Math.random()}`);
  const omitted = issue(keyset, AMOUNT_OMITTED, `sub-omitted-${Math.random()}`);
  const honestRecon = reconstruct(honest.proof, keyset.keysetId, keyset.amounts[AMOUNT_HONEST]!.publicKeyHex);
  const omittedRecon = reconstruct(omitted.proof, keyset.keysetId, keyset.amounts[AMOUNT_OMITTED]!.publicKeyHex);
  if (!honestRecon.bPrimeHex || !omittedRecon.bPrimeHex) throw new Error('reconstruction failed');

  const honestReceipt = signIssuedReceipt(honestRecon.bPrimeHex, 12, keyset.amounts[AMOUNT_HONEST]!.privateKeyHex);
  const omittedReceipt = signIssuedReceipt(omittedRecon.bPrimeHex, 12, keyset.amounts[AMOUNT_OMITTED]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(honestRecon.bPrimeHex, AMOUNT_HONEST));
  if (includeOmitted) issuedMmr = append(issuedMmr, issuedLeaf(omittedRecon.bPrimeHex, AMOUNT_OMITTED));
  let spentMmr = emptyMmr();
  spentMmr = append(spentMmr, spentLeaf(spentY('sub-spent-secret'), 5_000));

  const issuedRoot = root(issuedMmr);
  const spentRoot = root(spentMmr);
  const entry: KeysetManifestEntry = {
    keyset_id: keyset.keysetId,
    unit: 'sat',
    issued_mmr_size: issuedMmr.leaves.length,
    issued_mmr_root_hash: bytesToHex(issuedRoot.hash),
    issued_mmr_root_sum: Number(issuedRoot.sum),
    spent_mmr_size: spentMmr.leaves.length,
    spent_mmr_root_hash: bytesToHex(spentRoot.hash),
    spent_mmr_root_sum: Number(spentRoot.sum),
    active: true,
    deactivation_epoch: 999,
  };
  const sortedKeysets = sortKeysets([entry]);
  const keysetRoot = keysetMerkleRoot(sortedKeysets);
  const manifest: ManifestFields = {
    keyset_id: entry.keyset_id,
    unit: entry.unit,
    epoch_index: 12,
    timestamp: '2026-09-21T00:00:00Z',
    previous_global_digest: ZERO_DIGEST_HEX,
    issued_mmr_size: entry.issued_mmr_size,
    issued_mmr_root_hash: entry.issued_mmr_root_hash,
    issued_mmr_root_sum: entry.issued_mmr_root_sum,
    spent_mmr_size: entry.spent_mmr_size,
    spent_mmr_root_hash: entry.spent_mmr_root_hash,
    spent_mmr_root_sum: entry.spent_mmr_root_sum,
    outstanding_balance: Number(issuedRoot.sum - spentRoot.sum),
    active: entry.active,
    deactivation_epoch: entry.deactivation_epoch,
  };
  const manifestSignature = signManifest(manifest, masterPrivHex);

  const baseHonestInput: VerifyInput = {
    proof: honest.proof,
    mint: 'solvent-fixture-mint',
    keysetId: keyset.keysetId,
    amountPublicKeyHex: keyset.amounts[AMOUNT_HONEST]!.publicKeyHex,
    receipt: honestReceipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: masterPubHex,
    issuedMmrSize: issuedMmr.leaves.length,
    inclusionProof: getInclusionProof(issuedMmr, 0),
    reserve: { verified: true, reserveSats },
    nostr: { verified: true },
  };

  return {
    masterPrivHex,
    masterPubHex,
    manifest,
    manifestSignature,
    baseHonestInput,
    honestResult: verify(baseHonestInput),
    omittedResult: verify({
      proof: omitted.proof,
      mint: 'solvent-fixture-mint',
      keysetId: keyset.keysetId,
      amountPublicKeyHex: keyset.amounts[AMOUNT_OMITTED]!.publicKeyHex,
      receipt: omittedReceipt,
      manifest,
      manifestSignature,
      masterPublicKeyHex: masterPubHex,
      issuedMmrSize: issuedMmr.leaves.length,
      inclusionProof: includeOmitted ? getInclusionProof(issuedMmr, 1) : null,
      reserve: { verified: true, reserveSats },
      nostr: { verified: true },
    }),
  };
}

function checkGate4(epoch: ReturnType<typeof closeEpoch>): boolean {
  const store = createWalletStore();
  const accepted = runAcceptGate(epoch.baseHonestInput, store);
  if (!(accepted.accepted && accepted.result.reasonCode === 'ACCEPT_VERIFIED' && store.accepted.length === 1)) return false;

  const refuseCases: VerifyInput[] = [
    { ...epoch.baseHonestInput, inclusionProof: null },
    { ...epoch.baseHonestInput, reserve: { verified: true, reserveSats: 0 } },
  ];
  for (const input of refuseCases) {
    const store2 = createWalletStore();
    const r = runAcceptGate(input, store2);
    if (r.accepted || store2.accepted.length !== 0) return false;
  }
  return true;
}

function checkGate5Mechanism(epoch: ReturnType<typeof closeEpoch>): boolean {
  const sortedKeysets = sortKeysets([
    {
      keyset_id: epoch.manifest.keyset_id,
      unit: epoch.manifest.unit,
      issued_mmr_size: epoch.manifest.issued_mmr_size,
      issued_mmr_root_hash: epoch.manifest.issued_mmr_root_hash,
      issued_mmr_root_sum: epoch.manifest.issued_mmr_root_sum,
      spent_mmr_size: epoch.manifest.spent_mmr_size,
      spent_mmr_root_hash: epoch.manifest.spent_mmr_root_hash,
      spent_mmr_root_sum: epoch.manifest.spent_mmr_root_sum,
      active: epoch.manifest.active,
      deactivation_epoch: epoch.manifest.deactivation_epoch,
    },
  ]);
  const keysetRoot = keysetMerkleRoot(sortedKeysets);
  const manifestDigest = manifestDigestHex(epoch.manifest);
  const globalDigestHex = bytesToHex(globalDigest(ZERO_DIGEST_HEX, epoch.manifest.epoch_index, sortedKeysets.length, keysetRoot));
  const now = Math.floor(Date.now() / 1000);
  const expectation: NostrEvidenceExpectation = {
    mintIdentityHex: epoch.masterPubHex,
    epochIndex: epoch.manifest.epoch_index,
    manifestDigestHex: manifestDigest,
    globalDigestHex,
    reserveDigestHex: '1'.repeat(64),
    nowSeconds: now,
  };
  const event = signPolEvidenceEvent(
    buildPolEvidenceContent({
      mint: 'solvent-fixture-mint',
      mintIdentityHex: epoch.masterPubHex,
      keysetId: epoch.manifest.keyset_id,
      epochIndex: epoch.manifest.epoch_index,
      manifestDigestHex: manifestDigest,
      manifestSignature: epoch.manifestSignature,
      globalDigestHex,
      issuedMmrRootHash: epoch.manifest.issued_mmr_root_hash,
      issuedMmrRootSum: epoch.manifest.issued_mmr_root_sum,
      spentMmrRootHash: epoch.manifest.spent_mmr_root_hash,
      spentMmrRootSum: epoch.manifest.spent_mmr_root_sum,
      outstandingBalance: epoch.manifest.outstanding_balance,
      reserveDigestHex: '1'.repeat(64),
      reserveSats: 200_000,
      reserveNetwork: 'bitcoin-signet-mutinynet',
      validitySeconds: 3600,
      proofUri: 'local://submission-check',
      now,
    }),
    generateSecretKey(),
  );
  const okAccept = evaluatePolEvidence([event], expectation).verified === true;
  const okUnavailable = evaluatePolEvidence([], expectation).reasonCode === 'REFUSE_NOSTR_UNAVAILABLE';
  const okStale = evaluatePolEvidence([event], { ...expectation, nowSeconds: now + 999_999 }).reasonCode === 'REFUSE_NOSTR_STALE';
  const okMismatch = evaluatePolEvidence([event], { ...expectation, manifestDigestHex: 'ff'.repeat(32) }).reasonCode === 'REFUSE_NOSTR_STATE_MISMATCH';
  return okAccept && okUnavailable && okStale && okMismatch;
}

function checkGate6Mechanism(epoch: ReturnType<typeof closeEpoch>): boolean {
  const reserveKey = generateSignetReserveKey();
  const reserveMasterPriv = createRandomSecretKey();
  const reserveMasterPrivHex = bytesToHex(reserveMasterPriv);
  const reserveMasterPubHex = bytesToHex(getPubKeyFromPrivKey(reserveMasterPriv));
  const statement: ReserveStatement = {
    network: 'bitcoin-signet-mutinynet',
    reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: 'ab'.repeat(32), vout: 0, value_sats: 200_000, script_pubkey_hex: reserveKey.scriptPubKeyHex }],
    timestamp: '2026-09-21T00:00:00Z',
    block_height: 500_000,
  };
  const statementSignature = signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
  const digest = reserveStatementDigestHex(statement);
  const bindingSignature = signReserveBinding(statement.reserve_pubkey, digest, reserveMasterPrivHex);
  const attestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: reserveMasterPubHex };
  const honestChainState = new Map<string, ChainStateEntry>([
    ['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 200_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
  ]);
  const okAccept = evaluateReserveAttestation(attestation, honestChainState, epoch.manifest.outstanding_balance, 500_010).verified === true;
  const okSpent = evaluateReserveAttestation(
    attestation,
    new Map([['ab'.repeat(32) + ':0', { exists: true, confirmed: true, value: 200_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: true }]]),
    epoch.manifest.outstanding_balance,
    500_010,
  ).reasonCode === 'REFUSE_RESERVE_UTXO_SPENT';
  const okMismatch = evaluateReserveAttestation(attestation, new Map(), epoch.manifest.outstanding_balance, 500_010).reasonCode === 'REFUSE_RESERVE_STATE_MISMATCH';
  const okBadSig = evaluateReserveAttestation({ ...attestation, bindingSignature: '22'.repeat(64) }, honestChainState, epoch.manifest.outstanding_balance, 500_010).reasonCode === 'REFUSE_RESERVE_ATTESTATION_INVALID';
  return okAccept && okSpent && okMismatch && okBadSig;
}

export function runSubmissionChecks(external: ExternalEvidenceStatus): { lines: SubmissionLine[]; failures: number; ready: boolean } {
  const lines: SubmissionLine[] = [];
  const push = (label: string, ok: boolean, extra = '', required = true) => lines.push({ label, ok, required, extra });

  const gate0 = runGate0Spike();
  push('Gate 0 reconstruction', gate0.bPrimeEqual && gate0.cPrimeEqual);
  push('DLEQ', gate0.dleqValid);

  const honestCase = closeEpoch(true, 200_000);
  push('Honest inclusion', honestCase.honestResult.decision === 'ACCEPT', '-> ACCEPT');

  const heroCase = closeEpoch(false, 200_000);
  push('Hero omission', heroCase.omittedResult.reasonCode === 'REFUSE_ISSUANCE_OMITTED', '-> REFUSE_ISSUANCE_OMITTED');

  const shortReserveCase = closeEpoch(true, 1_000);
  push('Short reserve', shortReserveCase.honestResult.reasonCode === 'REFUSE_RESERVE_SHORT', '-> REFUSE_RESERVE_SHORT');

  push('Gate 4 (enforcement)', checkGate4(honestCase), 'spy: ACCEPT calls once, REFUSE calls zero');
  push('Gate 5 (Nostr mechanism)', checkGate5Mechanism(honestCase), 'signature/freshness/mismatch/unavailable checks');
  push('Gate 5 (live relay evidence, historical)', external.nostrLiveEvidencePass === true, external.nostrLiveEvidencePass === null ? '(no evidence/nostr/cases.json — run `npm run gate5`)' : '');
  push('Gate 6 (reserve mechanism)', checkGate6Mechanism(honestCase), 'signature/binding/spent/mismatch checks');
  push(
    'Gate 6 (live Signet UTXO, historical)',
    external.reserveLiveVerified === true,
    external.reserveLiveVerified === true ? '' : '(blocked pending funding — see DECISIONS.md and `npm run gate6`)',
  );

  if (external.canonicalLiveDemo === null) {
    push('Canonical Live Public Demo', false, '(could not be verified — see errors above)');
  } else {
    push('Canonical Live Public Demo', external.canonicalLiveDemo.ok, external.canonicalLiveDemo.ok ? external.canonicalLiveDemo.reasonCode : `${external.canonicalLiveDemo.reasonCode} — ${external.canonicalLiveDemo.detail}`);
  }

  if (external.attackCorpus === null) {
    push('Attack corpus', false, '(could not run — see errors above)');
  } else {
    const { passed, total, expectedTotal } = external.attackCorpus;
    push('Attack corpus', passed === total && total === expectedTotal, `${passed}/${total} (expected ${expectedTotal})`);
  }

  const failures = lines.filter((l) => l.required && !l.ok).length;
  return { lines, failures, ready: failures === 0 };
}
