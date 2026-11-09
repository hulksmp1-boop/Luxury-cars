# 3D car model

Place **one** lightweight, optimized car model here named exactly:

    assets/models/car.glb

The path is set by `data-model` on the `[data-xp-stage]` element in `index.html`.

Guidelines: under ~5 MB, roughly 100k triangles or fewer, textures 2048px or smaller (ideally
compressed to WebP/JPEG), PBR materials, license permitting web use (CC0 / CC-BY with credit).
Draco/KTX2-compressed files are not supported by this setup; export a plain GLB.

The model is auto-scaled, centred and placed on the ground, so any real-world scale or origin works.
Serve the site over HTTP (`python3 -m http.server 8000`); browsers block loading the GLB from `file://`.
Without the file, the page shows a "Vehicle preview unavailable" fallback.
