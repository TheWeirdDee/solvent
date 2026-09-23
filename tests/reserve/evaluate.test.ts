// Gate 6 — pure evaluation of the reserve attestation decision (checks
// 11-13). Real Taproot key generation and real BIP-340 Schnorr signing
// throughout; chain state is injected so every adversarial case is
// deterministic and needs no live network call — see
// src/cli/gate6.ts for the real end-to-end (address + live esplora query)
// exercise.
import { createRandomSecretKey, getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../../src/cashu/keys.js';
import { evaluateReserveAttestation, maxAttestationAgeBlocks, RESERVE_FRESHNESS_POLICY, type ChainStateEntry, type ReserveAttestation, type ReserveFreshnessPolicy } from '../../src/reserve/evaluate.js';
import { generateSignetReserveKey } from '../../src/reserve/taproot.js';
import { reserveStatementDigestHex, signReserveBinding, signReserveStatement, type ReserveStatement } from '../../src/reserve/statement.js';

const OUTSTANDING_BALANCE = 70_000;
const TIP_HEIGHT = 500_000;

function buildAttestation(overrides: Partial<ReserveStatement> = {}, opts: { badStatementSig?: boolean; badBindingSig?: boolean } = {}) {
  const reserveKey = generateSignetReserveKey();
  const masterPriv = createRandomSecretKey();
  const masterPrivHex = bytesToHex(masterPriv);
  const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));

  const statement: ReserveStatement = {
    network: 'bitcoin-signet-mutinynet',
    reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
    outpoints: [{ txid: 'a'.repeat(64), vout: 0, value_sats: 80_000, script_pubkey_hex: reserveKey.scriptPubKeyHex }],
    timestamp: '2026-09-21T00:00:00Z',
    block_height: TIP_HEIGHT - 10,
    ...overrides,
  };
  const statementSignature = opts.badStatementSig ? '00'.repeat(64) : signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
  const digest = reserveStatementDigestHex(statement);
  const bindingSignature = opts.badBindingSig ? '11'.repeat(64) : signReserveBinding(statement.reserve_pubkey, digest, masterPrivHex);

  const attestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: masterPubHex };
  const honestChainState = new Map<string, ChainStateEntry>([
    ['a'.repeat(64) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
  ]);
  return { attestation, honestChainState, reserveKey };
}

describe('Gate 6 — evaluateReserveAttestation', () => {
  it('ACCEPT (verified) when signatures, chain state, and coverage all check out', () => {
    const { attestation, honestChainState } = buildAttestation();
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.verified).toBe(true);
    expect(result.verifiedReserveSats).toBe(80_000);
  });

  it('REFUSE_RESERVE_ATTESTATION_INVALID — malformed statement (no outpoints)', () => {
    const { attestation, honestChainState } = buildAttestation({ outpoints: [] });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('REFUSE_RESERVE_ATTESTATION_INVALID — reserve key signature forged/invalid', () => {
    const { attestation, honestChainState } = buildAttestation({}, { badStatementSig: true });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('REFUSE_RESERVE_ATTESTATION_INVALID — wrong owner/binding: master key did not actually sign this reserve key', () => {
    const { attestation, honestChainState } = buildAttestation({}, { badBindingSig: true });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
  });

  it('REFUSE_RESERVE_ATTESTATION_INVALID — stale evidence (block_height far behind current tip, well past the network-aware ~1 week budget)', () => {
    // Default statement network is bitcoin-signet-mutinynet (~30.5s blocks),
    // whose real ~1 week budget is ~19,830 blocks (see the network-aware
    // policy tests below) — 2000 blocks would no longer be stale under the
    // correct policy, so this uses a margin comfortably past that budget.
    const { attestation, honestChainState } = buildAttestation({ block_height: TIP_HEIGHT - 25_000 });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    expect(result.detail).toMatch(/stale/i);
  });

  it('REFUSE_RESERVE_STATE_MISMATCH — wrong UTXO: declared outpoint does not exist on chain', () => {
    const { attestation } = buildAttestation();
    const emptyChainState = new Map<string, ChainStateEntry>();
    const result = evaluateReserveAttestation(attestation, emptyChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('REFUSE_RESERVE_STATE_MISMATCH — amount mismatch: on-chain value differs from declared statement', () => {
    const { attestation, reserveKey } = buildAttestation();
    const wrongValueChainState = new Map<string, ChainStateEntry>([
      ['a'.repeat(64) + ':0', { exists: true, confirmed: true, value: 1_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
    ]);
    const result = evaluateReserveAttestation(attestation, wrongValueChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('REFUSE_RESERVE_STATE_MISMATCH — script mismatch: on-chain scriptPubKey differs from declared statement', () => {
    const { attestation } = buildAttestation();
    const wrongScriptChainState = new Map<string, ChainStateEntry>([
      ['a'.repeat(64) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: '51' + '00'.repeat(32), spent: false }],
    ]);
    const result = evaluateReserveAttestation(attestation, wrongScriptChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_STATE_MISMATCH');
  });

  it('REFUSE_RESERVE_UTXO_SPENT — declared outpoint has been spent since attestation', () => {
    const { attestation, reserveKey } = buildAttestation();
    const spentChainState = new Map<string, ChainStateEntry>([
      ['a'.repeat(64) + ':0', { exists: true, confirmed: true, value: 80_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: true }],
    ]);
    const result = evaluateReserveAttestation(attestation, spentChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_UTXO_SPENT');
  });

  it('REFUSE_RESERVE_SHORT — reserve is fully verified but below outstanding liabilities', () => {
    const { attestation, honestChainState } = buildAttestation();
    const result = evaluateReserveAttestation(attestation, honestChainState, 999_999, TIP_HEIGHT);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_SHORT');
    expect(result.verifiedReserveSats).toBe(80_000);
  });

  it('sums multiple valid outpoints toward verifiedReserveSats', () => {
    const reserveKey = generateSignetReserveKey();
    const masterPriv = createRandomSecretKey();
    const masterPrivHex = bytesToHex(masterPriv);
    const masterPubHex = bytesToHex(getPubKeyFromPrivKey(masterPriv));
    const statement: ReserveStatement = {
      network: 'bitcoin-signet-mutinynet',
      reserve_pubkey: reserveKey.outputPublicKeyXOnlyHex,
      outpoints: [
        { txid: 'a'.repeat(64), vout: 0, value_sats: 50_000, script_pubkey_hex: reserveKey.scriptPubKeyHex },
        { txid: 'b'.repeat(64), vout: 1, value_sats: 30_000, script_pubkey_hex: reserveKey.scriptPubKeyHex },
      ],
      timestamp: '2026-09-21T00:00:00Z',
      block_height: TIP_HEIGHT - 5,
    };
    const statementSignature = signReserveStatement(statement, reserveKey.tweakedPrivateKeyHex);
    const digest = reserveStatementDigestHex(statement);
    const bindingSignature = signReserveBinding(statement.reserve_pubkey, digest, masterPrivHex);
    const attestation: ReserveAttestation = { statement, statementSignature, bindingSignature, masterPublicKeyHex: masterPubHex };
    const chainState = new Map<string, ChainStateEntry>([
      ['a'.repeat(64) + ':0', { exists: true, confirmed: true, value: 50_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
      ['b'.repeat(64) + ':1', { exists: true, confirmed: true, value: 30_000, scriptPubKeyHex: reserveKey.scriptPubKeyHex, spent: false }],
    ]);
    const result = evaluateReserveAttestation(attestation, chainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.verified).toBe(true);
    expect(result.verifiedReserveSats).toBe(80_000);
  });
});

describe('Gate 6 — network-aware reserve freshness policy (maxAttestationAgeBlocks)', () => {
  it('1008 blocks is the mainnet/default-signet budget for the real ~1 week target (7 days * 144 blocks/day at ~10min blocks)', () => {
    expect(maxAttestationAgeBlocks('bitcoin-mainnet')).toBe(1008);
    expect(maxAttestationAgeBlocks('bitcoin-signet')).toBe(1008);
  });

  it('Mutinynet gets a much larger block budget than mainnet, so the real wall-clock freshness target stays ~1 week despite ~30.5s blocks instead of ~600s', () => {
    const mutinynetBudget = maxAttestationAgeBlocks('bitcoin-signet-mutinynet');
    const mainnetBudget = maxAttestationAgeBlocks('bitcoin-mainnet');
    expect(mutinynetBudget).toBeGreaterThan(mainnetBudget * 15); // ~600/30.5 ≈ 19.7x
    // The actual real-world bug this fixes: the flat old constant (1008) enforced only ~8.5h on Mutinynet; a correct network-aware budget must clear a full week of Mutinynet blocks.
    const blocksPerWeekOnMutinynet = (7 * 24 * 3600) / 30.5;
    expect(mutinynetBudget).toBeGreaterThan(blocksPerWeekOnMutinynet * 0.99);
    expect(mutinynetBudget).toBeLessThan(blocksPerWeekOnMutinynet * 1.01);
  });

  it('an unrecognized network falls back to the conservative (mainnet-cadence) assumption, never a lax one', () => {
    expect(maxAttestationAgeBlocks('some-unknown-testnet')).toBe(maxAttestationAgeBlocks('bitcoin-mainnet'));
  });

  it('evaluateReserveAttestation actually uses the network-aware budget: a block_height that would be stale under the flat old 1008-block rule is FRESH on Mutinynet under the real policy', () => {
    // 2000 blocks behind tip would have failed the old flat MAX_ATTESTATION_AGE_BLOCKS=1008 rule
    // (see the "stale evidence" test above) — on Mutinynet's real per-network budget it must pass.
    const { attestation, honestChainState } = buildAttestation({ network: 'bitcoin-signet-mutinynet', block_height: TIP_HEIGHT - 2000 });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT);
    expect(result.verified).toBe(true);
  });

  it('a custom injected policy is honored instead of the default (dependency injection, not a hardcoded global)', () => {
    const strictPolicy: ReserveFreshnessPolicy = { targetSeconds: 60, secondsPerBlockByNetwork: { 'bitcoin-signet-mutinynet': 30.5 }, defaultSecondsPerBlock: 30.5 };
    const { attestation, honestChainState } = buildAttestation({ network: 'bitcoin-signet-mutinynet', block_height: TIP_HEIGHT - 10 });
    const result = evaluateReserveAttestation(attestation, honestChainState, OUTSTANDING_BALANCE, TIP_HEIGHT, strictPolicy);
    expect(result.reasonCode).toBe('REFUSE_RESERVE_ATTESTATION_INVALID');
    expect(result.detail).toMatch(/stale/i);
  });

  it('the default policy object is exported so callers (CLI, UI) never hardcode a duplicate magic number', () => {
    expect(RESERVE_FRESHNESS_POLICY.targetSeconds).toBe(7 * 24 * 3600);
  });
});
