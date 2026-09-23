// Assembles a full fixture mint: issues real proofs for each configured
// record, compiles the mint/burn Merkle-sum trees, and signs the Nostr
// solvency event over the resulting roots. Shared by the fixture generator
// script and by tests, so both exercise the exact same real crypto path.
import { generateSecretKey, type NostrEvent } from 'nostr-tools';
import type { Proof } from '@cashu/cashu-ts';
import { checkDleqAndReconstructCPrime } from '../cashu/dleq.js';
import { generateFixtureKeyset, issueFixtureProof, keysetToKeys } from '../cashu/mint-sim.js';
import { bytesToHex } from '../encode/canonical.js';
import { buildEventContent, deriveNostrPubkey, signSolvencyEvent } from '../nostr/event.js';
import { hashSecret } from '../proof/burn-leaf.js';
import { compileReport } from './reports.js';
import type { MintFixture } from './types.js';

export interface MintProofSpec {
  label: string;
  amount: number;
  secret: string;
  /** false models a real issuance the mint deliberately left out of its published mint_root. */
  published: boolean;
}

export interface BurnSpec {
  label: string;
  amount: number;
  secret: string;
}

export interface BuildMintFixtureParams {
  mintIdentity: string;
  keysetId: string;
  epoch: number;
  reserveSats: number;
  validitySeconds: number;
  mintProofSpecs: MintProofSpec[];
  burnSpecs: BurnSpec[];
  nostrSecretKey?: Uint8Array;
  now?: number;
}

export interface BuiltMintFixtureResult {
  fixture: MintFixture;
  event: NostrEvent;
  /** label -> real, minted Proof (whether or not it was published in the report). */
  issuedProofs: Record<string, Proof>;
  nostrSecretKey: Uint8Array;
}

export function buildMintFixture(params: BuildMintFixtureParams): BuiltMintFixtureResult {
  const amounts = [...new Set(params.mintProofSpecs.map((s) => s.amount))];
  const keyset = generateFixtureKeyset(amounts);
  const keyByAmount = new Map(keyset.map((k) => [k.amount, k]));

  const issuedProofs: Record<string, Proof> = {};
  const mintRecords: MintFixture['mintRecords'] = [];
  for (const spec of params.mintProofSpecs) {
    const key = keyByAmount.get(spec.amount);
    if (!key) throw new Error(`buildMintFixture: no key generated for amount ${spec.amount}`);
    const { proof } = issueFixtureProof({ key, keysetId: params.keysetId, secret: spec.secret });
    issuedProofs[spec.label] = proof;

    const dleq = checkDleqAndReconstructCPrime(proof, { [String(spec.amount)]: key.publicKeyHex });
    if (!dleq.valid || !dleq.cPrimeHex) {
      throw new Error(`buildMintFixture: freshly issued proof "${spec.label}" failed to self-verify: ${dleq.reason}`);
    }
    mintRecords.push({ label: spec.label, amount: spec.amount, secret: spec.secret, published: spec.published, cPrimeHex: dleq.cPrimeHex });
  }

  const burnRecords = params.burnSpecs.map((b) => ({
    label: b.label,
    amount: b.amount,
    secret: b.secret,
    secretHashHex: hashSecret(b.secret),
  }));

  const cashuKeys = keysetToKeys(keyset);
  const nostrSecretKey = params.nostrSecretKey ?? generateSecretKey();
  const nostrPubkeyHex = deriveNostrPubkey(nostrSecretKey);

  const draftFixture: MintFixture = {
    schema: 'solvent-mint-fixture/v1',
    mintIdentity: params.mintIdentity,
    keysetId: params.keysetId,
    cashuKeys,
    nostrPubkeyHex,
    nostrSecretKeyHexDemoOnly: bytesToHex(nostrSecretKey),
    epoch: params.epoch,
    reserveSats: params.reserveSats,
    reserveKind: 'demo-reserve',
    validitySeconds: params.validitySeconds,
    mintRoot: { hashHex: '', sumSats: 0 },
    burnRoot: { hashHex: '', sumSats: 0 },
    liabilitiesSats: 0,
    mintRecords,
    burnRecords,
  };

  const report = compileReport(draftFixture);
  draftFixture.mintRoot = { hashHex: bytesToHex(report.mintTree.root.hash), sumSats: Number(report.mintTree.root.sum) };
  draftFixture.burnRoot = { hashHex: bytesToHex(report.burnTree.root.hash), sumSats: Number(report.burnTree.root.sum) };
  draftFixture.liabilitiesSats = draftFixture.mintRoot.sumSats - draftFixture.burnRoot.sumSats;

  const now = params.now ?? Math.floor(Date.now() / 1000);
  const eventContent = buildEventContent({
    mintPubkeyHex: nostrPubkeyHex,
    keysetId: params.keysetId,
    epoch: params.epoch,
    mintRoot: draftFixture.mintRoot,
    burnRoot: draftFixture.burnRoot,
    liabilitiesSats: draftFixture.liabilitiesSats,
    reserveSats: params.reserveSats,
    validitySeconds: params.validitySeconds,
    proofUri: `local://fixtures/${params.mintIdentity}.json`,
    notes: 'Phase 1 fixture mint',
    now,
  });
  const event = signSolvencyEvent(eventContent, params.mintIdentity, nostrSecretKey);

  return { fixture: draftFixture, event, issuedProofs, nostrSecretKey };
}
