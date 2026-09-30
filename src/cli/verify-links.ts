// npm run verify:links — audits every external URL a visitor can reach from
// the app (index.html) and the docs it renders, and every repo-relative link
// in those docs. External URLs are classified, not just pass/fail, because
// some sites refuse automated requests:
//
//   reachable          2xx
//   redirect           3xx (followed target reported)
//   automation-blocked 401/403/405/429, or a CDN challenge
//   broken             404/410/5xx, DNS or connection failure
//
// Exit code is non-zero only for `broken` links and unresolvable repo paths.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DOC_REGISTRY } from '../app/docs-registry.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCES = ['index.html', 'src/app/faq-data.ts', 'src/app/real-mint-panel.ts', 'src/app/decision-view.ts', ...DOC_REGISTRY.map((d) => d.path)];
// Templates with a placeholder, not links a visitor follows.
const TEMPLATE = /<|\$\{|example\.com|\bexample\b|localhost|127\.0\.0\.1|\{|mint\.example|…/;
// API bases with no page at "/": probed at a real endpoint instead.
const API_BASE: Record<string, string> = {
  'https://solvent-production-2029.up.railway.app': '/v1/info',
  'https://solvent-production-9c92.up.railway.app': '/healthz',
};
const probeUrl = (u: string) => {
  const base = u.replace(/\/$/, '');
  return base in API_BASE ? base + API_BASE[base] : u;
};

type Kind = 'reachable' | 'redirect' | 'automation-blocked' | 'broken';

async function probe(url: string): Promise<{ kind: Kind; detail: string }> {
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'SOLVENT link audit (+https://github.com/TheWeirdDee/solvent)' } });
      if (res.status >= 200 && res.status < 300) return { kind: 'reachable', detail: String(res.status) };
      if (res.status >= 300 && res.status < 400) return { kind: 'redirect', detail: `${res.status} -> ${res.headers.get('location') ?? '?'}` };
      if ([401, 403, 405, 429, 999].includes(res.status)) {
        if (method === 'HEAD') continue;
        return { kind: 'automation-blocked', detail: String(res.status) };
      }
      if (method === 'HEAD' && res.status === 404) continue; // some servers 404 HEAD only
      return { kind: 'broken', detail: String(res.status) };
    } catch (err) {
      if (method === 'HEAD') continue;
      return { kind: 'broken', detail: (err as Error).message };
    }
  }
  return { kind: 'broken', detail: 'no response' };
}

async function main() {
  const external = new Map<string, Set<string>>();
  const repoBroken: string[] = [];
  for (const src of SOURCES) {
    const text = readFileSync(path.join(ROOT, src), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\]]+/g)) {
      const url = m[0].replace(/[.,;:]+$/, '');
      if (TEMPLATE.test(url) || /fonts\.(googleapis|gstatic)\.com$/.test(url)) continue;
      if (!external.has(url)) external.set(url, new Set());
      external.get(url)!.add(src);
    }
    if (src.endsWith('.md')) {
      const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/') + 1) : '';
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const link = m[1]!;
        if (/^(https?:|mailto:|#)/.test(link)) continue;
        const target = path.posix.normalize(dir + link.split('#')[0]!);
        if (!existsSync(path.join(ROOT, target))) repoBroken.push(`${src} -> ${link}`);
      }
    }
  }

  const counts: Record<Kind, number> = { reachable: 0, redirect: 0, 'automation-blocked': 0, broken: 0 };
  const urls = [...external.keys()].sort();
  const results = await Promise.all(urls.map(async (u) => ({ u, ...(await probe(probeUrl(u))) })));
  for (const r of results) {
    counts[r.kind]++;
    console.log(`${r.kind.padEnd(19)} ${r.u}  (${r.detail})${r.kind === 'broken' ? `  [in ${[...external.get(r.u)!].join(', ')}]` : ''}`);
  }
  for (const b of repoBroken) console.log(`broken-repo-link    ${b}`);
  console.log(`\n${urls.length} external URLs: ${counts.reachable} reachable, ${counts.redirect} redirect, ${counts['automation-blocked']} automation-blocked, ${counts.broken} broken; ${repoBroken.length} broken repo links`);
  process.exit(counts.broken + repoBroken.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-links crashed: ${(err as Error).message}`);
  process.exit(1);
});
