// Minimal hash-based router — no dependency needed for a handful of routes, and
// hash routing works unmodified on a static build with no server rewrite
// rules. Route hashes are namespaced under `#/...` so in-page anchor links
// on the landing page (e.g. `#attack`, `#how-it-works`) can coexist with
// routing: anything that isn't a recognized route hash is left alone and
// the browser's native "scroll to element with this id" behavior applies.
//
// `/docs` and `/verify` are prefix-matched (`#/docs?doc=nostr-schema`,
// `#/verify?mode=live`) rather than exact-matched, since each carries its
// own sub-navigation in the hash query string; docs-panel.ts/verifier-panel.ts
// read that query string themselves on route entry, so deep links (e.g.
// the landing page's "Run the live check" CTA, or the FAQ) land on the
// right sub-view. `/lab` (the developer reference mint) is reachable by URL
// and from the docs/footer only — never the primary navigation.
export type Route = 'home' | 'verify' | 'mint' | 'publish' | 'protocol' | 'docs' | 'lab';

function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash === '#/' || hash.startsWith('#/verify') || hash.startsWith('#/mint') || hash === '#/publish' || hash.startsWith('#/protocol') || hash.startsWith('#/docs') || hash === '#/lab';
}

function routeFromHash(hash: string): Route {
  if (hash.startsWith('#/verify')) return 'verify';
  if (hash.startsWith('#/mint')) return 'mint';
  if (hash === '#/publish') return 'publish';
  if (hash.startsWith('#/protocol')) return 'protocol';
  if (hash.startsWith('#/docs')) return 'docs';
  if (hash === '#/lab') return 'lab';
  return 'home';
}

export function routeHash(route: Route): string {
  return route === 'home' ? '#/' : `#/${route}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

export function initRouter(onRouteChange: (route: Route) => void): void {
  let routed = false;
  function handle() {
    const hash = window.location.hash;
    if (isRouteHash(hash)) {
      routed = true;
      onRouteChange(routeFromHash(hash));
      return;
    }
    // A landing-page section (#problem, #reserve…), loaded directly, refreshed
    // or reached with back/forward: render the landing route, then the section.
    const target = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target?.closest('#panel-home')) {
      routed = true;
      onRouteChange('home');
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
      return;
    }
    // Anything else on first load (an unknown fragment) still gets a page.
    if (!routed) {
      routed = true;
      onRouteChange('home');
    }
    // Otherwise: an in-page anchor inside the current route; leave it alone.
  }
  window.addEventListener('hashchange', handle);
  handle();
}
