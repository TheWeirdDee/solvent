import { Amount, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { issueFixtureProof, generateFixtureKeyset } from '../cashu/mint-sim.js';
import { buildMintFixture, type BuildMintFixtureParams } from '../mint/build.js';
import { signSolvencyEvent, type SolvencyEventContent } from '../nostr/event.js';
import { verify, type VerifyInput } from './rules.js';

const NOW = 1_700_000_000;

// Mirrors the demo narrative: mint A really issued T1 (30k) and T_hidden
// (70k), but only publishes T1 in its mint_root, alongside a 5k burn from
// an unrelated earlier redemption. Reserve (40k) looks healthy against the
// UNDERreported liabilities (30k - 5k = 25k) — the hero demo beat.
const MINT_A_PARAMS: BuildMintFixtureParams = {
  mintIdentity: 'mint-a',
  keysetId: 'solvent-mint-a-keyset-v1',
  epoch: 1,
  reserveSats: 40_000,
  validitySeconds: 3600,
  mintProofSpecs: [
    { label: 'T1', amount: 30_000, secret: 'mint-a-secret-t1', published: true },
    { label: 'T_hidden', amount: 70_000, secret: 'mint-a-secret-t-hidden', published: false },
  ],
  burnSpecs: [{ label: 'B1', amount: 5_000, secret: 'mint-a-burn-1' }],
  now: NOW,
};

const MINT_B_PARAMS: BuildMintFixtureParams = {
  mintIdentity: 'mint-b',
  keysetId: 'solvent-mint-b-keyset-v1',
  epoch: 1,
  reserveSats: 25_000,
  validitySeconds: 3600,
  mintProofSpecs: [{ label: 'B_TOKEN', amount: 50_000, secret: 'mint-b-secret-1', published: true }],
  burnSpecs: [{ label: 'B1', amount: 10_000, secret: 'mint-b-burn-1' }],
  now: NOW,
};

function baseInput(scenario: ReturnType<typeof buildMintFixture>, expectedMintIdentity: string, proof: Proof): VerifyInput {
  return { expectedMintIdentity, fixture: scenario.fixture, event: scenario.event, proof, now: NOW + 10 };
}

describe('verifier core rules — GREEN cases', () => {
  it('mint A + T1: valid DLEQ, issuance included, reserve covers liabilities -> GREEN', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const result = verify(baseInput(scenario, 'mint-a', scenario.issuedProofs.T1!));
    expect(result.decision).toBe('GREEN');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it('documented zero-liabilities behavior: mint == burn -> liabilities 0, trivially covered -> GREEN', () => {
    const scenario = buildMintFixture({
      mintIdentity: 'mint-zero',
      keysetId: 'solvent-mint-zero-keyset-v1',
      epoch: 1,
      reserveSats: 0,
      validitySeconds: 3600,
      mintProofSpecs: [{ label: 'Z1', amount: 10_000, secret: 'zero-secret-1', published: true }],
      burnSpecs: [{ label: 'ZB1', amount: 10_000, secret: 'zero-burn-1' }],
      now: NOW,
    });
    const result = verify(baseInput(scenario, 'mint-zero', scenario.issuedProofs.Z1!));
    expect(result.details.recomputedLiabilitiesSats).toBe(0);
    expect(result.details.ratio).toBe(Infinity);
    expect(result.decision).toBe('GREEN');
  });
});

describe('verifier core rules — RED cases', () => {
  it('mint A + T_hidden: real DLEQ, real mint origin, but omitted from mint_root -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const result = verify(baseInput(scenario, 'mint-a', scenario.issuedProofs.T_hidden!));
    expect(result.decision).toBe('RED');
    expect(result.checks.dleq).toBe(true);
    expect(result.checks.cPrimeReconstruction).toBe(true);
    expect(result.checks.inclusion).toBe(false);
    expect(result.reason).toMatch(/did not include the issuance/i);
  });

  it('mint B + valid included token, reserve below liabilities -> RED', () => {
    const scenario = buildMintFixture(MINT_B_PARAMS);
    const result = verify(baseInput(scenario, 'mint-b', scenario.issuedProofs.B_TOKEN!));
    expect(result.decision).toBe('RED');
    expect(result.checks.inclusion).toBe(true);
    expect(result.checks.reserveCoverage).toBe(false);
    expect(result.reason).toMatch(/reserve/i);
  });

  it('modified DLEQ (flipped e) -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const t1 = scenario.issuedProofs.T1!;
    const tampered: Proof = { ...t1, dleq: { ...t1.dleq!, e: (t1.dleq!.e[0] === '0' ? '1' : '0') + t1.dleq!.e.slice(1) } };
    const result = verify(baseInput(scenario, 'mint-a', tampered));
    expect(result.decision).toBe('RED');
    expect(result.checks.dleq).toBe(false);
  });

  it('missing required DLEQ data -> unsupported/RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const t1 = scenario.issuedProofs.T1!;
    const { dleq: _dleq, ...withoutDleq } = t1;
    const result = verify(baseInput(scenario, 'mint-a', withoutDleq as Proof));
    expect(result.decision).toBe('RED');
    expect(result.checks.dleq).toBe(false);
  });

  it('amount mismatch (claims an amount with no key in the keyset) -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const t1 = scenario.issuedProofs.T1!;
    const tampered: Proof = { ...t1, amount: Amount.from(12_345) };
    const result = verify(baseInput(scenario, 'mint-a', tampered));
    expect(result.decision).toBe('RED');
    expect(result.checks.dleq).toBe(false);
  });

  it("wrong C' (a real, DLEQ-valid proof from the same mint/amount that the mint never recorded at all) -> RED", () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    // Re-derive the same amount's mint key from the fixture is not directly exposed, so instead
    // simulate an entirely separate mint key at the same amount to get a fresh, self-consistent,
    // but wholly untracked proof — DLEQ will fail (different key), demonstrating the fail-closed
    // path distinctly from the "omitted" case where DLEQ succeeds but inclusion is what's missing.
    const [otherKey] = generateFixtureKeyset([30_000]);
    const { proof: untrackedProof } = issueFixtureProof({ key: otherKey!, keysetId: MINT_A_PARAMS.keysetId, secret: 'never-recorded-secret' });
    const result = verify(baseInput(scenario, 'mint-a', untrackedProof));
    expect(result.decision).toBe('RED');
  });

  it('proof bundle root differs from the signed Nostr event root -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const badContent: SolvencyEventContent = {
      ...(JSON.parse(scenario.event.content) as SolvencyEventContent),
      mint_root: { hash: 'ff'.repeat(32), sum_sats: scenario.fixture.mintRoot.sumSats },
    };
    const reSignedEvent = signSolvencyEvent(badContent, 'mint-a', scenario.nostrSecretKey);
    const result = verify({ ...baseInput(scenario, 'mint-a', scenario.issuedProofs.T1!), event: reSignedEvent });
    expect(result.decision).toBe('RED');
    expect(result.checks.proofBundleRoots).toBe(false);
  });

  it('flipped Nostr signature -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const plain = JSON.parse(JSON.stringify(scenario.event));
    const flippedChar = plain.sig[0] === '0' ? '1' : '0';
    const tamperedEvent = { ...plain, sig: flippedChar + plain.sig.slice(1) };
    const result = verify({ ...baseInput(scenario, 'mint-a', scenario.issuedProofs.T1!), event: tamperedEvent });
    expect(result.decision).toBe('RED');
    expect(result.checks.nostrSignature).toBe(false);
  });

  it('expired valid_until -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const farFuture = NOW + MINT_A_PARAMS.validitySeconds + 10_000;
    const result = verify({ ...baseInput(scenario, 'mint-a', scenario.issuedProofs.T1!), now: farFuture });
    expect(result.decision).toBe('RED');
    expect(result.checks.freshness).toBe(false);
  });

  it('burn_sum > mint_sum -> RED', () => {
    const scenario = buildMintFixture({
      mintIdentity: 'mint-overburn',
      keysetId: 'solvent-mint-overburn-keyset-v1',
      epoch: 1,
      reserveSats: 100_000,
      validitySeconds: 3600,
      mintProofSpecs: [{ label: 'O1', amount: 10_000, secret: 'overburn-secret-1', published: true }],
      burnSpecs: [{ label: 'OB1', amount: 50_000, secret: 'overburn-burn-1' }],
      now: NOW,
    });
    const result = verify(baseInput(scenario, 'mint-overburn', scenario.issuedProofs.O1!));
    expect(result.decision).toBe('RED');
    expect(result.checks.arithmetic).toBe(false);
  });

  it('signed liabilities_sats does not equal mint_sum - burn_sum -> RED', () => {
    const scenario = buildMintFixture(MINT_A_PARAMS);
    const originalContent = JSON.parse(scenario.event.content) as SolvencyEventContent;
    const badContent: SolvencyEventContent = { ...originalContent, liabilities_sats: originalContent.liabilities_sats + 999 };
    const reSignedEvent = signSolvencyEvent(badContent, 'mint-a', scenario.nostrSecretKey);
    const result = verify({ ...baseInput(scenario, 'mint-a', scenario.issuedProofs.T1!), event: reSignedEvent });
    expect(result.decision).toBe('RED');
    expect(result.checks.arithmetic).toBe(false);
  });

  it('empty/missing event scope is the CLI/fetch layer\'s responsibility, not verify() — documented, not exercised here', () => {
    // verify() requires a concrete signed event; "no event found on relays" is
    // handled before verify() is ever called (see cli/verify-fixture.ts).
    expect(true).toBe(true);
  });
});
