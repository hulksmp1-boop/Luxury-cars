// Phase 2: renderer, lights, environment, reflective-looking ground, fog.
// No car, road or scroll logic lives here. Later phases plug into the API returned
// by createScene(): add objects to `scene`, move `camera` / `cameraTarget`,
// call `requestRender()` (or `onFrame(cb)`) and set `autoFrame = false`
// once the timeline takes over the camera.
//
// WORLD CONVENTION: the car sits at the origin, wheels on y = 0, facing +Z.
// Camera path and the car's `anchors` (see car.js) are expressed in that space.

import * as THREE from 'three'; // pinned in the importmap in index.html

export const CAR_BOUNDS = { width: 1.95, height: 1.25, length: 4.6 }; // metres, x / y / z

// Light intensities (studio set). Edit here to retune the look.
const LIGHTING = { hemi: 0.25, key: 2.4, rimLeft: 2.6, rimRight: 1.4, fill: 0.65 };

const COLORS = {
  black: 0x050506,
  fog: 0x07080a,
  key: 0xdfe9ff,   // cool white
  silver: 0xb8bcc4,
  blue: 0x2f7bff,
};

const TIERS = {
  low:    { maxDpr: 1,   pixelBudget: 1.0e6, antialias: false, shadowMap: 0,    fps: 30 },
  medium: { maxDpr: 1.5, pixelBudget: 2.2e6, antialias: true,  shadowMap: 1024, fps: 60 },
  high:   { maxDpr: 2,   pixelBudget: 4.5e6, antialias: true,  shadowMap: 2048, fps: 60 },
};

let lastGPU = '';
const SOFTWARE_GPU = /swiftshader|llvmpipe|software|basic render/i;
const WEAK_GPU = /mali-[2-4]\d\d|mali-t[0-8]|adreno.*\b[2-4]\d\d\b|powervr|sgx|intel\(r\) hd graphics [2-4]\d{3}|gma/i;

/** Reads the GPU name from a throwaway context. Empty string if hidden or unavailable. */
function probeGPU() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/** Capability guess. Unknown values (Safari/Firefox hide memory) count as capable. Override with ?quality=low|medium|high. */
export function detectQuality() {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && TIERS[forced]) return forced;
  lastGPU = probeGPU();
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(screen.width, screen.height) < 700;
  const saveData = navigator.connection?.saveData || matchMedia('(prefers-reduced-data: reduce)').matches;
  if (saveData || mem <= 2 || cores <= 2 || SOFTWARE_GPU.test(lastGPU) || WEAK_GPU.test(lastGPU)) return 'low';
  if (coarse || smallScreen || mem <= 4 || cores <= 4) return 'medium';
  return 'high';
}

export function createScene(canvas, opts = {}) {
  const qualityName = opts.quality || detectQuality();
  const tier = TIERS[qualityName];
  const debug = new URLSearchParams(location.search).has('debug');
  const stageEl = canvas.parentElement;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  // Continuous idle drift only on capable, non-touch devices: phones render on demand to save battery.
  const canAmbient = !coarse && qualityName !== 'low';

  // ---------- Renderer (throws if WebGL is unavailable) ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier.antialias && !coarse, // phones: dpr already hides most aliasing
      alpha: false,
      stencil: false,
      powerPreference: qualityName === 'high' ? 'high-performance' : 'default',
    });
  } catch (err) {
    throw new Error('WEBGL_UNAVAILABLE: ' + err.message);
  }
  if (!renderer.getContext()) throw new Error('WEBGL_UNAVAILABLE: no context');

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(COLORS.black, 1);
  if (tier.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  // ---------- Scene, fog, background ----------
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.032);
  const backdrop = makeBackdropTexture();
  scene.background = backdrop;

  // Studio reflections: one small procedural map (built once, per quality tier). Materials read it through
  // scene.environment, so rebuilding it after a context restore needs no material changes.
  let env = buildEnvironment(renderer, qualityName);
  scene.environment = env.texture;

  // ---------- Camera (inside a rig so idle drift never fights the timeline) ----------
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 140);
  const rig = new THREE.Group();
  rig.add(camera);
  scene.add(rig);
  const cameraTarget = new THREE.Vector3(0, 0.5, 0);
  const HERO_DIR = new THREE.Vector3(4.4, 0.75, 6.3); // front three-quarter, slightly above hood height

  // ---------- Lights ----------
  scene.add(new THREE.HemisphereLight(0x8fa3c4, COLORS.black, LIGHTING.hemi));

  const key = new THREE.DirectionalLight(COLORS.key, LIGHTING.key);
  key.position.set(4, 7, 5);
  key.target.position.set(0, 0, 0);
  if (tier.shadowMap) {
    key.castShadow = true;
    const shadowSize = coarse ? Math.min(tier.shadowMap, 512) : tier.shadowMap;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
  }
  // Studio set: cool-white key, electric-blue rims, silver fill. The environment map carries most of the paint
  // highlights, so these stay modest to keep the dark paint from washing out. Low tier drops the second rim and
  // the fill (fewer per-pixel lights); the blue and silver strips in its environment map stand in for them.
  const rimLeft = new THREE.DirectionalLight(COLORS.blue, LIGHTING.rimLeft);
  rimLeft.position.set(-5, 2.2, -6);
  scene.add(key, key.target, rimLeft);
  if (qualityName !== 'low') {
    const rimRight = new THREE.DirectionalLight(COLORS.blue, LIGHTING.rimRight);
    rimRight.position.set(6, 1.5, -5);
    const fill = new THREE.DirectionalLight(COLORS.silver, LIGHTING.fill);
    fill.position.set(-4, 1, 6);
    scene.add(rimRight, fill);
  }

  // ---------- Ground: dark, glossy, blends into fog ----------
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0b0d, roughness: 0.28, metalness: 0.7, envMapIntensity: 0.6,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = !!tier.shadowMap;
  scene.add(ground);

  // Soft blue light pool under the car: cheap stand-in for a real reflection.
  const poolTex = makeRadialTexture();
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshBasicMaterial({
      map: poolTex, color: COLORS.blue, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.002;
  scene.add(pool);

  // ?debug shows the car's bounding box to check framing.
  let debugBox = null;
  if (debug) {
    const { width, height, length } = CAR_BOUNDS;
    debugBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, length)),
      new THREE.LineBasicMaterial({ color: COLORS.blue })
    );
    debugBox.position.y = height / 2;
    scene.add(debugBox);
  }

  // ---------- State ----------
  const api = {
    renderer, scene, camera, cameraTarget, rig,
    quality: qualityName,
    autoFrame: true,       // set false when the scroll timeline drives the camera
    ambient: canAmbient && !motionQuery.matches, // subtle idle drift; off for reduced motion, phones, low tier
    shadowsEnabled: !!tier.shadowMap,
    degradeLevel: 0,       // 0-2: raised automatically if frame rate stays poor
    gpu: lastGPU,
    render, requestRender, resize, start, stop, dispose, onFrame, onQualityChange, frameCamera,
  };

  let width = 0, height = 0;
  let raf = 0, running = false, dirty = true, disposed = false, degradeLevel = 0;
  let last = 0, time = 0, lastRender = 0, warmup = 45;
  let dprScale = 1, sampleN = 0, sampleSum = 0;
  const qualityCallbacks = new Set();
  const callbacks = new Set();
  const minInterval = 1000 / tier.fps - 1;

  // ---------- Sizing ----------
  function frameCamera() {
    const aspect = width / height;
    // Wider lens as the screen gets taller: 42 deg on portrait phones, 32 deg on landscape and desktop.
    camera.fov = THREE.MathUtils.lerp(32, 42, THREE.MathUtils.clamp((1.3 - aspect) / 0.5, 0, 1));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    // Pull back until the car's three-quarter footprint fits the horizontal FOV.
    const hFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect);
    const fitDist = (4.4 / 2) / Math.tan(hFov / 2) / 0.85;
    const baseDist = HERO_DIR.length() - 0.3;
    const dist = Math.max(baseDist, fitDist);
    if (api.autoFrame) {
      camera.position.copy(HERO_DIR).setLength(dist).add(cameraTarget);
      camera.position.y = Math.max(camera.position.y, 1.0);
    }
    scene.fog.density = THREE.MathUtils.clamp(0.032 * (baseDist / dist) ** 0.5, 0.018, 0.032);
  }

  function resize(force = false) {
    const w = Math.max(1, stageEl.clientWidth);
    const h = Math.max(1, stageEl.clientHeight);
    // Mobile URL-bar show/hide changes height only: ignore it to avoid reallocating buffers.
    if (!force && coarse && w === width && Math.abs(h - height) < 120) return;
    width = w; height = h;

    let dpr = Math.min(window.devicePixelRatio || 1, tier.maxDpr) * dprScale;
    if (w * h * dpr * dpr > tier.pixelBudget) dpr = Math.sqrt(tier.pixelBudget / (w * h));
    renderer.setPixelRatio(Math.max(0.6, dpr));
    renderer.setSize(w, h, false); // CSS already sizes the canvas to 100%
    frameCamera();
    dirty = true;
  }

  let resizePending = false;
  const ro = new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; if (!disposed) resize(); });
  });
  ro.observe(stageEl);
  // Some mobile browsers report stale sizes right after rotation: re-measure shortly after.
  const onOrient = () => setTimeout(() => { if (!disposed) resize(true); }, 250);
  window.addEventListener('orientationchange', onOrient);

  // ---------- Render loop ----------
  function render() {
    camera.lookAt(cameraTarget);
    renderer.render(scene, camera);
  }

  function requestRender() { dirty = true; }
  function onFrame(cb) { callbacks.add(cb); return () => callbacks.delete(cb); }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < minInterval) return;
    last = now;
    const dt = Math.min(elapsed, 100) / 1000;
    time += dt;

    callbacks.forEach((cb) => cb(time, dt));
    // Idle drift is capped at 30 fps to save battery; real changes render at the tier's rate.
    const ambientDue = api.ambient && now - lastRender >= 33;
    if (!dirty && !ambientDue) return;
    const explicit = dirty;
    dirty = false;
    if (api.ambient) rig.position.set(Math.sin(time * 0.25) * 0.12, Math.sin(time * 0.18) * 0.03, 0);

    // Frame-rate watchdog: sustained slow cadence during continuous rendering lowers quality.
    const gap = now - lastRender;
    lastRender = now;
    if (warmup > 0) warmup--;
    else if (gap < 120) {
      sampleSum += Math.min(gap / (explicit ? minInterval + 1 : 33), 4);
      if (++sampleN >= 90) {
        if (sampleSum / sampleN > 1.5) degrade();
        sampleN = 0; sampleSum = 0;
      }
    }
    render();
  }

  function degrade() {
    if (degradeLevel >= 2 || disposed) return;
    degradeLevel++;
    api.degradeLevel = degradeLevel;
    dprScale *= 0.75;
    if (degradeLevel >= 2) {
      renderer.shadowMap.enabled = false;
      key.castShadow = false;
      ground.receiveShadow = false;
      groundMat.needsUpdate = true;
      api.shadowsEnabled = false;
      api.ambient = false;
      rig.position.set(0, 0, 0);
    }
    warmup = 45;
    resize(true);
    qualityCallbacks.forEach((cb) => cb(degradeLevel));
  }
  function onQualityChange(cb) { qualityCallbacks.add(cb); return () => qualityCallbacks.delete(cb); }

  function start() {
    if (running || disposed) return;
    running = true;
    last = performance.now();
    warmup = 45;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // ---------- Page visibility, motion preference, context loss ----------
  const onVisibility = () => { document.hidden ? stop() : (dirty = true, start()); };
  document.addEventListener('visibilitychange', onVisibility);

  const onMotion = (e) => {
    api.ambient = canAmbient && !e.matches && degradeLevel < 2;
    if (e.matches) rig.position.set(0, 0, 0);
    dirty = true;
  };
  motionQuery.addEventListener('change', onMotion);

  const onLost = (e) => { e.preventDefault(); stop(); opts.onContextLost?.(); };
  const onRestored = () => {
    // The environment map lives in a render target, whose contents are lost with the context: build it again.
    env.dispose();
    env = buildEnvironment(renderer, qualityName);
    scene.environment = env.texture;
    dirty = true; start(); opts.onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // ---------- Cleanup ----------
  function dispose() {
    disposed = true;
    stop();
    ro.disconnect();
    window.removeEventListener('orientationchange', onOrient);
    document.removeEventListener('visibilitychange', onVisibility);
    motionQuery.removeEventListener('change', onMotion);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => { x.map?.dispose?.(); x.dispose(); });
    });
    scene.environment = null;
    backdrop.dispose(); env.dispose(); poolTex.dispose();
    renderer.dispose();
  }

  // First render happens now so shaders compile behind the loader.
  resize(true);
  render();
  if (debug) window.__aether = api;
  return api;
}

// ================= helpers =================

/**
 * Image-based lighting built from soft boxes: no HDR file, no download. Rendered once into a small PMREM cube.
 * Returns { texture, dispose } so the render target can be freed properly.
 *
 * Layout (car faces +Z, its left is +X): a bright overhead strip and a wide dim fill give the roof and hood a soft
 * gradient; long strips on both sides draw the shoulder line along the doors; blue strips left and behind give the
 * electric-blue rim; a silver strip on the right; a cool front box lights the bonnet and screen. A dim blue-grey
 * dome stops the dark paint from reflecting pure black.
 * Cost steps down with quality: fewer panels and a softer blur (blurrier = cheaper-looking, less mirror-like).
 */
const ENV_TIERS = {
  high:   { rank: 2, sigma: 0.05 },
  medium: { rank: 1, sigma: 0.065 },
  low:    { rank: 0, sigma: 0.08 },
};
// [width, height, color, gain, position, minimum tier rank]   (gain above 1 = brighter than white, HDR)
const ENV_PANELS = [
  [14,  2.4, 0xffffff,      6.0, [0, 7, 0.5],     0],   // overhead strip
  [2.2, 6,   COLORS.blue,   5.0, [-8, 2, 1],      0],   // blue strip, left
  [2.2, 5,   COLORS.silver, 3.0, [8, 2, -2],      0],   // silver strip, right
  [12,  1.6, COLORS.blue,   3.0, [0, 1.5, -9],    0],   // blue strip, behind
  [11,  0.9, COLORS.key,    3.5, [8.5, 3.2, 0],   1],   // long cool-white shoulder strip, left side of the car
  [11,  0.9, COLORS.key,    2.6, [-8.5, 3.2, 0],  1],   // ... and right side
  [16,  7,   0xffffff,      0.8, [0, 8.5, 0.5],   2],   // wide dim overhead fill
  [8,   1.6, COLORS.key,    2.2, [0, 3.5, 9],     2],   // cool front box
];

export function buildEnvironment(renderer, quality = 'high') {
  const cfg = ENV_TIERS[quality] || ENV_TIERS.high;
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x020203);
  const geos = [], mats = [], texs = [];

  for (const [w, h, color, gain, pos, minRank] of ENV_PANELS) {
    if (cfg.rank < minRank) continue;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain), side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.lookAt(0, 0, 0);
    env.add(m);
    geos.push(geo); mats.push(mat);
  }

  if (cfg.rank >= 1) {   // dim blue-grey dome: faint horizon glow fading to black overhead
    const c = document.createElement('canvas');
    c.width = 2; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 64);   // top of the sphere to bottom
    grad.addColorStop(0, '#04050a');
    grad.addColorStop(0.55, '#0c121d');
    grad.addColorStop(0.62, '#111a2a');
    grad.addColorStop(0.75, '#04050a');
    grad.addColorStop(1, '#020203');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(30, 16, 10);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
    env.add(new THREE.Mesh(geo, mat));
    geos.push(geo); mats.push(mat); texs.push(tex);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, cfg.sigma);
  pmrem.dispose();
  // The source scene is no longer needed once it has been baked.
  geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); texs.forEach((x) => x.dispose());

  let freed = false;
  return {
    texture: target.texture,
    panels: env.children.length,
    dispose() { if (freed) return; freed = true; target.dispose(); },   // frees the render target and its texture
  };
}

function makeBackdropTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#050506');
  grad.addColorStop(0.55, '#08090b');
  grad.addColorStop(1, '#101216');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeRadialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
