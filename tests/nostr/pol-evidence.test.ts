// Gate 5 — pure evaluation of fetched Nostr evidence events (checks 14-17
// of the PRD's decision rule): signature validity, freshness, conflicting
// state, and digest binding to the decision actually being made. Real
// BIP-340 signing via nostr-tools' finalizeEvent; no live relay needed
// here — network I/O lives in fetchPolEvidence/publishPolEvidence and is
// exercised for real by src/cli/gate5.ts.
import { generateSecretKey, type NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { buildPolEvidenceContent, signPolEvidenceEvent, type PolEvidenceContent } from '../../src/nostr/pol-event.js';
import { evaluatePolEvidence, type NostrEvidenceExpectation } from '../../src/nostr/pol-evidence.js';

const MINT_IDENTITY = 'a'.repeat(64);
const EPOCH = 12;
const NOW = 1_800_000_000;

function buildAndSign(overrides: Partial<Parameters<typeof buildPolEvidenceContent>[0]> = {}, signerKey = generateSecretKey()): { event: NostrEvent; content: PolEvidenceContent } {
  const content = buildPolEvidenceContent({
    mint: 'solvent-fixture-mint',
    mintIdentityHex: MINT_IDENTITY,
    keysetId: 'keyset-1',
    epochIndex: EPOCH,
    manifestDigestHex: 'b'.repeat(64),
    manifestSignature: 'c'.repeat(128),
    globalDigestHex: 'd'.repeat(64),
    issuedMmrRootHash: 'e'.repeat(64),
    issuedMmrRootSum: 30_000,
    spentMmrRootHash: 'f'.repeat(64),
    spentMmrRootSum: 5_000,
    outstandingBalance: 25_000,
    reserveDigestHex: '1'.repeat(64),
    reserveSats: 200_000,
    reserveNetwork: 'bitcoin-signet',
    validitySeconds: 3600,
    proofUri: 'local://evidence/gate-5',
    now: NOW,
    ...overrides,
  });
  return { event: signPolEvidenceEvent(content, signerKey), content };
}

function expectation(overrides: Partial<NostrEvidenceExpectation> = {}): NostrEvidenceExpectation {
  return {
    mintIdentityHex: MINT_IDENTITY,
    epochIndex: EPOCH,
    manifestDigestHex: 'b'.repeat(64),
    globalDigestHex: 'd'.repeat(64),
    reserveDigestHex: '1'.repeat(64),
    nowSeconds: NOW + 60,
    ...overrides,
  };
}

describe('Gate 5 — evaluatePolEvidence', () => {
  it('verifies when the fetched event is validly signed, fresh, and matches the decision digests', () => {
    const { event } = buildAndSign();
    const result = evaluatePolEvidence([event], expectation());
    expect(result.verified).toBe(true);
    expect(result.reasonCode).toBeUndefined();
  });

  it('REFUSE_NOSTR_UNAVAILABLE when no relay returned any matching event', () => {
    const result = evaluatePolEvidence([], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
  });

  it('REFUSE_NOSTR_SIGNATURE when the event content is tampered after signing', () => {
    const { event } = buildAndSign();
    const tampered: NostrEvent = { ...event, content: event.content.replace('30000', '99999') };
    const result = evaluatePolEvidence([tampered], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_SIGNATURE');
  });

  it('REFUSE_NOSTR_SIGNATURE when the signature bytes are corrupted', () => {
    const { event } = buildAndSign();
    const tampered: NostrEvent = { ...event, sig: '00'.repeat(64) };
    const result = evaluatePolEvidence([tampered], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_SIGNATURE');
  });

  it('REFUSE_NOSTR_STALE when now is past valid_until', () => {
    const { event } = buildAndSign({ validitySeconds: 10 });
    const result = evaluatePolEvidence([event], expectation({ nowSeconds: NOW + 3600 }));
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_STALE');
  });

  it('REFUSE_NOSTR_STATE_MISMATCH when the event commits a different manifest digest than the decision used', () => {
    const { event } = buildAndSign({ manifestDigestHex: 'ff'.repeat(32) });
    const result = evaluatePolEvidence([event], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('REFUSE_NOSTR_STATE_MISMATCH when the event commits a different reserve digest than the decision used', () => {
    const { event } = buildAndSign({ reserveDigestHex: 'ff'.repeat(32) });
    const result = evaluatePolEvidence([event], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_STATE_MISMATCH');
  });

  it('REFUSE_NOSTR_CONFLICT when two distinct validly-signed states exist for the same identity/epoch', () => {
    const a = buildAndSign();
    const b = buildAndSign({ manifestDigestHex: 'ee'.repeat(32) });
    const result = evaluatePolEvidence([a.event, b.event], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_CONFLICT');
  });

  it('does not flag a conflict when the same event is delivered twice (e.g. by two relays)', () => {
    const { event } = buildAndSign();
    const result = evaluatePolEvidence([event, { ...event }], expectation());
    expect(result.verified).toBe(true);
  });

  it('tolerates one relay contributing nothing as long as the other has valid matching evidence (A17)', () => {
    // Simulates: relay A returned nothing, relay B returned the real event.
    // fetchPolEvidence merges results from every relay into one array, so a
    // single relay's contribution is enough once merged.
    const { event } = buildAndSign();
    const mergedFromOneLiveRelay = [event];
    const result = evaluatePolEvidence(mergedFromOneLiveRelay, expectation());
    expect(result.verified).toBe(true);
  });

  it('ignores an event for a different mint identity when computing conflicts, even if a relay returned it', () => {
    // A relay's tag-filtered query result is never trusted as-is: an event
    // for an unrelated mint identity, even with a wildly different digest,
    // must not be able to manufacture a false REFUSE_NOSTR_CONFLICT.
    const { event } = buildAndSign();
    const unrelated = buildAndSign({ mintIdentityHex: 'z'.repeat(64), manifestDigestHex: 'ee'.repeat(32) }).event;
    const result = evaluatePolEvidence([event, unrelated], expectation());
    expect(result.verified).toBe(true);
  });

  it('ignores an event for a different epoch when computing conflicts, even if a relay returned it', () => {
    const { event } = buildAndSign();
    const otherEpoch = buildAndSign({ epochIndex: EPOCH + 1, manifestDigestHex: 'ee'.repeat(32) }).event;
    const result = evaluatePolEvidence([event, otherEpoch], expectation());
    expect(result.verified).toBe(true);
  });

  it('REFUSE_NOSTR_UNAVAILABLE when every fetched event is for a different identity/epoch than expected', () => {
    const unrelated = buildAndSign({ mintIdentityHex: 'z'.repeat(64) }).event;
    const result = evaluatePolEvidence([unrelated], expectation());
    expect(result.verified).toBe(false);
    expect(result.reasonCode).toBe('REFUSE_NOSTR_UNAVAILABLE');
  });
});
