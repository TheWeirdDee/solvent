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
// A section chosen from the index: it stays marked while the page scrolls to
// it (no flicker through the sections passed on the way), and afterwards if
// it sits near the page end, where it cannot scroll up to the header.
let chosen: string | null = null;
let scrolling = false;
let settleTimer: number | undefined;

function headerBottom(): number {
  return document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
}

/** Where a heading comes to rest: below the header, at its scroll-margin-top. */
function restingLine(): number {
  const margin = headings[0] ? parseFloat(getComputedStyle(headings[0]).scrollMarginTop) || 0 : 0;
  return Math.max(headerBottom(), margin);
}

/** The section being read: the last heading at or above its resting line (+ a small tolerance). */
export function activeSectionId(): string | null {
  const line = restingLine() + 24;
  let current: string | null = headings[0]?.id ?? null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= line) current = h.id;
    else break;
  }
  return current;
}

function chosenStillShown(): boolean {
  const h = chosen ? document.getElementById(chosen) : null;
  if (!h) return false;
  const top = h.getBoundingClientRect().top;
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  return top >= headerBottom() - 1 && top < window.innerHeight && (atEnd || Math.abs(top - restingLine()) < 24);
}

function markActive(): void {
  const id = scrolling || chosenStillShown() ? chosen : activeSectionId();
  links.forEach((a, key) => a.classList.toggle('active', key === id));
  if (select && id) select.value = id;
}

/** Unpins the marker once the page has stopped scrolling. */
function settleSoon(): void {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    scrolling = false;
    markActive();
  }, 180);
}

function scrollToSection(id: string, smooth: boolean): void {
  chosen = id;
  scrolling = true;
  markActive();
  // 'instant', not 'auto': the page's CSS smooth scrolling must not animate a jump the reader asked to be immediate.
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : ('instant' as ScrollBehavior), block: 'start' });
  settleSoon();
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
      if (document.getElementById('panel-protocol')?.hidden) return;
      if (scrolling) return settleSoon();
      if (queued) return;
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
