// /docs — real product documentation rendered from the same markdown files
// that are this repo's actual source of truth (docs-data.ts's `?raw`
// imports), not a hand-duplicated copy. Desktop gets a sidebar; narrow
// viewports get a select-driven drawer.
import { DOCS, docById, type DocEntry } from './docs-data.js';
import { FAQ } from './faq-data.js';
import { renderMarkdown } from './markdown.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`docs-panel: missing #${id}`);
  return el as T;
}

function docIdFromHash(): string | 'faq' {
  const hash = window.location.hash;
  const match = /[?&]doc=([a-z0-9-]+)/i.exec(hash);
  if (match && match[1] === 'faq') return 'faq';
  return match ? match[1]! : DOCS[0]!.id;
}

export function initDocsPanel(): void {
  const nav = byId<HTMLElement>('docs-nav');
  const mobileSelect = byId<HTMLSelectElement>('docs-mobile-select');
  const docContent = byId<HTMLElement>('docs-doc-content');
  const faqContent = byId<HTMLElement>('docs-faq-content');

  const entries: { id: string; label: string }[] = [...DOCS.map((d) => ({ id: d.id, label: d.navLabel })), { id: 'faq', label: 'FAQ' }];

  nav.innerHTML = entries.map((e) => `<button type="button" class="docs-nav-link" data-doc="${e.id}">${e.label}</button>`).join('');
  mobileSelect.innerHTML = entries.map((e) => `<option value="${e.id}">${e.label}</option>`).join('');

  function renderDoc(entry: DocEntry) {
    docContent.hidden = false;
    faqContent.hidden = true;
    docContent.innerHTML = `<article class="doc-article">${renderMarkdown(entry.raw)}</article>`;
  }

  function renderFaq() {
    docContent.hidden = true;
    faqContent.hidden = false;
    faqContent.innerHTML =
      '<h1 class="doc-h1">FAQ</h1>' +
      FAQ.map(
        (f) =>
          `<div class="doc-faq-entry"><h2 class="doc-h2">${f.q}</h2><p>${f.a}</p>${f.linkHref ? `<a class="doc-faq-link" href="${f.linkHref}">${f.linkLabel} &rarr;</a>` : ''}</div>`,
      ).join('');
  }

  function selectDoc(id: string) {
    nav.querySelectorAll<HTMLButtonElement>('.docs-nav-link').forEach((btn) => btn.classList.toggle('active', btn.dataset.doc === id));
    mobileSelect.value = id;
    if (id === 'faq') renderFaq();
    else renderDoc(docById(id));
    window.scrollTo({ top: 0 });
  }

  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.docs-nav-link');
    if (!btn?.dataset.doc) return;
    window.location.hash = `#/docs?doc=${btn.dataset.doc}`;
  });
  mobileSelect.addEventListener('change', () => {
    window.location.hash = `#/docs?doc=${mobileSelect.value}`;
  });

  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#/docs')) return;
    selectDoc(docIdFromHash());
  });

  // Initial render — covers both a direct load on /docs and navigating in
  // from elsewhere in the app before this listener was attached.
  if (window.location.hash.startsWith('#/docs')) selectDoc(docIdFromHash());
  else selectDoc(DOCS[0]!.id);
}
