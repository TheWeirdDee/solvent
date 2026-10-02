import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

// The exact commit a build was made from, so anyone can check which revision a
// deployment serves: Vercel and GitHub Actions provide it; a local build asks git.
function buildRevision(): string {
  const fromHost = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromHost) return fromHost;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function revisionStamp(): Plugin {
  const sha = buildRevision();
  const short = /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha;
  const link = /^[0-9a-f]{40}$/.test(sha)
    ? `<a href="https://github.com/TheWeirdDee/solvent/commit/${sha}" target="_blank" rel="noopener noreferrer" id="build-revision">build ${short}</a>`
    : `<span id="build-revision">build ${short}</span>`;
  return {
    name: 'solvent-revision-stamp',
    transformIndexHtml: (html) =>
      html
        .replace('<!--SOLVENT_REVISION_META-->', `<meta name="solvent-revision" content="${sha}" />`)
        .replace('<!--SOLVENT_REVISION_LINK-->', link),
  };
}

// GH_PAGES_BASE is set only by .github/workflows/refresh-live-demo.yml's
// build step, to the repo's GitHub Pages project-site subpath
// (https://theweirddee.github.io/solvent/ -> base '/solvent/'). Local
// `npm run dev`/`npm run build` are unaffected (default '/') — routing is
// hash-based (see src/app/router.ts), so this base only affects asset
// URLs, never route matching.
export default defineConfig({
  root: '.',
  base: process.env.GH_PAGES_BASE || '/',
  plugins: [revisionStamp()],
  build: {
    outDir: 'dist',
  },
});
