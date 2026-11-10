// Phase 2: the ONLY file that knows how the car is built.
//
// CAR CONTRACT — the procedural placeholder and a future GLB loader
// must return this same shape, so world/timeline code never changes:
//
//   {
//     root:        THREE.Group,        // pivot, origin on ground between the axles, car faces +Z
//     wheels:      THREE.Object3D[],   // spin around local X (FL, FR, RL, RR)
//     wheelRadius: number,             // metres; angle = distance / wheelRadius
//     anchors: { front, rear, side, wheel, headlight },  // camera targets, car-local THREE.Vector3
//     lights:  { head: Object3D[], tail: Object3D[] },   // emissive parts to glow
//     setLightProgress(p, reduced), setLightsDegraded(bool)  // headlight ignition / taillight glow (see scenes.js)
//     update(distance): void           // spins wheels
//   }
//
// createProceduralCar(opts)      -> placeholder (this file)
// initCar(stage, opts)           -> places any car that follows the contract into the scene
// loadCarFromGLB(url, mapping)   -> real model (later); `mapping` names its wheel/light nodes
//
// This module imports only three. It never imports scene.js: it receives the stage
// object (scene, renderer, camera, quality...) from the boot code.
//
// Units are metres. Facing +Z, so the car's left side is +X.
// Wheel order: wheel_FL (+X, front), wheel_FR (-X, front), wheel_RL, wheel_RR.

import * as THREE from 'three'; // pinned in the importmap in index.html
import { lightLevels } from './scenes.js'; // light timing (pure, no dependencies)

const WHEEL_RADIUS = 0.34;
const WHEEL_X = 0.855;     // wheel centre, distance from the centre line
const WHEEL_Z = 1.38;      // wheel centre, distance from the middle of the car
const TIRE_HALF_WIDTH = 0.135;

// Light effect strengths. Emissive intensity runs from OFF (dim, lenses still readable) to ON (the original look).
const HEAD_EMISSIVE = { off: 0.05, on: 2.4 };
const TAIL_EMISSIVE = { off: 0.35, on: 2.6 };
const HEAD_GLOW = 0.55;     // peak opacity of the additive glow sprites
const TAIL_GLOW = 0.6;
const HEAD_SPOT = 9;        // peak spotlight intensity (high tier only)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the procedural car. Pure construction: nothing is added to a scene.
 * @param {{ quality?: 'low'|'medium'|'high' }} [opts]
 */
export function createProceduralCar(opts = {}) {
  const quality = opts.quality || 'high';
  const low = quality === 'low';
  const castShadows = opts.shadows !== false && !low;
  const ring = low ? 20 : 28;       // cross-section resolution of the lofted body
  const sub = low ? 3 : 4;          // subdivisions between body stations
  const wheelSeg = low ? 20 : 32;

  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };

  // ---------- Materials (shared, a handful in total) ----------
  // Dark charcoal-blue metallic. Highlights come from the studio environment map (scene.js), not mirror gloss:
  // the base roughness spreads reflections into soft bands, the clearcoat adds a controlled sheen on top.
  // Per tier: high = best clearcoat; medium = same clearcoat, a little rougher; low = plain standard material with
  // a higher env intensity to make up for the missing clearcoat layer.
  const PAINT = {
    high:   { roughness: 0.3,  envMapIntensity: 1.35, clearcoat: 1, clearcoatRoughness: 0.07 },
    medium: { roughness: 0.34, envMapIntensity: 1.3,  clearcoat: 1, clearcoatRoughness: 0.1 },
    low:    { roughness: 0.34, envMapIntensity: 1.7 },
  }[quality] || { roughness: 0.3, envMapIntensity: 1.35, clearcoat: 1, clearcoatRoughness: 0.07 };
  const paintParams = { color: 0x2b323d, metalness: 0.9, ...PAINT };
  // Clear coat costs an extra specular lobe per pixel: only on capable devices.
  const paint = own(low ? new THREE.MeshStandardMaterial(paintParams) : new THREE.MeshPhysicalMaterial(paintParams));
  paint.name = 'mat_paint';

  const glass = own(new THREE.MeshStandardMaterial({
    color: 0x04060a, metalness: 0.9, roughness: 0.05, envMapIntensity: 1.7,
  }));
  glass.name = 'mat_glass';

  const trim = own(new THREE.MeshStandardMaterial({
    color: 0x090a0c, metalness: 0.35, roughness: 0.45, envMapIntensity: 0.8,
  }));
  trim.name = 'mat_trim';

  const tireMat = own(new THREE.MeshStandardMaterial({
    color: 0x0b0b0c, metalness: 0, roughness: 0.85, envMapIntensity: 0.25,
  }));
  tireMat.name = 'mat_tire';

  const headMat = own(new THREE.MeshStandardMaterial({
    color: 0xdfe9ff, emissive: 0xbcd6ff, emissiveIntensity: 2.4, metalness: 0, roughness: 0.2,
  }));
  headMat.name = 'mat_headlight';

  const tailMat = own(new THREE.MeshStandardMaterial({
    color: 0x3a0405, emissive: 0xff1410, emissiveIntensity: 2.6, metalness: 0, roughness: 0.3,
  }));
  tailMat.name = 'mat_taillight';

  const chrome = own(new THREE.MeshStandardMaterial({
    color: 0xb9bec7, metalness: 1, roughness: 0.22, envMapIntensity: 1.2,
  }));
  chrome.name = 'mat_chrome';

  const wellMat = own(new THREE.MeshBasicMaterial({ color: 0x010102, side: THREE.DoubleSide }));
  wellMat.name = 'mat_wheelwell';

  const root = new THREE.Group();
  root.name = 'AetherGT_Car';

  const addMesh = (parent, name, geo, mat, { cast = false } = {}) => {
    own(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = cast && castShadows;
    parent.add(m);
    return m;
  };

  // ---------- Body: lofted from cross-sections for a sculpted, continuous surface ----------
  // station = [z, halfWidth, bottomY, topY]
  const bodyStations = [
    [-2.30, 0.62, 0.26, 0.76],  // tail
    [-2.20, 0.78, 0.22, 0.84],
    [-1.95, 0.93, 0.18, 0.90],  // rear haunch rises over the rear wheels
    [-1.40, 0.975, 0.15, 0.88],
    [-0.80, 0.975, 0.14, 0.82],
    [0.00, 0.975, 0.14, 0.80],  // belt line
    [0.80, 0.975, 0.14, 0.82],
    [1.40, 0.975, 0.14, 0.80],  // front fender
    [1.90, 0.93, 0.16, 0.70],   // hood falls away
    [2.18, 0.72, 0.18, 0.60],
    [2.30, 0.50, 0.20, 0.50],   // nose
  ];
  const body = addMesh(root, 'body', loft(bodyStations, { n: 3.2, ring, sub }), paint, { cast: true });

  // Cabin glass: one lofted greenhouse (windshield, side windows and rear glass).
  const cabinStations = [
    [-1.60, 0.72, 0.70, 0.90],
    [-1.15, 0.66, 0.70, 1.03],
    [-0.70, 0.66, 0.70, 1.17],
    [-0.20, 0.68, 0.70, 1.21],
    [0.30, 0.70, 0.70, 1.17],
    [0.70, 0.72, 0.70, 1.04],
    [1.05, 0.74, 0.70, 0.84],
  ];
  const cabin = addMesh(root, 'cabin_glass', loft(cabinStations, { n: 2.4, ring, sub }), glass, { cast: true });

  // Painted roof panel laid over the glass, narrower than the greenhouse.
  const roofSrc = cabinStations.slice(1, 6); // z -1.15 .. 0.70
  const roofStations = roofSrc.map(([z, w, , yt], i) => {
    const end = i === 0 || i === roofSrc.length - 1;
    const top = yt + (end ? -0.04 : 0.018);
    return [z, w * 0.64, top - 0.14, top];
  });
  addMesh(root, 'roof', loft(roofStations, { n: 3, ring, sub }), paint);

  // ---------- Aero and trim ----------
  const placed = (mesh, x, y, z, rx = 0, ry = 0, rz = 0) => {
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    return mesh;
  };

  // Front splitter, side sills, rear diffuser, ducktail.
  placed(addMesh(root, 'splitter', new THREE.BoxGeometry(1.74, 0.03, 0.42), trim), 0, 0.1, 2.16);
  [1, -1].forEach((s) => {
    placed(addMesh(root, s > 0 ? 'sill_L' : 'sill_R', new THREE.BoxGeometry(0.05, 0.07, 1.9), trim), s * 0.985, 0.19, 0);
  });
  placed(addMesh(root, 'diffuser', new THREE.BoxGeometry(1.3, 0.1, 0.34), trim), 0, 0.2, -2.18);
  placed(addMesh(root, 'ducktail', new THREE.BoxGeometry(1.5, 0.03, 0.3), paint, { cast: true }), 0, 0.915, -2.02, -0.14, 0, 0);

  // Front intake (a dark bar on the nose) and a thin lower grille line.
  placed(addMesh(root, 'intake', new THREE.BoxGeometry(0.8, 0.1, 0.02), trim), 0, 0.31, 2.3);
  placed(addMesh(root, 'intake_low', new THREE.BoxGeometry(1.3, 0.05, 0.02), trim), 0, 0.2, 2.19, 0.35, 0, 0);

  // Exhaust tips.
  const pipeGeo = own(new THREE.CylinderGeometry(0.055, 0.055, 0.14, low ? 10 : 16, 1, true).rotateX(Math.PI / 2));
  [-0.4, 0.4].forEach((x, i) => {
    const p = new THREE.Mesh(pipeGeo, chrome);
    p.name = i ? 'exhaust_L' : 'exhaust_R';
    p.position.set(x, 0.27, -2.28);
    root.add(p);
  });

  // Mirrors.
  [1, -1].forEach((s) => {
    placed(addMesh(root, s > 0 ? 'mirror_L' : 'mirror_R', new THREE.BoxGeometry(0.17, 0.09, 0.11), paint), s * 0.86, 0.96, 0.66, 0, s * 0.25, 0);
  });

  // ---------- Lights ----------
  const head = [];
  const tail = [];
  // Headlight blades follow the slope of the hood and the curve of the front fender.
  [1, -1].forEach((s) => {
    const lamp = addMesh(root, s > 0 ? 'headlight_L' : 'headlight_R', new THREE.BoxGeometry(0.44, 0.05, 0.13), headMat);
    placed(lamp, s * 0.6, 0.6, 2.08, 0.3, -s * 0.5, s * 0.06);
    head.push(lamp);
    const drl = addMesh(root, s > 0 ? 'drl_L' : 'drl_R', new THREE.BoxGeometry(0.3, 0.014, 0.05), headMat);
    placed(drl, s * 0.5, 0.56, 2.2, 0.3, -s * 0.5, 0);
    head.push(drl);
  });
  // Full-width tail light bar, split in the middle by a thin gap.
  [1, -1].forEach((s) => {
    const lamp = addMesh(root, s > 0 ? 'taillight_L' : 'taillight_R', new THREE.BoxGeometry(0.5, 0.055, 0.03), tailMat);
    placed(lamp, s * 0.27, 0.665, -2.312);
    tail.push(lamp);
  });

  // ---------- Light effects ----------
  // Cheap by design: the lamp materials' emissive intensity (shared, so no per-mesh work), a few additive glow
  // sprites (no post-processing), and on the high tier only two small spotlights without shadows.
  // Everything is created once here; setLightProgress() only writes numbers.
  const glowTex = own(makeGlowTexture());
  const glowMat = (color) => own(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const headGlowMat = glowMat(0xa9c8ff);   // cool white with a touch of electric blue
  const tailGlowMat = glowMat(0xff2418);
  const addGlow = (lamp, mat, w, h, dy, dz) => {
    const sp = new THREE.Sprite(mat);
    sp.name = `${lamp.name}_glow`;
    sp.position.set(lamp.position.x, lamp.position.y + dy, lamp.position.z + dz); // nudged outward from the lens
    sp.scale.set(w, h, 1);
    sp.renderOrder = 2;
    root.add(sp);
  };
  head.forEach((lamp) => { if (lamp.name.startsWith('headlight_')) addGlow(lamp, headGlowMat, 0.85, 0.6, 0.02, 0.12); });
  tail.forEach((lamp) => addGlow(lamp, tailGlowMat, 0.95, 0.4, 0, -0.1));

  const spots = [];
  if (quality === 'high') {
    head.forEach((lamp) => {
      if (!lamp.name.startsWith('headlight_')) return;
      const sp = new THREE.SpotLight(0xcfe0ff, 0, 14, 0.42, 0.85, 2);
      sp.name = `${lamp.name}_beam`;
      sp.position.set(lamp.position.x, lamp.position.y, lamp.position.z + 0.1);
      sp.target.position.set(lamp.position.x * 0.8, 0.05, lamp.position.z + 9);
      root.add(sp, sp.target);
      spots.push(sp);
    });
  }

  const lv = { head: 0, tail: 0 };
  let shownHead = -1, shownTail = -1, spotScale = 1;

  /** Applies the light state for timeline progress p. Allocation-free; skips work when nothing changed. */
  function setLightProgress(p, reduced = false) {
    lightLevels(p, reduced, lv);
    if (lv.head !== shownHead) {
      shownHead = lv.head;
      headMat.emissiveIntensity = HEAD_EMISSIVE.off + (HEAD_EMISSIVE.on - HEAD_EMISSIVE.off) * shownHead;
      headGlowMat.opacity = HEAD_GLOW * shownHead;
      for (let i = 0; i < spots.length; i++) spots[i].intensity = HEAD_SPOT * shownHead * spotScale;
    }
    if (lv.tail !== shownTail) {
      shownTail = lv.tail;
      tailMat.emissiveIntensity = TAIL_EMISSIVE.off + (TAIL_EMISSIVE.on - TAIL_EMISSIVE.off) * shownTail;
      tailGlowMat.opacity = TAIL_GLOW * shownTail;
    }
  }

  /** Frame-rate watchdog hook: after a quality drop the spotlights fade out (they stay in the scene, so no shader rebuild). */
  function setLightsDegraded(on) {
    spotScale = on ? 0 : 1;
    shownHead = -1;
  }

  // ---------- Wheels ----------
  // Tyre profile, revolved once and shared by all four wheels.
  const R = WHEEL_RADIUS;
  const tireGeo = own(new THREE.LatheGeometry([
    new THREE.Vector2(0.22, -TIRE_HALF_WIDTH),
    new THREE.Vector2(R - 0.04, -TIRE_HALF_WIDTH),
    new THREE.Vector2(R - 0.006, -0.112),
    new THREE.Vector2(R, -0.07),
    new THREE.Vector2(R, 0.07),
    new THREE.Vector2(R - 0.006, 0.112),
    new THREE.Vector2(R - 0.04, TIRE_HALF_WIDTH),
    new THREE.Vector2(0.22, TIRE_HALF_WIDTH),
  ], wheelSeg).rotateZ(Math.PI / 2));

  const hubGeo = own(new THREE.CylinderGeometry(0.235, 0.235, TIRE_HALF_WIDTH * 2 - 0.02, wheelSeg).rotateZ(Math.PI / 2));

  const rimTex = makeRimTexture(low ? 128 : 256);
  disposables.push(rimTex);
  const rimMat = own(new THREE.MeshStandardMaterial({
    map: rimTex, color: 0xffffff, metalness: 0.95, roughness: 0.28, alphaTest: 0.5, envMapIntensity: 1.2,
  }));
  rimMat.name = 'mat_rim';
  const rimFaceGeo = {
    1: own(new THREE.CircleGeometry(0.295, wheelSeg).rotateY(Math.PI / 2)),
    '-1': own(new THREE.CircleGeometry(0.295, wheelSeg).rotateY(-Math.PI / 2)),
  };

  // Dark wheel-well shape painted on the flank: makes the wheel read as sitting inside an arch.
  const wellShape = new THREE.Shape();
  wellShape.moveTo(-0.4, -0.2);
  wellShape.lineTo(0.4, -0.2);
  wellShape.lineTo(0.4, 0);
  wellShape.absarc(0, 0, 0.4, 0, Math.PI, false);
  wellShape.lineTo(-0.4, -0.2);
  const wellGeo = own(new THREE.ShapeGeometry(wellShape, low ? 8 : 14).rotateY(Math.PI / 2));

  const wheels = [];
  const wheelDefs = [
    ['wheel_FL', 1, 1], ['wheel_FR', -1, 1], ['wheel_RL', 1, -1], ['wheel_RR', -1, -1],
  ];
  wheelDefs.forEach(([name, side, end]) => {
    const w = new THREE.Group(); // spins around local X
    w.name = name;
    w.position.set(side * WHEEL_X, R, end * WHEEL_Z);
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.name = name + '_tire';
    tire.castShadow = castShadows;
    const hub = new THREE.Mesh(hubGeo, trim);
    hub.name = name + '_hub';
    const face = new THREE.Mesh(rimFaceGeo[side], rimMat);
    face.name = name + '_rim';
    face.position.x = side * (TIRE_HALF_WIDTH + 0.002);
    w.add(tire, hub, face);
    root.add(w);
    wheels.push(w);

    const well = new THREE.Mesh(wellGeo, wellMat);
    well.name = name + '_arch';
    well.position.set(side * 0.982, R, end * WHEEL_Z);
    root.add(well);
  });

  // ---------- Soft contact shadow (works on every tier, including those without shadow maps) ----------
  const blobTex = makeBlobTexture();
  disposables.push(blobTex);
  const blob = new THREE.Mesh(
    own(new THREE.PlaneGeometry(1, 1)),
    own(new THREE.MeshBasicMaterial({
      map: blobTex, transparent: true, opacity: 0.8, depthWrite: false, fog: false,
    }))
  );
  blob.name = 'contact_shadow';
  blob.rotation.x = -Math.PI / 2;
  blob.scale.set(3.0, 5.9, 1);
  blob.position.y = 0.004;
  blob.renderOrder = 1;
  blob.userData.noBounds = true;
  root.add(blob);

  // ---------- Contract ----------
  const anchors = {
    front: new THREE.Vector3(0, 0.5, 2.3),
    rear: new THREE.Vector3(0, 0.6, -2.3),
    side: new THREE.Vector3(1.0, 0.55, 0),
    wheel: new THREE.Vector3(WHEEL_X, R, WHEEL_Z),
    headlight: new THREE.Vector3(0.6, 0.6, 2.08),
  };

  function update(distance = 0) {
    const a = distance / R; // positive angle about +X rolls the car toward +Z
    for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x = a;
  }

  function dispose() {
    root.removeFromParent();
    disposables.forEach((d) => d.dispose?.());
  }

  update(0);
  setLightProgress(0);   // headlights start dim, taillights at their resting glow
  return {
    root, wheels, wheelRadius: R, anchors,
    lights: { head, tail },
    parts: { body, cabin },
    update, setLightProgress, setLightsDegraded, dispose,
  };
}

/**
 * Creates the car and places it in the stage. Works with any car object that follows the contract,
 * so swapping in a GLB later only changes the first line.
 * @param {{ scene: THREE.Scene, quality?: string, shadowsEnabled?: boolean, renderer?: THREE.WebGLRenderer,
 *           camera?: THREE.Camera, requestRender?: () => void }} stage  the object returned by createScene()
 * @param {{ bounds?: {width:number,height:number,length:number}, quality?: string }} [opts]
 */
export function initCar(stage, opts = {}) {
  const car = createProceduralCar({
    quality: opts.quality || stage.quality,
    shadows: stage.shadowsEnabled,
  });
  fitToBounds(car.root, opts.bounds);
  stage.scene.add(car.root);
  // Compile shaders now (behind the loader) so the first visible frame doesn't hitch.
  try { stage.renderer?.compile(stage.scene, stage.camera); } catch { /* non-fatal */ }
  stage.requestRender?.();
  return car;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rests the model on y = 0 and shrinks it if it exceeds the allowed box. Origin stays between the axles. */
function fitToBounds(root, bounds) {
  const measure = () => {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isMesh && !o.userData.noBounds) box.expandByObject(o);
    });
    return box;
  };
  let box = measure();
  if (box.isEmpty()) return;
  if (bounds) {
    const size = box.getSize(new THREE.Vector3());
    const k = Math.min(1, bounds.width * 1.05 / size.x, bounds.height * 1.05 / size.y, bounds.length * 1.05 / size.z);
    if (k < 1) { root.scale.multiplyScalar(k); box = measure(); }
  }
  root.position.y -= box.min.y;
}

const cr = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);

/** Smooths a station table with Catmull-Rom splines (each column independently). */
function smoothStations(st, sub) {
  const out = [];
  const last = st.length - 1;
  for (let i = 0; i < last; i++) {
    const p0 = st[Math.max(i - 1, 0)], p1 = st[i], p2 = st[i + 1], p3 = st[Math.min(i + 2, last)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      out.push([0, 1, 2, 3].map((j) => cr(p0[j], p1[j], p2[j], p3[j], t)));
    }
  }
  out.push(st[last].slice());
  return out;
}

/**
 * Lofts a closed surface through cross-sections ordered from rear (-Z) to front (+Z).
 * Each section is a superellipse: n = 2 is an ellipse, larger n is boxier.
 * Both ends are closed with flat caps.
 */
function loft(stations, { n = 3, ring = 24, sub = 4 } = {}) {
  const rows = smoothStations(stations, sub);
  const e = 2 / n;
  const sgnPow = (v) => Math.sign(v) * Math.pow(Math.abs(v), e);
  const pos = [];
  for (const [z, w0, yb0, yt0] of rows) {
    const w = Math.max(w0, 0.02);
    const yb = yb0;
    const yt = Math.max(yt0, yb + 0.02);
    const cy = (yb + yt) / 2, hh = (yt - yb) / 2;
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      pos.push(w * sgnPow(Math.cos(a)), cy + hh * sgnPow(Math.sin(a)), z);
    }
  }
  const idx = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let k = 0; k < ring; k++) {
      const a = i * ring + k, b = i * ring + (k + 1) % ring;
      const c = (i + 1) * ring + k, d = (i + 1) * ring + (k + 1) % ring;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Side normals first (smooth, seam-free), then the flat caps with their own normals.
  const side = new THREE.BufferGeometry();
  side.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  side.setIndex(idx);
  side.computeVertexNormals();
  const normals = Array.from(side.getAttribute('normal').array);
  side.dispose();

  const addCap = (rowIdx, nz) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < ring; k++) {
      const o = (rowIdx * ring + k) * 3;
      pos.push(pos[o], pos[o + 1], pos[o + 2]);
      normals.push(0, 0, nz);
      cx += pos[o]; cy += pos[o + 1]; cz = pos[o + 2];
    }
    pos.push(cx / ring, cy / ring, cz);
    normals.push(0, 0, nz);
    const centre = base + ring;
    for (let k = 0; k < ring; k++) {
      const p = base + k, q = base + (k + 1) % ring;
      nz > 0 ? idx.push(centre, p, q) : idx.push(centre, q, p);
    }
  };
  addCap(rows.length - 1, 1);
  addCap(0, -1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Alloy wheel face: ten spokes, outer lip and centre cap. Transparent between spokes (alphaTest). */
function makeRimTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const m = size / 2;
  g.translate(m, m);
  g.strokeStyle = '#d4d8df';
  g.fillStyle = '#d4d8df';
  g.lineCap = 'round';
  // outer lip
  g.lineWidth = size * 0.07;
  g.beginPath(); g.arc(0, 0, m * 0.93, 0, Math.PI * 2); g.stroke();
  // spokes
  g.lineWidth = size * 0.055;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * m * 0.2, Math.sin(a) * m * 0.2);
    g.lineTo(Math.cos(a) * m * 0.9, Math.sin(a) * m * 0.9);
    g.stroke();
  }
  // centre cap with a darker ring
  g.beginPath(); g.arc(0, 0, m * 0.22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4b505a';
  g.beginPath(); g.arc(0, 0, m * 0.1, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Soft round falloff for the light glow sprites (white; tinted by the sprite material). */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Elongated soft black blob used under the car. */
function makeBlobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.65)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
