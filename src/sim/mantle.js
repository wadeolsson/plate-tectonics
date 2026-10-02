import { wrapPos, wrapDelta } from '../core/torus.js';

// A coarse convecting mantle, viewed from above.
//
// Plate motions used to come from an Ornstein-Uhlenbeck random force: smooth
// and persistent, but meaningless -- nothing about where a plate went had any
// cause. This replaces it with a temperature anomaly field that is heated from
// below, cooled through whatever lithosphere sits on top of it, and chilled by
// the slabs falling through it. Flow is then solved from that field, and plates
// are dragged along by it.
//
// Three things follow that previously had to be faked or were simply absent:
//
//   * Continents insulate. A craton with a 230 km root passes very little heat,
//     so the mantle beneath it warms, wells up, and puts the plate into
//     extension. That is the real mechanism behind supercontinent breakup, and
//     it replaces the `insulationStress` term that used to stand in for it.
//   * Downwellings are self-sustaining. Cold slab sinking under a trench keeps
//     the downwelling there after the slab itself has retired, so subduction
//     zones have a reason to persist and to attract further convergence.
//   * Hotspots exist at all. They are the persistent maxima of this field,
//     anchored in the mantle rather than the plates, which is what makes an
//     age-progressive island chain fall out of a plate drifting over one.
export class MantleField {
  constructor(world) {
    const { cfg, W, H } = world;
    this.W = W; this.H = H;
    const cell = world.spacing * cfg.mantleCellsPerSpacing;
    this.nx = Math.max(16, Math.round(W / cell));
    this.ny = Math.max(8, Math.round(H / cell));
    this.hx = W / this.nx;
    this.hy = H / this.ny;
    const n = this.nx * this.ny;
    this.n = n;

    this.T = new Float64Array(n);        // temperature anomaly, arbitrary units
    this.Tnext = new Float64Array(n);
    this.phi = new Float64Array(n);      // flow potential, warm-started
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.litho = new Float64Array(n);    // mean lithospheric thickness above
    this.cont = new Float64Array(n);     // mean continental fraction above
    this.slabCool = new Float64Array(n);
    this.wsum = new Float64Array(n);
    this.plumes = [];
    this.nextPlumeId = 1;
    this.seeded = false;
  }

  idx(gx, gy) { return gy * this.nx + gx; }
  cellX(x) { const i = Math.floor(x / this.hx); return ((i % this.nx) + this.nx) % this.nx; }
  cellY(y) { const j = Math.floor(y / this.hy); return ((j % this.ny) + this.ny) % this.ny; }

  // Mantle flow velocity at a world position, bilinear between cell centres.
  velAt(x, y, out) {
    const { nx, ny, hx, hy } = this;
    const fx = x / hx - 0.5, fy = y / hy - 0.5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    x0 = ((x0 % nx) + nx) % nx; y0 = ((y0 % ny) + ny) % ny;
    const x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny;
    const a = this.idx(x0, y0), b = this.idx(x1, y0), c = this.idx(x0, y1), d = this.idx(x1, y1);
    const lerp2 = (f) =>
      (f[a] * (1 - tx) + f[b] * tx) * (1 - ty) + (f[c] * (1 - tx) + f[d] * tx) * ty;
    out[0] = lerp2(this.vx);
    out[1] = lerp2(this.vy);
    return out;
  }

  tempAt(x, y) {
    return this.T[this.idx(this.cellX(x), this.cellY(y))];
  }

  // ---- per-step update -------------------------------------------------
  update(world) {
    const { cfg } = world;
    const dt = cfg.dt;
    this.sampleSurface(world);
    this.applySources(world, dt);
    this.transport(cfg, dt);
    this.solveFlow(cfg);
    this.findPlumes(world);
  }

  // What is sitting on top of each mantle cell, and what is falling through it.
  sampleSurface(world) {
    const { crust, slabs, cfg } = world;
    this.litho.fill(0); this.cont.fill(0); this.wsum.fill(0); this.slabCool.fill(0);

    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const c = this.idx(this.cellX(crust.x[i]), this.cellY(crust.y[i]));
      this.litho[c] += crust.litho[i];
      this.cont[c] += crust.continental[i];
      this.wsum[c] += 1;
    }
    for (let c = 0; c < this.n; c++) {
      if (this.wsum[c] > 0) { this.litho[c] /= this.wsum[c]; this.cont[c] /= this.wsum[c]; }
      else { this.litho[c] = 60; this.cont[c] = 0; }
    }

    // Slabs chill the mantle they are falling through. Weighted by how
    // negatively buoyant they are and faded out near the bottom of the model,
    // where they are leaving anyway.
    for (let i = 0; i < slabs.n; i++) {
      if (!slabs.alive[i]) continue;
      const d = slabs.depth[i];
      const fade = d > cfg.slabRetireDepth * 0.8 ? 0.3 : 1;
      const cold = (0.4 + 0.6 * Math.min(1, Math.sqrt(Math.max(0, slabs.ageAtSub[i])) / 11)) * fade;
      this.slabCool[this.idx(this.cellX(slabs.x[i]), this.cellY(slabs.y[i]))] += cold;
    }
  }

  applySources(world, dt) {
    const { cfg } = world;
    const T = this.T;
    const pointArea = world.pointArea;
    // Slab chilling is per subducted point; normalise by how many points a
    // mantle cell covers so the strength does not depend on the resolution.
    const perCell = (this.hx * this.hy) / pointArea;

    for (let c = 0; c < this.n; c++) {
      // Heated from below, uniformly.
      T[c] += cfg.mantleHeating * dt;
      // Chilled by slabs falling through.
      T[c] -= cfg.mantleSlabChill * (this.slabCool[c] / perCell) * dt;
      // Cooled through the lid. A thick cratonic root is a poor conductor, so
      // heat accumulates beneath it; thin oceanic lithosphere lets it straight
      // out. This is the insulation mechanism expressed as a conductance
      // rather than as a special case.
      //
      // Relaxation is exponential, not `T -= T*rate*dt`. Thin lithosphere
      // gives a decay rate well above 2 per Myr, and the explicit form
      // overshoots through zero and doubles every step -- the field reaches
      // 1e50 within a few tens of Myr.
      const rate = cfg.mantleCooling * cfg.mantleCoolingRef / Math.max(40, this.litho[c]);
      T[c] *= Math.exp(-rate * dt);
      // Numerical guard. Nothing physical should come near this.
      if (!(T[c] > -1e4)) T[c] = -1e4;
      else if (T[c] > 1e4) T[c] = 1e4;
    }
  }

  // Diffusion plus advection by the flow solved last step. Upwind in the
  // advective term, which is only first order but is unconditionally sane at
  // the Courant numbers this runs at.
  transport(cfg, dt) {
    // Sub-cycle so the explicit scheme stays inside its stability limits no
    // matter where the flow-speed and diffusivity sliders are set: the
    // advective Courant number below ~0.4, and the diffusive number below
    // 0.2. Without this, turning the mantle flow up past about 60 km/Myr
    // quietly detonates the field.
    const { hx, hy } = this;
    let vmax = 0;
    for (let c = 0; c < this.n; c++) {
      const s = Math.abs(this.vx[c]) / hx + Math.abs(this.vy[c]) / hy;
      if (s > vmax) vmax = s;
    }
    const kap = cfg.mantleDiffusivity;
    const diffRate = kap * (2 / (hx * hx) + 2 / (hy * hy));
    const limit = Math.min(vmax > 0 ? 0.4 / vmax : Infinity,
                           diffRate > 0 ? 0.2 / diffRate : Infinity);
    const sub = Math.max(1, Math.min(16, Math.ceil(dt / limit)));
    const h = dt / sub;
    for (let k = 0; k < sub; k++) this.transportStep(kap, h);
    this.subSteps = sub;
  }

  transportStep(kap, dt) {
    const { nx, ny, hx, hy, T, Tnext, vx, vy } = this;
    for (let gy = 0; gy < ny; gy++) {
      const yp = ((gy - 1 + ny) % ny) * nx, yn = ((gy + 1) % ny) * nx, y0 = gy * nx;
      for (let gx = 0; gx < nx; gx++) {
        const xp = (gx - 1 + nx) % nx, xn = (gx + 1) % nx;
        const c = y0 + gx;
        const lap = (T[y0 + xp] + T[y0 + xn] - 2 * T[c]) / (hx * hx)
                  + (T[yp + gx] + T[yn + gx] - 2 * T[c]) / (hy * hy);
        const ux = vx[c], uy = vy[c];
        const dTdx = ux > 0 ? (T[c] - T[y0 + xp]) / hx : (T[y0 + xn] - T[c]) / hx;
        const dTdy = uy > 0 ? (T[c] - T[yp + gx]) / hy : (T[yn + gx] - T[c]) / hy;
        Tnext[c] = T[c] + (kap * lap - ux * dTdx - uy * dTdy) * dt;
      }
    }
    T.set(Tnext);
  }

  // Solve del^2 phi = T' for the flow potential, then v = grad phi: divergence
  // over hot mantle, convergence over cold. Periodic boundaries make this
  // solvable only when the source integrates to zero, which is why the field is
  // an anomaly about its own mean. Red-black SOR, warm-started from last step
  // -- the field evolves slowly, so the previous solution is nearly the answer
  // and a couple of dozen sweeps is plenty.
  solveFlow(cfg) {
    const { nx, ny, hx, hy, T, phi } = this;
    let mean = 0;
    for (let c = 0; c < this.n; c++) mean += T[c];
    mean /= this.n;

    const ax = 1 / (hx * hx), ay = 1 / (hy * hy);
    const denom = 2 * (ax + ay);
    const omega = cfg.mantleSOR;

    for (let sweep = 0; sweep < cfg.mantleIterations; sweep++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let gy = 0; gy < ny; gy++) {
          const yp = ((gy - 1 + ny) % ny) * nx, yn = ((gy + 1) % ny) * nx, y0 = gy * nx;
          for (let gx = (gy + colour) & 1; gx < nx; gx += 2) {
            const xp = (gx - 1 + nx) % nx, xn = (gx + 1) % nx;
            const c = y0 + gx;
            const gs = ((phi[y0 + xp] + phi[y0 + xn]) * ax
                      + (phi[yp + gx] + phi[yn + gx]) * ay
                      - (T[c] - mean)) / denom;
            phi[c] += omega * (gs - phi[c]);
          }
        }
      }
    }

    // v = grad phi, taken over a WIDE stencil rather than between adjacent
    // cells. What drags a plate is the flow integrated across the whole of its
    // base, and a cell-scale gradient alternates sign faster than a plate is
    // wide, so averaging it over a plate cancels almost to nothing -- plates
    // end up crawling no matter how hard the coupling is turned up. The wide
    // stencil is a low-pass gradient: it reports the coherent, plate-scale
    // part of the flow, which is the part that actually pushes.
    const kx = Math.max(1, Math.round(cfg.mantleTractionScale / hx));
    const ky = Math.max(1, Math.round(cfg.mantleTractionScale / hy));
    let rms = 0;
    for (let gy = 0; gy < ny; gy++) {
      const yp = ((gy - ky + ny * 8) % ny) * nx, yn = ((gy + ky) % ny) * nx, y0 = gy * nx;
      for (let gx = 0; gx < nx; gx++) {
        const xp = (gx - kx + nx * 8) % nx, xn = (gx + kx) % nx;
        const c = y0 + gx;
        this.vx[c] = (phi[y0 + xn] - phi[y0 + xp]) / (2 * kx * hx);
        this.vy[c] = (phi[yn + gx] - phi[yp + gx]) / (2 * ky * hy);
        rms += this.vx[c] * this.vx[c] + this.vy[c] * this.vy[c];
      }
    }
    rms = Math.sqrt(rms / this.n);

    // The potential is defined up to an arbitrary scale, so normalise the flow
    // to a stated RMS speed. That makes the knob mean something in km/Myr
    // instead of being an opaque product of diffusivity and heating rate.
    this.rawRms = rms;
    const k = rms > 1e-12 ? cfg.mantleFlowSpeed / rms : 0;
    for (let c = 0; c < this.n; c++) { this.vx[c] *= k; this.vy[c] *= k; }
  }

  // ---- hotspots --------------------------------------------------------
  // Persistent maxima of the temperature field. They drift with the mantle
  // itself, not with the plates, which is the whole point: a plate crossing one
  // leaves a chain of volcanic edifices that gets older away from the plume.
  findPlumes(world) {
    const { cfg, t } = world;
    const { nx, ny, T } = this;
    let mean = 0, m2 = 0;
    for (let c = 0; c < this.n; c++) { mean += T[c]; }
    mean /= this.n;
    for (let c = 0; c < this.n; c++) { const d = T[c] - mean; m2 += d * d; }
    const sd = Math.sqrt(m2 / this.n) || 1;

    this.meanT = mean; this.sdT = sd;
    const found = [];
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const c = this.idx(gx, gy);
        const v = (T[c] - mean) / sd;
        if (v < cfg.plumeThreshold) continue;
        // A plume is a broad upwelling, not a single hot cell. The maximum has
        // to hold over a radius comparable to real hotspot spacing, or every
        // bump in the ambient field is reported as a hotspot.
        const rad = Math.max(2, Math.round(cfg.plumeSeparation / Math.min(this.hx, this.hy)));
        let isMax = true;
        for (let dy = -rad; dy <= rad && isMax; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (!dx && !dy) continue;
            const o = this.idx(((gx + dx) % nx + nx) % nx, ((gy + dy) % ny + ny) % ny);
            if (T[o] > T[c]) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        found.push({
          x: (gx + 0.5) * this.hx, y: (gy + 0.5) * this.hy,
          strength: Math.min(1, (v - cfg.plumeThreshold) / 2),
        });
      }
    }

    // Carry identity forward by proximity, as faults and ridge segments do.
    const claimed = new Set();
    const out = [];
    for (const f of found) {
      let best = null, bestD = cfg.plumeMatchRadius * cfg.plumeMatchRadius;
      for (const p of this.plumes) {
        if (claimed.has(p.id)) continue;
        const dx = wrapDelta(p.x - f.x, this.W), dy = wrapDelta(p.y - f.y, this.H);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) {
        claimed.add(best.id);
        // Plumes are anchored: they follow the mantle slowly, not the surface.
        best.x = wrapPos(best.x + wrapDelta(f.x - best.x, this.W) * 0.25, this.W);
        best.y = wrapPos(best.y + wrapDelta(f.y - best.y, this.H) * 0.25, this.H);
        best.strength += (f.strength - best.strength) * 0.25;
        best.lastSeen = t;
        out.push(best);
      } else {
        out.push({ id: this.nextPlumeId++, x: f.x, y: f.y, strength: f.strength, birth: t, lastSeen: t });
      }
    }
    // A plume that flickers out for a step or two is still the same plume.
    for (const p of this.plumes) {
      if (!out.includes(p) && t - p.lastSeen <= cfg.plumeGrace) out.push(p);
    }
    this.plumes = out;
  }

  // ---- plate coupling --------------------------------------------------
  // Basal traction: the force on each plate from the mantle sliding beneath it,
  // plus the torque that shear exerts about the plate's own pivot. This is what
  // gives a plate a reason to rotate other than a random number.
  tractions(world) {
    const { crust, plates, W, H } = world;
    const n = plates.count;
    const fx = new Float64Array(n), fy = new Float64Array(n);
    const tq = new Float64Array(n), r2 = new Float64Array(n), cnt = new Float64Array(n);
    const vm = [0, 0], vp = [0, 0];

    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const id = crust.plate[i];
      const p = plates.get(id);
      if (!p || !p.alive) continue;
      this.velAt(crust.x[i], crust.y[i], vm);
      p.velAtU(crust.ux[i], crust.uy[i], vp);
      const dvx = vm[0] - vp[0], dvy = vm[1] - vp[1];
      fx[id] += dvx; fy[id] += dvy;
      const rx = crust.ux[i] - p.ucx, ry = crust.uy[i] - p.ucy;
      tq[id] += rx * dvy - ry * dvx;
      r2[id] += rx * rx + ry * ry;
      cnt[id]++;
    }

    for (const p of plates.alive()) {
      const k = cnt[p.id] > 0 ? 1 / cnt[p.id] : 0;
      p.basalX = fx[p.id] * k;
      p.basalY = fy[p.id] * k;
      p.basalTorque = r2[p.id] > 1 ? tq[p.id] / r2[p.id] : 0;
    }
  }
}
