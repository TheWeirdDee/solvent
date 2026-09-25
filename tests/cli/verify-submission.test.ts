// Tests for the submission verifier's own fail-closed logic
// (src/cli/verify-submission-core.ts). The core re-derives Gate 0-6
// mechanism checks with real cryptography on every call (no mocking of
// verify()/evaluatePolEvidence()/evaluateReserveAttestation()); what's
// injected here is only the externally-observed evidence status
// (attack corpus count, live Nostr/reserve evidence) that the pure core
// cannot determine on its own.
import { describe, expect, it } from 'vitest';
import { runSubmissionChecks, type ExternalEvidenceStatus } from '../../src/cli/verify-submission-core.js';

const FULL_EXTERNAL: ExternalEvidenceStatus = {
  attackCorpus: { passed: 25, total: 25, expectedTotal: 25 },
  nostrLiveEvidencePass: true,
  reserveLiveVerified: true,
  canonicalLiveDemo: { ok: true, reasonCode: 'ACCEPT_VERIFIED', detail: 'ACCEPT_VERIFIED' },
};

// Every test here calls runSubmissionChecks(), which synchronously
// re-derives Gate 0-6 with real cryptography (fresh random keys and
// secrets each call). It has no network, filesystem, process, clock-race
// or module-level-state dependency. Measured over 300 back-to-back calls in
// one otherwise-idle process: 0 logic failures, p50 ~1.0s, p95 ~2.0s, max
// ~5.2s. That max already exceeds Vitest's 5s default before the full
// suite's parallel workers add CPU contention, which is what made this file
// fail intermittently. The fix is an explicit per-call budget, not weaker
// assertions.
const PER_CALL_TIMEOUT_MS = 15_000;

describe('verify-submission-core — runSubmissionChecks', { timeout: PER_CALL_TIMEOUT_MS }, () => {
  it('is ready (failures=0, exit-code-worthy 0) when every required item is real and passing', () => {
    const { failures, ready, lines } = runSubmissionChecks(FULL_EXTERNAL);
    expect(failures).toBe(0);
    expect(ready).toBe(true);
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it('re-derives Gate 0-6 mechanism checks with real cryptography, not stubs (all PASS independent of the external status)', () => {
    const { lines } = runSubmissionChecks(FULL_EXTERNAL);
    const mechanismLabels = ['Gate 0 reconstruction', 'DLEQ', 'Honest inclusion', 'Hero omission', 'Short reserve', 'Gate 4 (enforcement)', 'Gate 5 (Nostr mechanism)', 'Gate 6 (reserve mechanism)'];
    for (const label of mechanismLabels) {
      const line = lines.find((l) => l.label === label);
      expect(line, `expected a line for ${label}`).toBeDefined();
      expect(line!.ok).toBe(true);
    }
  });

  it('is NOT ready when the attack corpus is incomplete (breaking one required artifact must flip the result)', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, attackCorpus: { passed: 24, total: 25, expectedTotal: 25 } };
    const { failures, ready } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    expect(failures).toBeGreaterThanOrEqual(1);
  });

  it('is NOT ready when the attack corpus could not be determined at all', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, attackCorpus: null };
    const { ready, lines } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    const line = lines.find((l) => l.label === 'Attack corpus');
    expect(line!.ok).toBe(false);
  });

  it('is NOT ready when live Nostr relay evidence is missing (no evidence/nostr/cases.json)', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, nostrLiveEvidencePass: null };
    const { ready, lines } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    const line = lines.find((l) => l.label === 'Gate 5 (live relay evidence, historical)');
    expect(line!.ok).toBe(false);
  });

  it('is NOT ready when live Nostr relay evidence exists but reports failure', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, nostrLiveEvidencePass: false };
    const { ready } = runSubmissionChecks(external);
    expect(ready).toBe(false);
  });

  it('is NOT ready when the live Signet reserve is not yet verified (the current, honestly-disclosed Gate 6 blocker)', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, reserveLiveVerified: false };
    const { ready, lines } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    const line = lines.find((l) => l.label === 'Gate 6 (live Signet UTXO, historical)');
    expect(line!.ok).toBe(false);
    expect(line!.extra).toMatch(/blocked pending funding/);
  });

  it('is NOT ready when the live Signet reserve evidence file is simply missing', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, reserveLiveVerified: null };
    const { ready } = runSubmissionChecks(external);
    expect(ready).toBe(false);
  });

  it('is NOT ready when the canonical Live Public Demo itself is stale/unreachable/mismatched — this is the fix for "verify:submission could report READY while the actual browser demo is broken"', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, canonicalLiveDemo: { ok: false, reasonCode: 'REFUSE_RESERVE_ATTESTATION_INVALID', detail: 'stale' } };
    const { ready, lines } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    const line = lines.find((l) => l.label === 'Canonical Live Public Demo');
    expect(line!.ok).toBe(false);
    expect(line!.extra).toContain('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('is NOT ready when the canonical Live Public Demo could not be determined at all (e.g. the check itself crashed)', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, canonicalLiveDemo: null };
    const { ready, lines } = runSubmissionChecks(external);
    expect(ready).toBe(false);
    const line = lines.find((l) => l.label === 'Canonical Live Public Demo');
    expect(line!.ok).toBe(false);
  });

  it('historical Gate 5/6 evidence passing does NOT substitute for the canonical Live Public Demo — both are independently required', () => {
    const external: ExternalEvidenceStatus = { ...FULL_EXTERNAL, nostrLiveEvidencePass: true, reserveLiveVerified: true, canonicalLiveDemo: { ok: false, reasonCode: 'REFUSE_NOSTR_EVENT_NOT_FOUND', detail: 'not found' } };
    const { ready } = runSubmissionChecks(external);
    expect(ready).toBe(false);
  });

  it('never reports SUBMISSION READY while any single required line is failing (exhaustive single-break sweep)', () => {
    const variants: Partial<ExternalEvidenceStatus>[] = [
      { attackCorpus: { passed: 0, total: 25, expectedTotal: 25 } },
      { nostrLiveEvidencePass: false },
      { reserveLiveVerified: false },
      { canonicalLiveDemo: { ok: false, reasonCode: 'REFUSE_NOSTR_UNAVAILABLE', detail: 'unreachable' } },
    ];
    for (const variant of variants) {
      const { ready } = runSubmissionChecks({ ...FULL_EXTERNAL, ...variant });
      expect(ready, `expected NOT ready for variant ${JSON.stringify(variant)}`).toBe(false);
    }
  }, 4 * PER_CALL_TIMEOUT_MS); // four runSubmissionChecks() calls; the old 20s was below 4 x the measured 5.2s max
});
