// Raw markdown content for /docs, imported directly from the actual
// documentation files at build time (Vite's `?raw` loader) — this is the
// single source of truth; nothing here is copy-pasted or hand-duplicated.
import startHereRaw from '../../docs/start-here.md?raw';
import readmeRaw from '../../README.md?raw';
import protocolRaw from '../../PROTOCOL.md?raw';
import attacksRaw from '../../ATTACKS.md?raw';
import verifyIn5Raw from '../../VERIFY_IN_5_MINUTES.md?raw';
import draftAlignmentRaw from '../../docs/draft-alignment.md?raw';
import trustBoundariesRaw from '../../docs/trust-boundaries.md?raw';
import nostrSchemaRaw from '../../docs/nostr-schema.md?raw';
import reserveAttestationRaw from '../../docs/reserve-attestation.md?raw';
import verificationBundleRaw from '../../docs/verification-bundle.md?raw';

export interface DocEntry {
  id: string;
  navLabel: string;
  title: string;
  raw: string;
}

export const DOCS: DocEntry[] = [
  { id: 'start-here', navLabel: 'Start here (2 minutes)', title: 'Start here — try SOLVENT in 2 minutes', raw: startHereRaw },
  { id: 'getting-started', navLabel: 'Getting started', title: 'Getting started', raw: readmeRaw },
  { id: 'protocol', navLabel: 'Protocol & architecture', title: 'Protocol & architecture', raw: protocolRaw },
  { id: 'verification-bundle', navLabel: 'Verification bundle schema', title: 'Verification bundle schema', raw: verificationBundleRaw },
  { id: 'nostr-schema', navLabel: 'Nostr schema', title: 'Nostr schema', raw: nostrSchemaRaw },
  { id: 'reserve-attestation', navLabel: 'Reserve attestation', title: 'Reserve attestation', raw: reserveAttestationRaw },
  { id: 'attack-corpus', navLabel: 'Attack corpus', title: 'Attack corpus', raw: attacksRaw },
  { id: 'trust-boundaries', navLabel: 'Trust boundaries', title: 'Trust boundaries', raw: trustBoundariesRaw },
  { id: 'draft-alignment', navLabel: 'Draft alignment', title: 'Draft alignment (Cashu PR #388)', raw: draftAlignmentRaw },
  { id: 'verify-in-5', navLabel: 'Verify in 5 minutes', title: 'Verify in 5 minutes', raw: verifyIn5Raw },
];

export function docById(id: string): DocEntry {
  return DOCS.find((d) => d.id === id) ?? DOCS[0]!;
}
