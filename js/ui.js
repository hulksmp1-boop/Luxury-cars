// Phase 5: scene labels, editorial copy sync, progress line and scene counter.
//
// Progress comes from the camera timeline (timeline.onProgress), so the text is driven by the exact value that
// moves the camera. If the timeline is unavailable (WebGL or GSAP failed), the same number is derived from the
// scroll position, so the typography still works. Scene timing is scenes.js; the HTML sections are matched to it
// by data-scene (1-based index). Only opacity and transform are animated, in CSS (see "Scene overlays").
//
//   initUI(timeline?) -> { dispose }

import { SCENES, sceneAt } from './scenes.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pad2 = (n) => String(n).padStart(2, '0');

export function initUI(timeline) {
  const root = document.documentElement;
  const story = document.getElementById('story');
  const bar = document.getElementById('progress-bar');
  const counterNow = document.getElementById('counter-now');
  const counterTotal = document.getElementById('counter-total');
  if (!story) return null;

  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- Match sections to SCENES ----
  const scenes = SCENES.map((def, i) => {
    const el = story.querySelector(`.scene[data-scene="${i + 1}"]`);
    if (!el) { console.warn(`[aether] No section for scene ${i + 1} (${def.label}).`); return null; }

    // Label text comes from SCENES, so it cannot drift from the timing table: "01 — Presence".
    const label = el.querySelector('[data-label]');
    if (label) {
      const num = document.createElement('span');
      num.className = 'scene__num';
      num.textContent = pad2(i + 1);
      label.replaceChildren(num, document.createTextNode(` — ${def.label}`));
    }
    // Stagger index for the reveal (used by CSS as --i).
    el.querySelectorAll('.reveal').forEach((node, n) => node.style.setProperty('--i', n));
    return el;
  });

  let active = -1;
  let lastP = -1;

  function setScene(i) {
    if (i === active) return;
    const prev = active;
    active = i;
    scenes.forEach((el, n) => {
      if (!el) return;
      el.classList.toggle('is-active', n === i);
      el.classList.toggle('is-after', n < i);
    });
    if (counterNow) {
      counterNow.textContent = pad2(i + 1);
      if (prev >= 0 && !motionQuery.matches && counterNow.animate) {
        counterNow.animate(
          [{ opacity: 0, transform: 'translateY(.35rem)' }, { opacity: 1, transform: 'none' }],
          { duration: 450, easing: 'cubic-bezier(.22,.8,.2,1)' },
        );
      }
    }
    root.dataset.scene = String(i + 1);
  }

  function update(p) {
    p = clamp01(p);
    if (p === lastP) return;
    lastP = p;
    if (bar) bar.style.transform = `scaleX(${p})`;
    setScene(sceneAt(p));
  }

  // ---- Progress source ----
  let offProgress = null;
  let onScroll = null;
  if (timeline?.onProgress) {
    offProgress = timeline.onProgress(update);
  } else {
    // Same maths as the ScrollTrigger on #story (top top -> bottom bottom).
    const fromScroll = () => {
      const range = story.offsetHeight - window.innerHeight;
      const top = story.getBoundingClientRect().top;
      update(range > 0 ? -top / range : 0);
    };
    onScroll = fromScroll;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    fromScroll();
  }

  // Switch to overlay layout (story keeps one viewport of scroll per scene; see CSS "Scene overlays").
  if (counterTotal) counterTotal.textContent = pad2(SCENES.length);
  root.style.setProperty('--scenes', String(SCENES.length));
  root.classList.add('ui-ready');
  if (active < 0) setScene(sceneAt(clamp01(lastP < 0 ? 0 : lastP)));
  if (bar && lastP < 0) bar.style.transform = 'scaleX(0)';

  function dispose() {
    offProgress?.();
    if (onScroll) {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    }
    root.classList.remove('ui-ready');
  }

  return { dispose, get scene() { return active; } };
}
