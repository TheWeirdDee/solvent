// CLI: generates and publishes SOLVENT's stable "Live Public Demo" — one
// complete, mutually-consistent evidence bundle (Cashu proof, PoL receipt,
// closed epoch manifest, inclusion proof, real funded Signet reserve
// attestation, and a real Nostr evidence event) that gets published to
// real public relays and persisted to evidence/nostr/live-demo.json so the
// browser can repeatedly, independently FETCH and re-verify it without
// publishing a fresh throwaway event on every click.
//
// Why this exists: Create Test Ecash and Try SOLVENT's curated scenarios
// each mint a brand-new random mint identity per run specifically to prove
// genuine fresh issuance — which means their Nostr evidence is never
// publicly retrievable (nothing was ever published for that one-off
// identity). That's honest for a "create your own" demo, but it means
// there was no path in the product that could demonstrate SOLVENT's actual
// Nostr guarantee: independently retrieving PUBLICLY PUBLISHED accounting
// state, not just a privately-supplied signed copy. This script builds
// exactly one identity whose evidence genuinely is public, so ACCEPT_VERIFIED
// in the browser's "Live Public Demo" mode rests on a real fetch from real
// relays every time — see src/app/submission.ts's evaluateNostrIndependently
// and docs/trust-boundaries.md's "Live Public Demo" section.
//
// WHY THE IDENTITY IS NOT PERSISTED ACROSS RUNS (investigated and reverted
// — see DECISIONS.md): a stable mint identity reused across multiple
// reserve-attestation refresh cycles was tried and found to be genuinely
// incompatible with this build's Nostr evidence design. Kind 8181 is
// deliberately regular/immutable, not NIP-33 parameterized-replaceable
// (PRD §12.2 — "the audit record must not depend solely on an addressable
// event a relay may discard/replace"). That means an OLD published event
// never disappears; re-publishing a fresh reserve attestation under the
// SAME (mint_identity, epoch) leaves the previous event permanently
// co-discoverable with a *different* reserve_digest, which the real,
// locked evaluatePolEvidence() (Gate 5, src/nostr/pol-evidence.ts)
// correctly groups as two distinct valid signed states for the same
// identity/epoch — REFUSE_NOSTR_CONFLICT, confirmed by actually publishing
// twice and re-verifying for real. Loosening that conflict-detection rule
// to tolerate this would mean the verifier could no longer reliably catch
// genuine equivocation (a mint publishing two different real liability
// claims for the same epoch) — a real security property, not something to
// weaken to make demo maintenance more convenient. So every run of this
// script mints a genuinely fresh identity, exactly as it always did.
//
// Re-run this script to refresh the reserve attestation once its
// block_height falls too far behind the current chain tip (see
// maxAttestationAgeBlocks/RESERVE_FRESHNESS_POLICY in
// src/reserve/evaluate.ts — a network-aware ~1 week budget, ~19,830 blocks
// on Mutinynet's real ~30.5s block cadence; see docs/trust-boundaries.md's
// "Effective expiry" section, or run `npm run verify:live-demo` for the
// current live number) — re-running publishes a NEW event bound to the new
// attestation, since the reserve digest the event commits to changes with
// block_height, and mints an entirely new identity (see above).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRandomSecretKey, getEncodedToken, getPubKeyFromPrivKey, type Proof, type Token } from '@cashu/cashu-ts';
import { generateSecretKey } from 'nostr-tools';
import { bytesToHex, generateFixtureKeyset, issue } from '../cashu/keys.js';
import { reconstruct } from '../cashu/reconstruct.js';
import {
  globalDigest,
  keysetMerkleRoot,
  manifestDigestHex,
  signManifest,
  sortKeysets,
  ZERO_DIGEST_HEX,
  type KeysetManifestEntry,
  type ManifestFields,
} from '../pol/manifest.js';
import { append, emptyMmr, getInclusionProof, issuedLeaf, root, type InclusionProof } from '../pol/mmr.js';
import { signIssuedReceipt } from '../pol/receipt.js';
import { buildPolEvidenceContent, signPolEvidenceEvent } from '../nostr/pol-event.js';
import { fetchPolEvidence, publishPolEvidence, POL_RELAYS } from '../nostr/pol-evidence.js';
import { fetchTipHeight } from '../reserve/esplora.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../reserve/statement.js';
import type { ReserveAttestation } from '../reserve/evaluate.js';
import reserveKeyFixture from '../../evidence/reserves/reserve-key.json' with { type: 'json' };
import liveAttestationEvidence from '../../evidence/reserves/live-attestation.json' with { type: 'json' };

const EVIDENCE_DIR = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'nostr');
const OUT_FILE = path.join(EVIDENCE_DIR, 'live-demo.json');
const EPOCH_INDEX = 12;
const AMOUNT = 70_000;
const MINT_URL = 'solvent-fixture-mint';
const VALIDITY_SECONDS = 30 * 24 * 3600; // 30 days — well beyond the ~1 week reserve-attestation staleness window that actually bounds this demo's lifetime (network-aware — see module header and src/reserve/evaluate.ts).

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  console.log('SOLVENT — generating and publishing the stable Live Public Demo\n');

  // A dedicated master identity for this run of the Live Public Demo
  // specifically (never reused for Create Test Ecash's intentionally
  // fresh-every-run identities, and not persisted across live-demo runs
  // either — see module header for why).
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const keyset = generateFixtureKeyset([AMOUNT]);
  const { proof } = issue(keyset, AMOUNT, `solvent-live-demo-${Date.now()}`);
  const recon = reconstruct(proof, keyset.keysetId, keyset.amounts[AMOUNT]!.publicKeyHex);
  if (!recon.bPrimeHex) throw new Error('live-demo: reconstruction failed');
  const bPrime = recon.bPrimeHex;
  const receipt = signIssuedReceipt(bPrime, EPOCH_INDEX, keyset.amounts[AMOUNT]!.privateKeyHex);

  let issuedMmr = emptyMmr();
  issuedMmr = append(issuedMmr, issuedLeaf(bPrime, AMOUNT));
  const spentMmr = emptyMmr();
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
    epoch_index: EPOCH_INDEX,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
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
  const manifestDigest = manifestDigestHex(manifest);
  const globalDigestHex = bytesToHex(globalDigest(ZERO_DIGEST_HEX, EPOCH_INDEX, sortedKeysets.length, keysetRoot));
  const inclusionProof: InclusionProof = getInclusionProof(issuedMmr, 0);

  // Reserve: the REAL funded Signet outpoint, re-signed under THIS demo's
  // master identity, with a fresh tip height right now — this is what
  // eventually requires re-running this script (see module header).
  console.log('Querying the real current Signet tip height...');
  const tipHeight = await fetchTipHeight();
  const outpoint = liveAttestationEvidence.attestation.statement.outpoints[0]!;
  const statement: ReserveStatement = {
    network: liveAttestationEvidence.attestation.statement.network,
    reserve_pubkey: reserveKeyFixture.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: outpoint.txid, vout: outpoint.vout, value_sats: outpoint.value_sats, script_pubkey_hex: outpoint.script_pubkey_hex }],
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    block_height: tipHeight,
  };
  const statementSignature = signReserveStatement(statement, reserveKeyFixture.tweakedPrivateKeyHex);
  const reserveDigestHex = reserveStatementDigestHex(statement);
  const bindingSignature = signReserveBinding(statement.reserve_pubkey, reserveDigestHex, masterPrivHex);
  const reserveAttestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: masterPubHex };

  // Nostr: the one real publish this whole demo depends on.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const content = buildPolEvidenceContent({
    mint: MINT_URL,
    mintIdentityHex: masterPubHex,
    keysetId: manifest.keyset_id,
    epochIndex: EPOCH_INDEX,
    manifestDigestHex: manifestDigest,
    manifestSignature,
    globalDigestHex,
    issuedMmrRootHash: manifest.issued_mmr_root_hash,
    issuedMmrRootSum: manifest.issued_mmr_root_sum,
    spentMmrRootHash: manifest.spent_mmr_root_hash,
    spentMmrRootSum: manifest.spent_mmr_root_sum,
    outstandingBalance: manifest.outstanding_balance,
    reserveDigestHex,
    reserveSats: outpoint.value_sats,
    reserveNetwork: statement.network,
    validitySeconds: VALIDITY_SECONDS,
    proofUri: 'https://github.com/TheWeirdDee/solvent — SOLVENT Live Public Demo',
    now: nowSeconds,
  });
  const nostrEvent = signPolEvidenceEvent(content, generateSecretKey());

  console.log(`Publishing kind 8181 event ${nostrEvent.id} to ${POL_RELAYS.join(', ')}...`);
  const publishResults = await publishPolEvidence(nostrEvent);
  for (const r of publishResults) console.log(`  ${r.relay}: ${r.ok ? 'OK' : 'FAILED'} — ${r.detail}`);
  const publishedToAny = publishResults.some((r) => r.ok);
  if (!publishedToAny) throw new Error('live-demo: publish failed on every configured relay — nothing to verify a fetch-back against');

  console.log('\nIndependently fetching it back...');
  const { events: fetchedBack } = await fetchPolEvidence(masterPubHex, EPOCH_INDEX);
  const foundOwnEvent = fetchedBack.some((e) => e.id === nostrEvent.id);
  console.log(`Fetch-back: ${fetchedBack.length} event(s) found; own event present: ${foundOwnEvent}`);
  if (!foundOwnEvent) {
    console.log('WARNING: publish reported success but the immediate fetch-back did not see it yet (relay indexing lag is real and not always instant — the browser\'s bounded retry, see submission.ts, absorbs exactly this). Re-run this script or wait and re-check before relying on it.');
  }

  const token = getEncodedToken({ mint: MINT_URL, proofs: [proof] } as Token);

  const bundle = {
    proof: { ...proof, amount: proof.amount.toNumber() } as unknown as Proof,
    mint: MINT_URL,
    keysetId: keyset.keysetId,
    amountPublicKeyHex: keyset.amounts[AMOUNT]!.publicKeyHex,
    receipt,
    manifest,
    manifestSignature,
    masterPublicKeyHex: masterPubHex,
    issuedMmrSize: manifest.issued_mmr_size,
    inclusionProof: {
      leafIndex: inclusionProof.leafIndex,
      siblingPath: inclusionProof.siblingPath.map((s) => ({ hash: bytesToHex(s.hash), sum: s.sum.toString(), isLeft: s.isLeft })),
      peaks: inclusionProof.peaks.map((p) => ({ hash: bytesToHex(p.hash), sum: p.sum.toString() })),
    },
    reserveAttestation,
    nostrEvent,
  };

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        _note: 'SOLVENT Live Public Demo — a stable, real, once-published evidence set. Generated/published by npm run live-demo; the browser fetches and re-verifies this live on every run rather than trusting this file directly. A fresh mint identity is minted on every run — a persisted/stable identity was tried and reverted because kind 8181 is deliberately immutable/non-replaceable, so an old event never disappears and would permanently conflict with a newer one for the same identity/epoch (see this script\'s module header and DECISIONS.md). Re-run this script (or run `npm run verify:live-demo` to check first) if the reserve attestation goes stale — a network-aware ~1 week budget, see maxAttestationAgeBlocks in src/reserve/evaluate.ts and docs/trust-boundaries.md\'s "Effective expiry" section.',
        token,
        bundle,
        publishedAt: new Date(nowSeconds * 1000).toISOString(),
        publishResults,
        fetchBackConfirmed: foundOwnEvent,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`Nostr event id: ${nostrEvent.id}`);
  console.log(`Mint identity (master pubkey): ${masterPubHex}`);
  console.log(`Reserve outpoint: ${outpoint.txid}:${outpoint.vout} (${outpoint.value_sats} sats, ${statement.network})`);
  console.log(`Manifest digest: ${manifestDigest}`);
  console.log(`Global digest: ${globalDigestHex}`);
}

main().catch((err) => {
  console.error('live-demo generation crashed:', err);
  process.exit(1);
});
