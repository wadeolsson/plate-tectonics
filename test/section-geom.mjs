// Geometry checks for the cross-section and its map overlay. The section line
// is the one piece of UI that has to be torus-correct: a cut across the seam
// must sample the short way around, and its handles must be grabbable from
// either side of the wrap.
import './domstub.mjs';
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';
import { Raster } from '../src/render/raster.js';
import { MapView } from '../src/render/mapview.js';
import { SectionView } from '../src/render/section.js';
import { wrapDelta } from '../src/core/torus.js';

const w = new World(makeConfig('small'));
for (let i = 0; i < 40; i++) w.step();
const raster = new Raster(w);
raster.rasterise();
const canvas = document.createElement('canvas');
canvas.width = 1200; canvas.height = 600;
const view = new MapView(canvas, w, raster);
const sec = new SectionView(document.createElement('canvas'), w);
view.section = sec;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
};

// --- a cut straight across the seam --------------------------------------
sec.setLine(w.W - 600, w.H * 0.5, 600, w.H * 0.5);
const g = sec.geometry();
ok('seam-crossing cut takes the short way', Math.abs(g.len - 1200) < 1, `len ${g.len.toFixed(0)} km`);
ok('bearing points across the seam', g.tx > 0.99, `tx ${g.tx.toFixed(3)}`);

const [ax, ay] = sec.worldAt(0);
const [bx, by] = sec.worldAt(g.len);
ok('worldAt(0) is the A end', Math.abs(wrapDelta(ax - (w.W - 600), w.W)) < 1e-3);
ok('worldAt(len) is the A′ end', Math.abs(wrapDelta(bx - 600, w.W)) < 1e-3);

const data = sec.collect();
ok('corridor samples across the seam', data && data.crustPts.length > 20,
  `${data ? data.crustPts.length : 0} crust points`);
ok('every sample lies within the section', data.crustPts.every((p) => p.s >= 0 && p.s <= data.len));
ok('profile is continuous', data.profile.filter(Boolean).length > data.profile.length * 0.8,
  `${data.profile.filter(Boolean).length}/${data.profile.length} columns filled`);

// --- handles --------------------------------------------------------------
view.fitToView();
view.draw();                       // populates the visible tile list
const hitA = (() => {
  for (const [ox, oy] of view.tiles) {
    const [sx, sy] = view.toScreen(sec.line.x0 + ox, sec.line.y0 + oy);
    if (sx >= 0 && sx <= canvas.width && sy >= 0 && sy <= canvas.height) return view.handleAt(sx, sy);
  }
  return null;
})();
ok('the A handle is grabbable where it is drawn', hitA === 'a', `got ${hitA}`);
ok('empty space is not a handle', view.handleAt(4, 4) === null);

// --- a trench-normal cut --------------------------------------------------
if (sec.presetAcrossTrench(w.W / 2, w.H / 2)) {
  const d2 = sec.collect();
  ok('trench-normal cut has a profile', d2 && d2.profile.filter(Boolean).length > 40);
  console.log(`      ${d2.ribbons.length} slab ribbons, ${d2.breaks.length} plate boundaries crossed`);
  for (const b of d2.breaks) {
    console.log(`        ${(b.s / 1000).toFixed(2)}×10³ km: plate ${b.from} → ${b.to} (${b.label})`);
  }
  ok('plate breaks are ordered along the section',
    d2.breaks.every((b, i) => i === 0 || b.s > d2.breaks[i - 1].s));
  ok('slab ribbons are ordered along the section',
    d2.ribbons.every((r) => r.pts.every((p, i) => i === 0 || p.s > r.pts[i - 1].s)));
  ok('slab ribbons have a plate identity',
    d2.ribbons.every((r) => Number.isInteger(r.parent)));
} else {
  console.log('      (no subduction zone right now; trench-normal checks skipped)');
}

// --- draw path ------------------------------------------------------------
sec.hover = { sx: 400, sy: 200 };
sec.draw();
sec.colorBy = 'plate'; sec.draw();
sec.showSlabs = false; sec.draw();
sec.line = null; sec.draw();
ok('every draw path runs without error', true);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
