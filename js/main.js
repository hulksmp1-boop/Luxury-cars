/**
 * Luxury Automotive — JavaScript entry point (Phase 1)
 * Basic initialization only. Features (data, search, 3D, motion) arrive in later phases.
 */
(() => {
  'use strict';

  /** Shared runtime flags that later modules can read. */
  const env = {
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    isTouch: window.matchMedia('(pointer: coarse)').matches,
  };

  /** Header scroll state + accessible mobile menu. */
  function initNav() {
    const header = document.querySelector('[data-header]');
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-nav]');
    if (!header || !toggle || !nav) return;

    const label = toggle.querySelector('.visually-hidden');
    const desktop = window.matchMedia('(min-width: 1024px)');

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      if (label) label.textContent = open ? 'Close menu' : 'Open menu';
      header.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-locked', open);
    };

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && header.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    desktop.addEventListener('change', (e) => { if (e.matches) setOpen(false); });

    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /** Lightweight scroll reveal for [data-reveal] elements. */
  function initReveal() {
    const items = document.querySelectorAll('[data-reveal]');
    if (!items.length) return;
    if (env.prefersReducedMotion || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 4) * 70}ms`;
      io.observe(el);
    });
  }

  /** Manufacturers: the active row drives the sticky preview panel (desktop). */
  function initManufacturers() {
    const list = document.querySelector('[data-brand-list]');
    const panel = document.querySelector('[data-brand-preview]');
    if (!list || !panel) return;

    const img = panel.querySelector('[data-preview-img]');
    const mono = panel.querySelector('[data-preview-mono]');
    const name = panel.querySelector('[data-preview-name]');
    const meta = panel.querySelector('[data-preview-meta]');
    const note = panel.querySelector('[data-preview-note]');
    const rows = [...list.querySelectorAll('[data-brand]')];
    let current = null;

    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => img.classList.remove('is-loaded')); // typographic fallback stays visible

    const activate = (row) => {
      if (row === current) return;
      current = row;
      rows.forEach((r) => {
        const on = r === row;
        r.classList.toggle('is-active', on);
        r.querySelector('.brand__btn').setAttribute('aria-pressed', String(on));
      });
      const d = row.dataset;
      name.textContent = d.name;
      meta.textContent = `${d.country} \u00b7 Est. ${d.year}`;
      note.textContent = d.note;
      mono.textContent = d.name.charAt(0);
      img.classList.remove('is-loaded');
      img.removeAttribute('src');
      img.src = d.img;
    };

    rows.forEach((row) => {
      const btn = row.querySelector('.brand__btn');
      btn.addEventListener('mouseenter', () => activate(row));
      btn.addEventListener('focus', () => activate(row));
      btn.addEventListener('click', () => activate(row));
    });
    // Defer the first preview image until the panel is on screen.
    const first = () => activate(rows[0]);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { first(); io.disconnect(); } }, { rootMargin: '200px' });
      io.observe(panel);
    } else {
      first();
    }
  }

  /** Featured cars: render from window.LA_CARS and drive the frontend-only detail dialog. */
  function initCars() {
    const cars = window.LA_CARS;
    const host = document.querySelector('[data-cars]');
    const dialog = document.querySelector('[data-car-dialog]');
    if (!Array.isArray(cars) || !host || !dialog) return;

    const layouts = ['wide', 'lg', 'sm', 'sm', 'lg', 'wide flip', 'lg', 'sm'];
    const power = (c) => `${c.power.ps.toLocaleString('en-US')} PS \u00b7 ${c.power.hp.toLocaleString('en-US')} hp`;
    const media = (c, extra = '') => `
      <div class="car__fallback" aria-hidden="true"><svg class="car__sil"><use href="#car-silhouette"></use></svg><span class="label">${c.manufacturer} ${c.model}</span></div>
      <img class="car__img" data-car-img src="${c.image}" alt="${c.manufacturer} ${c.model}" width="1600" height="1100" decoding="async" ${extra}>`;

    host.insertAdjacentHTML('beforeend', cars.map((c, i) => {
      const lay = (layouts[i % layouts.length]).split(' ').map((l) => `car--${l}`).join(' ');
      return `
      <article class="car ${lay}" data-car="${c.id}" data-reveal>
        <figure class="car__media" data-car-open>
          ${media(c, 'loading="lazy"')}
          <span class="car__index" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
          <span class="car__year label">${c.year}</span>
        </figure>
        <div class="car__body">
          <p class="eyebrow">${c.manufacturer} <span aria-hidden="true">/</span> ${c.category}</p>
          <h3 class="car__name">${c.model}</h3>
          <p class="car__power label">${c.powertrain}</p>
          <p class="car__desc">${c.summary}</p>
          <dl class="car__stats">
            <div><dt>Power</dt><dd>${c.power.ps.toLocaleString('en-US')} PS</dd></div>
            <div><dt>0\u2013100 km/h</dt><dd>${c.zeroTo100}</dd></div>
          </dl>
          <button class="btn btn--text car__cta" type="button" data-car-open aria-label="View details: ${c.manufacturer} ${c.model}">View Details</button>
        </div>
      </article>`;
    }).join(''));

    // Hide broken images so the silhouette fallback shows.
    const guard = (root) => root.querySelectorAll('[data-car-img]').forEach((img) => {
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
    });
    guard(host);

    const $ = (s) => dialog.querySelector(s);
    const rows = (c) => [
      ['Powertrain', c.powertrain],
      ['Power', power(c)],
      c.torqueNm ? ['Torque', `${c.torqueNm.toLocaleString('en-US')} Nm`] : null,
      ['0\u2013100 km/h', c.zeroTo100],
      ['Top speed', c.topSpeed],
      ...(c.extras || []),
      ['Model year', c.year],
    ].filter(Boolean);

    let opener = null;
    const open = (id, trigger) => {
      const c = cars.find((x) => x.id === id);
      if (!c) return;
      opener = trigger;
      $('[data-dialog-media]').innerHTML = media(c);
      guard($('[data-dialog-media]'));
      $('[data-dialog-eyebrow]').textContent = `${c.manufacturer} \u00b7 ${c.category}`;
      $('[data-dialog-title]').textContent = c.model;
      $('[data-dialog-desc]').textContent = c.description;
      $('[data-dialog-specs]').innerHTML = rows(c).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
      $('.car-dialog__panel').scrollTop = 0;
      document.body.classList.add('nav-locked');
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    };
    const close = () => {
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      document.body.classList.remove('nav-locked');
      if (opener && opener.focus) opener.focus();
    };

    host.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-car-open]');
      const card = e.target.closest('[data-car]');
      if (trigger && card) open(card.dataset.car, card.querySelector('button[data-car-open]'));
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-car-close]')) close();
    });
    dialog.addEventListener('close', () => document.body.classList.remove('nav-locked')); // covers Esc
  }

  /** Contact: client-side validation and a demo success state. Nothing is sent anywhere. */
  function initContact() {
    const form = document.querySelector('[data-contact-form]');
    const success = document.querySelector('[data-contact-success]');
    if (!form || !success) return;

    const rules = {
      name: (v) => (v.length >= 2 ? '' : 'Please enter your full name.'),
      email: (v) => (!v ? 'Please enter your email address.'
        : /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Please enter a valid email address.'),
      message: (v) => (v.length >= 10 ? '' : 'Please write a message of at least 10 characters.'),
    };
    const fields = Object.keys(rules).map((key) => {
      const input = form.elements[key];
      return { key, input, error: document.getElementById(input.getAttribute('aria-describedby')) };
    });

    const check = ({ key, input, error }) => {
      const msg = rules[key](input.value.trim());
      error.textContent = msg;
      input.setAttribute('aria-invalid', String(Boolean(msg)));
      return !msg;
    };

    fields.forEach((f) => {
      f.input.addEventListener('blur', () => { if (f.input.value) check(f); });
      f.input.addEventListener('input', () => { if (f.input.getAttribute('aria-invalid') === 'true') check(f); });
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const results = fields.map(check);
      const firstBad = fields[results.indexOf(false)];
      if (firstBad) { firstBad.input.focus(); return; }

      const first = form.elements.name.value.trim().split(/\s+/)[0];
      success.querySelector('[data-success-title]').textContent = `Thank you, ${first}`;
      form.hidden = true;
      success.hidden = false;
      success.focus();
    });

    success.querySelector('[data-contact-reset]').addEventListener('click', () => {
      form.reset();
      fields.forEach(({ input, error }) => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
      success.hidden = true;
      form.hidden = false;
      form.elements.name.focus();
    });
  }

  /** Footer: current year. */
  function initYear() {
    document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
  }

  function init() {
    document.documentElement.classList.remove('no-js');
    document.documentElement.classList.add('js');
    document.documentElement.dataset.motion = env.prefersReducedMotion ? 'reduced' : 'full';

    // Keep the motion flag in sync if the user changes the OS setting mid-session.
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      env.prefersReducedMotion = e.matches;
      document.documentElement.dataset.motion = e.matches ? 'reduced' : 'full';
    });

    initNav();
    initCars();
    initReveal();
    initManufacturers();
    initContact();
    initYear();

    // Exposed for future modules (e.g. 3D scene, GSAP) to consult.
    window.LA = Object.freeze({ env });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
