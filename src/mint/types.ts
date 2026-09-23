// Fixture mint data model. Everything under "ground truth" here is the
// ALLOWED FIXTURE boundary from the PRD: we control which mint issued what
// and what it chooses to publish. The cryptography applied to this data
// (DLEQ, Merkle-sum, Nostr signing) is real.

export interface MintProofRecord {
  /** Human label for demo narration, e.g. "T1" or "T_hidden". */
  label: string;
  amount: number;
  /** The exact secret string used when this proof was blinded/issued. */
  secret: string;
  /**
   * Whether the mint includes this real issuance in its published mint_root.
   * `false` models a dishonest mint quietly omitting a liability — the hero
   * demo case (PRD section 2, CASE 2).
   */
  published: boolean;
}

export interface BurnRecord {
  label: string;
  amount: number;
  /** The spent secret the mint is asserting was redeemed. */
  secret: string;
}

export interface MintFixtureConfig {
  mintIdentity: string;
  keysetId: string;
  epoch: number;
  reserveSats: number;
  /** Seconds of validity from issuance, for the Nostr event's valid_until. */
  validitySeconds: number;
  mintProofs: MintProofRecord[];
  burns: BurnRecord[];
}

/** Compiled, published state for a mint — this is what ships as fixtures/<mint>.json. */
export interface MintFixture {
  schema: 'solvent-mint-fixture/v1';
  mintIdentity: string;
  keysetId: string;
  /** Cashu per-amount public keys for this keyset (NUT-01 style amount -> pubkey hex). */
  cashuKeys: Record<string, string>;
  nostrPubkeyHex: string;
  /**
   * DEMO-ONLY Nostr signing key, checked in intentionally so the publisher
   * and verifier CLIs work reproducibly for a stranger cloning the repo.
   * Never reuse this key for anything real. See docs/trust-assumptions.md.
   */
  nostrSecretKeyHexDemoOnly: string;
  epoch: number;
  reserveSats: number;
  reserveKind: 'demo-reserve';
  validitySeconds: number;
  mintRoot: { hashHex: string; sumSats: number };
  burnRoot: { hashHex: string; sumSats: number };
  liabilitiesSats: number;
  /** Every real mint-proof record (published AND omitted), so the CLI/UI can build any inclusion proof or show an omission. */
  mintRecords: Array<MintProofRecord & { cPrimeHex: string }>;
  burnRecords: Array<BurnRecord & { secretHashHex: string }>;
}
