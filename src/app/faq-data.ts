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
    q: "Why can't Create Test Ecash reach ACCEPT?",
    a: "It genuinely can't — on purpose. Create Test Ecash mints a fresh identity every run, so its evidence has never been published anywhere; a mint handing you a validly signed promise privately isn't the same as that promise being publicly checkable, which is what SOLVENT actually verifies. SOLVENT still genuinely queries public relays for it and correctly finds nothing — relays reachable, event absent (reason code REFUSE_NOSTR_EVENT_NOT_FOUND, badge \"PUBLICATION NOT FOUND\"), a different, more specific fact than a relay being unreachable. Try SOLVENT's Live Public Demo uses evidence that really was published once, and reaches a real ACCEPT.",
    linkLabel: 'Trust boundaries',
    linkHref: '#/docs?doc=trust-boundaries',
  },
  {
    q: 'Is the test ecash real — can I spend it in a wallet?',
    a: "The token is a real, standards-compliant encoded Cashu proof (the same getEncodedToken() a real wallet uses), so a wallet can parse it. But it's issued by SOLVENT's own test mint, not a reachable production mint — there's nothing to redeem it against. The cryptography is real; the mint behind it is a test fixture.",
    linkLabel: 'Verification bundle schema',
    linkHref: '#/docs?doc=verification-bundle',
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
