// Raw markdown content for /docs, imported directly from the actual
// documentation files at build time (Vite's `?raw` loader) — this is the
// single source of truth; nothing here is copy-pasted or hand-duplicated.
import startHereRaw from '../../docs/start-here.md?raw';
import gettingStartedRaw from '../../docs/getting-started.md?raw';
import readmeRaw from '../../README.md?raw';
import protocolRaw from '../../PROTOCOL.md?raw';
import attacksRaw from '../../ATTACKS.md?raw';
import verifyIn5Raw from '../../VERIFY_IN_5_MINUTES.md?raw';
import draftAlignmentRaw from '../../docs/draft-alignment.md?raw';
import trustBoundariesRaw from '../../docs/trust-boundaries.md?raw';
import nostrSchemaRaw from '../../docs/nostr-schema.md?raw';
import reserveAttestationRaw from '../../docs/reserve-attestation.md?raw';
import verificationBundleRaw from '../../docs/verification-bundle.md?raw';
import deployRealMintRaw from '../../docs/DEPLOY-REAL-MINT.md?raw';
import deployRailwayRaw from '../../docs/DEPLOY-RAILWAY.md?raw';
import demoRunbookRaw from '../../docs/DEMO-RUNBOOK.md?raw';
import realityMapRaw from '../../docs/REALITY-MAP.md?raw';
import { DOC_REGISTRY, type DocMeta } from './docs-registry.js';

export interface DocEntry extends DocMeta {
  raw: string;
}

const RAW: Record<string, string> = { 'start-here': startHereRaw, 'getting-started': gettingStartedRaw, 'protocol': protocolRaw, 'verification-bundle': verificationBundleRaw, 'nostr-schema': nostrSchemaRaw, 'reserve-attestation': reserveAttestationRaw, 'attack-corpus': attacksRaw, 'trust-boundaries': trustBoundariesRaw, 'reality-map': realityMapRaw, 'draft-alignment': draftAlignmentRaw, 'verify-in-5': verifyIn5Raw, 'deploy-real-mint': deployRealMintRaw, 'deploy-railway': deployRailwayRaw, 'demo-runbook': demoRunbookRaw, 'readme': readmeRaw };

export const DOCS: DocEntry[] = DOC_REGISTRY.map((d) => ({ ...d, raw: RAW[d.id]! }));

/** The doc id for a repo path, if the site renders that file. */
export function docIdForPath(repoPath: string): string | null {
  return DOCS.find((d) => d.path === repoPath)?.id ?? null;
}

export function docById(id: string): DocEntry {
  return DOCS.find((d) => d.id === id) ?? DOCS[0]!;
}
