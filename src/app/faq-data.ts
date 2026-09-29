// Shared FAQ content — rendered as an accordion on the landing page and as
// a plain list on /docs. Single source so the two presentations can never
// drift out of sync.
export interface FaqEntry {
  q: string;
  a: string;
  linkLabel?: string;
  linkHref?: string;
}

export const FAQ: FaqEntry[] = [
  {
    q: 'What does SOLVENT actually prove?',
    a: "That the mint's signed receipt, the closed epoch it promised to appear in, the published public state, and its Bitcoin reserve evidence are all mutually consistent — or, if not, exactly which one broke the chain.",
    linkLabel: 'Read the protocol',
    linkHref: '#/protocol',
  },
  {
    q: 'Does SOLVENT make a Cashu mint trustless?',
    a: 'No. The mint remains a custodian of the underlying funds. SOLVENT proves whether the mint kept its own signed promises — it does not eliminate counterparty risk.',
  },
  {
    q: 'Can SOLVENT verify any Cashu token?',
    a: 'No. The mint must provide a compatible signed Proof-of-Liabilities receipt and publish the corresponding epoch/accounting state. A mint that does not support this evidence chain cannot be fully verified.',
    linkLabel: 'Read mint requirements',
    linkHref: '#/docs?doc=draft-alignment',
  },
  {
    q: 'Why does SOLVENT use Nostr?',
    a: "So the mint's signed epoch state is public and independently fetchable — not just a number shown on the mint's own dashboard. Any relay or holder can pull the same signed evidence.",
    linkLabel: 'Nostr schema',
    linkHref: '#/docs?doc=nostr-schema',
  },
  {
    q: 'What does the live check actually check?',
    a: "A real published reference case: a signed receipt, a closed epoch manifest with an inclusion proof, a kind 8181 Nostr event and a Signet reserve attestation. Every run fetches that Nostr event from public relays again and re-queries the reserve UTXO, then runs the real verifier. If a relay or the reserve can't be reached, the result is a REFUSE that says so — nothing is filled in from bundled data.",
    linkLabel: 'Run the live check',
    linkHref: '#/verify?mode=live',
  },
  {
    q: 'Why is a validly signed bundle refused as PUBLIC EVIDENCE NOT FOUND?',
    a: "Because SOLVENT requires the mint's accounting event to be independently retrievable from public relays, not just handed to you. A bundle whose event was never published — for example one generated locally in the developer reference lab — can pass every cryptographic check and still refuse (reason code REFUSE_NOSTR_EVENT_NOT_FOUND). Relays that can't be reached at all are reported separately, as PUBLIC EVIDENCE UNAVAILABLE.",
    linkLabel: 'Trust boundaries',
    linkHref: '#/docs?doc=trust-boundaries',
  },
  {
    q: 'Is the reference case issued by a real mint?',
    a: "It is issued by SOLVENT's reference mint implementation: real blind signatures, real signed receipts and manifests, a real public Nostr event and a real Signet reserve — but not a production mint, so its token parses in a Cashu wallet with nothing to redeem it against. SOLVENT's accounting also runs inside a real CDK mint (NUT-04 minting and NUT-03 swaps, proven in CI), but that mint is not yet the backend behind this web page.",
    linkLabel: 'Trust boundaries',
    linkHref: '#/docs?doc=trust-boundaries',
  },
  {
    q: 'Is the Bitcoin reserve real?',
    a: 'Yes — this build verifies a real, unspent UTXO on the Mutinynet/Signet test network, independently re-queried on every check. Test-network coins have no monetary value.',
    linkLabel: 'Reserve attestation',
    linkHref: '#/docs?doc=reserve-attestation',
  },
  {
    q: 'What happens when SOLVENT refuses a token?',
    a: 'The acceptance boundary is not called. No token is committed, no side effect runs — refusal is enforced, not just displayed.',
  },
  {
    q: 'What happens when SOLVENT accepts a token?',
    a: 'The token reaches the reference acceptance store exactly once, via a real function call you can watch happen.',
  },
  {
    q: 'Why is the PoL protocol marked as draft?',
    a: "SOLVENT's liability semantics follow a draft Cashu Proof-of-Liabilities proposal (PR #388), not yet a finalized NUT. The mechanics are implemented byte-exact to the draft's own test vectors.",
  },
  {
    q: 'Can this be integrated into an actual Cashu wallet?',
    a: 'The decision protocol is wallet-agnostic — a real wallet can call the same verify() function and swap the reference acceptance store for its own accept/import logic without changing the protocol.',
  },
  {
    q: 'What happens if Nostr or reserve data cannot be verified?',
    a: 'SOLVENT fails closed: unverifiable evidence refuses the token, the same as evidence that actively fails. It never silently treats "unknown" as "accepted."',
  },
];
