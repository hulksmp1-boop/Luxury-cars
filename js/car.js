// Phase 2: the ONLY file that knows how the car is built.
//
// CAR CONTRACT — the procedural placeholder and a future GLB loader
// must return this same shape, so world/timeline code never changes:
//
//   {
//     root:        THREE.Group,        // pivot, origin on ground between the axles, car faces +Z
//     wheels:      THREE.Object3D[],   // spin groups (FL, FR, RL, RR). Procedural car: spin around local X.
//                                      // GLB car: groups at the real wheel centres; update() turns each about its axle axis.
//     wheelRadius: number,             // metres; angle = distance / wheelRadius
//     anchors: { front, rear, side, wheel, headlight },  // camera targets, car-local THREE.Vector3
//     lights:  { head: Object3D[], tail: Object3D[] },   // emissive parts to glow
//     setLightProgress(p, reduced), setLightsDegraded(bool)  // headlight ignition / taillight glow (see scenes.js)
//     update(distance): void           // spins wheels
//   }
//
// createProceduralCar(opts)      -> placeholder (this file)
// initCar(stage, opts)           -> places any car that follows the contract into the scene
// loadCarFromGLB(url, opts)      -> real model (async). Same contract; falls back to nothing by itself (see below)
// initCarFromGLB(stage, opts)    -> async initCar(): tries the GLB, falls back to the procedural car on any failure
//
// This module imports only three. It never imports scene.js: it receives the stage
// object (scene, renderer, camera, quality...) from the boot code.
//
// Units are metres. Facing +Z, so the car's left side is +X.
// Wheel order: wheel_FL (+X, front), wheel_FR (-X, front), wheel_RL, wheel_RR.

import * as THREE from 'three'; // pinned in the importmap in index.html
import { lightLevels } from './scenes.js'; // light timing (pure, no dependencies)
import { locateWheels, splitByWheel } from './wheels.js'; // GLB wheel separation maths (pure, no dependencies)

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
// Real model: BMW M5 F90 (GLB)
// ---------------------------------------------------------------------------
//
// Facts about assets/models/bmw_m5_f90.glb, read from the file (not assumed):
//  - 1 unit = 1 metre (body 4.95 m long). Y is up. The car FACES +X, so its width runs along Z.
//  - The scene root carries baked matrices; the net world transform is already Y-up, so only a yaw is needed.
//  - There are NO wheel nodes. The four wheels are merged, per material, into shared meshes (tyre, rims, discs,
//    caliper...). buildGLBWheels() below splits those meshes triangle by triangle into one piece per wheel (sharing the
//    original vertex buffers, materials and textures) and hangs each wheel on its own pivot at the real axle centre.
//    The brake calipers are not in the list of spinning meshes, so they stay with the car.
//  - Axle axis = the car's width (model Z). Wheel centres, radius and width are measured from the tyre vertices.
//  - One 18-vertex mesh ("gauge_emissive") is a degenerate line stretching 9 m behind the car; it has no area and
//    draws nothing, but it must not count towards the bounding box.
//  - Only two materials author an emission: "reartail" (red) and "material_95" (amber, front).

const GLB_URL = 'assets/models/bmw_m5_f90.glb';
const DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/';
const GLB_TIMEOUT_MS = 90000;               // ~40 MB: generous, a slow connection must not trip the fallback
const GLB_YAW = -Math.PI / 2;               // +X (model front) -> +Z (Aether GT front)

// Mesh names that exist in the file (suffix match; Three.js keeps the glTF node names).
const GLB_NAMES = {
  tyre: 'EXT_Tyre_0',                       // all four tyres in one mesh: gives wheel radius and axle positions
  ignoreBounds: ['gauge_emissive_001_0'],   // degenerate line, see above
  tail: ['reartail_0'],                     // authored red emissive
  head: ['LightEmissiveA_Material_0', '6738_1111_0'],  // front light meshes (listed for the contract, not driven yet)
  castShadow: ['Carpaint_0', 'EXT_BODY_2_0', 'EXT_CARBON_0', 'EXT_Tyre_0', 'EXt_GLASS_0'],
  // Meshes that turn with the wheel: tyre, every rim layer, both brake discs. Each is a merged mesh holding all
  // four wheels (the discs: two). 'Brake_Caliper_001_0' is left out on purpose: calipers do not rotate.
  // Anything not listed here is never touched. Add a name to make another merged wheel part spin.
  wheelSpin: ['EXT_Tyre_0', 'M_RimBadge_Max_0', 'M_Rim_Secondary_Max_0', 'M_Rim_Main_Max_0', 'M_Rim_NoTint_Max_0',
    'rimsiulver_0', 'Rim_Blurred_0', 'Brake_Disk_001_0', 'Brake_Disk_rear_001_0'],
};

// GLTFLoader renames a node whose name is already taken ("X" -> "X_1") and every mesh node in this file shares its
// name with its parent group, so Object3D.name ends in "_1". The original glTF name is kept in userData.name.
const glbName = (o) => (o.userData && o.userData.name) || o.name || '';
const nameEnds = (o, list) => { const n = glbName(o); return list.some((x) => x && n.endsWith(x)); };

const glog = (...a) => console.log('[aether][glb]', ...a);

/**
 * Loads the real car and returns an object that follows the CAR CONTRACT. Nothing is added to a scene.
 * Rejects on any failure (network, parse, timeout, unexpected content): the caller falls back (see initCarFromGLB).
 * @param {string} [url]
 * @param {{ quality?: string, shadows?: boolean, renderer?: THREE.WebGLRenderer,
 *           onProgress?: (fraction: number) => void, signal?: { cancelled: boolean } }} [opts]
 */
export async function loadCarFromGLB(url = GLB_URL, opts = {}) {
  // Loaded on demand so a blocked CDN for the add-ons cannot take the procedural fallback down with it.
  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
  ]);
  // Both file variants work: the plain one never touches the decoder; the Draco + WebP one (KHR_draco_mesh_compression,
  // EXT_texture_webp) needs it. The decoder files come from the same pinned three.js version as the importmap.
  const draco = new DRACOLoader().setDecoderPath(DRACO_DECODER_PATH);
  const loader = new GLTFLoader().setDRACOLoader(draco);

  glog('loading started:', new URL(url, location.href).href);
  const t0 = performance.now();
  let lastLogged = -1;
  let gltf;
  try {
    gltf = await withTimeoutMs(new Promise((resolve, reject) => {
      loader.load(
        url, resolve,
        (e) => {
          if (e.lengthComputable && e.total) opts.onProgress?.(e.loaded / e.total);
          const step = Math.floor(e.loaded / 4e6);   // log every ~4 MB (total is unknown when the server compresses)
          if (step !== lastLogged) {
            lastLogged = step;
            glog(`download ${(e.loaded / 1e6).toFixed(1)} MB` + (e.lengthComputable ? ` / ${(e.total / 1e6).toFixed(1)} MB (${Math.round(100 * e.loaded / e.total)}%)` : ' (total unknown)'));
          }
        },
        reject,
      );
    }), GLB_TIMEOUT_MS, 'GLB load timeout');
  } finally {
    draco.dispose();
  }
  glog(`parsed OK in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (opts.signal?.cancelled) { disposeObject(gltf.scene); throw new Error('GLB load cancelled'); }

  const low = opts.quality === 'low';
  const castShadows = opts.shadows !== false && !low;
  const maxAniso = Math.min(8, opts.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);

  // ---- Hierarchy: root (contract pivot) > orient (yaw) > gltf.scene (untouched) ----
  const root = new THREE.Group();
  root.name = 'AetherGT_Car';
  const orient = new THREE.Group();
  orient.name = 'glb_orient';
  orient.rotation.y = GLB_YAW;
  orient.add(gltf.scene);
  root.add(orient);

  // ---- Inventory: pass over the meshes once, without touching geometry, textures or material parameters ----
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) throw new Error('GLB has no meshes');

  const byEnd = (list) => meshes.filter((m) => nameEnds(m, list));
  glog(`${meshes.length} meshes; sample names: Object3D.name="${meshes[0].name}" glTF name="${glbName(meshes[0])}"`);
  byEnd(GLB_NAMES.ignoreBounds).forEach((m) => { m.userData.noBounds = true; m.frustumCulled = false; });

  const seen = new Set();
  for (const m of meshes) {
    m.castShadow = castShadows && nameEnds(m, GLB_NAMES.castShadow);
    m.receiveShadow = false;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of list) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
        'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap']) {
        if (mat[k]) mat[k].anisotropy = Math.max(mat[k].anisotropy || 1, maxAniso); // sharper at grazing angles; never lowers resolution
      }
    }
  }

  const measure = (filter) => {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    for (const m of meshes) if (!m.userData.noBounds && (!filter || filter(m))) box.expandByObject(m);
    return box;
  };

  // ---- Fit: centre on the axle mid-point (x/z of the origin) and rest the tyres on y = 0, no scaling here ----
  const all = measure();
  if (all.isEmpty()) throw new Error('GLB bounding box is empty');
  const tyres = measure((m) => glbName(m).endsWith(GLB_NAMES.tyre));
  const haveTyres = !tyres.isEmpty();

  // Tyre mesh = four tyres: radius from its height; axle lines from its extent along the length (z after the yaw).
  const R = haveTyres ? (tyres.max.y - tyres.min.y) / 2 : WHEEL_RADIUS;
  const axleFront = haveTyres ? tyres.max.z - R : all.max.z - 0.9;
  const axleRear = haveTyres ? tyres.min.z + R : all.min.z + 0.9;
  const track = haveTyres ? (tyres.max.x - tyres.min.x) / 2 : WHEEL_X;   // outer face to outer face / 2 (half-width incl. tyre)
  const centreX = (all.min.x + all.max.x) / 2;
  const centreZ = (axleFront + axleRear) / 2;
  const floor = haveTyres ? tyres.min.y : all.min.y;
  orient.position.set(-centreX, -floor, -centreZ);

  const size = measure().getSize(new THREE.Vector3());
  glog(`name matches: tyre=${haveTyres ? 'found' : 'NOT FOUND'}, ignoredBounds=${byEnd(GLB_NAMES.ignoreBounds).length}, ` +
    `tail=${byEnd(GLB_NAMES.tail).length}, head=${byEnd(GLB_NAMES.head).length}; ` +
    `size (w x h x l) = ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m, wheelRadius=${R.toFixed(3)}, ` +
    `wheelbase=${(axleFront - axleRear).toFixed(2)}`);
  if (!(size.x > 1 && size.x < 4 && size.y > 0.8 && size.y < 2.5 && size.z > 3 && size.z < 7)) {
    throw new Error(`GLB size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m is not a car in metres`);
  }

  // ---- Contact shadow: the procedural car ships one; without it the real car would float on the reflective floor ----
  const blobTex = makeBlobTexture();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.8, depthWrite: false, fog: false });
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  const blob = new THREE.Mesh(blobGeo, blobMat);
  blob.name = 'contact_shadow';
  blob.rotation.x = -Math.PI / 2;
  blob.scale.set(size.x * 1.5, size.z * 1.25, 1);
  blob.position.y = 0.004;
  blob.renderOrder = 1;
  blob.userData.noBounds = true;
  root.add(blob);

  // ---- Wheels: split the merged wheel meshes into four spinning assemblies. Non-fatal: on any problem the car is
  //      left exactly as loaded (wheels simply do not turn) and the reason goes to the console. ----
  let rig = null;
  try {
    const built = buildGLBWheels(orient, meshes);
    if (built.error) console.warn('[aether][glb] wheels NOT separated:', built.error);
    else { rig = built; built.report.forEach((l) => glog('wheels:', l)); }
  } catch (err) {
    console.error('[aether][glb] wheel separation failed, wheels will not turn:', err && err.stack || err);
    rig = null;
  }

  // ---- Lights: only what the file authors. Tail = the red emissive material; head meshes are listed, not driven ----
  const head = byEnd(GLB_NAMES.head);
  const tail = byEnd(GLB_NAMES.tail);
  const tailMats = [...new Set(tail.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material])))];
  const lv = { head: 0, tail: 0 };
  let shownTail = -1;
  function setLightProgress(p, reduced = false) {
    lightLevels(p, reduced, lv);
    if (lv.tail !== shownTail) {
      shownTail = lv.tail;
      const k = TAIL_EMISSIVE.off + (TAIL_EMISSIVE.on - TAIL_EMISSIVE.off) * shownTail;
      for (const mat of tailMats) mat.emissiveIntensity = k;
    }
  }
  function setLightsDegraded() { /* no spotlights or glow sprites on the GLB car yet */ }

  // ---- Contract ----
  const halfL = size.z / 2;
  const anchors = {
    front: new THREE.Vector3(0, 0.5, halfL),
    rear: new THREE.Vector3(0, 0.6, -halfL),
    side: new THREE.Vector3(size.x / 2, 0.55, 0),
    wheel: new THREE.Vector3(track - 0.15, R, axleFront),   // outer tyre face, front axle (left side, +X)
    headlight: new THREE.Vector3(0.6, 0.6, halfL - 0.15),
  };

  // Rolling without slipping: angle = distance / radius, with the distance the road has moved (world metres) and the
  // radius in world metres too. initCarFromGLB multiplies api.wheelRadius by the fit scale after loading, so it is
  // read at call time. The axis of each wheel was signed in buildGLBWheels so that a positive angle rolls the car
  // toward +Z, the same convention as the procedural car.
  function update(distance = 0) {
    if (!rig) return;
    const a = (distance / api.wheelRadius) % (Math.PI * 2);
    for (let i = 0; i < rig.spins.length; i++) rig.spins[i].quaternion.setFromAxisAngle(rig.axes[i], a);
  }

  function dispose() {
    root.removeFromParent();
    disposeObject(orient);                       // the original meshes and the split wheel pieces (they share materials)
    rig?.orphans.forEach((g) => g.dispose());    // geometries of merged meshes that were replaced by wheel pieces
    blobGeo.dispose(); blobMat.dispose(); blobTex.dispose();
  }

  setLightProgress(0);
  const api = {
    root, wheels: rig ? rig.spins : [], wheelRadius: rig ? rig.radius : R, anchors,
    lights: { head, tail },
    parts: { model: gltf.scene },
    source: 'glb',
    // Exposed for the report and for ?debug; read-only facts about the model as loaded.
    info: { size: size.toArray(), wheelRadius: R, axleFront, axleRear, track, meshes: meshes.length, wheels: rig ? rig.summary : null },
    update, setLightProgress, setLightsDegraded, dispose,
  };
  return api;
}

/**
 * Async counterpart of initCar(): GLB first, procedural car if anything goes wrong.
 * `?car=procedural` in the URL skips the GLB (handy to test the fallback).
 * @param {object} stage  see initCar
 * @param {{ bounds?: object, quality?: string, url?: string, onProgress?: (f: number) => void,
 *           signal?: { cancelled: boolean } }} [opts]
 */
export async function initCarFromGLB(stage, opts = {}) {
  const forced = new URLSearchParams(location.search).get('car') === 'procedural';
  if (!forced) {
    try {
      const car = await loadCarFromGLB(opts.url || GLB_URL, {
        quality: opts.quality || stage.quality,
        shadows: stage.shadowsEnabled,
        renderer: stage.renderer,
        onProgress: opts.onProgress,
        signal: opts.signal,
      });
      if (opts.signal?.cancelled) { car.dispose(); return null; }
      const k = fitToBounds(car.root, opts.bounds);
      car.wheelRadius *= k;                      // wheelRadius is in world metres: follow the uniform fit scale
      stage.scene.add(car.root);
      try { stage.renderer?.compile(stage.scene, stage.camera); } catch { /* non-fatal */ }
      stage.requestRender?.();
      glog(`model added to scene; fit scale=${k.toFixed(3)}, wheelRadius=${car.wheelRadius.toFixed(3)}, ` +
        `children of scene=${stage.scene.children.length}`);
      reportCarSource('glb');
      return car;
    } catch (err) {
      console.error('[aether][glb] FALLBACK to procedural car. Reason:', err && err.message || err);
      console.error(err && err.stack || err);
      reportCarSource('procedural', err);
    }
  }
  if (forced) reportCarSource('procedural', new Error('forced by ?car=procedural'));
  return opts.signal?.cancelled ? null : initCar(stage, opts);
}

/** Records which car is on screen as <html data-car="glb|procedural"> (no visible UI) and keeps the failure reason for debugging. */
function reportCarSource(kind, err) {
  document.documentElement.dataset.car = kind;
  if (err) window.__aetherCarError = String(err && err.message || err);
}

function withTimeoutMs(promise, ms, message) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** Vertex positions of a geometry transformed by a Matrix4, as a flat x,y,z Float32Array. */
function framePoints(geometry, M) {
  const p = geometry.getAttribute('position');
  const e = M.elements;
  const out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    out[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

/** A geometry that draws only `triangles` (vertex indices, 3 per triangle) of `src`. Vertex buffers are shared, not copied. */
function subsetGeometry(src, triangles) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  const count = src.getAttribute('position').count;
  g.setIndex(new THREE.BufferAttribute(count > 65535 ? triangles : Uint16Array.from(triangles), 1));
  const pos = src.getAttribute('position');
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (let i = 0; i < triangles.length; i++) box.expandByPoint(v.fromBufferAttribute(pos, triangles[i]));
  g.boundingBox = box;
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  return g;
}

/**
 * Separates the four wheels of the merged BMW meshes and puts each on its own pivot.
 *
 * What it does (all in the frame of `orient`, i.e. the model's own axes after its baked matrices: +X front, Y up):
 *  1. Takes the vertices of the tyre mesh, finds the four tyres and measures centre, radius, width and axle axis
 *     of each (wheels.js: locateWheels).
 *  2. For every mesh in GLB_NAMES.wheelSpin, assigns each triangle to the wheel whose cylinder contains it
 *     (wheels.js: splitByWheel). Triangles outside every wheel cylinder stay where they were.
 *  3. Builds one mesh per wheel and part. It shares the original vertex buffers (no copy, no resample), material and
 *     textures; only a new index list is created. Its matrix is T(-centre) * (original mesh -> frame matrix), so under
 *     its pivot (placed at the wheel centre) it renders exactly where the original did.
 *  4. Hierarchy: orient > pivot (at the wheel centre) > spin (rotated each frame) > parts.
 *     Rotating `spin` about the axle axis through the centre turns the wheel in place: it cannot drift or change height.
 *
 * Nothing is added to or removed from the scene until every piece has been built successfully.
 * @returns {{ error: string } | { spins: THREE.Group[], axes: THREE.Vector3[], radius: number, orphans: THREE.BufferGeometry[], report: string[], summary: object }}
 */
function buildGLBWheels(orient, meshes) {
  orient.updateMatrixWorld(true);
  const inv = orient.matrixWorld.clone().invert();
  const toFrame = (m) => inv.clone().multiply(m.matrixWorld);   // mesh space -> frame of `orient`

  const cand = meshes.filter((m) => nameEnds(m, GLB_NAMES.wheelSpin) && !Array.isArray(m.material) && m.geometry && m.geometry.getAttribute('position'));
  const tyreMesh = cand.find((m) => glbName(m).endsWith(GLB_NAMES.tyre));
  if (!tyreMesh) return { error: 'tyre mesh not found' };

  const loc = locateWheels(framePoints(tyreMesh.geometry, toFrame(tyreMesh)));
  if (!loc.ok) return { error: loc.reason };

  // Name each wheel from where it sits on the finished car (root frame: +Z front, +X left) and sign its axle axis
  // so that a positive angle rolls the car toward +Z.
  const mean = new THREE.Vector3();
  loc.wheels.forEach((w) => mean.add(new THREE.Vector3().fromArray(w.center)));
  mean.multiplyScalar(1 / loc.wheels.length);
  const rigs = loc.wheels.map((w) => {
    const c = new THREE.Vector3().fromArray(w.center);
    const rel = c.clone().sub(mean).applyQuaternion(orient.quaternion);
    const axis = new THREE.Vector3().fromArray(w.axis);
    if (axis.clone().applyQuaternion(orient.quaternion).x < 0) axis.negate();
    return { w, center: c, axis, key: (rel.z > 0 ? 'F' : 'R') + (rel.x > 0 ? 'L' : 'R') };
  });
  const order = ['FL', 'FR', 'RL', 'RR'];
  if (new Set(rigs.map((r) => r.key)).size !== 4) return { error: 'could not tell the four wheels apart: ' + rigs.map((r) => r.key).join(',') };
  rigs.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const wheelIndex = new Map(rigs.map((r, i) => [r.w, i]));

  // Stage 1: build everything, touching nothing in the scene.
  const report = [];
  const pieces = [];   // { wheel: index, mesh }
  const replace = [];  // { src, rest: Uint32Array }
  for (const m of cand) {
    const g = m.geometry;
    const M = toFrame(m);
    const count = g.getAttribute('position').count;
    let idx = g.index ? g.index.array : null;
    if (!idx) { idx = new Uint32Array(count); for (let i = 0; i < count; i++) idx[i] = i; }
    const res = splitByWheel(framePoints(g, M), idx, loc.wheels);
    if (m === tyreMesh && res.perWheel.some((a) => !a)) return { error: 'a wheel received no tyre triangles' };

    const per = [];
    loc.wheels.forEach((w, k) => {
      const tris = res.perWheel[k];
      if (!tris) return;
      const r = rigs[wheelIndex.get(w)];
      const part = new THREE.Mesh(subsetGeometry(g, tris), m.material);
      part.name = `${m.name}_${r.key}`;
      part.userData = { ...m.userData, wheel: r.key };
      part.castShadow = m.castShadow;
      part.receiveShadow = m.receiveShadow;
      part.renderOrder = m.renderOrder;
      part.visible = m.visible;
      part.layers.mask = m.layers.mask;
      part.frustumCulled = false;                       // the piece turns about the axle; it is always near the car
      part.matrixAutoUpdate = false;
      part.matrix.makeTranslation(-r.center.x, -r.center.y, -r.center.z).multiply(M);
      part.matrixWorldNeedsUpdate = true;
      pieces.push({ wheel: rigs.indexOf(r), mesh: part });
      per.push(`${r.key}:${tris.length / 3}`);
    });
    const eccMax = Math.max(...res.stats.map((s) => Math.hypot(s.ecc[0], s.ecc[1])));
    report.push(`${glbName(m)} -> ${per.join(' ')} tris` + (res.rest.length ? `, ${res.rest.length / 3} left static` : '') +
      `, off-axle ${(eccMax * 1000).toFixed(1)} mm`);
    if (res.rest.length) replace.push({ src: m, rest: res.rest });
    else replace.push({ src: m, rest: null });
  }

  const spins = [], pivots = [];
  for (const r of rigs) {
    const pivot = new THREE.Group();
    pivot.name = `wheel_${r.key}_pivot`;
    pivot.position.copy(r.center);
    const spin = new THREE.Group();
    spin.name = `wheel_${r.key}`;
    pivot.add(spin);
    pivots.push(pivot);
    spins.push(spin);
  }
  for (const p of pieces) spins[p.wheel].add(p.mesh);

  const restGeos = replace.map((e) => (e.rest ? subsetGeometry(e.src.geometry, e.rest) : null));

  // Stage 2: commit. Nothing below can fail halfway in a way that matters.
  const orphans = [];
  replace.forEach((e, i) => {
    if (restGeos[i]) { orphans.push(e.src.geometry); e.src.geometry = restGeos[i]; }
    else { orphans.push(e.src.geometry); e.src.removeFromParent(); }
  });
  pivots.forEach((p) => orient.add(p));

  const f = (n) => Math.round(n * 1000) / 1000;
  report.unshift(`${loc.wheels.length} wheels found, radius ${loc.radius.toFixed(3)} m; axle sources: ` +
    rigs.map((r) => `${r.key} ${r.w.axisSource} (tilt ${r.w.tiltDeg.toFixed(2)} deg)`).join(', '));
  return {
    spins, axes: rigs.map((r) => r.axis), radius: loc.radius, orphans, report,
    summary: {
      radius: f(loc.radius),
      wheels: rigs.map((r) => ({
        key: r.key, center: r.center.toArray().map(f), axis: r.axis.toArray().map(f),
        radius: f(r.w.radius), width: f(r.w.halfWidth * 2), axisSource: r.w.axisSource, tiltDeg: f(r.w.tiltDeg),
      })),
    },
  };
}

/** Frees GPU resources of a loaded glTF scene (geometries, materials and every texture slot). */
function disposeObject(obj) {
  const done = new Set();
  obj.traverse((o) => {
    o.geometry?.dispose();
    const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const mat of list) {
      if (done.has(mat)) continue;
      done.add(mat);
      for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose();
      mat.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rests the model on y = 0 and shrinks it if it exceeds the allowed box. Origin stays between the axles. */
function fitToBounds(root, bounds) {
  let applied = 1;
  const measure = () => {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isMesh && !o.userData.noBounds) box.expandByObject(o);
    });
    return box;
  };
  let box = measure();
  if (box.isEmpty()) return 1;
  if (bounds) {
    const size = box.getSize(new THREE.Vector3());
    const k = Math.min(1, bounds.width * 1.05 / size.x, bounds.height * 1.05 / size.y, bounds.length * 1.05 / size.z);
    if (k < 1) { root.scale.multiplyScalar(k); box = measure(); applied = k; }
  }
  root.position.y -= box.min.y;
  return applied; // uniform scale applied (1 = none)
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
