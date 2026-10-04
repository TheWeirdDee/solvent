// npm run verify:links — audits every link a visitor can reach from the app
// (index.html, app code) and from the docs it renders, in four classes:
//
//   A. broken      a link SOLVENT generates that does not resolve: a repo path
//                  that is not tracked in git (markdown links AND the links the
//                  renderer generates from code spans, via autoLinkTarget), or
//                  an external URL answering 404/410 / failing DNS
//   B. upstream    an external service that is temporarily failing (5xx,
//                  timeout) or refuses automated requests (401/403/405/429);
//                  reported, never fatal — SOLVENT never depends on it to verify
//   C. private     a local/secret path deliberately shown as plain code and
//                  never linked (deploy/secrets/*, *.env, deploy/mint.toml)
//   D. reachable   2xx, or a redirect to a working page
//
// Exit code is non-zero only for class A.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOC_REGISTRY } from '../app/docs-registry.js';
import { autoLinkTarget } from '../app/markdown.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const APP_SOURCES = ['index.html', 'src/app/faq-data.ts', 'src/app/real-mint-panel.ts', 'src/app/decision-view.ts', 'src/app/publisher-panel.ts', 'src/app/landing-evidence.ts'];
const DOC_SOURCES = DOC_REGISTRY.map((d) => d.path);
// Templates with a placeholder, not links a visitor follows.
const TEMPLATE = /<|\$\{|example\.com|\bexample\b|localhost|127\.0\.0\.1|\{|mint\.example|…/;
// API bases with no page at "/": probed at a real endpoint instead.
const API_BASE: Record<string, string> = {
  'https://solvent-production-2029.up.railway.app': '/v1/info',
  'https://solvent-production-9c92.up.railway.app': '/healthz',
  'https://mutinynet.com/api': '/blocks/tip/height',
};
const probeUrl = (u: string) => {
  const base = u.replace(/\/$/, '');
  return base in API_BASE ? base + API_BASE[base] : u;
};

type Kind = 'reachable' | 'upstream' | 'broken';

async function probe(url: string): Promise<{ kind: Kind; detail: string }> {
  let last = 'no response';
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'SOLVENT link audit (+https://github.com/TheWeirdDee/solvent)' } });
      if (res.ok) return { kind: 'reachable', detail: String(res.status) };
      last = String(res.status);
      if (method === 'HEAD') continue; // some servers reject HEAD only
      if (res.status === 404 || res.status === 410) return { kind: 'broken', detail: last };
      return { kind: 'upstream', detail: `${last}${res.status >= 500 ? ' (service failing)' : ' (refuses automated requests)'}` };
    } catch (err) {
      last = (err as Error).message;
      if (method === 'HEAD') continue;
      const dns = /ENOTFOUND|getaddrinfo/.test(String((err as { cause?: unknown }).cause ?? last));
      return { kind: dns ? 'broken' : 'upstream', detail: dns ? `DNS: ${last}` : `${last} (timeout or connection failure)` };
    }
  }
  return { kind: 'upstream', detail: last };
}

async function main() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const isTracked = (p: string) => tracked.includes(p) || tracked.some((t) => t.startsWith(`${p}/`));

  const external = new Map<string, Set<string>>();
  const broken: string[] = [];
  const privatePaths = new Map<string, Set<string>>();
  let generated = 0;

  // Evidence folders explain themselves in README.md files: their links must reach files Git will
  // actually keep (an ignored file exists locally but never reaches the repository).
  const EVIDENCE_SOURCES = tracked.filter((t) => /^evidence\/.+\/README\.md$|^evidence\/README\.md$/.test(t));
  for (const src of [...APP_SOURCES, ...DOC_SOURCES, ...EVIDENCE_SOURCES.filter((e) => !DOC_SOURCES.includes(e))]) {
    const text = readFileSync(path.join(ROOT, src), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\]]+/g)) {
      const url = m[0].replace(/[.,;:]+$/, '');
      if (TEMPLATE.test(url) || /fonts\.(googleapis|gstatic)\.com$/.test(url)) continue;
      if (!external.has(url)) external.set(url, new Set());
      external.get(url)!.add(src);
    }
    if (!src.endsWith('.md')) continue;
    const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/') + 1) : '';
    // Markdown links to repo files.
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const link = m[1]!;
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const target = path.posix.normalize(dir + link.split('#')[0]!).replace(/\/$/, '');
      if (!isTracked(target)) broken.push(`${src} -> ${link} (not a tracked repository path)`);
    }
    // Links the renderer generates from code spans.
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const code = m[1]!;
      const target = autoLinkTarget(code);
      if (target) {
        generated++;
        if (!isTracked(target)) broken.push(`${src} -> \`${code}\` (generated link to ${target}, not tracked)`);
      } else if (/^(deploy|evidence|src|docs)\//.test(code) && /secrets|\.env$|mint\.toml$/.test(code)) {
        if (!privatePaths.has(code)) privatePaths.set(code, new Set());
        privatePaths.get(code)!.add(src);
      }
    }
  }

  const urls = [...external.keys()].sort();
  const results = await Promise.all(urls.map(async (u) => ({ u, ...(await probe(probeUrl(u))) })));
  for (const r of results) {
    if (r.kind === 'broken') broken.push(`${r.u} (${r.detail}) [in ${[...external.get(r.u)!].join(', ')}]`);
  }

  console.log('A. BROKEN (SOLVENT-generated, fatal)');
  for (const b of broken) console.log(`   ${b}`);
  console.log('B. UPSTREAM / TEMPORARY (reported, not fatal)');
  for (const r of results.filter((x) => x.kind === 'upstream')) console.log(`   ${r.u} (${r.detail})`);
  console.log('C. PRIVATE / LOCAL PATHS (plain code, deliberately not linked)');
  for (const [p, srcs] of privatePaths) console.log(`   ${p} [in ${[...srcs].join(', ')}]`);
  const reachable = results.filter((x) => x.kind === 'reachable').length;
  console.log(`D. REACHABLE: ${reachable} external URLs`);
  console.log(
    `\n${urls.length} external URLs (${reachable} reachable, ${results.filter((x) => x.kind === 'upstream').length} upstream/temporary), ${generated} generated repo links checked, ${privatePaths.size} private paths not linked; ${broken.length} broken`,
  );
  process.exit(broken.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-links crashed: ${(err as Error).message}`);
  process.exit(1);
});
