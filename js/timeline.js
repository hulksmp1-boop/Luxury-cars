// Phase 4b: cinematic camera choreography on one master GSAP timeline.
//
//   page scroll --ScrollTrigger (scrub: true)--> master timeline progress p (0..1)
//        p --> camera pose (this file, a pure function of p and the viewport)
//        p --> motion.setProgress(p) --> world.update(distance, speed) + car.update(distance)
//
// One system owns movement: this timeline. motion.js's own scroll listener is switched off, so the world, the
// wheels and the camera all come from the same p. Nothing here uses timers or randomness, and scrub is exact
// (no smoothing lag), so the same scroll position and viewport always give the same camera and world state.
//
// Camera path: keyframes in `KEYS`, joined with eased interpolation (no overshoot, so the camera can never swing
// through the car). Each keyframe is a camera position in polar form around the car (azimuth, radius, height),
// a look-at target and a "width to keep in frame" used to pull the camera back on portrait screens.
//
// WORLD CONVENTION (scene.js): the car sits at the origin facing +Z; its left side is +X. Azimuth 0 = in front,
// 90 = the car's left side, 180 = behind.
//
// Needs gsap and gsap/ScrollTrigger from the importmap in index.html. If they fail to load, main.js catches the
// error and the page keeps the hero camera with motion.js scroll travel.

import * as GSAPModule from 'gsap';
import * as ScrollTriggerModule from 'gsap/ScrollTrigger';

const gsap = GSAPModule.gsap || GSAPModule.default;
const ScrollTrigger = ScrollTriggerModule.ScrollTrigger || ScrollTriggerModule.default;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
// Scene timing lives in scenes.js (shared with ui.js). Keep the KEYS below inside the same ranges.
import { SCENES } from './scenes.js';
export { SCENES };

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------
// [progress, azimuth deg, radius m, height m, target x, target y, target z, width m, calmOf]
//  radius: horizontal distance from the car's centre.
//  width:  how wide a slice of the world must fit across the screen; only matters on narrow screens.
//  calmOf: index of an earlier keyframe. Keyframes that only add a small drift inside a shot point at their
//          shot's main frame, so phones and reduced-motion users can blend the drift away (see `calm`).
const KEYS = [
  /* 0 */ [0.000,  35.0, 7.38, 1.22,  0.00, 0.50,  0.00, 5.2, -1], // opening: same framing scene.js starts with
  /* 1 */ [0.100,  38.0, 6.90, 1.05,  0.00, 0.50,  0.05, 5.0,  0],  // slow push-in
  /* 2 */ [0.300,  62.0, 6.00, 0.85,  0.00, 0.52,  0.40, 5.2, -1], // presence: front-side
  /* 3 */ [0.360,  68.0, 5.90, 0.75,  0.00, 0.52,  0.40, 5.2,  2],
  /* 4 */ [0.440,  84.0, 5.60, 0.50,  0.00, 0.50,  0.80, 5.0, -1], // side profile, low, starts at the front axle
  /* 5 */ [0.510,  98.0, 5.60, 0.46,  0.00, 0.50, -0.80, 5.0,  4],  // ...and tracks back along the car
  /* 6 */ [0.590,  58.0, 3.20, 0.38,  0.90, 0.36,  1.40, 1.5, -1], // wheel detail
  /* 7 */ [0.660,  66.0, 3.10, 0.42,  0.90, 0.38,  1.38, 1.5,  6],
  /* 8 */ [0.775,  18.0, 4.40, 0.52,  0.50, 0.58,  2.10, 2.4, -1], // headlight detail
  /* 9 */ [0.840,   8.0, 4.90, 0.62,  0.30, 0.58,  1.90, 2.4,  8],
  /*10 */ [0.910, 188.0, 6.20, 1.00,  0.00, 0.62, -0.20, 3.6, -1], // rear chase
  /*11 */ [0.935, 194.0, 5.90, 1.00,  0.00, 0.62, -0.20, 3.6, 10],
  /*12 */ [1.000, 215.0, 8.60, 3.60,  0.00, 0.45,  0.20, 5.4, -1], // finale: high, rising
];
const CH = 7;      // channels interpolated: azimuth, radius, height, target xyz, width
const N = KEYS.length;

// Rails stand at x = 6.45 (world.js). Beyond about 5.8 m sideways the camera is lifted so the low rail never
// hides the car.
const RAIL_CLEAR_X = 5.8;
const RAIL_LIFT = 0.9;
const MAX_PULLBACK = 3.2;   // upper bound on the portrait pull-back factor

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * @param {{ stage: object, car?: object, world?: object, motion?: object, story?: Element,
 *           reducedMotion?: boolean }} parts
 */
export function buildTimeline({ stage, motion, story, reducedMotion = false }) {
  if (!stage?.camera) throw new Error('buildTimeline needs the stage');
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true }); // the mobile URL bar must not restart the scroll maths

  const { camera, cameraTarget } = stage;
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)').matches;
  let reduced = reducedMotion || motionQuery.matches;

  // Everything below is allocated once; the per-scroll path only does arithmetic.
  const keyP = new Float64Array(N);
  const table = new Float64Array(N * CH);
  const cur = new Float64Array(CH);
  KEYS.forEach((k, i) => { keyP[i] = k[0]; });

  let calm = -1;     // 1 = full drift, lower = drift blended away
  let lastP = 0, lastAspect = 0, lastFov = 0;

  /** Resolves the keyframes for a given amount of drift. Called only when `calm` changes. */
  function resolveKeys(c) {
    calm = c;
    for (let i = 0; i < N; i++) {
      const k = KEYS[i];
      const base = k[8] >= 0 ? KEYS[k[8]] : null;
      for (let j = 0; j < CH; j++) {
        const v = k[j + 1];
        table[i * CH + j] = base ? base[j + 1] + (v - base[j + 1]) * c : v;
      }
    }
  }

  /** Writes the camera pose for progress p into `cur`. */
  function sample(p) {
    let i = 0;
    while (i < N - 2 && p > keyP[i + 1]) i++;
    const span = keyP[i + 1] - keyP[i];
    let t = span > 0 ? clamp01((p - keyP[i]) / span) : 0;
    // Reduced motion: hold each frame, then change shot quickly in the middle of the segment, with no long sweeps.
    t = reduced ? smooth(clamp01((t - 0.35) / 0.3)) : smooth(t);
    const a = i * CH, b = a + CH;
    for (let c = 0; c < CH; c++) cur[c] = table[a + c] + (table[b + c] - table[a + c]) * t;
  }

  function applyCamera(p) {
    const aspect = camera.aspect, fov = camera.fov;
    lastAspect = aspect; lastFov = fov;
    // Gentler drift on phones and for reduced motion.
    const want = reduced ? 0.3 : (coarse && aspect < 1 ? 0.55 : 1);
    if (want !== calm) resolveKeys(want);

    sample(p);
    const az = cur[0] * Math.PI / 180, r = cur[1];
    const tx = cur[3], ty = cur[4], tz = cur[5];
    let dx = r * Math.sin(az) - tx, dy = cur[2] - ty, dz = r * Math.cos(az) - tz;

    // Portrait and narrow screens: keep `width` metres across the frame by backing away from the target along the
    // line of sight. Never moves the camera closer than the authored position, so it cannot enter the car.
    const hFov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * aspect);
    const need = (cur[6] / 2) / Math.tan(hFov / 2);
    const dist = Math.hypot(dx, dz) || 1;
    const k = Math.min(MAX_PULLBACK, Math.max(1, need / dist));
    dx *= k; dy *= k; dz *= k;

    const x = tx + dx, z = tz + dz;
    const lift = clamp01((Math.abs(x) - RAIL_CLEAR_X) / 3) * RAIL_LIFT;
    camera.position.set(x, Math.max(0.22, ty + dy + lift), z);
    cameraTarget.set(tx, ty, tz);
  }

  const subs = new Set();   // progress listeners (ui.js)

  /** The single entry point for scroll: camera, world and wheels all come from p. */
  function apply(p) {
    lastP = p;
    applyCamera(p);
    for (const fn of subs) fn(p);
    if (motion) motion.setProgress(p);
    else stage.requestRender();
  }

  // ---------- The master timeline ----------
  // Duration 1, so a time on the timeline IS the scroll progress. Scene starts are labels (for the UI phase).
  const proxy = { p: 0 };
  const timeline = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: story || document.getElementById('story') || document.body,
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,               // exact: no time-based smoothing, so position fully determines state
      invalidateOnRefresh: true,
    },
  });
  SCENES.forEach((s) => timeline.addLabel(s.name, s.from));
  timeline.to(proxy, { p: 1, duration: 1, onUpdate: () => apply(proxy.p) }, 0);

  // ---------- Hand over from the independent systems ----------
  // Idle camera drift in scene.js is time-based, so it is turned off (also stops needless continuous rendering).
  const stopIdle = () => {
    if (stage.ambient) { stage.ambient = false; stage.rig?.position.set(0, 0, 0); }
  };
  stage.autoFrame = false;      // scene.js stops positioning the camera on resize
  stopIdle();
  motion?.useScrollInput(false);
  apply(timeline.progress());

  // Resizes change aspect and fov (scene.js); re-apply so the framing adapts. Cheap check, no allocation.
  const offFrame = stage.onFrame?.(() => {
    stopIdle();
    if (camera.aspect !== lastAspect || camera.fov !== lastFov) { applyCamera(lastP); stage.requestRender(); }
  });

  const onMotionPref = (e) => { reduced = reducedMotion || e.matches; calm = -1; apply(lastP); };
  motionQuery.addEventListener('change', onMotionPref);

  // The loader hides the page and fonts can change its height: measure again once the experience is shown.
  const onReady = () => { ScrollTrigger.refresh(); };
  window.addEventListener('experience:ready', onReady, { once: true });

  function dispose() {
    window.removeEventListener('experience:ready', onReady);
    motionQuery.removeEventListener('change', onMotionPref);
    offFrame?.();
    timeline.scrollTrigger?.kill();
    timeline.kill();
    stage.autoFrame = true;
    motion?.useScrollInput(true);
  }

  /** Calls fn(p) now and on every progress change; returns an unsubscribe function. */
  function onProgress(fn) { subs.add(fn); fn(lastP); return () => subs.delete(fn); }

  return { timeline, scenes: SCENES, apply, onProgress, get progress() { return lastP; }, dispose };
}
