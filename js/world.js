// Phase 3: cinematic road and environment.
//
// The car stays at the origin facing +Z; the world is built around it and is static for now.
// Like car.js, this module imports only three and never scene.js: boot code hands it the stage.
//
// createWorld(opts)   -> { root, groups, update(distance, speed), dispose }   (nothing added to a scene)
// initWorld(stage)    -> builds the world and adds it to stage.scene
//
// MOVEMENT (later phase): everything that repeats is periodic, so the scroll timeline only has to call
//   world.update(distance)
// with the metres travelled. Nothing in this file calls it, so nothing moves yet.
//   - road texture    : repeats every ROAD_TILE (12 m) along Z, scrolled through its UV offset
//   - lamps, gantries, rail posts : each group slides by (distance mod its period), which looks endless
//   - speed streaks: repeat every 36 m; density and brightness follow the `speed` argument (0..1)
//   - distant glow, lights : static, they never scroll (they are too far to show parallax)
//
// DEPTH: the stage fog is FogExp2 (~0.03), so anything past ~50 m fades to black.
// Near and mid-ground objects use the fog as it is. Distant elements opt out (`fog: false`) and are kept dim.
//
// DRAW CALLS (high tier, approx.): speed streaks 1 (0 on the low tier), road 1, rails 2, rail posts 1, blue edge strips 2, lamp poles 1,
// arms 1, heads 1, light pools 1, lamp glows 1, gantry parts 4, distant glow 1, distant lights 1.

import * as THREE from 'three'; // pinned in the importmap in index.html

export const WORLD = {
  roadWidth: 12.4,   // asphalt including shoulders, centred on x = 0 (car drives in the middle of three lanes)
  roadLength: 240,   // z from -120 to +120, camera far plane is 140
  roadTile: 12,      // metres of road covered by one texture repeat
  lampSpacing: 28,
  gantrySpacing: 56,
  postSpacing: 4,
};

const COLORS = {
  blue: 0x2f7bff,    // same accent as scene.js
  white: 0xdfe9ff,   // cool white, same as the key light
  silver: 0xb8bcc4,
};

const HALF_ROAD = WORLD.roadWidth / 2;
const HALF_LENGTH = WORLD.roadLength / 2;
const RAIL_X = 6.45;     // guard rail centre line
const POLE_X = 7.4;      // lamp poles stand behind the rail
const POLE_H = 7.4;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {{ quality?: 'low'|'medium'|'high', shadows?: boolean, maxAnisotropy?: number }} [opts]
 */
export function createWorld(opts = {}) {
  const quality = opts.quality || 'high';
  const low = quality === 'low';
  const maxAniso = opts.maxAnisotropy ?? 4;

  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };

  const root = new THREE.Group();
  root.name = 'AetherGT_World';
  const groups = {
    road: new THREE.Group(),
    roadside: new THREE.Group(),   // rails, posts, edge strips (uniform along Z, posts are periodic)
    lamps: new THREE.Group(),      // poles, light pools, glows (period = lampSpacing)
    gantries: new THREE.Group(),   // overhead frames (period = gantrySpacing)
    distant: new THREE.Group(),    // horizon glow and far lights (static)
  };
  Object.entries(groups).forEach(([k, g]) => { g.name = 'world_' + k; root.add(g); });
  // Sub-groups that scroll independently.
  const posts = new THREE.Group(); posts.name = 'rail_posts'; groups.roadside.add(posts);
  const lampRig = new THREE.Group(); lampRig.name = 'lamp_rig'; groups.lamps.add(lampRig);
  const gantryRig = new THREE.Group(); gantryRig.name = 'gantry_rig'; groups.gantries.add(gantryRig);

  const dummy = new THREE.Object3D();
  /** One draw call for many copies. `items` are [x, y, z, sx, sy, sz] and optional colour. */
  const instanced = (parent, name, geo, mat, items, colors) => {
    own(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    mesh.name = name;
    items.forEach(([x, y, z, sx = 1, sy = 1, sz = 1], i) => {
      dummy.position.set(x, y, z);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (colors) mesh.setColorAt(i, colors[i]);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false; // instances are spread over 240 m, the base geometry bounds would cull them
    parent.add(mesh);
    return mesh;
  };
  // ---------- Road: one plane, one texture (asphalt + lane markings), repeated along Z ----------
  const roadTex = own(makeRoadTexture(low ? 256 : 512));
  roadTex.wrapS = THREE.ClampToEdgeWrapping;
  roadTex.wrapT = THREE.RepeatWrapping;
  roadTex.repeat.set(1, WORLD.roadLength / WORLD.roadTile);
  roadTex.anisotropy = Math.min(maxAniso, low ? 2 : 8);

  const roadMat = own(new THREE.MeshStandardMaterial({
    map: roadTex, color: 0xffffff, metalness: 0.55, roughness: 0.42, envMapIntensity: 0.9,
    // A hair above the ground plane at y = 0 and below the glow pool (0.002) and the car's contact shadow (0.004).
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -2,
  }));
  roadMat.name = 'mat_road';
  const road = new THREE.Mesh(own(new THREE.PlaneGeometry(WORLD.roadWidth, WORLD.roadLength).rotateX(-Math.PI / 2)), roadMat);
  road.name = 'road';
  road.position.y = 0.0015;
  road.receiveShadow = opts.shadows !== false && !low;
  road.frustumCulled = false;
  groups.road.add(road);

  // ---------- Roadside: guard rails, posts, faint blue base strips ----------
  const railMat = own(new THREE.MeshStandardMaterial({
    color: 0x8d939d, metalness: 0.9, roughness: 0.3, envMapIntensity: 1.1,
  }));
  const postMat = own(new THREE.MeshStandardMaterial({
    color: 0x14161a, metalness: 0.5, roughness: 0.6, envMapIntensity: 0.6,
  }));
  const stripMat = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.blue).multiplyScalar(0.9) }));
  const railGeo = new THREE.BoxGeometry(0.07, 0.2, WORLD.roadLength);
  const stripGeo = new THREE.BoxGeometry(0.035, 0.035, WORLD.roadLength);
  [1, -1].forEach((s) => {
    const side = s > 0 ? 'L' : 'R';
    // The geometries are shared between both sides, so they are registered once below.
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.name = 'rail_' + side; rail.position.set(s * RAIL_X, 0.62, 0); rail.frustumCulled = false;
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.name = 'edge_strip_' + side; strip.position.set(s * (RAIL_X - 0.06), 0.11, 0); strip.frustumCulled = false;
    groups.roadside.add(rail, strip);
  });
  own(railGeo); own(stripGeo);

  const postItems = [];
  const postCount = Math.round(WORLD.roadLength / WORLD.postSpacing);
  for (let i = 0; i < postCount; i++) {
    const z = -HALF_LENGTH + (i + 0.5) * WORLD.postSpacing;
    postItems.push([RAIL_X, 0.36, z], [-RAIL_X, 0.36, z]);
  }
  instanced(posts, 'rail_posts_mesh', new THREE.BoxGeometry(0.1, 0.72, 0.1), postMat, postItems);

  // ---------- Street lamps: poles, arms, lamp heads, light pools on the asphalt, soft glows ----------
  const lampZ = [];
  // Half a period off the origin: no lamp stands next to the car or behind the hero camera.
  for (let z = -HALF_LENGTH + 22; z < HALF_LENGTH; z += WORLD.lampSpacing) lampZ.push(z); // -98 ... 98
  const poleItems = [], armItems = [], headItems = [], poolItems = [], headColors = [];
  const glowPos = [], glowCol = [];
  const cWhite = new THREE.Color(COLORS.white), cBlue = new THREE.Color(COLORS.blue);
  lampZ.forEach((z, i) => {
    [1, -1].forEach((s, j) => {
      // Mostly cool white, with a blue lamp now and then (restrained accent).
      const accent = (i + j * 2) % 4 === 3;
      const c = accent ? cBlue : cWhite;
      poleItems.push([s * POLE_X, POLE_H / 2, z]);
      armItems.push([s * (POLE_X - 0.85), POLE_H + 0.02, z]);
      headItems.push([s * (POLE_X - 1.65), POLE_H - 0.03, z]);
      poolItems.push([s * 5.1, 0.0035, z, 10, 1, 10]);
      headColors.push(c);
      glowPos.push(s * (POLE_X - 1.65), POLE_H - 0.1, z);
      glowCol.push(c.r, c.g, c.b);
    });
  });
  const poleMat = own(new THREE.MeshStandardMaterial({ color: 0x1a1c21, metalness: 0.6, roughness: 0.5, envMapIntensity: 0.7 }));
  instanced(lampRig, 'lamp_poles', new THREE.CylinderGeometry(0.06, 0.09, POLE_H, low ? 5 : 8), poleMat, poleItems);
  instanced(lampRig, 'lamp_arms', new THREE.BoxGeometry(1.7, 0.07, 0.07), poleMat, armItems);
  instanced(lampRig, 'lamp_heads', new THREE.BoxGeometry(0.55, 0.06, 0.24),
    own(new THREE.MeshBasicMaterial({ color: 0xffffff })), headItems, headColors);

  const glowTex = own(makeGlowTexture());
  const poolMat = own(new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffffff, transparent: true, opacity: 0.2,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const pools = instanced(lampRig, 'lamp_pools', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, poolItems, headColors);
  pools.renderOrder = 1;

  const glowGeo = own(new THREE.BufferGeometry());
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  glowGeo.setAttribute('color', new THREE.Float32BufferAttribute(glowCol, 3));
  const glows = new THREE.Points(glowGeo, own(new THREE.PointsMaterial({
    map: glowTex, size: 1.6, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  glows.name = 'lamp_glows';
  glows.frustumCulled = false;
  lampRig.add(glows);

  // ---------- Gantries: overhead frames with a blue light strip, far enough to frame the background ----------
  const gantryZ = [];
  for (let z = -HALF_LENGTH + 36; z < HALF_LENGTH; z += WORLD.gantrySpacing) gantryZ.push(z); // -84, -28, 28, 84
  const colItems = [], beamItems = [], gStripItems = [], barItems = [];
  gantryZ.forEach((z) => {
    colItems.push([8.3, 3.15, z], [-8.3, 3.15, z]);
    beamItems.push([0, 6.35, z]);
    gStripItems.push([0, 6.17, z]);
    [-4.2, 0, 4.2].forEach((x) => barItems.push([x, 6.15, z]));
  });
  instanced(gantryRig, 'gantry_columns', new THREE.BoxGeometry(0.28, 6.3, 0.28), poleMat, colItems);
  instanced(gantryRig, 'gantry_beams', new THREE.BoxGeometry(16.9, 0.32, 0.34), poleMat, beamItems);
  instanced(gantryRig, 'gantry_strips', new THREE.BoxGeometry(16.2, 0.05, 0.05), stripMat, gStripItems);
  instanced(gantryRig, 'gantry_lights', new THREE.BoxGeometry(0.9, 0.04, 0.14),
    own(new THREE.MeshBasicMaterial({ color: COLORS.white })), barItems);

  // ---------- Distant environment: horizon glow and far lights ----------
  // Fog would erase these (they are 70-120 m away), so they ignore it and are kept dim instead.
  const glowRingTex = own(makeHorizonTexture());
  glowRingTex.wrapS = THREE.RepeatWrapping;
  glowRingTex.repeat.set(3, 1);
  const horizon = new THREE.Mesh(
    own(new THREE.CylinderGeometry(118, 118, 30, low ? 20 : 36, 1, true)),
    own(new THREE.MeshBasicMaterial({
      map: glowRingTex, transparent: true, opacity: 0.55, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
  );
  horizon.name = 'horizon_glow';
  horizon.position.y = 12; // spans y -3 .. 27: the ground line sits near the bottom
  horizon.renderOrder = -1;
  horizon.frustumCulled = false;
  groups.distant.add(horizon);

  const rand = mulberry32(7);
  const farPos = [], farCol = [];
  const cSilver = new THREE.Color(COLORS.silver);
  const push = (x, y, z, c, k) => { farPos.push(x, y, z); farCol.push(c.r * k, c.g * k, c.b * k); };
  const cityCount = low ? 45 : 110;
  for (let i = 0; i < cityCount; i++) {
    // City-like specks on a ring, denser along the road axis (ahead of and behind the car).
    const along = rand() < 0.6;
    const ang = along ? (rand() < 0.5 ? 0 : Math.PI) + (rand() - 0.5) * 1.1 : rand() * Math.PI * 2;
    const r = 75 + rand() * 40;
    const c = rand() < 0.35 ? cBlue : rand() < 0.5 ? cWhite : cSilver;
    push(Math.sin(ang) * r, 0.4 + Math.pow(rand(), 2) * 13, Math.cos(ang) * r, c, 0.35 + rand() * 0.5);
  }
  // Pairs of far lights down the road: distant traffic, white and blue only.
  const trafficCount = low ? 5 : 10;
  for (let i = 0; i < trafficCount; i++) {
    const z = (rand() < 0.5 ? 1 : -1) * (72 + rand() * 40);
    const x = (rand() < 0.5 ? -1 : 1) * (1.8 + rand() * 2.4);
    const c = rand() < 0.3 ? cBlue : cWhite;
    push(x - 0.7, 0.7, z, c, 0.8);
    push(x + 0.7, 0.7, z, c, 0.8);
  }
  const farGeo = own(new THREE.BufferGeometry());
  farGeo.setAttribute('position', new THREE.Float32BufferAttribute(farPos, 3));
  farGeo.setAttribute('color', new THREE.Float32BufferAttribute(farCol, 3));
  const farLights = new THREE.Points(farGeo, own(new THREE.PointsMaterial({
    map: glowTex, size: 2.2, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })));
  farLights.name = 'far_lights';
  farLights.frustumCulled = false;
  groups.distant.add(farLights);

  // ---------- Speed streaks: thin light lines that rush past, more of them as speed rises ----------
  // One tile of streaks is repeated along Z every STREAK_PERIOD metres, so the pattern slides forever without a
  // seam. Instances are ordered streak-first, tile-second: drawing only the first N * tiles instances shows
  // N streaks in every tile, so density grows smoothly with speed. Fully deterministic (seeded, no per-frame state).
  const STREAK_PERIOD = 36, STREAK_TILES = 5;
  const streakPerTile = low ? 0 : quality === 'medium' ? 4 : 7;
  let streakMesh = null, streakMat = null, streakOn = streakPerTile > 0;
  const streakRig = new THREE.Group();
  streakRig.name = 'streak_rig';
  groups.streaks = streakRig;
  root.add(streakRig);
  if (streakPerTile > 0) {
    const rnd = mulberry32(41);
    const items = [], colors = [];
    for (let i = 0; i < streakPerTile; i++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const x = side * (1.5 + rnd() * 4.3);               // clear of the car (0.98) and of the rails (6.45)
      const y = 0.12 + Math.pow(rnd(), 2) * 1.9;          // mostly low, a few high
      const len = 3 + rnd() * 5;
      const zBase = ((i + rnd()) / streakPerTile - 0.5) * STREAK_PERIOD; // spread evenly along the tile
      const c = (rnd() < 0.7 ? cBlue : cWhite).clone().multiplyScalar(0.55 + rnd() * 0.45);
      for (let t = 0; t < STREAK_TILES; t++) {
        items.push([x, y, zBase + (t - (STREAK_TILES - 1) / 2) * STREAK_PERIOD, 1, 1, len]);
        colors.push(c);
      }
    }
    streakMat = own(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    streakMesh = instanced(streakRig, 'speed_streaks', new THREE.BoxGeometry(0.022, 0.022, 1), streakMat, items, colors);
    streakMesh.count = 0;
    streakMesh.visible = false;
  }
  // Streaks only appear once the car is clearly moving: 0 below s = 0.3, full at s = 1.
  const streakAmount = (s) => { const t = Math.min(1, Math.max(0, (s - 0.3) / 0.7)); return t * t * (3 - 2 * t); };

  // ---------- Movement hook (driven by motion.js) ----------
  const wrap = (d, period) => -(((d % period) + period) % period);
  /**
   * Pure function of its arguments: the same (distance, speed) always gives the same scene.
   * @param {number} distance metres the car has travelled forward (+Z); the world slides toward -Z
   * @param {number} [speed]  normalised speed 0..1, drives the streaks
   */
  function update(distance = 0, speed = 0) {
    roadTex.offset.y = -(((distance % WORLD.roadTile) + WORLD.roadTile) % WORLD.roadTile) / WORLD.roadTile;
    posts.position.z = wrap(distance, WORLD.postSpacing);
    lampRig.position.z = wrap(distance, WORLD.lampSpacing);
    gantryRig.position.z = wrap(distance, WORLD.gantrySpacing);
    if (streakMesh) {
      const a = streakOn ? streakAmount(speed) : 0;
      const n = Math.round(a * streakPerTile);
      streakMesh.count = n * STREAK_TILES;
      streakMesh.visible = n > 0;
      streakMat.opacity = 0.6 * a;
      streakRig.position.z = wrap(distance, STREAK_PERIOD);
    }
  }

  /** Streaks off for reduced motion or after a quality drop. Call update() again to apply. */
  function setStreaks(on) { streakOn = !!on && streakPerTile > 0; }

  /** Called when the frame-rate watchdog lowers quality: stop receiving shadows (keeps the shader in sync). */
  function setShadows(on) {
    road.receiveShadow = !!on && !low;
    roadMat.needsUpdate = true;
  }

  function dispose() {
    root.removeFromParent();
    disposables.forEach((d) => d.dispose?.());
  }

  update(0);
  return { root, groups, road, update, setShadows, setStreaks, dispose };
}

/**
 * Builds the world and adds it to the stage.
 * @param {{ scene: THREE.Scene, quality?: string, shadowsEnabled?: boolean, renderer?: THREE.WebGLRenderer,
 *           camera?: THREE.Camera, requestRender?: () => void, onQualityChange?: Function }} stage
 */
export function initWorld(stage, opts = {}) {
  const world = createWorld({
    quality: opts.quality || stage.quality,
    shadows: stage.shadowsEnabled,
    maxAnisotropy: stage.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4,
  });
  stage.scene.add(world.root);
  // When quality degrades at runtime, scene.js turns shadow maps off: follow it.
  stage.onQualityChange?.(() => { if (!stage.shadowsEnabled) world.setShadows(false); });
  try { stage.renderer?.compile(stage.scene, stage.camera); } catch { /* non-fatal */ }
  stage.requestRender?.();
  return world;
}

// ---------------------------------------------------------------------------
// Procedural textures (canvas): no image files to load
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dark asphalt with fine grain, three lanes, dashed dividers, solid edge lines and a few road studs.
 *  Covers WORLD.roadWidth x WORLD.roadTile metres and tiles seamlessly along Z. */
function makeRoadTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rand = mulberry32(11);

  // Grain
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = rand();
    const v = 15 + n * 9 + (n > 0.985 ? 22 : 0);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v + 1;
    img.data[i * 4 + 2] = v + 4; // a trace of blue, matches the scene's cool grade
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  const px = (x) => ((x + HALF_ROAD) / WORLD.roadWidth) * size; // metres -> pixels across
  const py = (m) => (m / WORLD.roadTile) * size;                // metres -> pixels along
  g.fillStyle = 'rgba(206,214,226,0.82)';
  // Solid edge lines
  [-5.2, 5.2].forEach((x) => g.fillRect(px(x) - px(0.08) + px(0), 0, px(0.16) - px(0), size));
  // Dashed lane dividers: 3 m paint, 3 m gap, so two dashes per tile
  [-1.8, 1.8].forEach((x) => {
    for (let k = 0; k < 2; k++) g.fillRect(px(x - 0.07), py(k * 6), px(0.07) - px(-0.07), py(3));
  });
  // Road studs in the middle of each gap: tiny cool-blue reflectors
  g.fillStyle = 'rgba(120,170,255,0.9)';
  [-1.8, 1.8].forEach((x) => {
    for (let k = 0; k < 2; k++) g.fillRect(px(x) - 2, py(k * 6 + 4.5) - 2, 4, 4);
  });
  // Wear: knock back the paint with dark specks
  g.fillStyle = 'rgba(14,15,18,0.55)';
  for (let i = 0; i < size * 3; i++) g.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Round soft glow, white in the centre and clear at the edge. */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Vertical gradient for the horizon: bright blue at the ground line fading upward, broken up sideways. */
function makeHorizonTexture() {
  const w = 256, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rand = mulberry32(23);
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(47,123,255,0)');
  grad.addColorStop(0.18, 'rgba(47,123,255,0.55)'); // the ring starts 3 m below ground, so this is just above the horizon line
  grad.addColorStop(0.5, 'rgba(47,123,255,0.12)');
  grad.addColorStop(1, 'rgba(47,123,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Break the band into soft patches so it reads as distant glow, not a stripe.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const x = rand() * w, r = 10 + rand() * 30;
    const rg = g.createRadialGradient(x, h, 0, x, h, r);
    rg.addColorStop(0, 'rgba(0,0,0,0.85)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, 0, r * 2, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
