import './style.css';
import { initVerifierPanel, syncModeFromHash } from './verifier-panel.js';
import { initPublisherPanel } from './publisher-panel.js';
import { initDocsPanel } from './docs-panel.js';
import { renderHeroPanel } from './hero-panel.js';
import { renderLandingEvidence } from './landing-evidence.js';
import { initRouter, navigate, type Route } from './router.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`main: missing #${id}`);
  return el as T;
}

function initRouting(): void {
  const routes: Record<Route, HTMLElement> = {
    home: byId('panel-home'),
    verify: byId('panel-verify'),
    publish: byId('panel-publish'),
    protocol: byId('panel-protocol'),
    docs: byId('panel-docs'),
  };
  // No dedicated nav-publish link in the v2 header — the evidence pipeline
  // is reached via footer/final CTA, not primary nav — so it has nothing
  // to highlight.
  const navLinks: Partial<Record<Route, HTMLElement>> = {
    home: byId('nav-home'),
    verify: byId('nav-verify'),
    protocol: byId('nav-protocol'),
    docs: byId('nav-docs'),
  };

  initRouter((route) => {
    for (const key of Object.keys(routes) as Route[]) {
      routes[key].hidden = key !== route;
      navLinks[key]?.classList.toggle('active', key === route);
    }
    // A #/verify?mode=... link clicked from elsewhere in the already-loaded
    // SPA is a same-document hash change, not a fresh page load — the
    // verifier panel's own one-time-at-init deep-link check would never
    // see it, so re-sync explicitly on every arrival at /verify.
    if (route === 'verify') syncModeFromHash();
    // jsdom (used by the automated UI tests) doesn't implement scrollTo; a
    // real browser always does, so this guard only matters for test noise.
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* no-op */
    }
  });
}

/**
 * The header's "Why / How it works / Reserve / Nostr" links point at
 * landing-page sections. From the landing page itself they're plain
 * in-page anchors (the router ignores non-route hashes, so the browser's
 * native smooth scroll — see `html { scroll-behavior: smooth }` — just
 * works). From an app route, clicking one must first navigate home, then
 * scroll, since the target section is inside the hidden landing route.
 */
function initScrollLinks(): void {
  const links = document.querySelectorAll<HTMLAnchorElement>('[data-scroll]');
  const homePanel = byId('panel-home');
  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const targetId = link.dataset.scroll;
      if (!targetId || !homePanel.hidden) return; // already home: let the native anchor jump happen
      event.preventDefault();
      navigate('home');
      requestAnimationFrame(() => {
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
      });
    });
  });
}

/** Mobile burger menu: below the 860px breakpoint (see style.css), .nav-mid/.nav-right are hidden and this drawer is the only way to reach nav links, so it must be keyboard-accessible, closeable, and close itself after navigation. */
function initMobileNav(): void {
  const burger = byId<HTMLButtonElement>('nav-burger');
  const drawer = byId<HTMLElement>('nav-drawer');
  const scrim = byId<HTMLElement>('nav-drawer-scrim');
  const topbar = document.querySelector<HTMLElement>('.topbar');

  function open(): void {
    // Start the drawer/scrim just below the real, current topbar height
    // (it varies by breakpoint) instead of covering it — .topbar sits
    // above both in z-index specifically so the burger button stays
    // reachable while open, and this keeps the drawer from rendering
    // its own links underneath that now-opaque strip.
    const top = topbar ? Math.round(topbar.getBoundingClientRect().bottom) : 0;
    drawer.style.top = `${top}px`;
    scrim.style.top = `${top}px`;
    drawer.hidden = false;
    scrim.hidden = false;
    burger.setAttribute('aria-expanded', 'true');
  }
  function close(): void {
    drawer.hidden = true;
    scrim.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
  }

  burger.addEventListener('click', () => (drawer.hidden ? open() : close()));
  scrim.addEventListener('click', close);
  drawer.querySelectorAll<HTMLAnchorElement>('[data-drawer-close]').forEach((link) => link.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) close();
  });
  window.addEventListener('hashchange', close);
}

initRouting();
initScrollLinks();
initMobileNav();
initVerifierPanel();
initPublisherPanel();
initDocsPanel();
void renderHeroPanel();
renderLandingEvidence();
