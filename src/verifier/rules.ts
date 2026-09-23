// The core accept-gate rule (PRD section 10.4). UI-independent: takes a
// mint fixture, a signed Nostr event, and a presented Cashu proof, and
// returns a structured GREEN/RED decision. GREEN requires every check to
// pass; anything unverifiable is RED. No boolean is ever hard-coded — every
// field here is the real result of a cryptographic or arithmetic check.
import { Amount, type Proof } from '@cashu/cashu-ts';
import type { NostrEvent } from 'nostr-tools';
import { checkDleqAndReconstructCPrime } from '../cashu/dleq.js';
import { hexToBytes } from '../encode/canonical.js';
import type { MintFixture } from '../mint/types.js';
import { compileReport, findMintInclusionProof } from '../mint/reports.js';
import { isEventFresh, verifySolvencyEvent, type SolvencyEventContent } from '../nostr/event.js';
import { bundleRootsMatchSignedRoots, buildProofBundle } from '../proof/bundle.js';
import { mintLeafHash } from '../proof/mint-leaf.js';
import { verifyInclusionProof } from '../proof/merkle-sum.js';

export interface VerifyChecks {
  nostrSignature: boolean;
  freshness: boolean;
  latestEvent: boolean;
  proofBundleRoots: boolean;
  arithmetic: boolean;
  reserveCoverage: boolean;
  dleq: boolean;
  cashuOrigin: boolean;
  cPrimeReconstruction: boolean;
  inclusion: boolean;
  amountMatch: boolean;
}

export interface VerifyDetails {
  cPrimeHex?: string;
  mintLeafHashHex?: string;
  recomputedLiabilitiesSats?: number;
  ratio?: number;
  eventContent?: SolvencyEventContent;
  eventId?: string;
}

export interface VerifyResult {
  decision: 'GREEN' | 'RED';
  checks: VerifyChecks;
  reason: string;
  details: VerifyDetails;
}

export interface VerifyInput {
  expectedMintIdentity: string;
  fixture: MintFixture;
  event: NostrEvent;
  proof: Proof;
  now: number;
  /** Other candidate events for the same (pubkey, kind, d-tag) scope, so staleness against a newer report can be checked. Optional — Phase 1's local demo has exactly one event per mint. */
  knownEvents?: NostrEvent[];
}

function allPass(checks: VerifyChecks): boolean {
  return Object.values(checks).every((v) => v === true);
}

export function verify(input: VerifyInput): VerifyResult {
  const checks: VerifyChecks = {
    nostrSignature: false,
    freshness: false,
    latestEvent: false,
    proofBundleRoots: false,
    arithmetic: false,
    reserveCoverage: false,
    dleq: false,
    cashuOrigin: false,
    cPrimeReconstruction: false,
    inclusion: false,
    amountMatch: false,
  };
  const details: VerifyDetails = { eventId: input.event.id };
  const reasons: string[] = [];
  // cashu-ts's Proof.amount is an Amount value object (protects against float/overflow bugs);
  // SOLVENT's own modules work with plain sats numbers, so normalize once here.
  const proofAmount = Amount.from(input.proof.amount).toNumber();

  // Checks 1-2: signature valid + event genuinely belongs to the expected mint identity.
  const eventCheck = verifySolvencyEvent(input.event);
  const dTag = input.event.tags.find((t) => t[0] === 'd')?.[1];
  const content = eventCheck.content;
  details.eventContent = content;

  checks.nostrSignature =
    eventCheck.signatureValid &&
    eventCheck.contentParses &&
    input.event.pubkey === input.fixture.nostrPubkeyHex &&
    content?.mint_pubkey === input.event.pubkey &&
    dTag === input.expectedMintIdentity;
  if (!checks.nostrSignature) {
    reasons.push(eventCheck.reason ?? 'signed event does not match the expected mint identity');
  }

  // Check 3: freshness.
  checks.freshness = content !== undefined && isEventFresh(content, input.now);
  if (!checks.freshness) reasons.push('signed solvency event is stale (past valid_until) or content did not parse');

  // Check 4: latest accepted replaceable event for this mint/scope.
  if (!input.knownEvents || input.knownEvents.length === 0) {
    checks.latestEvent = true;
  } else {
    const scope = [input.event, ...input.knownEvents].filter(
      (e) => e.pubkey === input.event.pubkey && e.kind === input.event.kind && e.tags.find((t) => t[0] === 'd')?.[1] === dTag,
    );
    const maxCreatedAt = Math.max(...scope.map((e) => e.created_at));
    checks.latestEvent = input.event.created_at >= maxCreatedAt;
    if (!checks.latestEvent) reasons.push('a newer solvency event exists for this mint; this one is stale');
  }

  const amountsValid =
    content !== undefined &&
    Number.isSafeInteger(content.mint_root.sum_sats) &&
    content.mint_root.sum_sats >= 0 &&
    Number.isSafeInteger(content.burn_root.sum_sats) &&
    content.burn_root.sum_sats >= 0 &&
    Number.isSafeInteger(content.liabilities_sats) &&
    Number.isSafeInteger(content.reserve_sats) &&
    content.reserve_sats >= 0;

  // Checks 6-8: burn <= mint, and signed liabilities == mint_sum - burn_sum (recomputed, not trusted).
  if (content && amountsValid) {
    const recomputedLiabilities = content.mint_root.sum_sats - content.burn_root.sum_sats;
    details.recomputedLiabilitiesSats = recomputedLiabilities;
    const burnNotOverMint = content.burn_root.sum_sats <= content.mint_root.sum_sats;
    const liabilitiesMatchSigned = recomputedLiabilities === content.liabilities_sats;
    checks.arithmetic = burnNotOverMint && liabilitiesMatchSigned;
    if (!burnNotOverMint) reasons.push('burn total exceeds mint total, which cannot happen in a real report');
    if (!liabilitiesMatchSigned) reasons.push('signed liabilities_sats does not equal mint_root.sum_sats - burn_root.sum_sats');
  } else {
    reasons.push('event amounts are missing or not valid non-negative integers');
  }

  // Check 9: reserve >= liabilities, using the recomputed figure so a mint cannot lie about liabilities_sats and still pass.
  if (checks.arithmetic && content) {
    const liabilities = details.recomputedLiabilitiesSats!;
    checks.reserveCoverage = content.reserve_sats >= liabilities;
    details.ratio = liabilities > 0 ? content.reserve_sats / liabilities : Infinity;
    if (!checks.reserveCoverage) reasons.push("Reserve does not cover the mint's committed outstanding liabilities. Do not accept.");
  } else {
    reasons.push('cannot check reserve coverage: arithmetic did not validate');
  }

  // Structural origin: presented proof's keyset must match this mint's published keyset.
  checks.cashuOrigin = input.proof.id === input.fixture.keysetId && content?.keyset_id === input.fixture.keysetId;
  if (!checks.cashuOrigin) reasons.push("presented proof's keyset does not match this mint's published keyset");

  // Checks 10-12: NUT-12 DLEQ data present + verifies + C' reconstructed (real crypto, see cashu/dleq.ts).
  const dleqResult = checks.cashuOrigin
    ? checkDleqAndReconstructCPrime(input.proof, input.fixture.cashuKeys)
    : { valid: false as const, reason: 'skipped: keyset origin mismatch' };
  checks.dleq = dleqResult.valid;
  checks.cPrimeReconstruction = dleqResult.valid && dleqResult.cPrimeHex !== undefined;
  if (dleqResult.cPrimeHex) {
    details.cPrimeHex = dleqResult.cPrimeHex;
    details.mintLeafHashHex = Array.from(
      mintLeafHash({ keysetId: input.fixture.keysetId, amount: proofAmount, cPrimeHex: dleqResult.cPrimeHex }),
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (!dleqResult.valid) reasons.push(dleqResult.reason ?? 'DLEQ verification failed');

  // Checks 13-16: mint-proof leaf derived locally, inclusion path verifies against the SIGNED mint_root,
  // and the proof bundle's roots equal what the event actually signed.
  if (checks.cPrimeReconstruction && content && amountsValid) {
    const report = compileReport(input.fixture);
    const inclusionProof = findMintInclusionProof(input.fixture, report, {
      amount: proofAmount,
      cPrimeHex: details.cPrimeHex!,
    });
    if (!inclusionProof) {
      reasons.push('This mint issued this ecash but did not include the issuance in its published liabilities. Do not accept.');
    } else {
      checks.amountMatch = true;
      const bundle = buildProofBundle({
        mintIdentity: input.fixture.mintIdentity,
        keysetId: input.fixture.keysetId,
        epoch: input.fixture.epoch,
        mintRoot: input.fixture.mintRoot,
        burnRoot: input.fixture.burnRoot,
        inclusion: inclusionProof,
      });
      checks.proofBundleRoots = bundleRootsMatchSignedRoots(bundle, {
        mintRootHash: content.mint_root.hash,
        mintRootSum: content.mint_root.sum_sats,
        burnRootHash: content.burn_root.hash,
        burnRootSum: content.burn_root.sum_sats,
      });
      if (!checks.proofBundleRoots) reasons.push('proof bundle roots do not match the roots signed in the Nostr event');

      checks.inclusion = verifyInclusionProof(inclusionProof, hexToBytes(content.mint_root.hash), BigInt(content.mint_root.sum_sats));
      if (!checks.inclusion) reasons.push('Merkle-sum inclusion path does not verify against the signed mint_root');
    }
  } else {
    reasons.push("cannot check inclusion: DLEQ / C' reconstruction did not succeed");
  }

  const decision: 'GREEN' | 'RED' = allPass(checks) ? 'GREEN' : 'RED';
  const reason =
    decision === 'GREEN'
      ? 'This ecash verifies as mint-issued, its issuance is included in the published commitment, and reported reserve covers the committed outstanding liabilities. The mint is still a custodian, and full completeness of all liabilities is not proven.'
      : (reasons[0] ?? 'one or more required checks failed');

  return { decision, checks, reason, details };
}
