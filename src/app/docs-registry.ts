// The documentation registry: every doc the site renders, by id, with its
// repo path. Plain data (no ?raw imports) so CLI tools can use it too.
export interface DocMeta {
  id: string;
  navLabel: string;
  title: string;
  path: string;
}

export const DOC_REGISTRY: DocMeta[] = [
  { id: 'start-here', navLabel: 'Start here', title: 'Start here — judge SOLVENT in 3 minutes', path: 'docs/start-here.md' },
  { id: 'getting-started', navLabel: 'Getting started', title: 'Getting started', path: 'docs/getting-started.md' },
  { id: 'protocol', navLabel: 'Protocol & architecture', title: 'Protocol & architecture', path: 'PROTOCOL.md' },
  { id: 'verification-bundle', navLabel: 'Verification bundle schema', title: 'Verification bundle schema', path: 'docs/verification-bundle.md' },
  { id: 'nostr-schema', navLabel: 'Nostr schema', title: 'Nostr schema', path: 'docs/nostr-schema.md' },
  { id: 'reserve-attestation', navLabel: 'Reserve attestation', title: 'Reserve attestation', path: 'docs/reserve-attestation.md' },
  { id: 'attack-corpus', navLabel: 'Attack corpus', title: 'Attack corpus', path: 'ATTACKS.md' },
  { id: 'trust-boundaries', navLabel: 'Trust boundaries', title: 'Trust boundaries', path: 'docs/trust-boundaries.md' },
  { id: 'reality-map', navLabel: 'Reality map', title: 'Reality map — what is real, where', path: 'docs/REALITY-MAP.md' },
  { id: 'draft-alignment', navLabel: 'Draft alignment', title: 'Draft alignment (Cashu PR #388)', path: 'docs/draft-alignment.md' },
  { id: 'verify-in-5', navLabel: 'Verify in 5 minutes', title: 'Verify in 5 minutes', path: 'VERIFY_IN_5_MINUTES.md' },
  { id: 'deploy-real-mint', navLabel: 'Deploy a real mint', title: 'Deploy a real SOLVENT mint', path: 'docs/DEPLOY-REAL-MINT.md' },
  { id: 'deploy-railway', navLabel: 'Deploy on Railway', title: 'Deploy the real SOLVENT mint on Railway', path: 'docs/DEPLOY-RAILWAY.md' },
  { id: 'demo-runbook', navLabel: 'Demo runbook', title: 'Demo runbook', path: 'docs/DEMO-RUNBOOK.md' },
  { id: 'readme', navLabel: 'Project README', title: 'Project README', path: 'README.md' },
];
