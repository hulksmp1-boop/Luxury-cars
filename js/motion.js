// Phase 4a: the driving motion system.
//
// Turns a single number, scroll progress 0..1, into forward travel:
//
//   progress -> distance (metres) -> world.update(distance, speed)   road, lamps, gantries, streaks
//                                 -> car.update(distance)            wheel rotation
//
// The car never moves: the world slides past it. Everything here is a pure function of progress, with no
// inertia, timers or random numbers, so the same scroll position always produces the same scene.
//
// Input: by default the page scroll position. The later GSAP timeline can take over without touching the rest:
//   motion.useScrollInput(false); then call motion.setProgress(p) from the timeline.
//
// This module does not import three, scene.js, car.js or world.js. Boot code passes them in.

export const MOTION = {
  totalDistance: 1400,   // metres driven over the whole page
  startSpeed: 0.25,      // speed profile: d(p) = D * (a * p + (1 - a) * p^2), so speed rises with progress
  reducedScale: 0.35,    // prefers-reduced-motion: the same scroll covers a third of the distance
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Metres travelled at scroll progress p (0..1). Smooth, monotonic, starts slowly. */
export function distanceAt(p) {
  const x = clamp01(p), a = MOTION.startSpeed;
  return MOTION.totalDistance * (a * x + (1 - a) * x * x);
}

/** Normalised speed 0..1 at progress p: the slope of distanceAt, divided by its maximum. */
export function speedAt(p) {
  const x = clamp01(p), a = MOTION.startSpeed;
  return (a + 2 * (1 - a) * x) / (2 - a);
}

/**
 * @param {{ stage?: object, car?: object, world?: object, reducedMotion?: boolean }} parts
 *        any of them may be missing (for example when the car failed to load)
 */
export function createMotion({ stage, car, world, reducedMotion = false } = {}) {
  const state = { progress: 0, distance: 0, speed: 0 };
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedMotion || motionQuery.matches;
  let degraded = false;       // set when the frame-rate watchdog lowers quality
  let scrollInput = false;
  let dirty = true;
  let maxScroll = 1;
  let disposed = false;

  // Streaks are the only expensive-looking effect: off for reduced motion and after a quality drop.
  const syncEffects = () => { world?.setStreaks?.(!reduced && !degraded); car?.setLightsDegraded?.(degraded); };

  /** Applies a progress value. Allocation-free: only numbers and calls into car and world. */
  function setProgress(p) {
    const k = reduced ? MOTION.reducedScale : 1;
    state.progress = clamp01(p);
    state.distance = distanceAt(state.progress) * k;
    state.speed = speedAt(state.progress);
    world?.update(state.distance, state.speed);
    car?.update(state.distance);
    car?.setLightProgress?.(state.progress, reduced);   // lights follow the same progress as the camera
    stage?.requestRender();
  }

  // ---------- Scroll input ----------
  const readProgress = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    return maxScroll > 1 ? y / maxScroll : 0;
  };
  const measure = () => {
    maxScroll = Math.max(1, document.documentElement.scrollHeight - document.documentElement.clientHeight);
    dirty = true;
  };
  const onScroll = () => { dirty = true; };

  // Scroll events only mark the state dirty; the work happens once per frame, just before rendering.
  const tick = () => {
    if (!dirty || !scrollInput) return;
    dirty = false;
    setProgress(readProgress());
  };
  let offFrame = null;
  if (stage?.onFrame) offFrame = stage.onFrame(tick);

  function useScrollInput(on) {
    if (on === scrollInput || disposed) return;
    scrollInput = !!on;
    if (scrollInput) {
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', measure);
      measure();
      setProgress(readProgress());
      if (!offFrame) { // no frame hook available: apply directly
        window.addEventListener('scroll', tick, { passive: true });
      }
    } else {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', tick);
    }
  }

  // The page height changes when fonts or images load: re-measure without a resize event.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  ro?.observe(document.body);

  const onMotionPref = (e) => { reduced = reducedMotion || e.matches; syncEffects(); setProgress(state.progress); };
  motionQuery.addEventListener('change', onMotionPref);
  const offQuality = stage?.onQualityChange?.(() => { degraded = true; syncEffects(); setProgress(state.progress); });

  syncEffects();
  useScrollInput(true);

  function dispose() {
    disposed = true;
    useScrollInput(false);
    offFrame?.();
    offQuality?.();
    ro?.disconnect();
    motionQuery.removeEventListener('change', onMotionPref);
  }

  return {
    state, setProgress, useScrollInput, dispose,
    get progress() { return state.progress; },
    get distance() { return state.distance; },
    get speed() { return state.speed; },
  };
}
