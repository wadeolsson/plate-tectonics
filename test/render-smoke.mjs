// Exercise the full render path under a DOM stub: rasterise, map draw with
// every layer and overlay on, and a cross-section. Catches runtime errors in
// drawing code without needing a browser.
import './domstub.mjs';
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';
import { Raster } from '../src/render/raster.js';
import { MapView, LAYERS } from '../src/render/mapview.js';
import { SectionView } from '../src/render/section.js';

const world = new World(makeConfig('small'));
for (let i = 0; i < 25; i++) world.step();

const canvas = document.createElement('canvas');
const raster = new Raster(world);
const t0 = performance.now();
raster.rasterise();
console.log(`raster ${raster.gw}x${raster.gh} in ${(performance.now() - t0).toFixed(0)} ms`);

let emin = Infinity, emax = -Infinity, land = 0;
for (let i = 0; i < raster.n; i++) {
  const e = raster.elevation[i];
  if (e < emin) emin = e;
  if (e > emax) emax = e;
  if (e > world.seaLevel) land++;
}
console.log(`elevation ${emin.toFixed(2)} .. ${emax.toFixed(2)} km, land ${(land / raster.n * 100).toFixed(1)}%, sea level ${world.seaLevel.toFixed(2)}`);

const view = new MapView(canvas, world, raster);
for (const k of Object.keys(view.overlays)) view.overlays[k] = true;

// Turning every overlay on is not enough: an overlay that iterates a
// collection draws nothing when the collection is empty, so the code path goes
// unexercised and a missing canvas method sails through. Guarantee there is
// something for each one to draw.
if (world.mantle.plumes.length === 0) {
  world.mantle.plumes.push({ id: -1, x: world.W * 0.5, y: world.H * 0.5, strength: 0.8, birth: 0, lastSeen: world.t });
}
if (!view.section) {
  view.section = sectionForSmoke();
}
function sectionForSmoke() {
  const s = new SectionView(document.createElement('canvas'), world);
  s.setLine(world.W * 0.2, world.H * 0.4, world.W * 0.6, world.H * 0.6);
  return s;
}
for (const layer of LAYERS) {
  view.base = layer;
  const a = performance.now();
  view.draw();
  console.log(`  draw ${layer.padEnd(10)} ok (${(performance.now() - a).toFixed(0)} ms)`);
}

const sec = new SectionView(document.createElement('canvas'), world);
const ok = sec.presetAcrossTrench(world.W / 2, world.H / 2);
if (!ok) sec.setLine(0, world.H * 0.5, world.W * 0.45, world.H * 0.5);
const data = sec.collect();
console.log(`section: ${data ? data.crustPts.length : 0} crust, ${data ? data.slabPts.length : 0} slab, ${data ? data.quakePts.length : 0} quakes`);
sec.draw();
console.log('section draw ok');

// snapshot round-trip
const snap = world.snapshot();
const before = world.crust.live;
for (let i = 0; i < 5; i++) world.step();
world.restore(snap);
console.log(`snapshot restore: t=${world.t} points ${world.crust.live} (expected ${before}) ${world.crust.live === before ? 'OK' : 'MISMATCH'}`);
