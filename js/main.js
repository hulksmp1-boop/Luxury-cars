// Boot: capability checks, loader, hand-off to the experience.
// Later phases import car/world/timeline/ui from here.

const root = document.documentElement;
const $ = (id) => document.getElementById(id);

export const env = {
  webgl: hasWebGL(),
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  coarsePointer: matchMedia('(pointer: coarse)').matches,
};

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

/**
 * Loader progress. Phase 1 simulates it; Phase 2+ calls setProgress()
 * from real asset loading (car model, environment map).
 */
const pct = $('loader-pct');
const bar = $('loader-bar');
let shownProgress = 0;
export function setProgress(p) {
  const v = Math.max(shownProgress, Math.min(1, p)); // never goes backwards: the timer and the real GLB download both report here
  shownProgress = v;
  pct.textContent = Math.round(v * 100);
  bar.style.transform = `scaleX(${v})`;
}

function simulateLoad(ms = 1600) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      setProgress(0.9 * (1 - Math.pow(1 - p, 3))); // the last 10% is real: set when the scene is built
      p < 1 ? requestAnimationFrame(tick) : resolve();
    };
    requestAnimationFrame(tick);
  });
}

/** The WebGL stage (see scene.js). null when WebGL is unavailable or failed. */
export let stage = null;

/** The car (see car.js). null until built, or when the stage or the car failed to load. */
export let car = null;

/** The road and environment (see world.js). null until built, or when the stage or the world failed to load. */
export let world = null;

/** The driving motion system (see motion.js): scroll progress -> world movement and wheel spin. */
export let motion = null;

/** The camera choreography (see timeline.js): one master GSAP timeline scrubbed by the page scroll. */
export let timeline = null;

let stageAborted = false;
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function initStage() {
  if (!env.webgl) return null;
  try {
    // Dynamic import + timeout: a blocked or slow CDN falls back instead of hanging the loader.
    const { createScene, CAR_BOUNDS } = await withTimeout(import('./scene.js'), 10000);
    if (stageAborted) return null;
    stage = createScene($('gl'), {
      onContextLost: () => root.classList.add('no-webgl'),
      onContextRestored: () => root.classList.remove('no-webgl'),
    });
    root.dataset.quality = stage.quality; // CSS hook (e.g. grain is dropped on the low tier)
    stage.onQualityChange(() => { root.dataset.quality = 'low'; });
    await initCar(CAR_BOUNDS);
    await initWorld();
    await initMotion();
    await initTimeline();
  } catch (err) {
    stageAborted = true;
    console.warn('[aether] WebGL scene unavailable, using fallback.', err);
    stage = null;
    root.dataset.quality = 'low';
    root.classList.add('no-webgl');
  }
  return stage;
}

/** Loads the real car (GLB) and adds it to the stage; car.js falls back to the procedural car if that fails.
 *  A failure here keeps the empty stage instead of the fallback. */
async function initCar(bounds) {
  try {
    const mod = await withTimeout(import('./car.js'), 10000);
    if (stageAborted || !stage) return;
    car = await mod.initCarFromGLB(stage, {
      bounds,
      onProgress: (f) => setProgress(0.9 * f),
      signal: { get cancelled() { return stageAborted; } },
    });
  } catch (err) {
    console.warn('[aether] Car failed to load, continuing without it.', err);
    car = null;
  }
}

/** Builds the road and environment. A failure here keeps the stage and the car. */
async function initWorld() {
  try {
    const mod = await withTimeout(import('./world.js'), 10000);
    if (stageAborted || !stage) return;
    world = mod.initWorld(stage);
  } catch (err) {
    console.warn('[aether] World failed to load, continuing without it.', err);
    world = null;
  }
}

/** Connects scroll to the car and the world. Without it the scene simply stays parked. */
async function initMotion() {
  try {
    const mod = await withTimeout(import('./motion.js'), 10000);
    if (stageAborted || !stage) return;
    motion = mod.createMotion({ stage, car, world, reducedMotion: env.reducedMotion });
  } catch (err) {
    console.warn('[aether] Motion system failed to load, scene stays parked.', err);
    motion = null;
  }
}

/** Hands scroll over to the master timeline. If GSAP cannot load, motion.js keeps driving the world alone. */
async function initTimeline() {
  try {
    const mod = await withTimeout(import('./timeline.js'), 10000);
    if (stageAborted || !stage) return;
    timeline = mod.buildTimeline({ stage, car, world, motion, story: $('story'), reducedMotion: env.reducedMotion });
  } catch (err) {
    console.warn('[aether] Camera timeline failed to load, keeping the hero camera.', err);
    timeline = null;
  }
}

/** Scene text, progress line and counter (see ui.js). Works with or without the timeline and WebGL. */
async function initUIOverlay() {
  try {
    const mod = await withTimeout(import('./ui.js'), 10000);
    mod.initUI(timeline);
  } catch (err) {
    console.warn('[aether] UI overlay failed to load, scenes stay as plain sections.', err);
  }
}

async function boot() {
  root.classList.toggle('no-webgl', !env.webgl);
  if (!env.webgl) root.dataset.quality = 'low';
  root.classList.toggle('reduced-motion', env.reducedMotion);

  // Minimum loader time and scene setup run together.
  await Promise.all([simulateLoad(env.reducedMotion ? 200 : 1600), initStage()]);
  setProgress(1);

  await initUIOverlay();

  root.classList.remove('is-loading');
  root.classList.add('is-ready');
  stage?.start();
  window.dispatchEvent(new CustomEvent('experience:ready', { detail: { env, stage, car, world, motion, timeline } }));
}

boot();
