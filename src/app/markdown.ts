// A small, purpose-built markdown-to-HTML renderer for SOLVENT's own
// trusted documentation files (never user input — see docs-panel.ts).
// Supports exactly what this repo's docs actually use: headings, code
// fences, inline code, bold/italic, links, unordered/ordered lists, pipe
// tables, blockquotes, and horizontal rules. Not a general-purpose
// CommonMark implementation.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const REPO_URL = 'https://github.com/TheWeirdDee/solvent';
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';

/** Where the document being rendered lives in the repo, and which repo paths are docs the site renders itself. */
export interface LinkContext {
  basePath: string;
  docIdForPath: (repoPath: string) => string | null;
}

let ctx: LinkContext = { basePath: 'README.md', docIdForPath: () => null };

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Repo-relative links: to a doc the site renders -> in-app route; anything else -> the file on GitHub. */
export function resolveDocLink(url: string, c: LinkContext = ctx): { href: string; external: boolean } {
  // The canonical app linking to itself: an in-app route, same tab.
  const app = /^https:\/\/solvent-ashen\.vercel\.app\/(#\/.*)$/.exec(url);
  if (app) return { href: app[1]!, external: false };
  if (/^(https?:|mailto:)/.test(url)) return { href: url, external: true };
  if (url.startsWith('#')) return { href: url, external: false };
  const [pathPart = '', anchor] = url.split('#');
  const dir = c.basePath.includes('/') ? c.basePath.slice(0, c.basePath.lastIndexOf('/') + 1) : '';
  const resolved = normalizePath(dir + pathPart);
  const docId = c.docIdForPath(resolved);
  if (docId) return { href: `#/docs?doc=${docId}`, external: false };
  const kind = /\.[a-z0-9]+$/i.test(resolved) ? 'blob' : 'tree';
  return { href: `${REPO_URL}/${kind}/main/${resolved}${anchor ? `#${anchor}` : ''}`, external: true };
}

const REPO_PATH = /^(src|evidence|patches|migrations|deploy|docs|tests|\.github)\/[\w./-]+$/;
/** Local or secret paths a reader creates themselves: shown as code, never linked. */
const PRIVATE_PATH = /^deploy\/secrets(\/|$)|\.env$|^deploy\/mint\.toml$/;
/** The CDK patch series, so `patches/cdk/0003` can link the exact file. */
const CDK_PATCHES: Record<string, string> = {
  '0001': '0001-add-sign_pol_receipt-to-signatory.patch',
  '0002': '0002-add-record_pol_receipt_signature-db-hook.patch',
  '0003': '0003-wire-pol-receipt-signing-into-nut04-issuance.patch',
  '0004': '0004-recover-pending-pol-receipts-at-mint-startup.patch',
  '0005': '0005-add-pol-receipt-retrieval-endpoint.patch',
  '0006': '0006-wire-pol-receipt-signing-into-nut03-swap.patch',
  '0007': '0007-sign-pol-receipts-over-the-open-epoch.patch',
  '0008': '0008-sign-manifest-key-delegation-with-mint-identity.patch',
  '0009': '0009-sign-pol-receipts-for-melt-change.patch',
};

/**
 * The repository path a code span such as `src/verifier/verify.ts` links to,
 * or null when it must stay plain code: local/secret paths, or anything that
 * is not a repository path. A patch range (`patches/cdk/0001-0009`) names the
 * series and links its directory. `npm run verify:links` checks every target
 * this returns against the tracked files.
 */
export function autoLinkTarget(code: string): string | null {
  if (!REPO_PATH.test(code)) return null;
  const p = code.replace(/\/$/, '');
  if (PRIVATE_PATH.test(p)) return null;
  const patch = /^patches\/cdk\/(\d{4})(-\d{4})?$/.exec(p);
  if (patch) return patch[2] ? 'patches/cdk' : CDK_PATCHES[patch[1]!] ? `patches/cdk/${CDK_PATCHES[patch[1]!]}` : 'patches/cdk';
  return p;
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    // An inspectable repo path in code is a link to that file.
    const target = autoLinkTarget(code);
    if (target) {
      const r = resolveDocLink(target, { ...ctx, basePath: '' });
      return `<a href="${r.href}" ${r.external ? EXTERNAL : ''}><code>${code}</code></a>`;
    }
    return `<code>${code}</code>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[((?:<code>[^<]*<\/code>|[^\]])+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const r = resolveDocLink(url.replace(/&amp;/g, '&'));
    const inner = label.replace(/<a [^>]*>(<code>[^<]*<\/code>)<\/a>/g, '$1');
    return `<a href="${r.href}" ${r.external ? EXTERNAL : ''}>${inner}</a>`;
  });
  return out;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(md: string, linkContext?: LinkContext): string {
  ctx = linkContext ?? { basePath: 'README.md', docIdForPath: () => null };
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;

  function closeList() {
    if (listType) html.push(`</${listType}>`);
    listType = null;
  }

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      closeList();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      html.push(`<pre class="doc-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      i++;
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#{1,4}\s/, '');
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      html.push(`<h${Math.min(level + 1, 6)} id="${slug}">${renderInline(text)}</h${Math.min(level + 1, 6)}>`);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push('<hr class="doc-hr" />');
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      closeList();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote class="doc-quote">${renderInline(quoteLines.join(' '))}</blockquote>`);
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      closeList();
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        bodyRows.push(splitTableRow(lines[i]!));
        i++;
      }
      html.push(
        '<div class="doc-table-wrap"><table class="doc-table"><thead><tr>' +
          headerCells.map((c) => `<th>${renderInline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          bodyRows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    const ulMatch = /^[-*]\s+(.*)/.exec(line);
    const olMatch = /^\d+\.\s+(.*)/.exec(line);
    if (ulMatch || olMatch) {
      const kind = ulMatch ? 'ul' : 'ol';
      if (listType !== kind) {
        closeList();
        html.push(`<${kind} class="doc-list">`);
        listType = kind;
      }
      html.push(`<li>${renderInline((ulMatch ?? olMatch)![1]!)}</li>`);
      i++;
      continue;
    }

    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }

    closeList();
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '' && !/^#{1,4}\s/.test(lines[i]!) && !lines[i]!.startsWith('```') && !lines[i]!.trim().startsWith('|') && !/^[-*]\s+/.test(lines[i]!) && !/^\d+\.\s+/.test(lines[i]!)) {
      paraLines.push(lines[i]!);
      i++;
    }
    html.push(`<p>${renderInline(paraLines.join(' '))}</p>`);
  }
  closeList();
  return html.join('\n');
}
