// Render the map to PNG files without a browser, so the output can actually be
// looked at. Usage: node test/render-png.mjs --steps=120 --out=/tmp/pt
import fs from 'node:fs';
import './domstub.mjs';
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';
import { Raster } from '../src/render/raster.js';
import { encodePNG } from './png.mjs';
import * as CM from '../src/render/colormaps.js';
import { ROCKS } from '../src/sim/rocks.js';
import { wrapDelta } from '../src/core/torus.js';
import { KIND } from '../src/sim/boundaries.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const steps = +(args.steps ?? 120);
const out = args.out || '/tmp/pt';
const preset = args.preset || 'small';
const scale = +(args.scale ?? 2);
fs.mkdirSync(out, { recursive: true });

const cfg = makeConfig(preset, { seed: +(args.seed ?? 1234) });
const world = new World(cfg);
const raster = new Raster(world);

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const shots = (args.shots || String(steps)).split(',').map(Number);
let next = 0;
for (let i = 0; i <= steps; i++) {
  if (shots.includes(i)) writeAll(i);
  if (i < steps) world.step();
}
if (!shots.includes(steps)) writeAll(steps);

function writeAll(i) {
  raster.rasterise();
  const layers = (args.layers || 'elevation,age,crust,heat,bouguer,freeair,basement,strain,weakness,plates,slabDepth').split(',');
  for (const layer of layers) {
    const img = paint(layer);
    fs.writeFileSync(`${out}/${String(i).padStart(4, '0')}-${layer}.png`, encodePNG(raster.gw * scale, raster.gh * scale, img));
  }
  const s = world.stats();
  console.log(`t=${i} pts=${s.crustPoints} plates=${s.plates} faults=${s.faults} segs=${s.segments} -> ${out}/${String(i).padStart(4, '0')}-*.png`);
}

function paint(layer) {
  const { gw, gh } = raster;
  const W = gw * scale, H = gh * scale;
  const px = new Uint8Array(W * H * 3);
  const sea = world.seaLevel;
  const shade = computeShade();

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      let c;
      switch (layer) {
        case 'elevation': {
          const e = raster.elevation[i];
          c = e < sea ? CM.bathymetry(1 - Math.min(1, (sea - e) / 7))
                      : CM.hypsometric(Math.min(1, (e - sea) / 6.5));
          const k = shade[i];
          c = [c[0] * k, c[1] * k, c[2] * k];
          break;
        }
        case 'age':
          c = raster.continental[i] > 0.55 ? [62, 62, 68]
            : CM.ageRamp(Math.min(1, raster.age[i] / 180));
          break;
        case 'crust': c = CM.crustRamp(raster.continental[i]); break;
        case 'weakness': c = CM.weaknessRamp(Math.min(1, raster.weakness[i])); break;
        case 'plates': {
          const p = raster.plate[i];
          const pl = p >= 0 ? world.plates.get(p) : null;
          c = pl ? CM.plateColor(pl.hue, pl.alive) : [20, 20, 24];
          if (raster.elevation[i] < sea) c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.62];
          break;
        }
        case 'heat':
          c = CM.heatRamp(Math.log(1 + raster.heatFlow[i] / 22) / Math.log(1 + 450 / 22));
          break;
        case 'bouguer':
          c = CM.gravityRamp(0.5 + Math.max(-0.5, Math.min(0.5, raster.bouguer[i] / 1400)));
          break;
        case 'freeair':
          c = CM.gravityRamp(0.5 + Math.max(-0.5, Math.min(0.5, raster.freeAir[i] / 500)));
          break;
        case 'basement':
          c = raster.continental[i] < 0.25 ? [26, 32, 44]
            : CM.provinceRamp(Math.log(1 + raster.defAge[i] / 25) / Math.log(1 + 2500 / 25));
          break;
        case 'mantle': {
          const m = world.mantle;
          const mgx = Math.min(m.nx - 1, Math.floor(x / gw * m.nx));
          const mgy = Math.min(m.ny - 1, Math.floor(y / gh * m.ny));
          c = CM.mantleRamp(0.5 + Math.max(-0.5, Math.min(0.5,
            (m.T[mgy * m.nx + mgx] - m.meanT) / (m.sdT * 4))));
          break;
        }
        case 'geology': {
          const rk = raster.topRock[i];
          if (rk < 0) { c = [26, 32, 44]; break; }
          c = ROCKS[rk].color.slice();
          if (raster.elevation[i] < sea) { c = [c[0] * 0.52, c[1] * 0.56, c[2] * 0.68]; }
          break;
        }
        case 'strain':
          c = CM.strainRamp(Math.log(1 + raster.strainRate[i] / 30) / Math.log(1 + 2500 / 30));
          break;
        case 'slabDepth': {
          const sd = raster.slabDepth[i];
          c = sd < 0 ? (raster.elevation[i] < sea ? [12, 20, 34] : [42, 44, 40])
                     : CM.slabRamp(Math.min(1, sd / 660));
          break;
        }
      }
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((y * scale + sy) * W + x * scale + sx) * 3;
          px[o] = clamp(c[0]); px[o + 1] = clamp(c[1]); px[o + 2] = clamp(c[2]);
        }
      }
    }
  }

  if (layer !== 'plates' && layer !== 'strain') drawFaults(px, W, H);
  drawPlumes(px, W, H);
  return px;
}

function drawFaults(px, W, H) {
  const b = world.boundaries;
  const kx = W / world.W, ky = H / world.H;
  for (let e = 0; e < b.count; e++) {
    const c = CM.obliquityColor(b.obliquity[e]);
    const ax = b.ax[e] * kx, ay = b.ay[e] * ky;
    const dx = wrapDelta(b.bx[e] - b.ax[e], world.W) * kx;
    const dy = wrapDelta(b.by[e] - b.ay[e], world.H) * ky;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(ax + dx * (k / n)), y = Math.round(ay + dy * (k / n));
      const xx = ((x % W) + W) % W, yy = ((y % H) + H) % H;
      const o = (yy * W + xx) * 3;
      px[o] = clamp(c[0]); px[o + 1] = clamp(c[1]); px[o + 2] = clamp(c[2]);
    }
  }
}

// Hotspots, as rings. They sit still while the plates slide over them, so a
// trail of thickened crust downstream of one is the plate's own track.
function drawPlumes(px, W, H) {
  const m = world.mantle;
  if (!m) return;
  const kx = W / world.W, ky = H / world.H;
  for (const p of m.plumes) {
    const cx = p.x * kx, cy = p.y * ky;
    const r = 5 + 5 * p.strength;
    for (let a = 0; a < 360; a += 3) {
      const rad = a * Math.PI / 180;
      for (const rr of [r, r + 1]) {
        const x = ((Math.round(cx + Math.cos(rad) * rr) % W) + W) % W;
        const y = ((Math.round(cy + Math.sin(rad) * rr) % H) + H) % H;
        const o = (y * W + x) * 3;
        px[o] = 255; px[o + 1] = 230; px[o + 2] = 170;
      }
    }
  }
}

function computeShade() {
  const { gw, gh, cw, ch } = raster;
  const s = new Float32Array(gw * gh);
  const e = raster.elevation;
  const zx = 2.2 / cw, zy = 2.2 / ch;
  for (let y = 0; y < gh; y++) {
    const yp = (y - 1 + gh) % gh, yn = (y + 1) % gh;
    for (let x = 0; x < gw; x++) {
      const xp = (x - 1 + gw) % gw, xn = (x + 1) % gw;
      const dzdx = (e[y * gw + xn] - e[y * gw + xp]) * 0.5 * zx;
      const dzdy = (e[yn * gw + x] - e[yp * gw + x]) * 0.5 * zy;
      const nl = (-dzdx * 0.5 + dzdy * 0.5 + 1) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      s[y * gw + x] = 0.72 + 0.55 * Math.max(0, nl);
    }
  }
  return s;
}
