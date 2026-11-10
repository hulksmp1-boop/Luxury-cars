# Aether GT — cinematic scroll showcase

ES modules need a local server (they won't run from file://).

    npx serve .        # or: python3 -m http.server 8000
    # or VS Code "Live Server"

Then open the printed localhost URL.

Status: Phase 2 (3D scene foundation) complete. GLB loading foundation added (BMW M5 F90, no wheel animation yet).

Debug: add ?debug to the URL to show the car bounding box; ?quality=low|medium|high forces a quality tier.

Car model: `assets/models/bmw_m5_f90.glb` (original file, uncompressed, ~40 MB). If it fails to load the procedural car is used; `?car=procedural` forces that fallback.

Credits: "Bmw M5 F90" by RES1N (https://sketchfab.com/Resinnnn), https://sketchfab.com/3d-models/bmw-m5-f90-5478e978bd634337adc8e3dc413fbfa3, licensed CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). Attribution must stay visible wherever the project is published.
