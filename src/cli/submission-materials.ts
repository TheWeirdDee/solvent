// The submission-materials half of `npm run verify:submission`: checks the
// things a judge actually meets — the README and the rendered docs — not only
// the mechanism. Pure (takes file contents and an existence check), so it is
// unit-testable without touching the disk.
//
// Two kinds of failure are kept apart:
//   engineering — something in the product or its docs is wrong or broken
//                 (missing canonical URL, a stale "not deployed" claim, a broken
//                 internal link): never ready while any of these fail.
//   submission  — material only the team can supply (the demo video URL, the
//                 team name): reported as SUBMISSION BLOCKED, truthfully, while
//                 the engineering can still be ready.

export const CANONICAL_APP_URL = 'https://solvent-ashen.vercel.app/';
export const DEMO_VIDEO_PENDING = 'DEMO_VIDEO_URL_PENDING';

export interface MaterialLine {
  label: string;
  ok: boolean;
  kind: 'engineering' | 'submission';
  extra: string;
}

/** User-facing sources that must never carry an obsolete deployment/integration claim. */
export const USER_FACING_FILES = [
  'README.md',
  'index.html',
  'docs/start-here.md',
  'docs/getting-started.md',
  'docs/trust-boundaries.md',
  'docs/DEMO-RUNBOOK.md',
  'src/app/faq-data.ts',
];

/** Deterministically searchable obsolete claims (each was once true and is no longer). */
export const STALE_CLAIMS: { pattern: RegExp; claim: string }[] = [
  { pattern: /not (yet )?the (browser'?s )?(mint )?backend( behind this (web )?page)?/i, claim: '"the real CDK mint is not the backend"' },
  { pattern: /no persistent public host/i, claim: '"no persistent public host"' },
  { pattern: /NO REAL MINT IS CONNECTED TO THIS DEPLOYMENT/, claim: '"no real mint is connected to this deployment"' },
  { pattern: /browser (still )?uses (the )?fixture mint/i, claim: '"the browser uses the fixture mint"' },
  { pattern: /Railway deployment (is )?not live/i, claim: '"Railway deployment not live"' },
];

/** Doc ids the site can route to (#/docs?doc=<id>). */
export type DocIdCheck = (id: string) => boolean;

const ROUTES = new Set(['', 'mint', 'verify', 'publish', 'protocol', 'docs', 'lab']);

function markdownLinks(md: string): string[] {
  return [...md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

export function checkSubmissionMaterials(files: Record<string, string>, exists: (repoPath: string) => boolean, isDocId: DocIdCheck): MaterialLine[] {
  const lines: MaterialLine[] = [];
  const push = (label: string, ok: boolean, kind: MaterialLine['kind'], extra = '') => lines.push({ label, ok, kind, extra });
  const readme = files['README.md'] ?? '';

  push('README: canonical public app URL', readme.includes(CANONICAL_APP_URL), 'engineering', CANONICAL_APP_URL);
  push('README: demo / judge section', /^## Demo\b/m.test(readme), 'engineering');

  const team = /^\*\*Team:\*\*\s*(.+)$/m.exec(readme)?.[1]?.trim() ?? '';
  push('README: team', !!team && !/add your name|TEAM_PENDING|_\(/i.test(team), 'submission', team || '(missing)');

  const video = /^\*\*Demo video:\*\*\s*(.+)$/m.exec(readme)?.[1]?.trim() ?? '';
  const videoOk = /https?:\/\/\S+/.test(video) && !video.includes(DEMO_VIDEO_PENDING) && !/add link here/i.test(video);
  push('README: demo video URL', videoOk, 'submission', videoOk ? (/https?:\/\/\S+/.exec(video)?.[0] ?? '') : 'DEMO VIDEO URL pending');

  const stale: string[] = [];
  for (const f of USER_FACING_FILES) {
    const text = files[f];
    if (text === undefined) continue;
    for (const { pattern, claim } of STALE_CLAIMS) if (pattern.test(text)) stale.push(`${f}: ${claim}`);
  }
  push('No obsolete deployment/integration claims', stale.length === 0, 'engineering', stale.join('; '));

  const broken: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith('.md')) continue;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    for (const link of markdownLinks(text)) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      if (link.startsWith('#/')) {
        const route = link.slice(2).split(/[?#]/)[0]!;
        const doc = /[?&]doc=([\w-]+)/.exec(link)?.[1];
        if (!ROUTES.has(route) || (doc && !isDocId(doc))) broken.push(`${file} -> ${link}`);
        continue;
      }
      if (link.startsWith('#')) continue;
      const target = normalize(dir + link.split('#')[0]!);
      if (target && !exists(target)) broken.push(`${file} -> ${link}`);
    }
  }
  push('Internal links resolve', broken.length === 0, 'engineering', broken.slice(0, 6).join('; ') + (broken.length > 6 ? ` (+${broken.length - 6} more)` : ''));
  return lines;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
