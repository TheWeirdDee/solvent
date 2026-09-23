// A small, purpose-built markdown-to-HTML renderer for SOLVENT's own
// trusted documentation files (never user input — see docs-panel.ts).
// Supports exactly what this repo's docs actually use: headings, code
// fences, inline code, bold/italic, links, unordered/ordered lists, pipe
// tables, blockquotes, and horizontal rules. Not a general-purpose
// CommonMark implementation.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}" ${url.startsWith('http') ? 'target="_blank" rel="noreferrer"' : ''}>${label}</a>`);
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

export function renderMarkdown(md: string): string {
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
