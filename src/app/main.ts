import './style.css';
import { gsap } from 'gsap';
import { initVerifierPanel, syncModeFromHash } from './verifier-panel.js';
import { initPublisherPanel } from './publisher-panel.js';
import { initDocsPanel } from './docs-panel.js';
import { initLabPanel } from './lab-panel.js';
import { enterRealMintPanel, initRealMintPanel } from './real-mint-panel.js';
import { renderHeroPanel } from './hero-panel.js';
import { refreshLandingLive, renderLandingEvidence } from './landing-evidence.js';
import { refreshEvidenceLive } from './publisher-panel.js';
import { startAgeTicker } from './live-status.js';
import { initLandingMotion, refreshLandingMotion } from './landing-motion.js';
import { initRouter, navigate, type Route } from './router.js';
import { initProtocolToc, syncProtocolSection } from './protocol-toc.js';
import { relayAssistFor } from './relay-assist.js';
import { setDefaultAssistedRelayFetch } from './submission.js';

// Browsers or networks that cannot open relay WebSockets fall back to the
// configured evidence service's HTTPS relay fetch (verified here either way).
const evidenceUrl = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}).VITE_SOLVENT_EVIDENCE_URL;
if (evidenceUrl) setDefaultAssistedRelayFetch(relayAssistFor(evidenceUrl));

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`main: missing #${id}`);
  return el as T;
}

export const ROUTE_TITLES: Record<Route, string> = {
  home: 'SOLVENT — Auditable Ecash',
  mint: 'SOLVENT — Live Mint',
  verify: 'SOLVENT — Verify',
  protocol: 'SOLVENT — Protocol',
  publish: 'SOLVENT — Evidence',
  docs: 'SOLVENT — Docs',
  lab: 'SOLVENT — Reference Lab',
};

let currentRoute: Route = 'home';
let landingReady = false;
let publishReady = false;

function initRouting(): void {
  const routes: Record<Route, HTMLElement> = {
    home: byId('panel-home'),
    verify: byId('panel-verify'),
    mint: byId('panel-mint'),
    publish: byId('panel-publish'),
    protocol: byId('panel-protocol'),
    docs: byId('panel-docs'),
    lab: byId('panel-lab'),
  };
  const navLinks: Partial<Record<Route, HTMLElement>> = {
    home: byId('nav-home'),
    verify: byId('nav-verify'),
    mint: byId('nav-mint'),
    publish: byId('nav-publish'),
    protocol: byId('nav-protocol'),
    docs: byId('nav-docs'),
  };

  initRouter((route) => {
    for (const key of Object.keys(routes) as Route[]) {
      routes[key].hidden = key !== route;
      navLinks[key]?.classList.toggle('active', key === route);
    }
    // Landing-section anchors ("Why", "Reserve"…) are shown only on the
    // landing page; elsewhere the header is plain site navigation.
    document.body.dataset.route = route;
    document.title = ROUTE_TITLES[route];
    // A #/verify?mode=... link clicked from elsewhere in the already-loaded
    // SPA is a same-document hash change, not a fresh page load — the
    // verifier panel's own one-time-at-init deep-link check would never
    // see it, so re-sync explicitly on every arrival at /verify.
    if (route === 'verify') syncModeFromHash();
    if (route === 'mint') enterRealMintPanel();
    if (route === 'protocol') syncProtocolSection();
    // Live observations are refreshed on every arrival (cached ones are labelled as such).
    if (route === 'home' && landingReady) void refreshLandingLive();
    if (route === 'publish' && publishReady) void refreshEvidenceLive();
    currentRoute = route;
    // Scroll-trigger positions measured while the landing route was hidden
    // are wrong; re-measure once it is visible again.
    if (route === 'home') refreshLandingMotion();
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
  const items = drawer.querySelectorAll('a, .nav-drawer-heading, .nav-drawer-footnote');
  let motion: gsap.core.Timeline | undefined;
  let isOpen = false;
  const reduceMotion = () => !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function open(): void {
    motion?.kill();
    isOpen = true;
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
    burger.setAttribute('aria-label', 'Close menu');
    document.body.style.overflowY = 'hidden';
    if (!reduceMotion()) {
      motion = gsap.timeline({ defaults: { ease: 'power3.out' } })
        .fromTo(scrim, { opacity: 0 }, { opacity: 1, duration: 0.35 })
        .fromTo(drawer, { xPercent: 105 }, { xPercent: 0, duration: 0.65 }, 0)
        .fromTo(items, { y: 25, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.045, duration: 0.45 }, 0.18);
    } else {
      gsap.set([drawer, scrim, ...items], { clearProps: 'all' });
      drawer.style.top = `${top}px`;
      scrim.style.top = `${top}px`;
    }
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    motion?.kill();
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
    document.body.style.overflowY = '';
    burger.focus({ preventScroll: true });
    const finish = () => { drawer.hidden = true; scrim.hidden = true; };
    if (reduceMotion()) finish();
    else motion = gsap.timeline({ onComplete: finish })
      .to(drawer, { xPercent: 105, duration: 0.32, ease: 'power3.in' })
      .to(scrim, { opacity: 0, duration: 0.3 }, 0);
  }

  burger.addEventListener('click', () => (isOpen ? close() : open()));
  scrim.addEventListener('click', close);
  drawer.querySelectorAll<HTMLAnchorElement>('[data-drawer-close]').forEach((link) => link.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) close();
    if (e.key === 'Tab' && isOpen) {
      const links = Array.from(drawer.querySelectorAll<HTMLAnchorElement>('a'));
      const stops = [burger, ...links];
      const index = stops.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      stops[(index + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
    }
  });
  window.addEventListener('hashchange', close);
  window.addEventListener('resize', () => { if (window.innerWidth > 860) close(); });
}

function initEntrance(): void {
  if (!window.matchMedia) return;
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
    gsap.timeline({ defaults: { duration: 0.8, ease: 'power3.out', clearProps: 'all' } })
      .from('.hero-copy > *', { y: 32, opacity: 0, stagger: 0.1 }, 0.08)
      .from('.hero-panel-wrap', { y: 45, opacity: 0, scale: 0.97 }, 0.3)
      .from('.hero-bands', { clipPath: 'inset(0 100% 0 0)', duration: 1.3, ease: 'power2.inOut' }, 0.15);
  });
}

initRouting();
initScrollLinks();
initMobileNav();
initEntrance();
initVerifierPanel();
initPublisherPanel();
initDocsPanel();
initLabPanel();
initRealMintPanel();
initProtocolToc();
void renderHeroPanel();
renderLandingEvidence();
landingReady = true;
publishReady = true;
startAgeTicker();
// Back to a tab left open: refresh what is on screen rather than show an old observation as current.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (currentRoute === 'home') void refreshLandingLive();
  if (currentRoute === 'publish') void refreshEvidenceLive();
});
// After renderLandingEvidence(): the attack-corpus and FAQ rows it renders
// are animation targets, and the attack count it sets is the count-up's end
// value.
initLandingMotion();
