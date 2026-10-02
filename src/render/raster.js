import { elevationField, solveSeaLevel, waterVolume } from '../sim/elevation.js';
import { heatFlowField, gravityFields, strainRateField } from '../sim/geophysics.js';
import { topRock } from '../sim/rocks.js';

// Splat, do not nearest-neighbour. Each point writes a Gaussian-weighted
// contribution into an accumulation buffer over a radius of a few point
// spacings, with weight accumulated separately and divided out at the end.
// Cheap, parallel, smooth, and it wraps trivially because the buffer is
// wrap-indexed.
//
// Field ordering matters: rasterise the RAW fields (thickness, age,
// continental, lithosphere) and compute elevation from the rasterised result.
// Not the reverse -- elevation is a nonlinear function of them, and
// interpolating it directly smears shelf breaks and ridge crests into mush.
export class Raster {
  constructor(world) {
    this.world = world;
    this.resize();
  }

  resize() {
    const { cfg, W, H, spacing } = this.world;
    const cell = spacing / cfg.rasterCellsPerSpacing;
    this.gw = Math.max(8, Math.round(W / cell));
    this.gh = Math.max(8, Math.round(H / cell));
    this.cw = W / this.gw;
    this.ch = H / this.gh;
    const n = this.gw * this.gh;
    this.n = n;
    const f32 = () => new Float32Array(n);
    this.thickness = f32(); this.continental = f32(); this.age = f32();
    this.litho = f32(); this.weakness = f32(); this.stress = f32();
    this.defAge = f32();
    this.elevation = f32();
    // Derived from the rasterised fields, never splatted directly.
    this.heatFlow = f32(); this.bouguer = f32(); this.freeAir = f32();
    this.strainRate = f32();
    this.wsum = f32();
    this.bestW = f32();
    this.plate = new Int32Array(n);
    this.segment = new Int32Array(n);
    this.topRock = new Int32Array(n);
    this.slabDepth = f32(); this.slabW = f32();
    this.distToBoundary = f32();
    this.cellArea = this.cw * this.ch;
  }

  // Precomputed Gaussian kernels, one per sub-cell offset bin. Cells whose
  // weight is negligible are dropped from the list entirely, so the inner loop
  // has no distance test and no branch.
  kernels(cfg, spacing) {
    const sig = cfg.splatSigmaFactor, rad = cfg.splatRadiusFactor;
    const sig2 = `${sig}:${rad}:${this.cw}:${this.ch}:${spacing}`;
    if (this._kSig === sig2) return this._kernels;
    const radius = rad * spacing;
    const sigma = sig * spacing;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const rx = Math.max(1, Math.ceil(radius / this.cw));
    const ry = Math.max(1, Math.ceil(radius / this.ch));
    const bins = 4;
    const table = [];
    for (let by = 0; by < bins; by++) {
      for (let bx = 0; bx < bins; bx++) {
        const fx = (bx + 0.5) / bins, fy = (by + 0.5) / bins;
        const ox = [], oy = [], ws = [];
        for (let dy = -ry; dy <= ry; dy++) {
          const ddy = (dy + 0.5 - fy) * this.ch;
          for (let dx = -rx; dx <= rx; dx++) {
            const ddx = (dx + 0.5 - fx) * this.cw;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 > radius * radius) continue;
            const wt = Math.exp(-d2 * inv2s2);
            if (wt < 1e-3) continue;
            ox.push(dx); oy.push(dy); ws.push(wt);
          }
        }
        table.push({ ox: Int32Array.from(ox), oy: Int32Array.from(oy), w: Float32Array.from(ws) });
      }
    }
    this._kSig = sig2;
    this._kernels = { bins, table };
    return this._kernels;
  }

  rasterise() {
    const w = this.world;
    const { cfg, crust, slabs } = w;
    const { gw, gh, cw, ch, n } = this;
    const sc = w.scratch;

    this.thickness.fill(0); this.continental.fill(0); this.age.fill(0);
    this.litho.fill(0); this.weakness.fill(0); this.stress.fill(0);
    this.defAge.fill(0);
    this.wsum.fill(0); this.bestW.fill(0);
    this.plate.fill(-1); this.segment.fill(0); this.topRock.fill(-1);

    // The splat kernel is the hot loop: ~80 cells per point over tens of
    // thousands of points, every frame. Evaluating exp() there dominates the
    // cost, so the kernel is precomputed once per configuration for a small
    // grid of sub-cell offsets and then only indexed.
    const K = this.kernels(cfg, w.spacing);

    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const px = crust.x[i] / cw, py = crust.y[i] / ch;
      const gx0 = Math.floor(px), gy0 = Math.floor(py);
      const k = K.table[(Math.min(K.bins - 1, ((py - gy0) * K.bins) | 0) * K.bins)
                      + Math.min(K.bins - 1, ((px - gx0) * K.bins) | 0)];
      const th = crust.thickness[i], co = crust.continental[i], ag = crust.age[i];
      const li = crust.litho[i], we = crust.weakness[i], da = crust.defAge[i];
      const st = sc.stress ? sc.stress[i] : 0;
      const pl = crust.plate[i], sg = crust.segment[i], tr = topRock(crust, i, cfg.bedrockVeneer);
      const ox = k.ox, oy = k.oy, wt_ = k.w, m = wt_.length;
      for (let q = 0; q < m; q++) {
        const gy = ((gy0 + oy[q]) % gh + gh) % gh;
        const gx = ((gx0 + ox[q]) % gw + gw) % gw;
        const c = gy * gw + gx;
        const wt = wt_[q];
        this.thickness[c] += wt * th;
        this.continental[c] += wt * co;
        this.age[c] += wt * ag;
        this.litho[c] += wt * li;
        this.weakness[c] += wt * we;
        this.stress[c] += wt * st;
        this.defAge[c] += wt * da;
        this.wsum[c] += wt;
        // Categorical fields cannot be averaged: take the nearest point's.
        if (wt > this.bestW[c]) {
          this.bestW[c] = wt; this.plate[c] = pl; this.segment[c] = sg; this.topRock[c] = tr;
        }
      }
    }

    for (let c = 0; c < n; c++) {
      const s = this.wsum[c];
      if (s > 0) {
        const inv = 1 / s;
        this.thickness[c] *= inv; this.continental[c] *= inv; this.age[c] *= inv;
        this.litho[c] *= inv; this.weakness[c] *= inv; this.stress[c] *= inv;
        this.defAge[c] *= inv;
      } else {
        this.thickness[c] = cfg.thickOcean; this.continental[c] = 0;
        this.age[c] = 0; this.litho[c] = 10; this.weakness[c] = 0;
        this.defAge[c] = 0;
      }
    }

    // Slabs get their own underlay: shallowest slab wins, so an overlying
    // shallow slab is not averaged away by a deep one.
    this.slabDepth.fill(-1);
    const sr = w.spacing * 1.6, sr2 = sr * sr;
    const srx = Math.max(1, Math.ceil(sr / cw)), sry = Math.max(1, Math.ceil(sr / ch));
    for (let i = 0; i < slabs.n; i++) {
      if (!slabs.alive[i]) continue;
      const px = slabs.x[i] / cw, py = slabs.y[i] / ch;
      const gx0 = Math.floor(px), gy0 = Math.floor(py);
      const d = slabs.depth[i];
      for (let dy = -sry; dy <= sry; dy++) {
        const gy = ((gy0 + dy) % gh + gh) % gh;
        const ddy = (gy0 + dy + 0.5 - py) * ch;
        for (let dx = -srx; dx <= srx; dx++) {
          const ddx = (gx0 + dx + 0.5 - px) * cw;
          if (ddx * ddx + ddy * ddy > sr2) continue;
          const c = gy * gw + ((gx0 + dx) % gw + gw) % gw;
          if (this.slabDepth[c] < 0 || d < this.slabDepth[c]) this.slabDepth[c] = d;
        }
      }
    }

    // Everything derived comes LAST, from the smoothed raw fields. These are
    // all nonlinear in thickness, age and lithospheric depth, so interpolating
    // the results instead of the inputs would smear every boundary.
    elevationField(cfg, this.thickness, this.continental, this.litho, this.age, this.elevation);
    heatFlowField(cfg, this.litho, this.thickness, this.continental, this.heatFlow);
    gravityFields(cfg, this.thickness, this.continental, this.litho, this.age,
      this.elevation, this.bouguer, this.freeAir);
    strainRateField(w, this, this.strainRate);

    this.updateSeaLevel();
    this.boundaryDistance();
    return this;
  }

  // Total ocean water is fixed, so a world with a lot of young shallow seafloor
  // has less basin volume to hold it and sea level rises, flooding continental
  // margins. That is the mechanism behind the great epicontinental seas.
  updateSeaLevel() {
    const w = this.world, cfg = w.cfg;
    if (this.world.waterTarget == null) {
      this.world.waterTarget = waterVolume(this.elevation, cfg.seaLevel, this.cellArea);
      w.seaLevel = cfg.seaLevel;
      return;
    }
    if (!cfg.dynamicSeaLevel) { w.seaLevel = cfg.seaLevel; return; }
    const solved = solveSeaLevel(cfg, this.elevation, this.cellArea, this.world.waterTarget);
    w.seaLevel += (solved - w.seaLevel) * cfg.oceanVolumeRelax;
  }

  // Distance to the nearest plate boundary, by two-pass chamfer over the
  // wrapped grid. Used for arc-placement checks, wedge falloff and rift
  // shoulder shading. The row offsets are precomputed rather than taken modulo
  // in the inner loop -- this runs over every cell four times per frame.
  boundaryDistance() {
    const { gw, gh, cw, ch } = this;
    const d = this.distToBoundary;
    const plate = this.plate;
    const BIG = 1e9;
    d.fill(BIG);

    if (!this._rowUp || this._rowUp.length !== gh) {
      this._rowUp = new Int32Array(gh);
      this._rowDn = new Int32Array(gh);
    }
    const up = this._rowUp, dn = this._rowDn;
    for (let y = 0; y < gh; y++) {
      up[y] = ((y - 1 + gh) % gh) * gw;
      dn[y] = ((y + 1) % gh) * gw;
    }

    for (let y = 0; y < gh; y++) {
      const row = y * gw, below = dn[y];
      for (let x = 0; x < gw; x++) {
        const p = plate[row + x];
        const xr = x + 1 === gw ? 0 : x + 1;
        if (p !== plate[row + xr] || p !== plate[below + x]) {
          d[row + x] = 0;
          d[row + xr] = 0;
          d[below + x] = 0;
        }
      }
    }

    const dx = cw, dy = ch, dd = Math.hypot(cw, ch);
    // forward pass
    for (let y = 0; y < gh; y++) {
      const row = y * gw, above = up[y];
      for (let x = 0; x < gw; x++) {
        const c = row + x;
        let v = d[c];
        if (v === 0) continue;
        const xl = x === 0 ? gw - 1 : x - 1;
        const xr = x + 1 === gw ? 0 : x + 1;
        let t = d[row + xl] + dx; if (t < v) v = t;
        t = d[above + x] + dy;    if (t < v) v = t;
        t = d[above + xl] + dd;   if (t < v) v = t;
        t = d[above + xr] + dd;   if (t < v) v = t;
        d[c] = v;
      }
    }
    // backward pass
    for (let y = gh - 1; y >= 0; y--) {
      const row = y * gw, below = dn[y];
      for (let x = gw - 1; x >= 0; x--) {
        const c = row + x;
        let v = d[c];
        if (v === 0) continue;
        const xl = x === 0 ? gw - 1 : x - 1;
        const xr = x + 1 === gw ? 0 : x + 1;
        let t = d[row + xr] + dx; if (t < v) v = t;
        t = d[below + x] + dy;    if (t < v) v = t;
        t = d[below + xr] + dd;   if (t < v) v = t;
        t = d[below + xl] + dd;   if (t < v) v = t;
        d[c] = v;
      }
    }
  }

  sampleAt(field, x, y) {
    const gx = Math.floor((((x % this.world.W) + this.world.W) % this.world.W) / this.cw);
    const gy = Math.floor((((y % this.world.H) + this.world.H) % this.world.H) / this.ch);
    return field[gy * this.gw + gx];
  }
}
