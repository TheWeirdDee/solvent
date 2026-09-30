// npm run verify:submission — the five-minute judge verifier (PRD §16).
// Re-runs the real gate mechanisms (not a canned transcript; see
// verify-submission-core.ts) and prints a concise PASS/FAIL summary with
// evidence paths. Exits non-zero on ANY required failure — fail closed,
// no exceptions, per the explicit instruction that this command must never
// report success while a required gate or the attack corpus is incomplete.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyCanonicalLiveDemo } from '../app/submission.js';
import { DOC_REGISTRY as DOCS } from '../app/docs-registry.js';
import { checkSubmissionMaterials, USER_FACING_FILES } from './submission-materials.js';
import { runSubmissionChecks, type ExternalEvidenceStatus } from './verify-submission-core.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXPECTED_ATTACK_COUNT = 25;

function readJsonIfExists<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function gatherAttackCorpusStatus(): ExternalEvidenceStatus['attackCorpus'] {
  try {
    // shell: true so Windows resolves npx.cmd (execFileSync does not use a
    // shell by default, and a bare 'npx' spawn fails with ENOENT there).
    const output = execFileSync('npx', ['tsx', 'src/cli/attacks.ts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    const match = output.match(/(\d+)\/(\d+) attacks produced the expected outcome/);
    if (!match) return null;
    return { passed: Number(match[1]), total: Number(match[2]), expectedTotal: EXPECTED_ATTACK_COUNT };
  } catch (err) {
    // attacks.ts exits non-zero when any attack fails — that output is still on stdout.
    const output = (err as { stdout?: string }).stdout ?? '';
    const match = output.match(/(\d+)\/(\d+) attacks produced the expected outcome/);
    if (!match) return null;
    return { passed: Number(match[1]), total: Number(match[2]), expectedTotal: EXPECTED_ATTACK_COUNT };
  }
}

async function gatherCanonicalLiveDemoStatus(): Promise<ExternalEvidenceStatus['canonicalLiveDemo']> {
  try {
    const { result } = await verifyCanonicalLiveDemo();
    return { ok: result.decision === 'ACCEPT', reasonCode: result.reasonCode, detail: result.decision === 'ACCEPT' ? 'ACCEPT_VERIFIED' : result.reason };
  } catch (err) {
    return { ok: false, reasonCode: 'ERROR', detail: `verifyCanonicalLiveDemo() crashed: ${(err as Error).message}` };
  }
}

async function main() {
  console.log('SOLVENT submission verifier\n');

  const nostrEvidence = readJsonIfExists<{ pass: boolean }>(path.join(ROOT, 'evidence', 'nostr', 'cases.json'));
  const reserveEvidence = readJsonIfExists<{ live_verified: boolean }>(path.join(ROOT, 'evidence', 'reserves', 'cases.json'));
  const attackCorpus = gatherAttackCorpusStatus();
  const canonicalLiveDemo = await gatherCanonicalLiveDemoStatus();

  const external: ExternalEvidenceStatus = {
    attackCorpus,
    nostrLiveEvidencePass: nostrEvidence ? nostrEvidence.pass === true : null,
    reserveLiveVerified: reserveEvidence ? reserveEvidence.live_verified === true : null,
    canonicalLiveDemo,
  };

  const { lines, failures, ready } = runSubmissionChecks(external);
  for (const l of lines) {
    console.log(`${l.label.padEnd(30)} ${l.ok ? 'PASS' : 'FAIL'}${l.extra ? '  ' + l.extra : ''}`);
  }

  console.log('\nEvidence:');
  console.log('  evidence/gate-0/  evidence/gate-1/  evidence/gate-2/  evidence/gate-4/  evidence/nostr/  evidence/reserves/  evidence/hero/  evidence/attacks/');
  console.log('\nRun `npm run gate0`..`gate6` individually to regenerate evidence files, or `npm run attacks` for the full attack corpus.');
  console.log('The "Canonical Live Public Demo" line is a real, right-now check (see `npm run verify:live-demo` for the same check with full diagnostic detail) — everything else above it reads previously-recorded evidence files.');
  console.log('See docs/draft-alignment.md and docs/trust-boundaries.md for exactly what is real vs. not yet implemented.');

  // ---- Submission materials: what a judge actually meets.
  const docFiles = new Set([...USER_FACING_FILES, ...DOCS.map((d) => d.path)]);
  const files: Record<string, string> = {};
  for (const f of docFiles) if (existsSync(path.join(ROOT, f))) files[f] = readFileSync(path.join(ROOT, f), 'utf8');
  const materials = checkSubmissionMaterials(files, (p) => existsSync(path.join(ROOT, p)), (id) => id === 'faq' || DOCS.some((d) => d.id === id));
  console.log('\nSubmission materials:');
  for (const m of materials) console.log(`${m.label.padEnd(42)} ${m.ok ? 'PASS' : m.kind === 'submission' ? 'PENDING' : 'FAIL'}${m.extra ? '  ' + m.extra : ''}`);
  const engineeringFails = materials.filter((m) => !m.ok && m.kind === 'engineering').length;
  const blockers = materials.filter((m) => !m.ok && m.kind === 'submission');

  const engineeringReady = ready && engineeringFails === 0;
  if (!engineeringReady) {
    console.log(`\nNOT SUBMISSION READY - ${failures + engineeringFails} required item(s) failing`);
    process.exit(1);
  }
  if (blockers.length > 0) {
    console.log('\nENGINEERING READY');
    console.log(`SUBMISSION BLOCKED: ${blockers.map((b) => b.label.replace(/^README: /, '').toUpperCase()).join(', ')}`);
    // CI gates on engineering; --strict demands the complete submission.
    process.exit(process.argv.includes('--strict') ? 1 : 0);
  }
  console.log('\nENGINEERING READY\nSUBMISSION READY');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-submission crashed:', err);
  process.exit(1);
});
