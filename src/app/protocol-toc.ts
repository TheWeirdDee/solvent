// The Protocol page's section index: a sticky side list on wide screens, a
// jump menu on narrow ones. The active entry is the last section whose
// heading has passed just below the sticky header — computed from real scroll
// positions, so it always names the section being read. Choosing a section
// records #/protocol?section=<id>, so refresh, direct links and back/forward
// land on it; headings carry scroll-margin-top so they never sit under the
// header.
let headings: HTMLHeadingElement[] = [];
let links = new Map<string, HTMLAnchorElement>();
let select: HTMLSelectElement | null = null;

function headerBottom(): number {
  return document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
}

/** The section being read: the last heading at or above the header line (+ a small tolerance). */
export function activeSectionId(): string | null {
  const line = headerBottom() + 24;
  let current: string | null = headings[0]?.id ?? null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= line) current = h.id;
    else break;
  }
  return current;
}

function markActive(): void {
  const id = activeSectionId();
  links.forEach((a, key) => a.classList.toggle('active', key === id));
  if (select && id) select.value = id;
}

function scrollToSection(id: string, smooth: boolean): void {
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

function choose(id: string): void {
  const target = `#/protocol?section=${id}`;
  if (window.location.hash !== target) history.pushState(null, '', target);
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  scrollToSection(id, !reduce);
}

/** Called on every arrival at #/protocol (including back/forward): honours ?section=. */
export function syncProtocolSection(): void {
  const id = /[?&]section=([\w-]+)/.exec(window.location.hash)?.[1];
  if (id && document.getElementById(id)) requestAnimationFrame(() => {
    scrollToSection(id, false);
    markActive();
  });
}

export function initProtocolToc(): void {
  const doc = document.querySelector<HTMLElement>('#panel-protocol .protocol-doc');
  const list = document.getElementById('protocol-toc-list');
  select = document.getElementById('protocol-toc-select') as HTMLSelectElement | null;
  if (!doc || !list || !select) return;
  headings = Array.from(doc.querySelectorAll<HTMLHeadingElement>('h2[id]'));
  list.innerHTML = headings.map((h) => `<li><a href="#/protocol?section=${h.id}" data-target="${h.id}">${h.textContent ?? ''}</a></li>`).join('');
  select.innerHTML = headings.map((h) => `<option value="${h.id}">${h.textContent ?? ''}</option>`).join('');
  links = new Map(Array.from(list.querySelectorAll<HTMLAnchorElement>('a[data-target]')).map((a) => [a.dataset.target!, a]));
  list.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-target]');
    if (!a) return;
    e.preventDefault();
    choose(a.dataset.target!);
  });
  select.addEventListener('change', () => choose(select!.value));
  let queued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (queued || document.getElementById('panel-protocol')?.hidden) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        markActive();
      });
    },
    { passive: true },
  );
  markActive();
}
