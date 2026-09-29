// npm run select:live-evidence -- <candidate live-demo.json>
//
// Used by .github/workflows/deploy-site.yml before it builds the site. The
// candidate is evidence/nostr/live-demo.json as uploaded by the most recent
// SUCCESSFUL "Refresh Live Evidence" run — a run that only uploads evidence
// it has just published and proven live (verify:live-demo, the full test
// suite, the attack corpus and verify:submission all passed first). This
// picks whichever of that candidate and the committed file is newer, so a
// push to main never redeploys older evidence than the last refresh
// produced, and a failed refresh never blocks a deploy.
//
// No network here, by design: deploying the site must not depend on relays
// being reachable. The candidate is only checked offline — it must load as
// a canonical SubmissionBundle and its Nostr event must carry a valid
// BIP-340 signature — and is never trusted to be live; the deployed live
// check re-verifies it against public relays on every run.
//
// Uses process.exitCode (never a forced process.exit()) — see
// verify-deployed.ts for why.
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { submissionBundleFromJson } from '../app/bundle-json.js';
import { verifyPolEvidenceEvent } from '../nostr/pol-event.js';

interface LiveDemoFile {
  publishedAt: string;
  bundle: unknown;
}

function load(file: string): LiveDemoFile {
  return JSON.parse(readFileSync(file, 'utf8')) as LiveDemoFile;
}

function main(): boolean {
  const candidatePath = process.argv[2];
  if (!candidatePath) {
    console.error('Usage: npm run select:live-evidence -- <candidate live-demo.json>');
    return false;
  }
  const committedPath = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'nostr', 'live-demo.json');
  const committed = load(committedPath);

  let candidate: LiveDemoFile;
  try {
    candidate = load(candidatePath);
    const bundle = submissionBundleFromJson(JSON.stringify(candidate.bundle));
    if (!bundle.nostrEvent || !bundle.reserveAttestation) throw new Error('bundle has no Nostr event or reserve attestation');
    const event = verifyPolEvidenceEvent(bundle.nostrEvent);
    if (!event.signatureValid || !event.contentParses) throw new Error(`Nostr event invalid: ${event.reason ?? 'unknown'}`);
    if (Number.isNaN(Date.parse(candidate.publishedAt))) throw new Error(`publishedAt is not a date: ${candidate.publishedAt}`);
  } catch (err) {
    console.log(`Candidate evidence rejected (${(err as Error).message}) — keeping the committed evidence (published ${committed.publishedAt}).`);
    return true;
  }

  if (Date.parse(candidate.publishedAt) > Date.parse(committed.publishedAt)) {
    copyFileSync(candidatePath, committedPath);
    console.log(`Using refreshed evidence published ${candidate.publishedAt} (committed copy: ${committed.publishedAt}).`);
  } else {
    console.log(`Keeping the committed evidence published ${committed.publishedAt} (candidate: ${candidate.publishedAt} is not newer).`);
  }
  return true;
}

process.exitCode = main() ? 0 : 1;
