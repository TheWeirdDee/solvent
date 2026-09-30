// The Protocol page's section index: a sticky side list on wide screens, a
// jump menu on narrow ones, with the section in view highlighted. Scrolling
// is done in-page so the route hash (#/protocol) never changes.
export function initProtocolToc(): void {
  const doc = document.querySelector<HTMLElement>('#panel-protocol .protocol-doc');
  const list = document.getElementById('protocol-toc-list');
  const select = document.getElementById('protocol-toc-select') as HTMLSelectElement | null;
  if (!doc || !list || !select) return;
  const heads = Array.from(doc.querySelectorAll<HTMLHeadingElement>('h2[id]'));
  list.innerHTML = heads.map((h) => `<li><a href="#/protocol" data-target="${h.id}">${h.textContent ?? ''}</a></li>`).join('');
  select.innerHTML = heads.map((h) => `<option value="${h.id}">${h.textContent ?? ''}</option>`).join('');
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  list.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-target]');
    if (!a) return;
    e.preventDefault();
    go(a.dataset.target!);
  });
  select.addEventListener('change', () => go(select.value));
  if (!('IntersectionObserver' in window)) return;
  const links = new Map(Array.from(list.querySelectorAll<HTMLAnchorElement>('a[data-target]')).map((a) => [a.dataset.target!, a]));
  const obs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach((a) => a.classList.remove('active'));
        links.get(en.target.id)?.classList.add('active');
        select.value = en.target.id;
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  heads.forEach((h) => obs.observe(h));
}
