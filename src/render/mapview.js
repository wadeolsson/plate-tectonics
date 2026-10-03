import * as CM from './colormaps.js';
import { KIND } from '../sim/boundaries.js';
import { ROCKS } from '../sim/rocks.js';
import { wrapDelta } from '../core/torus.js';

export const LAYERS = [
  'elevation', 'crust', 'age', 'basement age', 'heat flow',
  'Bouguer gravity', 'free-air gravity', 'strain rate',
  'surface geology', 'weakness', 'stress', 'plates', 'slabDepth', 'mantle',
];

// The map is tiled 3x3 when drawing so features spanning the seam appear
// continuous. Panning across the seam should show no discontinuity -- if it
// does, something in the physics probably has an unwrapped delta in it too.
function tickStep(len) {
  const raw = len / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) || pow;
}

export class MapView {
  constructor(canvas, world, raster) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.raster = raster;
    this.cam = { x: world.W / 2, y: world.H / 2, scale: 1 };
    this.base = 'elevation';
    this.overlays = {
      faults: true, segments: true, slabs: false, quakes: false,
      junctions: true, velocity: false, symbols: true, grid: false,
      plumes: true, mantleFlow: false, rivers: true, volcanoes: true,
    };
    this.section = null;        // SectionView, so the cut can be drawn in place
    this.dragHandle = null;     // 'a' | 'b' | 'mid' while an endpoint is held
    this.hillshade = true;
    // Elevation and distance are both in km, so a real continental slope is a
    // few parts per thousand and shades as perfectly flat. Every global relief
    // map exaggerates the vertical for this reason; without it the lighting
    // has nothing to work with.
    this.reliefExaggeration = 28;   // vertical exaggeration, shading only
    this.occlusionStrength = 5;     // how strongly hollows are darkened
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.img = null;
    this.fitToView();
  }

  fitToView() {
    const { width, height } = this.canvas;
    this.cam.scale = Math.min(width / this.world.W, height / this.world.H);
    this.cam.x = this.world.W / 2;
    this.cam.y = this.world.H / 2;
  }

  toScreen(x, y) {
    const { width, height } = this.canvas;
    return [
      width / 2 + (x - this.cam.x) * this.cam.scale,
      height / 2 + (y - this.cam.y) * this.cam.scale,
    ];
  }

  toWorld(sx, sy) {
    const { width, height } = this.canvas;
    return [
      this.cam.x + (sx - width / 2) / this.cam.scale,
      this.cam.y + (sy - height / 2) / this.cam.scale,
    ];
  }

  // ---- base layer ------------------------------------------------------
  buildImage() {
    const r = this.raster, w = this.world;
    const { gw, gh } = r;
    if (this.off.width !== gw || this.off.height !== gh) {
      this.off.width = gw; this.off.height = gh;
      this.img = this.offCtx.createImageData(gw, gh);
    }
    const d = this.img.data;
    const sea = w.seaLevel;
    const shade = this.hillshade ? this.computeShade() : null;
    const shadeOn = shade && (this.base === 'elevation' || this.base === 'crust');

    const L = {
      bath: CM.lut(CM.bathymetry), hyp: CM.lut(CM.hypsometric),
      age: CM.lut(CM.ageRamp), crust: CM.lut(CM.crustRamp),
      weak: CM.lut(CM.weaknessRamp), stress: CM.lut(CM.stressRamp),
      slab: CM.lut(CM.slabRamp), heat: CM.lut(CM.heatRamp),
      grav: CM.lut(CM.gravityRamp), prov: CM.lut(CM.provinceRamp),
      strain: CM.lut(CM.strainRamp), mantle: CM.lut(CM.mantleRamp),
    };
    const pick = (t, tab) => {
      let i = (t * 255) | 0;
      if (i < 0) i = 0; else if (i > 255) i = 255;
      return i * 3;
    };

    // Plate colours are per-plate, not per-cell: build the table once.
    let plateLut = null;
    if (this.base === 'plates') {
      const n = w.plates.count;
      plateLut = new Uint8Array(Math.max(1, n) * 3);
      for (const p of w.plates.list) {
        const c = CM.plateColor(p.hue, p.alive);
        plateLut[p.id * 3] = c[0]; plateLut[p.id * 3 + 1] = c[1]; plateLut[p.id * 3 + 2] = c[2];
      }
    }

    const n = gw * gh;
    for (let i = 0; i < n; i++) {
      let r0, g0, b0;
      switch (this.base) {
        case 'elevation': {
          const e = r.elevation[i];
          let tab, o;
          if (e < sea) { tab = L.bath.a; o = pick(1 - Math.min(1, (sea - e) / 7)); }
          else { tab = L.hyp.a; o = pick(Math.min(1, Math.pow((e - sea) / 6.5, 0.45))); }
          r0 = tab[o]; g0 = tab[o + 1]; b0 = tab[o + 2];
          break;
        }
        case 'crust': {
          const o = pick(r.continental[i]);
          r0 = L.crust.a[o]; g0 = L.crust.a[o + 1]; b0 = L.crust.a[o + 2];
          break;
        }
        case 'age': {
          if (r.continental[i] > 0.55) { r0 = 64; g0 = 64; b0 = 70; }
          else {
            const o = pick(Math.min(1, r.age[i] / 180));
            r0 = L.age.a[o]; g0 = L.age.a[o + 1]; b0 = L.age.a[o + 2];
          }
          break;
        }
        case 'basement age': {
          // Oceanic crust has no basement age worth speaking of; grey it out so
          // the continental provinces are what the eye picks up.
          if (r.continental[i] < 0.25) { r0 = 26; g0 = 32; b0 = 44; }
          else {
            // Log-ish, like the age bins a basement map is drawn in: the
            // difference between 20 and 200 Myr matters as much as between
            // 200 and 2000.
            const o = pick(Math.log(1 + r.defAge[i] / 25) / Math.log(1 + 2500 / 25));
            r0 = L.prov.a[o]; g0 = L.prov.a[o + 1]; b0 = L.prov.a[o + 2];
          }
          break;
        }
        case 'heat flow': {
          const o = pick(Math.log(1 + r.heatFlow[i] / 22) / Math.log(1 + 450 / 22));
          r0 = L.heat.a[o]; g0 = L.heat.a[o + 1]; b0 = L.heat.a[o + 2];
          break;
        }
        case 'Bouguer gravity': {
          const o = pick(0.5 + Math.max(-0.5, Math.min(0.5, r.bouguer[i] / 1400)));
          r0 = L.grav.a[o]; g0 = L.grav.a[o + 1]; b0 = L.grav.a[o + 2];
          break;
        }
        case 'free-air gravity': {
          const o = pick(0.5 + Math.max(-0.5, Math.min(0.5, r.freeAir[i] / 500)));
          r0 = L.grav.a[o]; g0 = L.grav.a[o + 1]; b0 = L.grav.a[o + 2];
          break;
        }
        case 'strain rate': {
          const o = pick(Math.log(1 + r.strainRate[i] / 30) / Math.log(1 + 2500 / 30));
          r0 = L.strain.a[o]; g0 = L.strain.a[o + 1]; b0 = L.strain.a[o + 2];
          break;
        }
        case 'mantle': {
          const m = w.mantle;
          if (!m) { r0 = g0 = b0 = 20; break; }
          const gx = Math.min(m.nx - 1, Math.floor((i % gw) / gw * m.nx));
          const gy = Math.min(m.ny - 1, Math.floor(Math.floor(i / gw) / gh * m.ny));
          const o = pick(0.5 + Math.max(-0.5, Math.min(0.5,
            (m.T[gy * m.nx + gx] - m.meanT) / (m.sdT * 4))));
          r0 = L.mantle.a[o]; g0 = L.mantle.a[o + 1]; b0 = L.mantle.a[o + 2];
          break;
        }
        case 'surface geology': {
          // What rock is actually at the surface. Categorical, so this reads
          // like a geological map rather than a shaded scalar field.
          const rk = r.topRock[i];
          if (rk < 0) { r0 = 26; g0 = 32; b0 = 44; break; }
          const col = ROCKS[rk].color;
          r0 = col[0]; g0 = col[1]; b0 = col[2];
          // Submerged rock is dimmed, so the coastline still reads.
          if (r.elevation[i] < sea) { r0 *= 0.52; g0 *= 0.56; b0 *= 0.68; }
          break;
        }
        case 'weakness': {
          const o = pick(Math.min(1, r.weakness[i]));
          r0 = L.weak.a[o]; g0 = L.weak.a[o + 1]; b0 = L.weak.a[o + 2];
          break;
        }
        case 'stress': {
          const o = pick(0.5 + Math.max(-0.5, Math.min(0.5, r.stress[i] / 80)));
          r0 = L.stress.a[o]; g0 = L.stress.a[o + 1]; b0 = L.stress.a[o + 2];
          break;
        }
        case 'plates': {
          const p = r.plate[i];
          if (p >= 0 && plateLut) { r0 = plateLut[p * 3]; g0 = plateLut[p * 3 + 1]; b0 = plateLut[p * 3 + 2]; }
          else { r0 = 20; g0 = 20; b0 = 24; }
          if (r.elevation[i] < sea) { r0 *= 0.55; g0 *= 0.55; b0 *= 0.62; }
          break;
        }
        case 'slabDepth': {
          const sd = r.slabDepth[i];
          if (sd < 0) {
            if (r.elevation[i] < sea) { r0 = 12; g0 = 20; b0 = 34; } else { r0 = 42; g0 = 44; b0 = 40; }
          } else {
            const o = pick(Math.min(1, sd / 660));
            r0 = L.slab.a[o]; g0 = L.slab.a[o + 1]; b0 = L.slab.a[o + 2];
          }
          break;
        }
        default: r0 = g0 = b0 = 0;
      }
      if (shadeOn) {
        const k = shade[i];
        r0 *= k; g0 *= k; b0 *= k;
      }
      const o = i * 4;
      d[o] = r0 > 255 ? 255 : r0;
      d[o + 1] = g0 > 255 ? 255 : g0;
      d[o + 2] = b0 > 255 ? 255 : b0;
      d[o + 3] = 255;
    }
    this.offCtx.putImageData(this.img, 0, 0);
  }

  // Multi-directional hillshade with an ambient-occlusion term.
  //
  // A single light source leaves every slope facing away from it uniformly
  // dark, so whole flanks of a range read as flat shadow and ridge lines
  // facing the light vanish. Relief shading on real maps combines several
  // azimuths for exactly this reason: every slope catches at least one light,
  // so the SHAPE survives rather than just the aspect. The occlusion term --
  // how much a cell sits below its surroundings -- then puts valleys in shade
  // and leaves ridges standing, which is what reads as depth.
  computeShade() {
    const r = this.raster;
    const { gw, gh, cw, ch } = r;
    const n = gw * gh;
    if (!this._shade || this._shade.length !== n) this._shade = new Float32Array(n);
    const out = this._shade;
    // Shade the sharp reconstruction, not the colour field -- see
    // Raster.sharpenRelief(). This is where the terrain gets its shape back.
    const e = r.elevSharp && r.elevSharp.length === n ? r.elevSharp : r.elevation;
    const vx = this.reliefExaggeration / cw, vy = this.reliefExaggeration / ch;

    // Four lights, dominant from the north-west as convention expects.
    const lights = [
      { az: 315, alt: 50, w: 0.45 },
      { az: 45, alt: 42, w: 0.22 },
      { az: 180, alt: 38, w: 0.18 },
      { az: 265, alt: 60, w: 0.15 },
    ].map((l) => {
      const a = l.az * Math.PI / 180, z = l.alt * Math.PI / 180;
      return { x: Math.cos(z) * Math.sin(a), y: -Math.cos(z) * Math.cos(a), z: Math.sin(z), w: l.w };
    });

    for (let y = 0; y < gh; y++) {
      const yp = ((y - 1) + gh) % gh, yn = (y + 1) % gh;
      const rowP = yp * gw, rowN = yn * gw, row = y * gw;
      for (let x = 0; x < gw; x++) {
        const xp = ((x - 1) + gw) % gw, xn = (x + 1) % gw;
        const c = row + x;
        // Horn's method: a 3x3 Sobel, far less noisy than a 2-cell difference.
        const z1 = e[rowP + xp], z2 = e[rowP + x], z3 = e[rowP + xn];
        const z4 = e[row + xp], z6 = e[row + xn];
        const z7 = e[rowN + xp], z8 = e[rowN + x], z9 = e[rowN + xn];
        const dzdx = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) / 8 * vx;
        const dzdy = ((z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)) / 8 * vy;
        const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const nx = -dzdx * inv, ny = -dzdy * inv, nz = inv;

        let lit = 0;
        for (const L of lights) {
          const d = nx * L.x + ny * L.y + nz * L.z;
          lit += L.w * (d > 0 ? d : 0);
        }

        // Sitting below your neighbours darkens you; standing above them does
        // not brighten you as much. Cheap, and it is what gives valleys depth.
        const mean8 = (z1 + z2 + z3 + z4 + z6 + z7 + z8 + z9) / 8;
        const rel = e[c] - mean8;
        const occ = rel < 0 ? 1 + Math.max(-0.45, rel * this.occlusionStrength)
                            : 1 + Math.min(0.18, rel * this.occlusionStrength * 0.35);

        out[c] = Math.max(0.25, Math.min(1.75, (0.46 + 1.08 * lit) * occ));
      }
    }
    return out;
  }

  // ---- main draw -------------------------------------------------------
  draw() {
    const ctx = this.ctx, w = this.world;
    const { width, height } = this.canvas;
    ctx.save();
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, width, height);

    this.buildImage();
    ctx.imageSmoothingEnabled = this.cam.scale * (w.W / this.raster.gw) > 3;

    // Which torus tiles touch the viewport?
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(width, height);
    const ti0 = Math.floor(x0 / w.W), ti1 = Math.floor(x1 / w.W);
    const tj0 = Math.floor(y0 / w.H), tj1 = Math.floor(y1 / w.H);

    this.tiles = [];
    for (let j = tj0; j <= tj1; j++) {
      for (let i = ti0; i <= ti1; i++) this.tiles.push([i * w.W, j * w.H]);
    }

    for (const [ox, oy] of this.tiles) {
      const [sx, sy] = this.toScreen(ox, oy);
      ctx.drawImage(this.off, sx, sy, w.W * this.cam.scale, w.H * this.cam.scale);
    }

    for (const [ox, oy] of this.tiles) {
      ctx.save();
      const [sx, sy] = this.toScreen(ox, oy);
      ctx.translate(sx, sy);
      ctx.scale(this.cam.scale, this.cam.scale);
      this.drawOverlays(ctx);
      ctx.restore();
    }

    this.drawSeam(ctx);
    ctx.restore();
  }

  drawSeam(ctx) {
    if (!this.overlays.grid) return;
    const w = this.world;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    for (const [ox, oy] of this.tiles) {
      const [sx, sy] = this.toScreen(ox, oy);
      ctx.strokeRect(sx, sy, w.W * this.cam.scale, w.H * this.cam.scale);
    }
    ctx.restore();
  }

  // Everything below draws in world units; the caller has already applied the
  // tile translation and the camera scale.
  drawOverlays(ctx) {
    const w = this.world, s = this.cam.scale;
    const px = 1 / s;                      // one screen pixel in world units

    if (this.overlays.slabs) this.drawSlabContours(ctx, px);
    if (this.overlays.faults) this.drawFaults(ctx, px);
    if (this.overlays.segments) this.drawSegments(ctx, px);
    if (this.overlays.symbols) this.drawSymbols(ctx, px);
    if (this.overlays.junctions) this.drawJunctions(ctx, px);
    if (this.overlays.quakes) this.drawQuakes(ctx, px);
    if (this.overlays.mantleFlow) this.drawMantleFlow(ctx, px);
    if (this.overlays.velocity) this.drawVelocities(ctx, px);
    if (this.overlays.rivers) this.drawRivers(ctx, px);
    if (this.overlays.volcanoes) this.drawVolcanoes(ctx, px);
    if (this.overlays.plumes) this.drawPlumes(ctx, px);
    if (this.section && this.section.line) this.drawSectionLine(ctx, px);
  }

  // Hotspots. They sit still while the plates slide over them, so the chain of
  // volcanoes trailing away from one is the plate's own track.
  // Rivers, straight off the drainage solve. Width follows the square root of
  // discharge, the way a real channel does, so a trunk stream reads as a trunk
  // and its headwaters do not. Only channels above a threshold are drawn --
  // every cell technically has a flow direction, and drawing all of them would
  // just flood-fill the continents.
  drawRivers(ctx, px) {
    const d = this.world.drainage;
    if (!d) return;
    const { gw, gh, cw, ch, area, recv, filled } = d;
    const sea = this.world.seaLevel;
    const minA = this.world.cfg.riverMinArea;
    const maxA = Math.max(minA * 50, this.world.cfg.W * this.world.cfg.H * 0.02);
    ctx.lineCap = 'round';
    for (let c = 0; c < gw * gh; c++) {
      const a = area[c];
      if (a < minA) continue;
      const r = recv[c];
      if (r < 0 || filled[c] <= sea) continue;
      const x0 = (c % gw + 0.5) * cw, y0 = ((c / gw | 0) + 0.5) * ch;
      let x1 = (r % gw + 0.5) * cw, y1 = ((r / gw | 0) + 0.5) * ch;
      // Do not draw the segment that crosses the seam; the tiling handles it.
      if (Math.abs(x1 - x0) > this.world.W / 2) continue;
      if (Math.abs(y1 - y0) > this.world.H / 2) continue;
      const t = Math.min(1, Math.sqrt(a / maxA));
      ctx.strokeStyle = `rgba(104,170,228,${(0.35 + 0.55 * t).toFixed(3)})`;
      ctx.lineWidth = (0.6 + 3.4 * t) * px;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }

  // Volcanoes. A filled triangle is the convention, and the two kinds really
  // do look different on the ground, so they look different here: a tall
  // narrow triangle for a stratocone, a broad flat one for a shield.
  drawVolcanoes(ctx, px) {
    const V = this.world.volcanoes;
    if (!V) return;
    for (let i = 0; i < V.n; i++) {
      if (!V.alive[i]) continue;
      const shield = V.kind[i] === 1;
      const vig = Math.min(1, V.vigour[i] / 40);
      const h = (shield ? 5.5 : 8) * px * (0.65 + 0.5 * vig);
      const wd = (shield ? 9 : 5) * px * (0.65 + 0.5 * vig);
      const x = V.x[i], y = V.y[i];
      ctx.beginPath();
      ctx.moveTo(x, y - h); ctx.lineTo(x + wd, y + h * 0.55); ctx.lineTo(x - wd, y + h * 0.55);
      ctx.closePath();
      // Dormant vents are hollow; an erupting one is filled and hot.
      const active = V.idle[i] < 6;
      ctx.fillStyle = active ? 'rgba(246,108,62,0.92)' : 'rgba(58,46,44,0.62)';
      ctx.fill();
      ctx.strokeStyle = active ? 'rgba(255,224,150,0.95)' : 'rgba(228,214,206,0.70)';
      ctx.lineWidth = 1.1 * px;
      ctx.stroke();
    }
  }

  drawPlumes(ctx, px) {
    const m = this.world.mantle;
    if (!m) return;
    for (const p of m.plumes) {
      const r = 9 * px * (0.6 + p.strength);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
      g.addColorStop(0, 'rgba(255,196,92,0.55)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,226,170,0.95)';
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.55, p.y); ctx.lineTo(p.x + r * 0.55, p.y);
      ctx.moveTo(p.x, p.y - r * 0.55); ctx.lineTo(p.x, p.y + r * 0.55);
      ctx.stroke();
    }
  }

  // The convecting flow the plates are riding on.
  drawMantleFlow(ctx, px) {
    const m = this.world.mantle;
    if (!m) return;
    const step = Math.max(1, Math.round(m.nx / 34));
    const k = 6;
    ctx.strokeStyle = 'rgba(150,200,255,0.55)';
    ctx.fillStyle = 'rgba(150,200,255,0.55)';
    ctx.lineWidth = 1.2 * px;
    for (let gy = 0; gy < m.ny; gy += step) {
      for (let gx = 0; gx < m.nx; gx += step) {
        const c = gy * m.nx + gx;
        const sp = Math.hypot(m.vx[c], m.vy[c]);
        if (sp < 2) continue;
        const x = (gx + 0.5) * m.hx, y = (gy + 0.5) * m.hy;
        const ex = x + m.vx[c] * k, ey = y + m.vy[c] * k;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
        const a = Math.atan2(m.vy[c], m.vx[c]);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(a - 0.4) * 5 * px, ey - Math.sin(a - 0.4) * 5 * px);
        ctx.lineTo(ex - Math.cos(a + 0.4) * 5 * px, ey - Math.sin(a + 0.4) * 5 * px);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  // ---- section line ----------------------------------------------------
  // A section you cannot see on the map is a section you cannot aim. Draw the
  // cut, the corridor it actually samples, distance ticks and grab handles at
  // both ends, all torus-aware.
  drawSectionLine(ctx, px) {
    const sec = this.section, w = this.world;
    const g = sec.geometry();
    if (!g) return;
    const { dx, dy, len, tx, ty } = g;
    const nx = -ty, ny = tx;
    const hw = sec.halfWidth;
    const x0 = sec.line.x0, y0 = sec.line.y0;
    const x1 = x0 + dx, y1 = y0 + dy;

    // The corridor: everything inside this band is what the section shows.
    ctx.beginPath();
    ctx.moveTo(x0 + nx * hw, y0 + ny * hw);
    ctx.lineTo(x1 + nx * hw, y1 + ny * hw);
    ctx.lineTo(x1 - nx * hw, y1 - ny * hw);
    ctx.lineTo(x0 - nx * hw, y0 - ny * hw);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,200,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,200,255,0.30)';
    ctx.lineWidth = 1 * px;
    ctx.stroke();

    // The cut itself, with a dark casing so it reads over any base layer.
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 4.5 * px;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

    // Distance ticks in round numbers.
    const step = tickStep(len);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.4 * px;
    ctx.font = `${10 * px}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let d = step; d < len - step * 0.25; d += step) {
      const cx = x0 + tx * d, cy = y0 + ty * d;
      ctx.beginPath();
      ctx.moveTo(cx + nx * 5 * px, cy + ny * 5 * px);
      ctx.lineTo(cx - nx * 5 * px, cy - ny * 5 * px);
      ctx.stroke();
      if (this.cam.scale > 0.035) {
        ctx.fillText(`${(d / 1000).toFixed(1)}`, cx + nx * 9 * px, cy + ny * 9 * px);
      }
    }

    // Grab handles. A and A' match the labels in the section panel.
    const handle = (hx, hy, label, active) => {
      ctx.beginPath();
      ctx.arc(hx, hy, 6.5 * px, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(86,176,240,0.95)' : 'rgba(14,18,27,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.6 * px;
      ctx.stroke();
      ctx.font = `bold ${10 * px}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(label, hx + 9 * px, hy - 7 * px);
    };
    handle(x0, y0, 'A', this.dragHandle === 'a');
    handle(x1, y1, 'A′', this.dragHandle === 'b');
    // Midpoint handle: translates the whole cut without changing its bearing.
    const mxp = x0 + dx * 0.5, myp = y0 + dy * 0.5;
    ctx.beginPath();
    ctx.arc(mxp, myp, 4.5 * px, 0, Math.PI * 2);
    ctx.fillStyle = this.dragHandle === 'mid' ? 'rgba(86,176,240,0.95)' : 'rgba(255,255,255,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.2 * px;
    ctx.stroke();
  }

  // Which handle, if any, is under a screen position. Tested against every
  // visible torus tile, so a handle near the seam is grabbable from either
  // side of it.
  handleAt(screenX, screenY) {
    const sec = this.section;
    if (!sec || !sec.line || !this.tiles) return null;
    const g = sec.geometry();
    if (!g) return null;
    const pts = [
      ['a', sec.line.x0, sec.line.y0],
      ['b', sec.line.x0 + g.dx, sec.line.y0 + g.dy],
      ['mid', sec.line.x0 + g.dx * 0.5, sec.line.y0 + g.dy * 0.5],
    ];
    const grab = 11;
    for (const [name, wx, wy] of pts) {
      for (const [ox, oy] of this.tiles) {
        const [px2, py2] = this.toScreen(wx + ox, wy + oy);
        if (Math.hypot(px2 - screenX, py2 - screenY) <= grab) return name;
      }
    }
    return null;
  }

  // Hue from obliquity, width from rate.
  drawFaults(ctx, px) {
    const b = this.world.boundaries;
    const W = this.world.W, H = this.world.H;
    ctx.lineCap = 'round';
    for (let e = 0; e < b.count; e++) {
      const ax = b.ax[e], ay = b.ay[e];
      const dx = wrapDelta(b.bx[e] - ax, W), dy = wrapDelta(b.by[e] - ay, H);
      const c = CM.obliquityColor(b.obliquity[e]);
      ctx.strokeStyle = CM.rgb(c, 0.95);
      ctx.lineWidth = Math.max(1.2 * px, (0.8 + b.rate[e] * 0.055) * px * 1.6);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + dx, ay + dy);
      ctx.stroke();
    }
  }

  // Ridges as a double line; transforms as the offsets between them.
  drawSegments(ctx, px) {
    const w = this.world;
    ctx.lineCap = 'butt';
    for (const seg of w.segments.active()) {
      const dx = wrapDelta(seg.x1 - seg.x0, w.W), dy = wrapDelta(seg.y1 - seg.y0, w.H);
      const nx = seg.dirX, ny = seg.dirY;
      const off = 3.2 * px;
      ctx.strokeStyle = seg.continental > 0.5 ? 'rgba(255,196,120,0.95)' : 'rgba(150,230,255,0.95)';
      ctx.lineWidth = 1.6 * px;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(seg.x0 + nx * off * sgn, seg.y0 + ny * off * sgn);
        ctx.lineTo(seg.x0 + dx + nx * off * sgn, seg.y0 + dy + ny * off * sgn);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(236,206,86,0.9)';
    ctx.lineWidth = 1.4 * px;
    for (const t of w.segments.transforms) {
      const dx = wrapDelta(t.x1 - t.x0, w.W), dy = wrapDelta(t.y1 - t.y0, w.H);
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x0 + dx, t.y0 + dy);
      ctx.stroke();
    }
  }

  // Real geologic symbols: barbed teeth on trenches pointing to the overriding
  // side, ticks on the hanging wall of rifts, paired arrows on strike-slip.
  drawSymbols(ctx, px) {
    const w = this.world, b = w.boundaries;
    const tooth = 9 * px;
    ctx.lineWidth = 1.1 * px;
    for (const z of w.trenches.all()) {
      if (z.isCollision) continue;
      ctx.fillStyle = 'rgba(232,84,60,0.92)';
      ctx.strokeStyle = 'rgba(232,84,60,0.92)';
      let k = 0;
      for (const e of z.edges) {
        if ((k++ % 3) !== 0) continue;
        const ax = b.ax[e], ay = b.ay[e];
        const dx = wrapDelta(b.bx[e] - ax, w.W), dy = wrapDelta(b.by[e] - ay, w.H);
        const L = Math.hypot(dx, dy) || 1;
        const tx = dx / L, ty = dy / L;
        // Teeth point away from the ocean, i.e. onto the overriding plate.
        const sx = -(z.oceanX || 0), sy = -(z.oceanY || 0);
        const mx = ax + dx * 0.5, my = ay + dy * 0.5;
        ctx.beginPath();
        ctx.moveTo(mx - tx * tooth * 0.45, my - ty * tooth * 0.45);
        ctx.lineTo(mx + tx * tooth * 0.45, my + ty * tooth * 0.45);
        ctx.lineTo(mx + sx * tooth, my + sy * tooth);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Rift ticks on the hanging wall.
    ctx.strokeStyle = 'rgba(255,196,120,0.85)';
    for (let e = 0; e < b.count; e += 3) {
      if (b.kind[e] !== KIND.RIFT) continue;
      const ax = b.ax[e], ay = b.ay[e];
      const dx = wrapDelta(b.bx[e] - ax, w.W), dy = wrapDelta(b.by[e] - ay, w.H);
      const mx = ax + dx * 0.5, my = ay + dy * 0.5;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + b.nx[e] * tooth * 0.8, my + b.ny[e] * tooth * 0.8);
      ctx.stroke();
    }
    // Strike-slip arrow pairs.
    ctx.strokeStyle = 'rgba(240,226,140,0.9)';
    for (let e = 0; e < b.count; e += 7) {
      if (b.kind[e] !== KIND.TRANSFORM) continue;
      const sense = Math.sign(b.vt[e]);
      const ax = b.ax[e], ay = b.ay[e];
      const dx = wrapDelta(b.bx[e] - ax, w.W), dy = wrapDelta(b.by[e] - ay, w.H);
      const L = Math.hypot(dx, dy) || 1;
      const tx = dx / L * tooth, ty = dy / L * tooth;
      const nx = b.nx[e] * tooth * 0.5, ny = b.ny[e] * tooth * 0.5;
      const mx = ax + dx * 0.5, my = ay + dy * 0.5;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(mx + nx * sgn - tx * sense * sgn * 0.6, my + ny * sgn - ty * sense * sgn * 0.6);
        ctx.lineTo(mx + nx * sgn + tx * sense * sgn * 0.6, my + ny * sgn + ty * sense * sgn * 0.6);
        ctx.stroke();
      }
    }
  }

  drawJunctions(ctx, px) {
    const tj = this.world.boundaries.tripleJunctions || [];
    ctx.font = `${9 * px}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 2 * px;
    for (const j of tj) {
      ctx.beginPath();
      ctx.arc(j.x, j.y, 3.2 * px, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      if (this.cam.scale > 0.06) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(j.type, j.x + 5 * px, j.y - 4 * px);
        ctx.fillText(j.type, j.x + 5 * px, j.y - 4 * px);
      }
    }
  }

  drawSlabContours(ctx, px) {
    const r = this.raster;
    const { gw, gh, cw, ch } = r;
    ctx.lineWidth = 1 * px;
    for (const depth of [100, 200, 300, 450, 600]) {
      ctx.strokeStyle = CM.rgb(CM.slabRamp(depth / 660), 0.55);
      ctx.beginPath();
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const a = r.slabDepth[y * gw + x];
          const b = r.slabDepth[y * gw + ((x + 1) % gw)];
          if (a < 0 || b < 0) continue;
          if ((a - depth) * (b - depth) > 0) continue;
          ctx.moveTo((x + 1) * cw, y * ch);
          ctx.lineTo((x + 1) * cw, (y + 1) * ch);
        }
      }
      ctx.stroke();
    }
  }

  drawQuakes(ctx, px) {
    const w = this.world, q = w.quakes;
    for (const i of q.recent(w.t, 8)) {
      const age = (w.t - q.t[i]) / 8;
      const d = q.depth[i];
      const c = d < 60 ? [255, 92, 72] : d < 200 ? [255, 190, 70] : [120, 200, 255];
      ctx.fillStyle = CM.rgb(c, 0.75 * (1 - age));
      ctx.beginPath();
      ctx.arc(q.x[i], q.y[i], (0.7 + (q.mag[i] - 4) * 0.8) * px * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawVelocities(ctx, px) {
    const w = this.world;
    const v = [0, 0];
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.4 * px;
    const step = Math.max(w.W, w.H) / 26;
    for (let y = step * 0.5; y < w.H; y += step) {
      for (let x = step * 0.5; x < w.W; x += step) {
        const pid = this.raster.sampleAt(this.raster.plate, x, y);
        const p = pid >= 0 ? w.plates.get(pid) : null;
        if (!p || !p.alive) continue;
        p.velAtWorld(x, y, w.W, w.H, v);
        const sp = Math.hypot(v[0], v[1]);
        if (sp < 1) continue;
        const k = step * 0.42 / Math.max(1, 90) ;
        const ex = x + v[0] * k, ey = y + v[1] * k;
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
        const a = Math.atan2(v[1], v[0]);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(a - 0.4) * 6 * px, ey - Math.sin(a - 0.4) * 6 * px);
        ctx.lineTo(ex - Math.cos(a + 0.4) * 6 * px, ey - Math.sin(a + 0.4) * 6 * px);
        ctx.closePath(); ctx.fill();
      }
    }
  }
}
