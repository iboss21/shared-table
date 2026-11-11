'use strict';
// Optional companion that lives above the message box: it paces while agents work, celebrates when they finish and naps when the table is quiet.
// Artwork (c) LIKE A KING INC.: Flick from animatedwebs.com, Perle from theclarte.pro. See public/pets/LICENSE.md.
(() => {
  const PETS = {
    flick: {
      label: 'Flick the fox', height: 92,
      stills: { idle: ['/pets/flick-sit.webp', 222, 300], happy: ['/pets/flick-wave.webp', 263, 300], sleep: ['/pets/flick-sleep.webp', 317, 300, 0.8] },
      walk: { src: '/pets/flick-walk.webp', frames: 43, width: 180, height: 224, ms: 26 },
    },
    perle: {
      label: 'Perle the kitten', height: 96, grid: 4,
      sheets: { walk: '/pets/perle-walk.png', behavior: '/pets/perle-behaviors.png' },
      ground: { walk: [285, 285, 284, 285, 285.5, 285.5, 284.5, 284.5, 284, 284, 283, 283, 283.5, 284.5, 284.5, 284.5], behavior: [303, 303, 302, 302, 301.5, 296.5, 295.5, 294.5, 300, 300, 300, 300, 287.5, 280.5, 271.5, 270.5] },
      actions: {
        idle: { sheet: 'behavior', frames: [12], ms: [1000], loop: true },
        walk: { sheet: 'walk', frames: [...Array(16).keys()], ms: Array(16).fill(70), loop: true },
        happy: { sheet: 'behavior', frames: [6, 7, 6], ms: [500, 600, 420] },
        stretch: { sheet: 'behavior', frames: [6, 7, 6], ms: [500, 600, 420] },
        groom: { sheet: 'behavior', frames: [8, 9, 10, 11, 10, 9, 8, 9, 10, 11, 10, 9], ms: Array(12).fill(240) },
        sleep: { sheet: 'behavior', frames: [12, 13, 14, 15], ms: [320, 500, 700, 5000], hold: true },
      },
    },
  };
  const images = new Map();
  const load = src => { if (!images.has(src)) { const image = new Image(); image.src = src; images.set(src, image); } return images.get(src); };
  // Perle's sheets carry a faint light haze around the artwork that only shows on dark themes: drop near-transparent pixels once.
  const cleaned = new Map();
  function clean(image) {
    if (cleaned.has(image)) return cleaned.get(image);
    const sheet = document.createElement('canvas'); sheet.width = image.naturalWidth; sheet.height = image.naturalHeight;
    const g = sheet.getContext('2d', { willReadFrequently: true }); g.drawImage(image, 0, 0);
    const data = g.getImageData(0, 0, sheet.width, sheet.height), d = data.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] < 90 ? 0 : d[i] < 150 ? (d[i] - 90) * 2.5 : d[i];
    g.putImageData(data, 0, 0); cleaned.set(image, sheet); return sheet;
  }
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  let pet = null, canvas = null, bubble = null, context = null, mood = 'idle', since = 0, x = 24, y = 0, direction = 1, lastTick = 0, quietSince = performance.now(), frameHandle = 0, working = false;
  let perch = null, bounds = () => ({ left: 0, right: innerWidth, y: innerHeight }), onMenu = () => {}, onPet = () => {}, bubbleTimer = 0, pauseUntil = 0;
  const SIZE = () => (innerWidth < 980 ? 84 : 120);
  const store = { get() { try { return JSON.parse(localStorage.getItem('st-pet-spot') || 'null'); } catch { return null; } }, set(value) { try { if (value) localStorage.setItem('st-pet-spot', JSON.stringify(value)); else localStorage.removeItem('st-pet-spot'); } catch { /* private mode */ } } };

  function setMood(next) { if (mood !== next) { mood = next; since = performance.now(); } }

  function draw(now) {
    frameHandle = requestAnimationFrame(draw);
    if (!pet || document.hidden) { lastTick = now; return; }
    const elapsed = Math.min(64, now - lastTick); lastTick = now;
    const size = SIZE(), area = bounds();
    if (mood === 'happy' && now - since > 1700) setMood(roaming(now) ? 'walk' : 'idle');
    if (mood === 'idle' && !working && now - quietSince > 90000) setMood('sleep');
    // Small idle habits so the pet is not a statue: Perle grooms or stretches, Flick waves.
    if (mood === 'idle' && !working && now - since > 14000 && now - quietSince < 90000) setMood(pet.actions ? (Math.random() < 0.5 ? 'groom' : 'stretch') : 'happy');
    if (perch) { x = Math.min(Math.max(0, perch.x * innerWidth), innerWidth - size); y = Math.min(Math.max(0, perch.y * innerHeight), innerHeight - size); if (mood === 'walk') setMood('idle'); }
    else {
      // Wandering: pace while agents work; otherwise stroll now and then and sit in between.
      if (mood === 'walk' || mood === 'idle') setMood(roaming(now) ? 'walk' : 'idle');
      if (mood === 'walk' && !calm.matches) { x += direction * elapsed * (working ? 0.05 : 0.03); if (x > area.right - size - 8) direction = -1; if (x < area.left + 8) direction = 1; }
      x = Math.min(Math.max(area.left, x), Math.max(area.left, area.right - size)); y = area.y - size + 8;
    }
    canvas.style.translate = Math.round(x) + 'px ' + Math.round(y) + 'px';
    if (bubble && !bubble.hidden) bubble.style.translate = Math.round(Math.min(Math.max(8, x + size / 2 - bubble.offsetWidth / 2), innerWidth - bubble.offsetWidth - 8)) + 'px ' + Math.round(Math.max(8, y - bubble.offsetHeight - 2)) + 'px';

    const pixels = canvas.width, scale = pixels / 120;
    context.clearRect(0, 0, pixels, pixels);
    context.save();
    context.translate(pixels / 2, pixels - 4 * scale);
    if (direction < 0) context.scale(-1, 1);
    const t = now - since;
    if (pet.walk) { // Flick: still poses plus a walk strip
      if (mood === 'walk' && !calm.matches) {
        const strip = load(pet.walk.src), frame = Math.floor(t / pet.walk.ms) % pet.walk.frames, h = pet.height * scale * 1.12, w = h * pet.walk.width / pet.walk.height;
        if (strip.complete && strip.naturalWidth) context.drawImage(strip, frame * pet.walk.width, 0, pet.walk.width, pet.walk.height, -w / 2, -h, w, h);
      } else {
        const [src, width, height, shrink = 1] = pet.stills[mood === 'walk' ? 'idle' : mood] || pet.stills.idle, image = load(src);
        const breathe = 1 + Math.sin(now / (mood === 'sleep' ? 730 : 540)) * 0.012, hop = mood === 'happy' ? Math.abs(Math.sin(t / 180)) * 10 * scale * Math.max(0, 1 - t / 1500) : 0;
        const h = pet.height * scale * shrink * breathe, w = pet.height * scale * shrink * width / height;
        if (image.complete && image.naturalWidth) context.drawImage(image, -w / 2, -h - hop, w, h);
      }
    } else { // Perle: two 4x4 sprite sheets
      const action = pet.actions[mood] || pet.actions.idle, total = action.ms.reduce((sum, value) => sum + value, 0);
      let time = action.loop ? t % total : Math.min(t, total - 1), index = action.frames.at(-1);
      for (let i = 0; i < action.frames.length; i++) { if (time < action.ms[i]) { index = action.frames[i]; break; } time -= action.ms[i]; }
      if (!action.loop && !action.hold && t >= total) setMood(working ? 'walk' : 'idle');
      const sheet = load(pet.sheets[action.sheet]);
      if (sheet.complete && sheet.naturalWidth) {
        const cell = sheet.naturalWidth / pet.grid, fit = pet.height * scale * 1.22 / cell, ground = pet.ground[action.sheet][index] / 313.5 * cell;
        context.drawImage(clean(sheet), (index % pet.grid) * cell, Math.floor(index / pet.grid) * cell, cell, cell, -cell * fit / 2, -ground * fit, cell * fit, cell * fit);
      }
    }
    context.restore();
  }

  // Stroll for a while, rest for a while; always pace while agents are working.
  function roaming(now) { if (calm.matches || now < pauseUntil) return false; return working || (now / 1000) % 34 < 9; }
  function say(text, ms = 5000) {
    if (!bubble || !pet) return;
    bubble.textContent = text; bubble.hidden = false;
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
  }

  function choose(name) {
    pet = PETS[name] || null;
    if (!canvas) return;
    canvas.hidden = !pet;
    if (pet) { for (const still of Object.values(pet.stills || {})) load(still[0]); if (pet.walk) load(pet.walk.src); for (const src of Object.values(pet.sheets || {})) load(src); canvas.title = pet.label + ': click to say hello'; setMood(working ? 'walk' : 'idle'); quietSince = performance.now(); }
    if (pet && !frameHandle) { lastTick = performance.now(); frameHandle = requestAnimationFrame(draw); }
    if (!pet && frameHandle) { cancelAnimationFrame(frameHandle); frameHandle = 0; }
  }

  window.SharedTablePet = {
    list: () => Object.entries(PETS).map(([id, item]) => [id, item.label]),
    mount(element, speech, options = {}) {
      canvas = element; bubble = speech; context = canvas.getContext('2d'); canvas.width = canvas.height = 240;
      bounds = options.bounds || bounds; onMenu = options.onMenu || onMenu; onPet = options.onPet || onPet; perch = store.get();
      // Drag to put the pet anywhere; it stays there until told to wander again. A plain click pets it.
      let drag = null;
      canvas.addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = { dx: event.clientX - x, dy: event.clientY - y, moved: false, startX: event.clientX, startY: event.clientY }; canvas.setPointerCapture(event.pointerId); });
      canvas.addEventListener('pointermove', event => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
        drag.moved = true; canvas.classList.add('dragging');
        perch = { x: (event.clientX - drag.dx) / innerWidth, y: (event.clientY - drag.dy) / innerHeight };
      });
      const release = () => { if (!drag) return; const moved = drag.moved; drag = null; canvas.classList.remove('dragging'); quietSince = performance.now(); if (moved) store.set(perch); else { setMood('happy'); onPet(); } };
      canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
      canvas.addEventListener('contextmenu', event => { event.preventDefault(); quietSince = performance.now(); onMenu(event.clientX, event.clientY); });
      let press = 0;
      canvas.addEventListener('touchstart', event => { const touch = event.touches[0]; press = setTimeout(() => onMenu(touch.clientX, touch.clientY), 600); }, { passive: true });
      for (const type of ['touchend', 'touchmove', 'touchcancel']) canvas.addEventListener(type, () => clearTimeout(press), { passive: true });
    },
    say,
    wander() { perch = null; store.set(null); pauseUntil = 0; },
    perched: () => !!perch,
    /** Ask for a pose: sit, sleep, wave, stretch, groom. Returns the poses this pet knows. */
    act(name) { quietSince = performance.now(); const map = { sit: 'idle', wave: 'happy' }; const next = map[name] || name; if (next === 'sleep') quietSince = 0; if (next === 'idle') pauseUntil = performance.now() + 30000; setMood(next); },
    poses: () => (pet?.actions ? ['sit', 'stretch', 'groom', 'sleep'] : ['sit', 'wave', 'sleep']),
    current: () => (pet ? pet.label : ''),
    choose,
    /** working: agents are running. finished: a turn just ended. */
    signal(kind) {
      quietSince = performance.now();
      if (kind === 'working') { working = true; if (mood !== 'happy') setMood('walk'); }
      if (kind === 'finished') { working = false; setMood('happy'); }
      if (kind === 'idle') { working = false; if (mood === 'walk') setMood('idle'); }
      if (kind === 'wake' && mood === 'sleep' && performance.now() - since > 1500) setMood('idle');
    },
  };
})();
