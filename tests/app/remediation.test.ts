// @vitest-environment jsdom
//
// The September 30 audit remediation, unit level: exactly-once acceptance with
// a persisted store, the three result classes, broken-promise wording, doc
// links, and the submission-materials checks.
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptanceStoreSize, acceptedRecord, enforce } from '../../src/app/acceptance-store.js';
import { decisionFacts, resultClass } from '../../src/app/decision-view.js';
import { resolveDocLink } from '../../src/app/markdown.js';
import type { NostrLiveStatus, ReserveLiveStatus } from '../../src/app/submission.js';
import { checkSubmissionMaterials, DEMO_VIDEO_PENDING } from '../../src/cli/submission-materials.js';
import { verify, type VerifyResult } from '../../src/verifier/verify.js';
import { verifyInputFixture } from '../fixtures/verify-input.js';

beforeEach(() => localStorage.clear());

describe('acceptance store: the real Gate 4 side effect, exactly once', () => {
  it('ACCEPT calls the accept function once and stores a record', () => {
    const input = verifyInputFixture();
    const o = enforce(input);
    expect(o).toMatchObject({ decision: 'ACCEPT', callsThisRun: 1, totalCalls: 1, recordStored: true, storeSizeBefore: 0, storeSizeAfter: 1, alreadyAccepted: false });
    expect(acceptedRecord(input.proof)?.encodedToken).toMatch(/^cashu/);
  });

  it('retrying an accepted issuance never calls accept again (and survives a reload: the store is persisted)', () => {
    const input = verifyInputFixture();
    enforce(input);
    const again = enforce(input);
    expect(again).toMatchObject({ decision: 'ACCEPT', callsThisRun: 0, totalCalls: 1, alreadyAccepted: true, storeSizeBefore: 1, storeSizeAfter: 1 });
    expect(JSON.parse(localStorage.getItem('solvent.acceptance.v1')!)).toHaveLength(1);
  });

  it('REFUSE calls nothing and leaves the store unchanged', () => {
    enforce(verifyInputFixture());
    const refused = enforce(verifyInputFixture({ includeInEpoch: false }));
    expect(refused).toMatchObject({ decision: 'REFUSE', reasonCode: 'REFUSE_ISSUANCE_OMITTED', callsThisRun: 0, totalCalls: 0, recordStored: false, storeSizeBefore: 1, storeSizeAfter: 1 });
    expect(acceptanceStoreSize()).toBe(1);
  });
});

const reserveOk: ReserveLiveStatus = { supplied: true, queried: true, queryOk: true, verified: true, verifiedReserveSats: 1_000_000, outstandingBalance: 64, detail: '' };
const nostrOk: NostrLiveStatus = { supplied: true, relayReachable: true, eventFetched: true, providedCopyValid: true, publicationVerified: true, signatureValid: true, freshnessValid: true, bindingValid: true, verified: true, detail: '', retrievalPath: 'direct' };
const refuse = (reasonCode: VerifyResult['reasonCode']): VerifyResult => ({ ...verify(verifyInputFixture({ includeInEpoch: false })), reasonCode, decision: 'REFUSE' });

describe('result classes', () => {
  it('separates availability from proven refusal', () => {
    expect(resultClass(verify(verifyInputFixture()), reserveOk, nostrOk)).toBe('accept');
    expect(resultClass(refuse('REFUSE_NOSTR_UNAVAILABLE'), reserveOk, { ...nostrOk, relayReachable: false })).toBe('availability');
    expect(resultClass(refuse('REFUSE_NOSTR_EVENT_NOT_FOUND'), reserveOk, nostrOk)).toBe('availability');
    expect(resultClass(refuse('REFUSE_UNVERIFIABLE'), { ...reserveOk, queryOk: false }, nostrOk)).toBe('availability');
    expect(resultClass(refuse('REFUSE_ISSUANCE_OMITTED'), reserveOk, nostrOk)).toBe('refusal');
    expect(resultClass(refuse('REFUSE_RESERVE_SHORT'), reserveOk, nostrOk)).toBe('refusal');
  });

  it('a broken promise reads as valid cryptography with the promised issuance missing', () => {
    const r = verify(verifyInputFixture({ includeInEpoch: false }));
    const facts = Object.fromEntries(decisionFacts(r, reserveOk, nostrOk).map((f) => [f.label, f.value]));
    expect(facts['Receipt signature']).toBe('VALID');
    expect(facts['Epoch manifest']).toMatch(/^VALID/);
    expect(facts['Public Nostr retrieval']).toMatch(/RETRIEVED/);
    expect(facts['Live reserve']).toMatch(/COVERED/);
    expect(facts['Promised issuance']).toMatch(/MISSING/);
    expect(facts['Reason code']).toBe('REFUSE_ISSUANCE_OMITTED');
    expect(Object.values(facts).join(' ')).not.toMatch(/FAILED — Liability inclusion/);
  });
});

describe('doc links', () => {
  const ctx = { basePath: 'docs/start-here.md', docIdForPath: (p: string) => (p === 'docs/trust-boundaries.md' ? 'trust-boundaries' : null) };
  it('routes rendered docs in-app, opens source on GitHub, keeps external links external', () => {
    expect(resolveDocLink('trust-boundaries.md', ctx)).toEqual({ href: '#/docs?doc=trust-boundaries', external: false });
    expect(resolveDocLink('../src/verifier/verify.ts#L10', ctx)).toEqual({ href: 'https://github.com/TheWeirdDee/solvent/blob/main/src/verifier/verify.ts#L10', external: true });
    expect(resolveDocLink('../deploy', ctx)).toEqual({ href: 'https://github.com/TheWeirdDee/solvent/tree/main/deploy', external: true });
    expect(resolveDocLink('https://njump.me/x', ctx)).toEqual({ href: 'https://njump.me/x', external: true });
    expect(resolveDocLink('#/mint', ctx)).toEqual({ href: '#/mint', external: false });
  });
});

describe('submission materials', () => {
  const good = `# X\n**Team:** [a](https://github.com/a)\n**Demo video:** https://youtu.be/abc\n\nhttps://solvent-ashen.vercel.app/\n\n## Demo\n[doc](docs/a.md) [route](#/docs?doc=start-here)\n`;
  const check = (readme: string, extra: Record<string, string> = {}) =>
    checkSubmissionMaterials({ 'README.md': readme, ...extra }, (p) => p === 'docs/a.md', (id) => id === 'start-here');
  const byLabel = (lines: ReturnType<typeof check>) => Object.fromEntries(lines.map((l) => [l.label, l]));

  it('everything present -> all pass', () => {
    expect(check(good).every((l) => l.ok)).toBe(true);
  });

  it('a pending demo video blocks the submission, not the engineering', () => {
    const l = byLabel(check(good.replace('https://youtu.be/abc', DEMO_VIDEO_PENDING)))['README: demo video URL']!;
    expect(l).toMatchObject({ ok: false, kind: 'submission' });
  });

  it('a placeholder team is reported', () => {
    expect(byLabel(check(good.replace('[a](https://github.com/a)', '_(add your name(s) here)_')))['README: team']!.ok).toBe(false);
  });

  it('obsolete claims and broken links fail engineering', () => {
    const lines = byLabel(check(good + '\nThe real CDK mint is not the backend behind this web page.\n[x](docs/missing.md) [y](#/docs?doc=nope)\n'));
    expect(lines['No obsolete deployment/integration claims']).toMatchObject({ ok: false, kind: 'engineering' });
    expect(lines['Internal links resolve']!.extra).toMatch(/docs\/missing\.md/);
    expect(lines['Internal links resolve']!.extra).toMatch(/doc=nope/);
  });
});
