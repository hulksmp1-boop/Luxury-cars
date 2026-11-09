# Luxury Automotive

A premium, cinematic, multi-brand luxury automotive website. Frontend only: HTML5, CSS3, vanilla JavaScript. Three.js and GSAP + ScrollTrigger are planned for later phases.

> The brand name is intentionally undecided. Page title and metadata are placeholders.

## Status

**Phase 2 — Complete One-Page Frontend Structure** (complete): project structure, design system, HTML/CSS/JS foundations. No page sections yet.

## Structure

```
luxury-automotive/
├── index.html
├── css/styles.css      # tokens, reset, typography, layout, buttons, utilities, a11y
├── js/main.js          # entry point, basic initialization
├── assets/
│   ├── images/
│   ├── models/         # GLB/glTF (later phases)
│   └── icons/
└── README.md
```

## Run

No build step or dependencies. Either:

- Open `index.html` directly in a browser, or
- Serve the folder locally (recommended for later phases, which load models and modules):

```bash
cd luxury-automotive
python3 -m http.server 8000
# open http://localhost:8000
```

Fonts (Cormorant Garamond, Inter) load from Google Fonts, so an internet connection is needed to see them; system fallbacks are defined.

## Design system (summary)

- **Colors:** deep black / charcoal / graphite backgrounds, warm white text, muted silver secondary, restrained electric blue accent (`--color-accent`).
- **Type:** Cormorant Garamond (display), Inter (UI and body), fluid `clamp()` scale.
- **Spacing:** 4px-based scale (`--space-1` … `--space-11`), fluid `--section-space`, `.container` with fluid gutters.
- **Breakpoints (mobile-first):** 640 / 768 / 1024 / 1280 / 1536 px.
- **Buttons:** `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--text`.
- **Accessibility:** skip link, visible `:focus-visible` states, `prefers-reduced-motion` support.
