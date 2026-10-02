import { makeConfig, PRESETS } from './core/config.js';
import { World } from './core/world.js';
import { Raster } from './render/raster.js';
import { MapView, LAYERS } from './render/mapview.js';
import { SectionView } from './render/section.js';
import { SnapshotStore } from './ui/snapshots.js';
import { TUNING, el, slider, toggles } from './ui/controls.js';
import { elevationOf } from './sim/elevation.js';
import * as CM from './render/colormaps.js';
import { ROCKS } from './sim/rocks.js';

const mapCanvas = document.getElementById('map');
const secCanvas = document.getElementById('section');
const panel = document.getElementById('panel');

let cfg = makeConfig('small');
let world = new World(cfg);
let raster = new Raster(world);
let view = new MapView(mapCanvas, world, raster);
let section = new SectionView(secCanvas, world);
view.section = section;
let snaps = new SnapshotStore(cfg);

let running = false;
let speed = 2;                 // target simulation steps per second; Infinity = as fast as possible
let dirty = true;
let replayIndex = -1;          // >=0 while scrubbing history
let inspect = null;
let sectionMode = false;      // sticky 'cut a section' mode, as well as shift-drag

// ---------------------------------------------------------------------------
// canvas sizing
// ---------------------------------------------------------------------------
function resize() {
  for (const [c, h] of [[mapCanvas, null], [secCanvas, 230]]) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(64, Math.floor(r.width * dpr));
    c.height = Math.max(64, Math.floor((h ?? r.height) * dpr));
  }
  dirty = true;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// simulation loop
// ---------------------------------------------------------------------------
let lastStep = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (running && replayIndex < 0) {
    const budget = speed === Infinity ? 1 : 1000 / speed;
    if (now - lastStep >= budget) {
      lastStep = now;
      const t0 = performance.now();
      do { world.step(); } while (speed === Infinity && performance.now() - t0 < 60);
      snaps.maybeCapture(world);
      dirty = true;
    }
  }
  if (dirty) {
    raster.rasterise();
    view.draw();
    section.draw();
    updateHud();
    updateStats();
    dirty = false;
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const clockEl = document.getElementById('clock');
const readoutEl = document.getElementById('readout');
const legendEl = document.getElementById('legend');

function updateHud() {
  clockEl.textContent = `${world.t.toFixed(0)} Myr`;
  const s = world.stats();
  let txt = `${s.crustPoints} crust · ${s.slabPoints} slab · ${s.plates} plates\n`
          + `${s.faults} faults · ${s.segments} ridge seg · ${s.trenches} subduction zones\n`
          + `sea level ${world.seaLevel.toFixed(2)} km`;
  if (inspect) txt += `\n\n${inspect}`;
  readoutEl.textContent = txt;
  drawLegend();
}

function drawLegend() {
  const base = view.base;
  const stops = [];
  const add = (c, label) => stops.push({ c, label });
  if (base === 'elevation') {
    add(CM.bathymetry(0.1), '−7 km'); add(CM.bathymetry(0.9), 'sea level');
    add(CM.hypsometric(0.3), '+2 km'); add(CM.hypsometric(1), '+6.5 km');
  } else if (base === 'age') {
    add(CM.ageRamp(0), '0 Myr'); add(CM.ageRamp(0.5), '90'); add(CM.ageRamp(1), '180+');
  } else if (base === 'crust') {
    add(CM.crustRamp(0), 'oceanic'); add(CM.crustRamp(1), 'continental');
  } else if (base === 'weakness') {
    add(CM.weaknessRamp(0), 'intact'); add(CM.weaknessRamp(1), 'inherited scar');
  } else if (base === 'stress') {
    add(CM.stressRamp(0), 'compression'); add(CM.stressRamp(1), 'extension');
  } else if (base === 'slabDepth') {
    add(CM.slabRamp(0), '0 km'); add(CM.slabRamp(0.5), '330'); add(CM.slabRamp(1), '660');
  } else if (base === 'basement age') {
    add(CM.provinceRamp(0), 'active'); add(CM.provinceRamp(0.4), '~800 Myr');
    add(CM.provinceRamp(1), '2 Gyr craton');
  } else if (base === 'heat flow') {
    add(CM.heatRamp(0), '~20 mW/m²'); add(CM.heatRamp(0.5), '~80');
    add(CM.heatRamp(1), '300+ (ridge axis)');
  } else if (base === 'Bouguer gravity') {
    add(CM.gravityRamp(0), '−600 mGal (root)'); add(CM.gravityRamp(0.5), '0');
    add(CM.gravityRamp(1), '+600 (ocean)');
  } else if (base === 'free-air gravity') {
    add(CM.gravityRamp(0), '−250 mGal'); add(CM.gravityRamp(0.5), '0 (compensated)');
    add(CM.gravityRamp(1), '+250');
  } else if (base === 'surface geology') {
    for (const id of [3, 5, 4, 1, 2, 12, 9]) add(ROCKS[id].color, ROCKS[id].name);
  } else if (base === 'mantle') {
    add(CM.mantleRamp(0), 'cold downwelling'); add(CM.mantleRamp(0.5), 'ambient');
    add(CM.mantleRamp(1), 'hot upwelling');
  } else if (base === 'strain rate') {
    add(CM.strainRamp(0), 'rigid interior'); add(CM.strainRamp(0.5), '~200 nstrain/yr');
    add(CM.strainRamp(1), '2500 (fast boundary)');
  } else { legendEl.innerHTML = ''; return; }
  legendEl.innerHTML = '';
  for (const s of stops) {
    legendEl.append(el('div', { class: 'row' },
      el('div', { class: 'sw', style: `background:${CM.rgb(s.c)}` }),
      el('span', { text: s.label })));
  }
  if (view.overlays.faults) {
    legendEl.append(el('div', { class: 'row', style: 'margin-top:5px' },
      el('div', { class: 'sw', style: `background:linear-gradient(90deg,${CM.rgb(CM.obliquityColor(0))},${CM.rgb(CM.obliquityColor(Math.PI / 2))},${CM.rgb(CM.obliquityColor(Math.PI))})` }),
      el('span', { text: 'conv → transf → div' })));
  }
}

// ---------------------------------------------------------------------------
// map interaction
// ---------------------------------------------------------------------------
let drag = null;

function canvasPos(e) {
  const dpr = mapCanvas.width / mapCanvas.getBoundingClientRect().width;
  return [e.offsetX * dpr, e.offsetY * dpr];
}

function setSectionMode(on) {
  sectionMode = on;
  mapCanvas.classList.toggle('sectioning', on);
  const b = document.getElementById('secDraw');
  if (b) b.classList.toggle('on', on);
}

mapCanvas.addEventListener('pointerdown', (e) => {
  const [sx, sy] = canvasPos(e);

  // Grabbing an endpoint takes priority: the handles are small and a missed
  // grab that pans the map instead is infuriating.
  const h = view.handleAt(sx, sy);
  if (h) {
    const g = section.geometry();
    drag = {
      mode: 'handle', which: h,
      start: view.toWorld(sx, sy),
      line: { ...section.line },
      d: g ? { dx: g.dx, dy: g.dy } : { dx: 0, dy: 0 },
    };
    view.dragHandle = h;
  } else if (e.shiftKey || sectionMode) {
    const [wx, wy] = view.toWorld(sx, sy);
    drag = { mode: 'section', x0: wx, y0: wy };
    mapCanvas.classList.add('sectioning');
  } else {
    drag = { mode: 'pan', sx, sy, cx: view.cam.x, cy: view.cam.y, moved: false };
    mapCanvas.classList.add('panning');
  }
  mapCanvas.setPointerCapture(e.pointerId);
  dirty = true;
});

mapCanvas.addEventListener('pointermove', (e) => {
  const [sx, sy] = canvasPos(e);
  if (!drag) {
    // Hovering a handle should look grabbable.
    const over = view.handleAt(sx, sy);
    mapCanvas.style.cursor = over ? 'grab' : (sectionMode ? 'crosshair' : '');
    return;
  }
  if (drag.mode === 'pan') {
    view.cam.x = drag.cx - (sx - drag.sx) / view.cam.scale;
    view.cam.y = drag.cy - (sy - drag.sy) / view.cam.scale;
    if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
  } else if (drag.mode === 'section') {
    const [wx, wy] = view.toWorld(sx, sy);
    section.setLine(wrap(drag.x0, world.W), wrap(drag.y0, world.H),
      wrap(wx, world.W), wrap(wy, world.H));
  } else if (drag.mode === 'handle') {
    const [wx, wy] = view.toWorld(sx, sy);
    const L = drag.line;
    if (drag.which === 'a') {
      section.setLine(wrap(wx, world.W), wrap(wy, world.H),
        wrap(L.x0 + drag.d.dx, world.W), wrap(L.y0 + drag.d.dy, world.H));
    } else if (drag.which === 'b') {
      section.setLine(L.x0, L.y0, wrap(wx, world.W), wrap(wy, world.H));
    } else {
      // Translate the whole cut, keeping its length and bearing.
      const dx = wx - drag.start[0], dy = wy - drag.start[1];
      section.setLine(
        wrap(L.x0 + dx, world.W), wrap(L.y0 + dy, world.H),
        wrap(L.x0 + dx + drag.d.dx, world.W), wrap(L.y0 + dy + drag.d.dy, world.H));
    }
  }
  dirty = true;
});

mapCanvas.addEventListener('pointerup', (e) => {
  if (drag && drag.mode === 'pan' && !drag.moved) {
    inspectAt(...view.toWorld(...canvasPos(e)));
  }
  if (drag && drag.mode === 'section') setSectionMode(false);
  drag = null;
  view.dragHandle = null;
  mapCanvas.classList.remove('panning', 'sectioning');
  dirty = true;
});

mapCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [sx, sy] = canvasPos(e);
  const [wx, wy] = view.toWorld(sx, sy);
  const k = Math.exp(-e.deltaY * 0.0016);
  view.cam.scale = Math.max(
    Math.min(mapCanvas.width / world.W, mapCanvas.height / world.H) * 0.4,
    Math.min(view.cam.scale * k, 0.6));
  const [nx, ny] = view.toWorld(sx, sy);
  view.cam.x += wx - nx;
  view.cam.y += wy - ny;
  dirty = true;
}, { passive: false });

// Hovering the section reports what is under the cursor -- the section is
// where you go to find out why something happened, so it has to answer
// questions about specific places.
secCanvas.addEventListener('pointermove', (e) => {
  const r = secCanvas.getBoundingClientRect();
  const dpr = secCanvas.width / r.width;
  section.hover = { sx: e.offsetX * dpr, sy: e.offsetY * dpr };
  dirty = true;
});
secCanvas.addEventListener('pointerleave', () => { section.hover = null; dirty = true; });

const wrap = (v, L) => ((v % L) + L) % L;

function inspectAt(x, y) {
  const wx = wrap(x, world.W), wy = wrap(y, world.H);
  const i = world.crustHash.nearest(wx, wy, world.spacing * 3);
  if (i < 0) { inspect = null; return; }
  const c = world.crust;
  const e = elevationOf(cfg, c.thickness[i], c.continental[i], c.litho[i], c.age[i]);
  const p = world.plates.get(c.plate[i]);
  const sd = world.scratch.slabDepth ? world.scratch.slabDepth[i] : -1;
  inspect = `point ${i} @ ${wx.toFixed(0)},${wy.toFixed(0)} km\n`
    + `plate ${c.plate[i]}  v=${p ? Math.hypot(p.vx, p.vy).toFixed(0) : '?'} km/Myr\n`
    + `elev ${e.toFixed(2)} km  crust ${c.thickness[i].toFixed(1)} km  litho ${c.litho[i].toFixed(0)} km\n`
    + `continental ${c.continental[i].toFixed(2)}  age ${c.age[i].toFixed(0)} Myr\n`
    + `segment #${c.segment[i]}  weakness ${c.weakness[i].toFixed(2)}`
    + (sd >= 0 ? `\nslab beneath at ${sd.toFixed(0)} km` : '');
  dirty = true;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
  else if (e.key === '.') { doStep(); }
  else if (e.key.toLowerCase() === 't') {
    const ok = section.presetAcrossTrench(view.cam.x, view.cam.y);
    if (!ok) inspect = 'no active subduction zone to section';
    dirty = true;
  } else if (e.key.toLowerCase() === 'f') { view.fitToView(); dirty = true; }
});

// ---------------------------------------------------------------------------
// section controls
// ---------------------------------------------------------------------------
bindRange('secW', 'secWv', (v) => { section.halfWidth = v; return `${v} km`; });
bindRange('secV', 'secVv', (v) => { section.vertExag = v; return `${v}×`; });
document.getElementById('secQ').onchange = (e) => { section.showQuakes = e.target.checked; dirty = true; };
document.getElementById('secM').onchange = (e) => { section.showMoho = e.target.checked; dirty = true; };
document.getElementById('secS').onchange = (e) => { section.showSlabs = e.target.checked; dirty = true; };
document.getElementById('secL').onchange = (e) => { section.showLabels = e.target.checked; dirty = true; };
document.getElementById('secC').onchange = (e) => { section.colorBy = e.target.value; dirty = true; };
document.getElementById('secT').onclick = () => { section.presetAcrossTrench(view.cam.x, view.cam.y); dirty = true; };
document.getElementById('secDraw').onclick = () => { setSectionMode(!sectionMode); dirty = true; };
document.getElementById('secClear').onclick = () => { section.line = null; section.hover = null; dirty = true; };

function bindRange(id, outId, fn) {
  const inp = document.getElementById(id), out = document.getElementById(outId);
  const apply = () => { out.textContent = fn(+inp.value); dirty = true; };
  inp.oninput = apply; apply();
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------
let statsBody, eventsEl, scrubEl, scrubLabel;

function buildPanel() {
  panel.innerHTML = '';

  // --- time -----------------------------------------------------------
  panel.append(el('h2', { text: 'Time' }));
  const playBtn = el('button', { text: '▶ play', onclick: () => setRunning(!running) });
  panel.append(el('div', { class: 'btnrow' },
    playBtn,
    el('button', { text: '⏭ step', onclick: doStep }),
    el('button', { text: '×10', onclick: () => runMany(10) }),
    el('button', { text: '×50', onclick: () => runMany(50) })));
  window._playBtn = playBtn;

  const speedSel = el('select', {
    onchange: (e) => { speed = e.target.value === 'max' ? Infinity : +e.target.value; },
  });
  for (const [v, l] of [['1', '1 Myr/s'], ['2', '2 Myr/s'], ['5', '5 Myr/s'], ['20', '20 Myr/s'], ['max', 'as fast as possible']]) {
    speedSel.append(el('option', { value: v, text: l }));
  }
  speedSel.value = '2';
  panel.append(el('div', { class: 'field' }, el('label', {}, el('span', { text: 'speed' })), speedSel));

  scrubLabel = el('b', { text: 'live' });
  scrubEl = el('input', {
    type: 'range', min: 0, max: 0, step: 1, value: 0,
    oninput: (e) => scrubTo(+e.target.value),
  });
  panel.append(el('div', { class: 'field' },
    el('label', {}, el('span', { text: 'history scrub' }), scrubLabel), scrubEl));
  panel.append(el('div', { class: 'btnrow' },
    el('button', { text: 'return to live', onclick: () => { replayIndex = -1; scrubLabel.textContent = 'live'; restoreLatest(); } })));

  // --- layers ---------------------------------------------------------
  panel.append(el('h2', { text: 'Map layers' }));
  const layerSel = el('select', { onchange: (e) => { view.base = e.target.value; dirty = true; } });
  for (const l of LAYERS) layerSel.append(el('option', { value: l, text: l }));
  layerSel.value = view.base;
  panel.append(layerSel);
  panel.append(el('div', { style: 'height:6px' }));
  panel.append(toggles(view.overlays, () => { dirty = true; }));
  const hs = el('input', { type: 'checkbox', onchange: (e) => { view.hillshade = e.target.checked; dirty = true; } });
  hs.checked = view.hillshade;
  panel.append(el('div', { class: 'toggles' }, el('label', {}, hs, el('span', { text: 'hillshade' }))));

  // --- stats ----------------------------------------------------------
  panel.append(el('h2', { text: 'Diagnostics' }));
  const table = el('table', { class: 'stats' });
  statsBody = el('tbody');
  table.append(statsBody);
  panel.append(table);
  panel.append(el('p', { class: 'note', text:
    'Conservation error is the mass ledger: crust + slab against sources and sinks. '
    + 'A figure that creeps above a fraction of a percent means a process is leaking.' }));

  panel.append(el('h2', { text: 'Events' }));
  eventsEl = el('div', { id: 'events' });
  panel.append(eventsEl);

  // --- world ----------------------------------------------------------
  panel.append(el('h2', { text: 'World' }));
  const presetSel = el('select', {});
  for (const k of Object.keys(PRESETS)) {
    const p = PRESETS[k];
    presetSel.append(el('option', { value: k, text: `${k} — ${p.W}×${p.H} km, ${p.spacing} km` }));
  }
  presetSel.value = cfg.preset;
  const seedInp = el('input', { type: 'number', value: cfg.seed });
  panel.append(el('div', { class: 'field' }, el('label', {}, el('span', { text: 'preset' })), presetSel));
  panel.append(el('div', { class: 'field' }, el('label', {}, el('span', { text: 'seed' })), seedInp));
  panel.append(el('div', { class: 'btnrow' },
    el('button', { text: 'new world', onclick: () => rebuild(presetSel.value, +seedInp.value) }),
    el('button', { text: 'same seed, reset', onclick: () => rebuild(cfg.preset, cfg.seed) })));

  const dsl = el('input', { type: 'checkbox', onchange: (e) => { cfg.dynamicSeaLevel = e.target.checked; } });
  dsl.checked = cfg.dynamicSeaLevel;
  panel.append(el('div', { class: 'toggles' },
    el('label', {}, dsl, el('span', { text: 'dynamic sea level' }))));

  // --- tuning ---------------------------------------------------------
  for (const g of TUNING) {
    panel.append(el('h2', { text: g.group }));
    for (const [key, label, min, max, step, unit] of g.keys) {
      panel.append(slider(cfg, key, label, min, max, step, unit, () => { dirty = true; }));
    }
  }
  panel.append(el('p', { class: 'note', text:
    'Sliders take effect on the next step. The seed plus this configuration fully '
    + 'determine a run, so a promising world can be reproduced exactly.' }));
}

function updateStats() {
  if (!statsBody) return;
  const s = world.stats();
  const a = s.audit || { relError: 0, crustVolume: 0, slabVolume: 0, continentalArea: 0 };
  const rows = [
    ['time', `${world.t.toFixed(0)} Myr`],
    ['crust points', s.crustPoints],
    ['slab points', s.slabPoints],
    ['plates', s.plates],
    ['faults', s.faults],
    ['ridge segments', s.segments],
    ['transforms', s.transforms],
    ['subduction zones', s.trenches],
    ['triple junctions', s.tripleJunctions],
    ['hotspots', s.plumes],
    ['slab windows', s.slabWindows],
    ['continental area', `${(a.continentalArea / (world.W * world.H) * 100).toFixed(1)} %`],
    ['crust volume', `${(a.crustVolume / 1e9).toFixed(3)} ×10⁹ km³`],
    ['slab volume', `${(a.slabVolume / 1e9).toFixed(3)} ×10⁹ km³`],
    ['conservation error', `${(a.relError * 100).toFixed(3)} %`],
    ['sea level', `${world.seaLevel.toFixed(2)} km`],
    ['— magma made', `${(world.budget.created / 1e9).toFixed(3)}`],
    ['— thinned away', `${(world.budget.destroyed / 1e9).toFixed(3)}`],
    ['— crust → slab', `${(world.budget.toSlab / 1e9).toFixed(3)}`],
    ['— slab retired', `${(world.budget.slabRetired / 1e9).toFixed(3)}`],
    ['— over cap', `${(world.budget.lost / 1e9).toFixed(3)}`],
    ['— regrid', `${(world.budget.regrid / 1e9).toFixed(3)}`],
    ['rifts / sutures', `${world.riftHistory.length} / ${world.events.filter((e) => e.kind === 'suture').length}`],
    ['ms / step', Object.values(world.timings).reduce((x, y) => x + y, 0).toFixed(0)],
  ];
  statsBody.innerHTML = '';
  for (const [k, v] of rows) {
    const tr = el('tr', k === 'conservation error' && Math.abs(a.relError) > 0.01 ? { class: 'warn' } : {},
      el('td', { text: k }), el('td', { text: String(v) }));
    statsBody.append(tr);
  }

  eventsEl.innerHTML = '';
  for (const ev of world.events.slice(-40).reverse()) {
    eventsEl.append(el('div', {}, el('b', { text: `${ev.t.toFixed(0)} ` }), document.createTextNode(ev.text)));
  }

  if (snaps.count) {
    scrubEl.max = String(snaps.count - 1);
    if (replayIndex < 0) scrubEl.value = String(snaps.count - 1);
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
function setRunning(v) {
  running = v;
  if (v) replayIndex = -1;
  if (window._playBtn) {
    window._playBtn.textContent = v ? '⏸ pause' : '▶ play';
    window._playBtn.classList.toggle('on', v);
  }
}
function doStep() { replayIndex = -1; world.step(); snaps.maybeCapture(world); dirty = true; }
function runMany(n) {
  replayIndex = -1;
  for (let i = 0; i < n; i++) { world.step(); snaps.maybeCapture(world); }
  dirty = true;
}
function scrubTo(i) {
  if (!snaps.count) return;
  replayIndex = i;
  running = false;
  setRunning(false);
  world.restore(snaps.at(i));
  scrubLabel.textContent = `${world.t.toFixed(0)} Myr`;
  dirty = true;
}
function restoreLatest() {
  if (snaps.count) world.restore(snaps.at(snaps.count - 1));
  dirty = true;
}

function rebuild(preset, seed) {
  cfg = makeConfig(preset, { seed });
  world = new World(cfg);
  raster = new Raster(world);
  view = new MapView(mapCanvas, world, raster);
  section = new SectionView(secCanvas, world);
  view.section = section;
  snaps = new SnapshotStore(cfg);
  replayIndex = -1;
  inspect = null;
  buildPanel();
  resize();
  view.fitToView();
  dirty = true;
}

buildPanel();
resize();
view.fitToView();
