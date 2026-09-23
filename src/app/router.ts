// Minimal hash-based router — no dependency needed for four routes, and
// hash routing works unmodified on a static build with no server rewrite
// rules. Route hashes are namespaced under `#/...` so in-page anchor links
// on the landing page (e.g. `#attack`, `#how-it-works`) can coexist with
// routing: anything that isn't a recognized route hash is left alone and
// the browser's native "scroll to element with this id" behavior applies.
//
// `/docs` and `/verify` are prefix-matched (`#/docs?doc=nostr-schema`,
// `#/verify?mode=create`) rather than exact-matched, since each carries its
// own sub-navigation in the hash query string; docs-panel.ts/verifier-panel.ts
// read that query string themselves on route entry, so deep links (e.g.
// the landing page's "Create test ecash" CTA, or the FAQ) land on the
// right sub-view.
export type Route = 'home' | 'verify' | 'publish' | 'protocol' | 'docs';

function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash === '#/' || hash.startsWith('#/verify') || hash === '#/publish' || hash === '#/protocol' || hash.startsWith('#/docs');
}

function routeFromHash(hash: string): Route {
  if (hash.startsWith('#/verify')) return 'verify';
  if (hash === '#/publish') return 'publish';
  if (hash === '#/protocol') return 'protocol';
  if (hash.startsWith('#/docs')) return 'docs';
  return 'home';
}

export function routeHash(route: Route): string {
  return route === 'home' ? '#/' : `#/${route}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

export function initRouter(onRouteChange: (route: Route) => void): void {
  function handle() {
    const hash = window.location.hash;
    if (!isRouteHash(hash)) return; // in-page anchor scroll, not a route change
    onRouteChange(routeFromHash(hash));
  }
  window.addEventListener('hashchange', handle);
  handle();
}
