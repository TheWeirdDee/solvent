// Which commit is a deployment serving? Reads the <meta name="solvent-revision">
// the build stamps into the page (vite.config.ts) and compares it with a
// commit (default: the local HEAD).
//
//   npm run verify:deployed-revision -- [url] [commit]
import { execSync } from 'node:child_process';

const url = process.argv[2] ?? 'https://solvent-ashen.vercel.app/';
const expected = process.argv[3] ?? execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

async function main(): Promise<void> {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}revision-check=${Date.now()}`, { cache: 'no-store' });
  const html = await res.text();
  const served = /<meta name="solvent-revision" content="([^"]+)"/.exec(html)?.[1] ?? null;
  console.log(`deployment: ${url}`);
  console.log(`serves:     ${served ?? '(no revision stamp — built before stamping existed)'}`);
  console.log(`expected:   ${expected}`);
  const ok = served !== null && served === expected;
  console.log(ok ? 'MATCH: the deployment serves exactly this commit.' : 'MISMATCH');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-deployed-revision failed:', (err as Error).message);
  process.exit(1);
});
