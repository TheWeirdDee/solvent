// The submission/verification boundary — this is the fix for the gap where
// a hand-edited or malicious bundle could simply assert `reserve.verified:
// true` / `nostr.verified: true` with no real evidence behind it and have
// verify() trust those booleans as fact. verify() itself (src/verifier/
// verify.ts) is locked and untouched: it still takes a VerifyInput with
// pre-evaluated `reserve`/`nostr` booleans, and it still must, because it is
// a synchronous, pure, no-network function by design (that purity is what
// makes checks 1-10 unit-testable without a live chain/relay).
//
// What changes is what is allowed to PRODUCE those booleans. A bundle a
// user creates, exports, or pastes is now a SubmissionBundle — raw evidence
// only (a signed ReserveAttestation object, a signed Nostr event object),
// with no `verified` field anywhere in its schema. verifySubmission() is the
// only place that turns raw evidence into the `reserve`/`nostr` booleans
// verify() consumes, and it does that by:
//   - reserve: a REAL live Esplora re-query of the attestation's own
//     declared outpoints, right now, independent of anything the bundle
//     claims about their state;
//   - nostr: independently recomputing the manifest/global/reserve digests
//     from the bundle's OWN manifest/reserve fields (never trusting a
//     claimed digest) and re-running the real evaluatePolEvidence() (BIP-340
//     signature check + content-schema check + freshness + digest-binding)
//     against the bundle's raw signed event.
//
// A pasted bundle cannot shortcut this: there is no boolean field to set.
// The worst a malicious bundle can do is supply a real signed event/
// attestation that doesn't match — which independent re-evaluation catches
// the same way it always has.
//
// Note on Nostr "liveness" — TWO DISTINCT LEVELS, never conflated:
//
//   1. CRYPTOGRAPHIC BUNDLE VALIDITY (`providedCopyValid`) — is the raw
//      signed event the bundle itself carries a genuine, internally
//      consistent BIP-340 signature/schema/digest-binding match for this
//      bundle's own manifest/reserve fields? This is real cryptography, but
//      it only proves the SENDER possesses a validly signed event — not
//      that anyone else can independently find it.
//   2. LIVE PUBLIC ACCEPTANCE VERIFICATION (`publicationVerified`, and the
//      `verified`/`reasonCode` actually fed into verify()) — was that exact
//      accounting state independently RETRIEVED from a public relay right
//      now? A signed event a sender merely hands you privately does not
//      satisfy this, no matter how cryptographically valid it is: SOLVENT's
//      whole point is that the mint's accounting is publicly checkable, not
//      just signable. So `verified` is true ONLY when a public relay
//      genuinely returns this evidence — never falls back to the bundle's
//      own private copy for the accept-gating decision. A bundle whose
//      event cannot be found publicly gets `REFUSE_NOSTR_UNAVAILABLE` (or
//      a more specific conflict/mismatch code, if the relay's real public
//      state actively disagrees) even when `providedCopyValid` is true.
//
// Every verification attempts a REAL fetch from public relays
// (fetchPolEvidence, the same multi-relay-redundant call Gate 5 uses) for
// events matching the bundle's own (mint_identity, epoch) — never a
// fabricated result, never skipped. What this module does NOT do is
// publish a fresh event on every click before fetching it back — that
// would spam production relays with throwaway evidence on every button
// press for no real benefit. So a demo-generated bundle (Create Test Ecash,
// which mints a brand-new random identity every run specifically to prove
// genuine fresh issuance) will predictably find nothing on public relays,
// since it was never published anywhere — and correctly cannot reach
// ACCEPT_VERIFIED on that basis alone (see protocol-demo.ts's
// loadLivePublicDemo() for the one identity that genuinely IS published,
// once, via `npm run live-demo`, and is what Try SOLVENT's HEALTHY / Live
// Public Demo case verifies against). See docs/trust-boundaries.md.
import type { Proof } from '@cashu/cashu-ts';
import type { NostrEvent } from 'nostr-tools';
import { globalDigest, keysetMerkleRoot, manifestDigestHex, sortKeysets, type KeysetManifestEntry, type ManifestFields } from '../pol/manifest.js';
import { bytesToHex, type InclusionProof } from '../pol/mmr.js';
import type { PolReceipt } from '../pol/receipt.js';
import { evaluatePolEvidence, fetchPolEvidence, realDelay, type DelayFn, type NostrEvidenceReasonCode } from '../nostr/pol-evidence.js';
import { fetchOutspend, fetchTipHeight, fetchTxOutScript, realDelay as esploraRealDelay } from '../reserve/esplora.js';
import { evaluateReserveAttestation, type ChainStateEntry, type ReserveAttestation, type ReserveReasonCode } from '../reserve/evaluate.js';
import { reserveStatementDigestHex } from '../reserve/statement.js';
import { verify, type VerifyInput, type VerifyResult } from '../verifier/verify.js';
import { submissionBundleFromJson } from './bundle-json.js';
import liveDemoEvidenceFile from '../../evidence/nostr/live-demo.json' with { type: 'json' };

/**
 * What a user actually creates, exports, or pastes. Everything except
 * `reserveAttestation`/`nostrEvent` is identical to VerifyInput's own
 * crypto-spine fields (still checked, unmodified, by verify() itself) —
 * the difference is only that `reserve`/`nostr` are never pre-evaluated
 * booleans here. There is no field a bundle can set to claim "this is
 * already verified."
 */
export interface SubmissionBundle {
  proof: Proof;
  mint: string;
  keysetId: string;
  amountPublicKeyHex: string;
  receipt: PolReceipt;
  manifest: ManifestFields;
  manifestSignature: string;
  masterPublicKeyHex: string;
  issuedMmrSize: number;
  inclusionProof: InclusionProof | null;
  /** Raw signed reserve statement + two BIP-340 signatures — or null if the mint supplied none. Never a boolean. */
  reserveAttestation: ReserveAttestation | null;
  /** Raw signed Nostr event — or null if none was supplied. Never a boolean. */
  nostrEvent: NostrEvent | null;
}

export interface ReserveLiveStatus {
  supplied: boolean;
  queried: boolean;
  queryOk: boolean;
  verified: boolean;
  reasonCode?: ReserveReasonCode;
  verifiedReserveSats: number;
  outstandingBalance: number;
  /** The real current chain tip height, if the query succeeded — lets a caller compute how much of the attestation's staleness window (MAX_ATTESTATION_AGE_BLOCKS in evaluate.ts) remains, e.g. for the Live Public Demo's expiry display. */
  tipHeight?: number;
  detail: string;
}

export interface NostrLiveStatus {
  supplied: boolean;
  /** Did the relay fetch attempt itself complete without a network-level error? */
  relayReachable: boolean;
  /** Did a public relay actually return the bundle's exact event? False for demo-generated events, which are never published — see module header. */
  eventFetched: boolean;
  /** Informational only, never gates ACCEPT: is the bundle's OWN private copy of the event a genuine, internally consistent signed artifact? */
  providedCopyValid: boolean;
  /** The real gate: was this evidence independently retrieved from a public relay AND cryptographically valid there? Only this can make `verified` true. */
  publicationVerified: boolean;
  signatureValid: boolean;
  freshnessValid: boolean;
  bindingValid: boolean;
  /** Equals `publicationVerified` — this exact field is what verifySubmission() feeds into verify(). Never derived from the bundle's own private copy alone. */
  verified: boolean;
  reasonCode?: NostrEvidenceReasonCode | 'REFUSE_NOSTR_EVENT_NOT_FOUND';
  detail: string;
}

export interface SubmissionVerification {
  verifyInput: VerifyInput;
  result: VerifyResult;
  reserveLive: ReserveLiveStatus;
  nostrLive: NostrLiveStatus;
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

const ESPLORA_RETRY_DELAY_MS = 1500;

async function fetchChainStateOnce(outpoints: { txid: string; vout: number }[]): Promise<{ ok: true; chainState: Map<string, ChainStateEntry>; tipHeight: number } | { ok: false; error: Error }> {
  try {
    const perOutpoint = await Promise.all(
      outpoints.map(async (o) => ({ o, out: await fetchTxOutScript(o.txid, o.vout), outspend: await fetchOutspend(o.txid, o.vout) })),
    );
    const tipHeight = await fetchTipHeight();
    const chainState = new Map<string, ChainStateEntry>();
    for (const { o, out, outspend } of perOutpoint) {
      if (out) chainState.set(outpointKey(o.txid, o.vout), { exists: true, confirmed: true, value: out.value, scriptPubKeyHex: out.scriptPubKeyHex, spent: outspend.spent });
    }
    return { ok: true, chainState, tipHeight };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

/**
 * A real, live re-query of an attestation's own declared outpoints against
 * a public Esplora API — generalized so it works for ANY submitted
 * attestation, not just SOLVENT's own bundled demo outpoint. Fails closed
 * (ok:false) on any network error; never fabricates chain state.
 *
 * BOUNDED RETRY: one extra attempt, after a short delay, but ONLY for a
 * transport-level failure (the fetch itself throwing — timeout, connection
 * error, non-2xx HTTP status; see esplora.ts's getJson()). This never
 * retries away a genuine PROTOCOL result — a successful fetch that reports
 * a spent UTXO, a value/script mismatch, or (via the separate, synchronous
 * evaluateReserveAttestation()) a shortfall or stale attestation is
 * returned immediately, with no retry, because retrying wouldn't change
 * real on-chain/protocol facts and could mask a real problem behind a
 * misleading "still checking" delay. Exactly one retry, never more — a
 * real outage still fails closed in bounded time.
 */
export async function queryLiveChainState(
  outpoints: { txid: string; vout: number }[],
  delayFn: DelayFn = esploraRealDelay,
): Promise<{ ok: boolean; chainState: Map<string, ChainStateEntry>; tipHeight: number; detail: string }> {
  const first = await fetchChainStateOnce(outpoints);
  if (first.ok) return { ok: true, chainState: first.chainState, tipHeight: first.tipHeight, detail: `live Esplora query succeeded (tip ${first.tipHeight})` };

  await delayFn(ESPLORA_RETRY_DELAY_MS);
  const second = await fetchChainStateOnce(outpoints);
  if (second.ok) return { ok: true, chainState: second.chainState, tipHeight: second.tipHeight, detail: `live Esplora query succeeded on retry (tip ${second.tipHeight})` };

  return { ok: false, chainState: new Map(), tipHeight: 0, detail: `live reserve query failed after one retry: ${second.error.message}` };
}

/** The exact shape of queryLiveChainState() — extracted for the same reason as RelayFetchFn above (see src/cli/attacks.ts's A25): lets a deterministic caller inject a fake chain-state response at this exact boundary, while the browser always uses the real function (the default). */
export type ChainStateFetchFn = typeof queryLiveChainState;

async function evaluateReserveLive(
  attestation: ReserveAttestation | null,
  outstandingBalance: number,
  fetchFn: ChainStateFetchFn = queryLiveChainState,
): Promise<ReserveLiveStatus> {
  if (!attestation) {
    return { supplied: false, queried: false, queryOk: false, verified: false, verifiedReserveSats: 0, outstandingBalance, detail: 'No reserve attestation was supplied with this bundle.' };
  }
  const live = await fetchFn(attestation.statement.outpoints);
  if (!live.ok) {
    return { supplied: true, queried: true, queryOk: false, verified: false, verifiedReserveSats: 0, outstandingBalance, detail: live.detail };
  }
  const evalResult = evaluateReserveAttestation(attestation, live.chainState, outstandingBalance, live.tipHeight + 1);
  return {
    supplied: true,
    queried: true,
    queryOk: true,
    verified: evalResult.verified,
    reasonCode: evalResult.reasonCode,
    verifiedReserveSats: evalResult.verifiedReserveSats,
    outstandingBalance,
    tipHeight: live.tipHeight,
    detail: evalResult.detail,
  };
}

function keysetEntryFromManifest(m: ManifestFields): KeysetManifestEntry {
  return {
    keyset_id: m.keyset_id,
    unit: m.unit,
    issued_mmr_size: m.issued_mmr_size,
    issued_mmr_root_hash: m.issued_mmr_root_hash,
    issued_mmr_root_sum: m.issued_mmr_root_sum,
    spent_mmr_size: m.spent_mmr_size,
    spent_mmr_root_hash: m.spent_mmr_root_hash,
    spent_mmr_root_sum: m.spent_mmr_root_sum,
    active: m.active,
    deactivation_epoch: m.deactivation_epoch,
  };
}

/** Recomputes the global digest from the bundle's OWN manifest fields — never trusts a claimed digest embedded anywhere else. Assumes the single-keyset-per-epoch shape this build always produces (see buildEpoch in protocol-demo.ts). Exported for reuse anywhere a real global digest needs recomputing from a manifest alone (e.g. protocol-demo.ts's Live Public Demo display). */
export function computeGlobalDigestHex(m: ManifestFields): string {
  const sorted = sortKeysets([keysetEntryFromManifest(m)]);
  return bytesToHex(globalDigest(m.previous_global_digest, m.epoch_index, sorted.length, keysetMerkleRoot(sorted)));
}

/** The exact shape of fetchPolEvidence() — extracted so a caller (the deterministic attack corpus, in particular — see src/cli/attacks.ts's A25) can inject a fake relay response at this exact boundary without touching real public relays, while the browser always uses the real function (the default). */
export type RelayFetchFn = typeof fetchPolEvidence;

/**
 * How long the bounded retry (below) waits before its one extra attempt.
 * Sized for relay indexing/propagation lag, not for a real outage — a
 * genuinely unreachable relay fails fast on both attempts regardless of
 * this value. Exported so a caller (e.g. a UI "retrying..." indicator)
 * could reference the same number without hardcoding a duplicate.
 */
export const NOSTR_FETCH_RETRY_DELAY_MS = 1500;

async function evaluateNostrIndependently(
  event: NostrEvent | null,
  bundle: Pick<SubmissionBundle, 'manifest' | 'masterPublicKeyHex' | 'reserveAttestation'>,
  fetchFn: RelayFetchFn = fetchPolEvidence,
  delayFn: DelayFn = realDelay,
): Promise<NostrLiveStatus> {
  if (!event) {
    return {
      supplied: false, relayReachable: false, eventFetched: false, providedCopyValid: false, publicationVerified: false,
      signatureValid: false, freshnessValid: false, bindingValid: false, verified: false,
      detail: 'No Nostr evidence event was supplied with this bundle.',
    };
  }
  const manifestDigest = manifestDigestHex(bundle.manifest);
  const globalDigestHexValue = computeGlobalDigestHex(bundle.manifest);
  const reserveDigestHexValue = bundle.reserveAttestation ? reserveStatementDigestHex(bundle.reserveAttestation.statement) : '';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expect = {
    mintIdentityHex: bundle.masterPublicKeyHex,
    epochIndex: bundle.manifest.epoch_index,
    manifestDigestHex: manifestDigest,
    globalDigestHex: globalDigestHexValue,
    reserveDigestHex: reserveDigestHexValue,
    nowSeconds,
  };

  // Informational only (see module header): does the bundle's OWN private
  // copy hold up cryptographically on its own? This NEVER contributes to
  // `verified`/`reasonCode` below — only to `providedCopyValid`.
  const providedCopyResult = evaluatePolEvidence([event], expect);

  // The real gate: a live attempt to fetch this exact (mint_identity,
  // epoch) evidence from public relays, every time — never skipped, never
  // assumed. Multi-relay redundant (fetchPolEvidence queries all
  // POL_RELAYS in parallel and tolerates any subset being unreachable,
  // same as Gate 5/attacks A17-A18). `relayReachable` comes from fetchFn's
  // own connection-level signal (see fetchPolEvidence's doc comment) —
  // never inferred from whether the call threw, since the real relay
  // client resolves normally even when every relay is unreachable.
  //
  // BOUNDED RETRY: a real relay miss can be transient (indexing/propagation
  // lag right after a publish, or a momentary blip on one of several
  // relays) — observed for real during this build (a genuinely-published,
  // genuinely-findable event once came back NOT FOUND on the first attempt,
  // then FOUND on an immediate re-check). One extra attempt, after one
  // short delay, absorbs that without masking a genuinely unpublished
  // event: if the exact event still isn't found after the retry, the
  // result is exactly what a single attempt would have reported (REFUSE_
  // NOSTR_EVENT_NOT_FOUND / REFUSE_NOSTR_UNAVAILABLE as appropriate) — this
  // never converts a real absence into a false ACCEPT, and never retries
  // more than once, so an outage still refuses in bounded time. Reachability
  // and fetched events from BOTH attempts are combined (reachable if EITHER
  // attempt reached a relay; events are the union, deduped downstream by
  // evaluatePolEvidence) rather than the retry silently discarding whatever
  // the first attempt actually observed.
  async function attemptFetch(): Promise<{ relayReachable: boolean; events: NostrEvent[] }> {
    try {
      const { events, relayReachable: reachable } = await fetchFn(bundle.masterPublicKeyHex, bundle.manifest.epoch_index);
      return { relayReachable: reachable, events };
    } catch {
      return { relayReachable: false, events: [] };
    }
  }

  const first = await attemptFetch();
  let relayReachable = first.relayReachable;
  let fetchedEvents = first.events;
  const foundOnFirstAttempt = fetchedEvents.some((e) => e.id === event.id);

  if (!foundOnFirstAttempt) {
    await delayFn(NOSTR_FETCH_RETRY_DELAY_MS);
    const second = await attemptFetch();
    relayReachable = relayReachable || second.relayReachable;
    const merged = new Map<string, NostrEvent>();
    for (const e of fetchedEvents) merged.set(e.id, e);
    for (const e of second.events) merged.set(e.id, e);
    fetchedEvents = [...merged.values()];
  }
  const eventFetched = fetchedEvents.some((e) => e.id === event.id);

  // Evaluate ONLY what relays actually, independently returned — never
  // merged with or falling back to the bundle's own private copy. A
  // bundle cannot satisfy the public-publication gate just by including a
  // valid signed event; only a real relay response can. This also still
  // catches a relay serving a genuinely different, conflicting valid state
  // for the same mint identity/epoch (REFUSE_NOSTR_CONFLICT) or one whose
  // digests don't match what this bundle claims (REFUSE_NOSTR_STATE_MISMATCH).
  const liveResult = evaluatePolEvidence(fetchedEvents, expect);

  // evaluatePolEvidence() (locked Gate 5 logic, unchanged) reports
  // REFUSE_NOSTR_UNAVAILABLE both when it was handed zero candidate events
  // AND when none of the candidates it was handed actually commit to the
  // expected identity/epoch — it has no way to know whether that's because
  // the relay layer itself was unreachable or because it was reached and
  // genuinely had nothing. Only this orchestration layer knows that (via
  // `relayReachable`), so it remaps the distinction here: a relay that was
  // truly reached but had no matching public evidence is a materially
  // different fact ("the mint never published this") from being unable to
  // reach any relay at all ("we don't know whether it's published").
  const reasonCode: NostrEvidenceReasonCode | 'REFUSE_NOSTR_EVENT_NOT_FOUND' =
    relayReachable && liveResult.reasonCode === 'REFUSE_NOSTR_UNAVAILABLE' ? 'REFUSE_NOSTR_EVENT_NOT_FOUND' : (liveResult.reasonCode ?? 'REFUSE_NOSTR_UNAVAILABLE');

  return {
    supplied: true,
    relayReachable,
    eventFetched,
    providedCopyValid: providedCopyResult.verified,
    publicationVerified: liveResult.verified,
    signatureValid: liveResult.reasonCode !== 'REFUSE_NOSTR_SIGNATURE',
    freshnessValid: liveResult.reasonCode !== 'REFUSE_NOSTR_STALE' && liveResult.reasonCode !== 'REFUSE_NOSTR_SIGNATURE',
    bindingValid: liveResult.verified,
    verified: liveResult.verified,
    reasonCode: liveResult.verified ? undefined : reasonCode,
    detail: eventFetched
      ? `Event found and independently re-verified on a public relay. ${liveResult.detail}`
      : `${relayReachable ? 'Relay(s) reachable, but none returned the required public event' : 'Relay(s) unreachable — public retrieval could not be attempted'} — public retrieval could not be independently confirmed. The bundle's own signed copy is ${providedCopyResult.verified ? 'cryptographically valid' : 'NOT cryptographically valid'}, but that alone does not establish public publication. ${liveResult.detail}`,
  };
}

/**
 * The single entry point every /verify surface now goes through — Try
 * SOLVENT's curated scenarios, Create Test Ecash, and Verify Your Evidence
 * (pasted bundles) alike. Independently re-derives `reserve`/`nostr` from
 * raw evidence (see module header) and only then calls the real, locked
 * verify(). A caller cannot skip the independent re-derivation — there is
 * no code path here that reads a `verified` boolean off the input bundle.
 */
export async function verifySubmission(
  bundle: SubmissionBundle,
  relayFetchFn: RelayFetchFn = fetchPolEvidence,
  chainStateFetchFn: ChainStateFetchFn = queryLiveChainState,
  delayFn: DelayFn = realDelay,
): Promise<SubmissionVerification> {
  const [reserveLive, nostrLive] = await Promise.all([
    evaluateReserveLive(bundle.reserveAttestation, bundle.manifest.outstanding_balance, chainStateFetchFn),
    evaluateNostrIndependently(bundle.nostrEvent, bundle, relayFetchFn, delayFn),
  ]);

  const verifyInput: VerifyInput = {
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
    // Omit entirely (never a defined-but-false object) whenever the fact
    // itself could not be independently established — a network failure is
    // not the same claim as "checked and short/invalid", and only omission
    // reaches verify()'s existing REFUSE_UNVERIFIABLE fail-closed default.
    ...(reserveLive.supplied && reserveLive.queryOk ? { reserve: { verified: reserveLive.verified, reserveSats: reserveLive.verifiedReserveSats, reasonCode: reserveLive.reasonCode } } : {}),
    ...(nostrLive.supplied ? { nostr: { verified: nostrLive.verified, reasonCode: nostrLive.reasonCode } } : {}),
  };

  const result = verify(verifyInput);
  return { verifyInput, result, reserveLive, nostrLive };
}

// ---------------------------------------------------------------------
// THE canonical Live Public Demo — one source, three callers.
//
// Previously the browser (protocol-demo.ts's loadLivePublicDemo), `npm run
// verify:live-demo`, and `npm run verify:submission` each had their own
// path to "is the headline demo currently live": the browser bundled
// evidence/nostr/live-demo.json at build time, verify-live-demo.ts read the
// same file straight off disk, and verify:submission didn't look at this
// file at all — it graded historical Gate 5/6 evidence instead, so it was
// possible for `verify:submission` to report SUBMISSION READY while the
// actual browser-facing Live Public Demo was stale or unreachable. Fixed
// by giving all three exactly one loader and one verifier, both below.
//
// Both the browser (bundled by Vite at build time) and CLI scripts (read
// by tsx at run time) resolve `with { type: 'json' }` imports identically,
// so this one import (top of file) IS the single canonical evidence
// source — there is no second file for any caller to accidentally drift
// onto.
// ---------------------------------------------------------------------

export const CANONICAL_LIVE_DEMO_EVIDENCE_PATH = 'evidence/nostr/live-demo.json';

/** The ONE loader every caller (browser, verify:live-demo, verify:submission) uses to turn the canonical evidence file into a real SubmissionBundle. */
export function loadCanonicalLiveDemoBundle(): SubmissionBundle {
  return submissionBundleFromJson(JSON.stringify(liveDemoEvidenceFile.bundle));
}

export interface CanonicalLiveDemoVerification extends SubmissionVerification {
  evidenceSource: string;
  publishedAt: string;
  token: string;
  bundle: SubmissionBundle;
}

/**
 * THE canonical Live Public Demo verification. Loads the one canonical
 * bundle above and runs it through the exact same verifySubmission()
 * pipeline every other path uses — no duplicated evaluation logic. Callers
 * only ever inject relay/chain-state/delay functions for deterministic
 * testing (see src/cli/attacks.ts's A25 pattern); the browser and the real
 * CLI scripts always use the real defaults.
 */
export async function verifyCanonicalLiveDemo(
  relayFetchFn?: RelayFetchFn,
  chainStateFetchFn?: ChainStateFetchFn,
  delayFn?: DelayFn,
): Promise<CanonicalLiveDemoVerification> {
  const bundle = loadCanonicalLiveDemoBundle();
  const verification = await verifySubmission(bundle, relayFetchFn, chainStateFetchFn, delayFn);
  return { ...verification, evidenceSource: CANONICAL_LIVE_DEMO_EVIDENCE_PATH, publishedAt: liveDemoEvidenceFile.publishedAt, token: liveDemoEvidenceFile.token, bundle };
}
