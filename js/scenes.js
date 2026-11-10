// The one source of truth for scene timing and editorial labels.
//
// Read by timeline.js (camera labels) and ui.js (text, counter). It has no imports on purpose, so the typography
// still follows scroll if GSAP fails to load and timeline.js never runs.
//
// Progress ranges from the brief. It lists six ranges for seven scenes, so the last range (85-100%) is shared:
// the rear chase takes its first half and the finale pull-up the rest. Edit here to retime a scene; keep the
// KEYS in timeline.js inside the same ranges. The HTML sections (data-scene="1".."7") map to these entries by
// order, and their text switches at exactly `from`.
//
//   name:  camera shot id (timeline label)
//   label: editorial scene label, shown as "NN — Label"
export const SCENES = [
  { name: 'opening',   label: 'Presence',  from: 0.00, to: 0.20 },  // front three-quarter, slow push-in
  { name: 'presence',  label: 'Velocity',  from: 0.20, to: 0.40 },  // front-side angle
  { name: 'side',      label: 'Precision', from: 0.40, to: 0.55 },  // low tracking shot along the flank
  { name: 'wheel',     label: 'Detail',    from: 0.55, to: 0.70 },  // close on the front wheel
  { name: 'headlight', label: 'Signature', from: 0.70, to: 0.85 },  // close on the headlight
  { name: 'rear',      label: 'Departure', from: 0.85, to: 0.93 },  // swing round behind the car
  { name: 'finale',    label: 'Legacy',    from: 0.93, to: 1.00 },  // pull up into a high hero angle
];

/** Index of the scene that owns progress p (0..1). Scenes are contiguous, so this is the last one that has started. */
export function sceneAt(p) {
  let i = 0;
  for (let n = 1; n < SCENES.length; n++) if (p >= SCENES[n].from) i = n;
  return i;
}

// ---------------------------------------------------------------------------
// Car lights
// ---------------------------------------------------------------------------
// Both transitions are pure functions of timeline progress (scrubbed, no timers), derived from SCENES:
//   headlights ignite inside the opening scene (15% to 85% of it) and stay on;
//   taillights glow up as the camera reaches the rear/departure scene (its first 60%) and stay on.
// Reduced motion keeps the same start but finishes in a quarter of the span (a quick fade, no long build-up).
const shot = (name, i) => SCENES.find((s) => s.name === name) || SCENES[i];
const OPENING = shot('opening', 0);
const REAR = shot('rear', 5);
const span = (s, a, b) => [s.from + (s.to - s.from) * a, s.from + (s.to - s.from) * b];

export const LIGHT_TIMING = {
  head: span(OPENING, 0.15, 0.85),
  tail: span(REAR, 0, 0.6),
  reducedSpan: 0.25,
};

const ramp = (p, [a, b], k) => {
  const e = a + (b - a) * k;
  if (p <= a) return 0;
  if (p >= e) return 1;
  const t = (p - a) / (e - a);
  return t * t * (3 - 2 * t);
};

/** Light levels 0..1 at progress p. Writes into `out` (allocation-free when one is passed). */
export function lightLevels(p, reduced = false, out = { head: 0, tail: 0 }) {
  const k = reduced ? LIGHT_TIMING.reducedSpan : 1;
  out.head = ramp(p, LIGHT_TIMING.head, k);
  out.tail = ramp(p, LIGHT_TIMING.tail, k);
  return out;
}
