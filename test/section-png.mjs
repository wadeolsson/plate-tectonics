// Render a cross-section to PNG headlessly. Defaults to a trench-normal
// section, which is the orientation you want nine times out of ten.
//   node test/section-png.mjs --steps=150 --out=/tmp/pt/section.png
import fs from 'node:fs';
import './domstub.mjs';
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';
import { encodePNG } from './png.mjs';
import { elevationOf } from '../src/sim/elevation.js';
import * as CM from '../src/render/colormaps.js';
import { ROCKS } from '../src/sim/rocks.js';
import { MAX_LAYERS } from '../src/core/pointsets.js';
import { SectionView, makeDepthScale } from '../src/render/section.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const cfg = makeConfig(args.preset || 'small', { seed: +(args.seed ?? 1234) });
const w = new World(cfg);
for (let i = 0; i < +(args.steps ?? 150); i++) w.step();

const sec = new SectionView(document.createElement('canvas'), w);
sec.halfWidth = +(args.width ?? 90);
if (args.mode === 'suture') {
  let best = null, bl = 0;
  for (const z of w.trenches.all()) if (z.isCollision && z.length > bl) { bl = z.length; best = z; }
  if (best) sec.setLine(
    (best.trenchX + 900) % w.W, (best.trenchY + 900) % w.H,
    (best.trenchX - 900 + w.W) % w.W, (best.trenchY - 900 + w.H) % w.H);
} else if (!sec.presetAcrossTrench(w.W / 2, w.H / 2)) {
  sec.setLine(0, w.H * 0.5, w.W * 0.4, w.H * 0.5);
}

const data = sec.collect();
if (!data) { console.log('no section data'); process.exit(1); }

const W = 1100, H = 440, px = new Uint8Array(W * H * 3);
const bg = [10, 12, 18];
for (let i = 0; i < W * H; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
const put = (x, y, c) => {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
};
const vline = (x, y0, y1, c) => { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) put(x, y, c); };

const pad = 50;
const plotW = W - pad - 12;
const plotH = H - 28;
const exag = +(args.exag ?? 24);
const yOf = makeDepthScale(10, 10, plotH, exag);
const sx = (s) => pad + (s / data.len) * plotW;

// mantle, transition zone, ocean
for (let x = pad; x < pad + plotW; x++) vline(x, yOf.seaY | 0, yOf.bottom | 0, [27, 20, 16]);
for (let x = pad; x < pad + plotW; x++) vline(x, yOf(-410) | 0, yOf(-660) | 0, [36, 28, 22]);
for (let x = pad; x < pad + plotW; x++) vline(x, yOf(Math.max(0, w.seaLevel)) | 0, yOf.seaY | 0, [26, 66, 116]);

// Slab ribbons first, so the crust draws over their shallow ends.
const hline = (y, xa, xb, c) => { for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) put(x, y, c); };
for (const rb of data.ribbons) {
  const pl = w.plates.get(rb.parent);
  const base = pl ? CM.plateColor(pl.hue, true) : [150, 150, 160];
  const body = [base[0] * 0.55, base[1] * 0.55, base[2] * 0.6];
  for (let k = 0; k + 1 < rb.pts.length; k++) {
    const a = rb.pts[k], b = rb.pts[k + 1];
    const xa = Math.round(sx(a.s)), xb = Math.round(sx(b.s));
    for (let x = xa; x <= xb; x++) {
      const f = xb === xa ? 0 : (x - xa) / (xb - xa);
      const depth = a.depth + (b.depth - a.depth) * f;
      const lith = a.litho + (b.litho - a.litho) * f;
      const crust = Math.max(2, a.crust + (b.crust - a.crust) * f);
      vline(x, yOf(-depth) | 0, yOf(-(depth + lith)) | 0, body);
      vline(x, yOf(-depth) | 0, yOf(-(depth + crust)) | 0, CM.crustRamp(0.05));
      put(x, yOf(-depth) | 0, base);
      put(x, yOf(-(depth + lith)) | 0, base);
    }
  }
}

const cols = data.profile;
const colW = Math.max(1, Math.ceil(plotW / cols.length) + 1);
for (const q of cols) {
  if (!q) continue;
  const x = sx(q.s);
  const pl = w.plates.get(q.plate);
  const hue = pl ? CM.plateColor(pl.hue, true) : [120, 100, 86];
  const lithoC = [hue[0] * 0.20 + 34, hue[1] * 0.18 + 28, hue[2] * 0.16 + 24];
  const cc = args.byplate ? [hue[0] * 1.15 + 20, hue[1] * 1.15 + 20, hue[2] * 1.15 + 20]
                         : CM.crustSection(q.continental);
  const yTop = yOf(q.elev) | 0;
  const yMoho = Math.max(yOf(q.elev - q.thickness) | 0, yTop + 3);
  for (let k = 0; k < colW; k++) {
    const xx = x + k - (colW >> 1);
    vline(xx, yMoho, yOf(q.elev - q.thickness - q.litho) | 0, lithoC);
    if (q.elev < w.seaLevel) vline(xx, yOf(w.seaLevel) | 0, yTop, [34, 96, 166]);
    if (!args.byplate && !args.bycomp && q.rep >= 0 && w.crust.alive[q.rep]) {
      // Real stratigraphy from one representative column, rescaled to the
      // smoothed thickness this profile column reports.
      const i = q.rep, b = i * MAX_LAYERS, n = w.crust.nLayers[i];
      const own = Math.max(1e-6, w.crust.thickness[i]);
      // Floor the band so 7 km of oceanic crust is still legible on an axis
      // that reaches 660 km; the Moho line keeps the true depth honest.
      const band = Math.max(4, yMoho - yTop);
      const scale = band / own;
      let y = yTop;
      for (let L = 0; L < n; L++) {
        const h = w.crust.layerThick[b + L] * scale;
        vline(xx, y | 0, (y + h) | 0, ROCKS[w.crust.layerType[b + L]].color);
        y += h;
      }
      if (yTop + band - y > 0.6) vline(xx, y | 0, (yTop + band) | 0, ROCKS[w.crust.layerType[b + Math.max(0, n - 1)]].color);
    } else {
      vline(xx, yTop, yMoho, cc);
    }
  }
}
for (const q of cols) {
  if (!q) continue;
  put(sx(q.s), yOf(q.elev) | 0, [255, 255, 255]);
  put(sx(q.s), Math.max(yOf(q.elev - q.thickness) | 0, (yOf(q.elev) | 0) + 3), [255, 226, 170]);
  put(sx(q.s), yOf(q.elev - q.thickness - q.litho) | 0, [190, 150, 255]);
}
for (const q of data.quakePts) {
  const cx = sx(q.s), cy = yOf(-q.depth);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(cx + dx, cy + dy, [255, 255, 255]);
}
for (const d of [0, 10, 25, 50, 100, 150, 300, 410, 660]) {
  const y = yOf(-d) | 0;
  for (let x = pad; x < pad + plotW; x += 3) put(x, y, [90, 100, 120]);
}
for (let x = pad; x < pad + plotW; x++) put(x, yOf(w.seaLevel) | 0, [150, 190, 230]);
for (const b of data.breaks) {
  const x = Math.round(sx(b.s));
  const c = b.kind >= 0 ? CM.obliquityColor(b.obliquity ?? Math.PI / 2) : [255, 255, 255];
  for (let y = 10; y < (yOf.bottom | 0); y += 4) { put(x, y, c); put(x + 1, y, c); }
}

const out = args.out || '/tmp/pt/section.png';
fs.writeFileSync(out, encodePNG(W, H, px));
console.log(`t=${w.t} Myr  section ${(data.len / 1000).toFixed(2)}e3 km  ${data.crustPts.length} crust, `
  + `${data.slabPts.length} slab (${data.ribbons.length} ribbons), ${data.quakePts.length} quakes, `
  + `${data.breaks.length} plate boundaries crossed -> ${out}`);
for (const b of data.breaks) console.log(`   ${(b.s / 1000).toFixed(2)}e3 km: plate ${b.from} → ${b.to}  (${b.label})`);
console.log(`depth grid lines at 0/10/25/50/100/150/300/410/660 km; scale breaks at 50 and 150 km; topography ×${exag}`);
