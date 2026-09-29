// Scroll-driven GSAP motion for every landing-page section below the hero
// (the hero's own entrance timeline lives in main.ts). Each section gets a
// short timeline that plays once, when the section scrolls into view, and
// is choreographed to what the section is saying: the problem shows the
// verified token before the two unknowns, the solution flow steps from
// issuance to the decision, the promise chain cascades receipt -> epoch ->
// REFUSE, the enforcement flow splits into its accept/refuse branches, and
// so on.
//
// Content is never hidden unless motion will reveal it:
//   - nothing runs without matchMedia (jsdom/UI tests) or when the visitor
//     prefers reduced motion — the page then renders exactly as authored;
//   - every trigger's start is clamp()ed to the page's scroll range, so a
//     section near the bottom of a short page still reaches its trigger;
//   - animated properties (transform/opacity) are cleared on completion, so
//     the final state is always the stylesheet's own.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let initialized = false;

type Q = (selector: string) => Element[];

const CLEAR = 'transform,opacity';

function sectionTimeline(section: Element, start = 'clamp(top 80%)'): gsap.core.Timeline {
  return gsap.timeline({
    defaults: { duration: 0.7, ease: 'power3.out', clearProps: CLEAR },
    scrollTrigger: { trigger: section, start, once: true },
  });
}

/** Adds a `from` tween only when the selector matched something, so a
 * section whose dynamic content hasn't rendered never produces a GSAP
 * "target not found" warning. */
function from(tl: gsap.core.Timeline, targets: Element[], vars: gsap.TweenVars, position?: gsap.Position): void {
  if (targets.length > 0) tl.from(targets, vars, position);
}

function header(tl: gsap.core.Timeline, q: Q, position: gsap.Position = 0): void {
  from(tl, q('.section-inner > .eyebrow, .section-inner > .section-heading, .section-inner > .section-body:not(.enforcement-note)'), { y: 28, opacity: 0, stagger: 0.08 }, position);
}

function scoped(section: Element): Q {
  return (selector) => Array.from(section.querySelectorAll(selector));
}

const choreography: Record<string, (tl: gsap.core.Timeline, q: Q) => void> = {
  // The token is verified; then, after "but", the two things it can't show.
  '.problem-gap': (tl, q) => {
    header(tl, q);
    from(tl, q('.gap-card-known'), { y: 26, opacity: 0 }, 0.3);
    from(tl, q('.gap-but'), { opacity: 0 }, 0.55);
    from(tl, q('.gap-card-unknown'), { y: 26, opacity: 0, stagger: 0.14 }, 0.7);
    from(tl, q('.gap-callout'), { y: 18, opacity: 0 }, 1.05);
  },

  // Issuance through to the decision, one step at a time.
  '.solution': (tl, q) => {
    header(tl, q);
    from(tl, q('.solution-flow li'), { y: 24, opacity: 0, stagger: 0.1, duration: 0.5 }, 0.3);
    from(tl, q('.solution-punchline'), { y: 14, opacity: 0 }, '-=0.1');
  },

  '.who-for': (tl, q) => {
    header(tl, q);
    from(tl, q('.who-for-lede'), { y: 16, opacity: 0 }, 0.2);
    from(tl, q('.who-for-card'), { y: 40, opacity: 0, stagger: 0.1 }, 0.3);
  },

  // Copy builds on the left while the promise chain cascades on the right,
  // ending on the REFUSE block.
  '.problem#why': (tl, q) => {
    from(tl, q('.problem-copy > .eyebrow, .problem-copy > .section-heading, .problem-copy > .section-body'), { y: 28, opacity: 0, stagger: 0.08 });
    from(tl, q('.checklist li'), { x: -20, opacity: 0, stagger: 0.08 }, 0.35);
    from(tl, q('.problem-copy > .btn'), { y: 14, opacity: 0 }, 0.7);
    from(tl, q('.promise-chain-card'), { y: 36, opacity: 0 }, 0.1);
    from(tl, q('.promise-block:not(.promise-block-result), .promise-arrow'), { y: 18, opacity: 0, stagger: 0.14 }, 0.35);
    from(tl, q('.promise-block-result'), { scale: 0.9, opacity: 0, ease: 'back.out(1.7)', duration: 0.6 }, 1.0);
  },

  // Mirror of the previous section: the report card leads, from the left.
  '.problem-solvency': (tl, q) => {
    from(tl, q('.report-grid-card'), { x: -36, opacity: 0 });
    from(tl, q('.report-grid-card > .grid-cell, .report-grid-card > .grid-divider'), { y: 10, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.25);
    from(tl, q('.problem-copy > .eyebrow, .problem-copy > .section-heading, .problem-copy > .section-body'), { y: 28, opacity: 0, stagger: 0.08 }, 0.1);
    from(tl, q('.checklist li'), { x: -20, opacity: 0, stagger: 0.08 }, 0.45);
  },

  '.how-to-try': (tl, q) => {
    header(tl, q);
    from(tl, q('.how-to-try-step'), { y: 36, opacity: 0, stagger: 0.12 }, 0.25);
    from(tl, q('.how-to-try-num'), { scale: 0.4, opacity: 0, ease: 'back.out(2)', stagger: 0.12, duration: 0.5 }, 0.35);
    from(tl, q('.gate-cta'), { y: 16, opacity: 0 }, '-=0.2');
  },

  '.gate': (tl, q) => {
    header(tl, q);
    from(tl, q('.gate-card'), { y: 48, opacity: 0, stagger: 0.12, duration: 0.8 }, 0.25);
    from(tl, q('.gate-cta'), { y: 16, opacity: 0 }, '-=0.3');
  },

  '.protocols-strip': (tl, q) => {
    from(tl, q('.eyebrow'), { y: 16, opacity: 0 });
    from(tl, q('.protocol-marks > span'), { y: 22, opacity: 0, stagger: 0.08 }, 0.1);
    from(tl, q('.protocols-note'), { y: 12, opacity: 0 }, '-=0.3');
  },

  // VERIFY, then the flow splits: ACCEPT from the left, refusal from the
  // right, then both outcomes land.
  '.enforcement': (tl, q) => {
    header(tl, q);
    from(tl, q('.enforcement-step'), { scale: 0.88, opacity: 0, ease: 'back.out(1.6)' }, 0.35);
    from(tl, q('.enforcement-flow > .enforcement-arrow'), { opacity: 0, scale: 0.6 }, 0.6);
    from(tl, q('.enforcement-branch-accept'), { x: -40, opacity: 0 }, 0.75);
    from(tl, q('.enforcement-branch-refuse'), { x: 40, opacity: 0 }, 0.75);
    from(tl, q('.enforcement-branch-result'), { scale: 0.9, opacity: 0, stagger: 0.1, ease: 'back.out(1.6)' }, 1.05);
    from(tl, q('.enforcement-note'), { y: 14, opacity: 0 }, 1.2);
  },

  '#reserve': (tl, q) => {
    header(tl, q);
    from(tl, q('.reserve-network-label'), { y: 12, opacity: 0 }, 0.2);
    from(tl, q('.reserve-panel'), { y: 30, opacity: 0 }, 0.3);
    from(tl, q('.reserve-panel > .grid-cell'), { y: 10, opacity: 0, stagger: 0.05, duration: 0.45 }, 0.45);
    from(tl, q('.reserve-live-note'), { opacity: 0 }, '-=0.2');
  },

  '#nostr': (tl, q) => {
    header(tl, q);
    from(tl, q('.nostr-panel'), { y: 30, opacity: 0 }, 0.3);
    from(tl, q('.nostr-panel > .grid-cell, .nostr-panel > .grid-divider'), { y: 10, opacity: 0, stagger: 0.05, duration: 0.45 }, 0.45);
  },

  '.editorial': (tl, q) => {
    from(tl, q('.section-inner > .eyebrow'), { y: 16, opacity: 0 });
    from(tl, q('.editorial-quote'), { y: 30, opacity: 0, duration: 1 }, 0.1);
    from(tl, q('.proves-col'), { y: 30, opacity: 0, stagger: 0.15 }, 0.45);
    from(tl, q('.proves-list li'), { x: -16, opacity: 0, stagger: 0.04, duration: 0.45 }, 0.6);
    from(tl, q('.proves-link'), { opacity: 0 }, '-=0.2');
  },

  // The count animates up to the real value already rendered from the
  // attack-corpus evidence, and is restored to that exact text at the end.
  // It starts at position 0, while header() is still fading the heading in
  // from opacity 0, so the real number never flashes before the count-up.
  '.attack-corpus': (tl, q) => {
    header(tl, q);
    const count = q('#attack-count')[0];
    const finalText = count?.textContent ?? '';
    const finalValue = Number(finalText);
    if (count && finalText !== '' && Number.isInteger(finalValue) && finalValue > 0) {
      const counter = { value: 0 };
      tl.to(counter, {
        value: finalValue,
        duration: 1.1,
        ease: 'power2.out',
        clearProps: '',
        onStart: () => { count.textContent = '0'; },
        onUpdate: () => { count.textContent = String(Math.round(counter.value)); },
        onComplete: () => { count.textContent = finalText; },
      }, 0);
    }
    from(tl, q('.attack-row'), { x: -24, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.35);
    from(tl, q('.gate-cta'), { y: 16, opacity: 0 }, '-=0.2');
  },

  '.faq-section': (tl, q) => {
    header(tl, q);
    from(tl, q('.faq-row'), { y: 20, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.25);
  },

  '.final-cta-section': (tl, q) => {
    from(tl, q('.final-cta-panel'), { y: 36, scale: 0.95, opacity: 0, duration: 0.9 });
    from(tl, q('.final-cta-content > *'), { y: 24, opacity: 0, stagger: 0.1 }, 0.25);
  },
};

export function initLandingMotion(): void {
  if (initialized || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const landing = document.getElementById('panel-home');
  if (!landing) return;
  initialized = true;
  gsap.registerPlugin(ScrollTrigger);

  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
    for (const [selector, build] of Object.entries(choreography)) {
      const section = landing.querySelector(`:scope > section${selector}`);
      if (!section) continue;
      build(sectionTimeline(section), scoped(section));
    }

    // The hero terminal drifts up slightly as the hero scrolls away. It
    // animates .terminal, not .hero-panel-wrap, so it never fights the
    // hero entrance timeline, which owns the wrapper's transform.
    const terminal = landing.querySelector('.hero .terminal');
    const hero = landing.querySelector(':scope > section.hero');
    if (terminal && hero) {
      gsap.to(terminal, { y: -40, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.6 } });
    }
  });
}

/** Recompute every trigger position. The landing route is display:none
 * while another route is showing, so positions measured then are wrong;
 * call this whenever the landing route becomes visible again. */
export function refreshLandingMotion(): void {
  if (!initialized) return;
  requestAnimationFrame(() => ScrollTrigger.refresh());
}
