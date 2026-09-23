import { defineConfig } from 'vite';

// GH_PAGES_BASE is set only by .github/workflows/refresh-live-demo.yml's
// build step, to the repo's GitHub Pages project-site subpath
// (https://theweirddee.github.io/solvent/ -> base '/solvent/'). Local
// `npm run dev`/`npm run build` are unaffected (default '/') — routing is
// hash-based (see src/app/router.ts), so this base only affects asset
// URLs, never route matching.
export default defineConfig({
  root: '.',
  base: process.env.GH_PAGES_BASE || '/',
  build: {
    outDir: 'dist',
  },
});
