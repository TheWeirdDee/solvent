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
    q: 'What is the difference between "Try the live mint" and "Re-check published evidence"?',
    a: 'Try the live mint creates a fresh issuance on a real patched CDK mint (hosted on Railway), waits for its epoch to close and be published, then verifies it — about 30–90 seconds, with a new receipt, new public evidence and a fresh ACCEPT or REFUSE. Re-check published evidence re-verifies a captured reference case that was published earlier: its Nostr event and reserve are fetched again now, but it mints nothing.',
    linkLabel: 'Try the live mint',
    linkHref: '#/mint',
  },
  {
    q: 'Is the Lightning payment on the live mint real?',
    a: "No — the public mint uses CDK's fakewallet Lightning backend, so invoices settle by themselves, and the page says so. Everything SOLVENT checks (the mint, its receipts, epochs, manifests, delegation, public Nostr evidence and the Bitcoin reserve) is real. The same pipeline runs over real LND in CI; those results are committed and shown on the Evidence page.",
    linkLabel: 'See the real-LND evidence',
    linkHref: '#/publish',
  },
  {
    q: 'What does Re-check published evidence actually check?',
    a: "A captured, published reference case: a signed receipt, a closed epoch manifest with an inclusion proof, a kind 8181 Nostr event and a Signet reserve attestation. Every run fetches that Nostr event from public relays again and re-queries the reserve UTXO, then runs the real verifier. If a relay or the reserve can't be reached, the result says the check could not complete — nothing is filled in from bundled data.",
    linkLabel: 'Re-check published evidence',
    linkHref: '#/verify?mode=live',
  },
  {
    q: 'Why is a validly signed bundle refused as PUBLIC EVIDENCE NOT FOUND?',
    a: "Because SOLVENT requires the mint's accounting event to be independently retrievable from public relays, not just handed to you. A bundle whose event was never published — for example one generated locally in the developer reference lab — can pass every cryptographic check and still refuse (reason code REFUSE_NOSTR_EVENT_NOT_FOUND). Relays that can't be reached at all are reported separately (REFUSE_NOSTR_UNAVAILABLE), as a check that could not complete — retry it.",
    linkLabel: 'Trust boundaries',
    linkHref: '#/docs?doc=trust-boundaries',
  },
  {
    q: 'Is the reference case issued by a real mint?',
    a: "The captured reference case is issued by SOLVENT's reference mint implementation: real blind signatures, real signed receipts and manifests, a real public Nostr event and a real Signet reserve — but not a production mint. The live mint (#/mint) is different: a real patched CDK mint, hosted publicly, whose every issuance you can verify.",
    linkLabel: 'Trust boundaries',
    linkHref: '#/docs?doc=trust-boundaries',
  },
  {
    q: 'Is the Bitcoin reserve real?',
    a: 'Yes — a real UTXO on the Mutinynet/Signet test network, independently re-queried on every check. Test-network coins have no monetary value. An observed, unspent reserve covering the committed liabilities does not prove the reserve backs only this mint, that no liabilities exist outside the commitment, future solvency, or that a redemption will succeed.',
    linkLabel: 'Reserve attestation',
    linkHref: '#/docs?doc=reserve-attestation',
  },
  {
    q: 'What happens when SOLVENT refuses a token?',
    a: 'The acceptance boundary is not called. No token is committed, no side effect runs — refusal is enforced, not just displayed.',
  },
  {
    q: 'What happens when SOLVENT accepts a token?',
    a: 'The real accept function runs exactly once for that issuance — retrying or reloading never accepts it twice — and the live mint result shows the call count read back from the store. The store is a local reference store in your browser: it proves the verdict gates a real side effect, and is not a universal Cashu wallet.',
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
    a: 'Nothing is accepted — SOLVENT fails closed. But the result says what happened: a relay or the reserve service could not be reached ("verification could not complete"), which is not a finding against the mint. Retry verification re-checks the same issuance once it is reachable. A proven refusal (red REFUSE) is reserved for evidence that was checked and failed.',
  },
];
