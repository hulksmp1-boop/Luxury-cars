/**
 * Luxury Automotive — 3D scene (Phase 3)
 * Task 1: scene, camera, renderer, lights, neutral ground, visibility/reduced-motion handling.
 * Task 2: loads ONE local GLB car (path from data-model on the stage), fits it to the container.
 *
 * Three.js and its loader are fetched lazily from a pinned CDN build when the stage nears the
 * viewport. Classic script + dynamic import(), so it also works from file:// (the GLB itself
 * needs a local web server, see assets/models/README.md).
 */
(() => {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0';
  const THREE_URL = `${CDN}/build/three.module.min.js`; // must match the importmap in index.html
  const GLTF_URL = `${CDN}/examples/jsm/loaders/GLTFLoader.js`;
  const ENV_URL = `${CDN}/examples/jsm/environments/RoomEnvironment.js`;

  const CAR_LENGTH = 4.6; // world units the car's longest horizontal side is scaled to
  const FRAME = 0.86;     // fraction of the viewport the car may occupy (leaves room for drift)

  const stage = document.querySelector('[data-xp-stage]');
  if (!stage) return;
  const status = stage.querySelector('[data-xp-status]');
  const statusText = stage.querySelector('[data-xp-status-text]');
  const fallback = stage.querySelector('[data-xp-fallback]');
  const modelFallback = stage.querySelector('[data-xp-model-fallback]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  function showFallback(reason) {
    stage.classList.remove('is-ready');
    stage.classList.add('is-fallback');
    if (status) status.hidden = true;
    if (fallback) {
      fallback.hidden = false;
      if (reason) fallback.querySelector('[data-xp-reason]').textContent = reason;
    }
  }

  function webglAvailable() {
    try {
      const probe = document.createElement('canvas');
      return Boolean(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')));
    } catch (_) {
      return false;
    }
  }

  async function start() {
    if (!webglAvailable()) return showFallback('Your browser or device does not support WebGL.');

    let THREE;
    try {
      THREE = await import(THREE_URL);
    } catch (_) {
      return showFallback('The 3D engine could not be loaded. Check your connection and reload.');
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (_) {
      return showFallback('The 3D scene could not be started on this device.');
    }

    const BG = 0x08090b;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 10, 26);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    stage.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    // Lighting: soft sky/ground fill, a warm key, and a cool accent rim.
    const hemi = new THREE.HemisphereLight(0x9fb4ff, 0x101216, 0.55);
    const key = new THREE.DirectionalLight(0xf3efe8, 2.2);
    key.position.set(4, 6, 3);
    const rim = new THREE.DirectionalLight(0x5b8cff, 1.4);
    rim.position.set(-5, 3, -4);
    scene.add(hemi, key, rim);

    // Neutral ground: dark floor fading into fog, plus a subtle stage disc.
    const groundMat = (color, rough, metal) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.3 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), groundMat(0x14171c, 0.6, 0.25));
    floor.rotation.x = -Math.PI / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.6, 64), groundMat(0x1c2027, 0.45, 0.35));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    scene.add(floor, disc);

    // --- Framing: camera is fitted to the model's bounds for the current aspect ratio ---
    const bounds = new THREE.Box3(new THREE.Vector3(-2.3, 0, -0.95), new THREE.Vector3(2.3, 1.3, 0.95)); // placeholder footprint
    const view = { az: 0.61, el: 0.2, dist: 10 }; // azimuth from +Z toward +X, elevation (radians)
    const center = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const pt = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);

    function setDir(az) {
      dir.set(Math.sin(az) * Math.cos(view.el), Math.sin(view.el), Math.cos(az) * Math.cos(view.el));
    }
    function fit() {
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanH = tanV * camera.aspect;
      bounds.getCenter(center);
      setDir(view.az);
      fwd.copy(dir).negate();
      right.crossVectors(fwd, UP).normalize();
      up.crossVectors(right, fwd);
      let need = 3;
      for (let i = 0; i < 8; i++) {
        pt.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z).sub(center);
        const f = pt.dot(fwd);
        need = Math.max(need, Math.abs(pt.dot(right)) / (FRAME * tanH) - f, Math.abs(pt.dot(up)) / (FRAME * tanV) - f);
      }
      view.dist = need;
    }

    // --- Render loop: runs only while visible, tab active and motion allowed ---
    let raf = 0;
    let visible = true;
    let contextLost = false;

    function draw(t = 0) {
      // Very gentle orbit drift around the car; fixed when reduced motion is requested.
      setDir(view.az + (reduceMotion.matches ? 0 : Math.sin(t * 0.0002) * 0.1));
      camera.position.copy(center).addScaledVector(dir, view.dist);
      camera.lookAt(center);
      renderer.render(scene, camera);
    }
    function frame(t) {
      raf = requestAnimationFrame(frame);
      draw(t);
    }
    function sync() {
      const run = visible && !document.hidden && !contextLost && !reduceMotion.matches;
      if (run && !raf) raf = requestAnimationFrame(frame);
      else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!run && visible && !contextLost) draw(); // single static frame
    }

    function resize() {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2));
      renderer.setSize(w, h, false); // CSS controls the canvas box
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fit();
      if (!raf) draw();
    }

    new ResizeObserver(resize).observe(stage);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { rootMargin: '100px 0px' }).observe(stage);
    document.addEventListener('visibilitychange', sync);
    reduceMotion.addEventListener('change', sync);
    renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; sync(); });
    renderer.domElement.addEventListener('webglcontextrestored', () => { contextLost = false; sync(); });

    resize();
    sync();
    stage.classList.add('is-ready');

    const api = { THREE, scene, camera, renderer, stage, requestRender: draw, model: null };
    window.LuxuryScene = api; // handle for later tasks

    // --- Task 2: one car model ---------------------------------------------------
    const setProgress = (p) => stage.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
    function finishLoading(ok) {
      if (status) status.hidden = true;
      if (!ok && modelFallback) modelFallback.hidden = false;
      stage.classList.toggle('has-model', ok);
      draw();
    }

    function addContactShadow(size) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(0,0,0,0.8)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.01;
      m.scale.set(size.x * 1.35, size.z * 1.5, 1);
      scene.add(m);
    }

    function place(root) {
      // Scale the longest horizontal side to CAR_LENGTH, centre on the origin, sit on the ground.
      let box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      if (![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Empty model');
      root.scale.multiplyScalar(CAR_LENGTH / Math.max(size.x, size.z));
      root.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(root);
      const c = box.getCenter(new THREE.Vector3());
      root.position.set(root.position.x - c.x, root.position.y - box.min.y, root.position.z - c.z);
      root.updateMatrixWorld(true);

      bounds.setFromObject(root);
      const s = bounds.getSize(new THREE.Vector3());
      view.az = s.x >= s.z ? 0.96 : 0.61; // front/rear three-quarter whichever way the car is exported
      const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      root.traverse((o) => {
        if (!o.isMesh) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.isMeshStandardMaterial) m.envMapIntensity = 1;
          ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach((k) => { if (m[k]) m[k].anisotropy = maxAniso; });
        });
      });
      scene.add(root);
      addContactShadow(s);
      api.model = root;
      fit();
    }

    async function loadCar() {
      const url = stage.dataset.model;
      if (!url) return finishLoading(false);
      if (statusText) statusText.textContent = 'Loading vehicle\u2026';

      let GLTFLoader;
      try {
        ({ GLTFLoader } = await import(GLTF_URL));
      } catch (_) {
        return finishLoading(false);
      }

      // Image-based lighting gives paint and glass believable reflections for the price of one
      // small procedural environment. Optional: the car still renders without it.
      try {
        const { RoomEnvironment } = await import(ENV_URL);
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        hemi.intensity = 0.3;
        key.intensity = 1.7;
      } catch (_) { /* keep the direct lights */ }

      new GLTFLoader().load(
        url,
        (gltf) => {
          try { place(gltf.scene); finishLoading(true); } catch (_) { finishLoading(false); }
        },
        (e) => setProgress(e.lengthComputable && e.total ? e.loaded / e.total : 0.35),
        () => finishLoading(false)
      );
    }
    loadCar();
  }

  // Load and start only when the stage approaches the viewport.
  const starter = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      starter.disconnect();
      start();
    }
  }, { rootMargin: '300px 0px' });
  starter.observe(stage);
})();
