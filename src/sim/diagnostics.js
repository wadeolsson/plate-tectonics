import { KIND } from './boundaries.js';
import { wrapPos } from '../core/torus.js';

// ---------------------------------------------------------------------------
// Mass ledger
// ---------------------------------------------------------------------------
// Crust and slab volumes are tracked against an explicit ledger of sources and
// sinks. Subduction and the accretionary wedge are transfers, not sources, so
// they must not move the total. A conservation error that starts creeping is
// the earliest warning that a long run is going wrong.
export function newBudget() {
  return {
    initial: 0,
    created: 0,       // magma: ridges, arcs, slab-driven uplift
    destroyed: 0,     // thinning: rifts, back-arc extension
    toSlab: 0,        // transfer, crust -> slab
    slabRetired: 0,   // slab leaving the model at 660 km
    lost: 0,          // volume that hit the orogenic-root cap
    regrid: 0,        // numerical, from point insertion and merging
    lostBy: {},       // which pipeline stage discarded it
  };
}

export function auditMass(world) {
  const { crust, slabs, pointArea, budget } = world;
  let vc = 0, vs = 0, contArea = 0;
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    vc += crust.thickness[i];
    contArea += crust.continental[i];
  }
  vc *= pointArea; contArea *= pointArea;
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i]) continue;
    vs += slabs.thickness[i];
  }
  vs *= pointArea;

  const expected = budget.initial + budget.created + budget.regrid
                 - budget.destroyed - budget.slabRetired - budget.lost;
  const actual = vc + vs;
  return {
    crustVolume: vc,
    slabVolume: vs,
    continentalArea: contArea,
    expected, actual,
    error: actual - expected,
    relError: expected > 0 ? (actual - expected) / expected : 0,
  };
}

// ---------------------------------------------------------------------------
// Earthquakes -- diagnostic only
// ---------------------------------------------------------------------------
// Events from boundary stress x slip rate x weakness x fault type. On the map
// they are dots; in cross-section they are a Wadati-Benioff zone, which
// validates slab geometry directly.
export class QuakeLog {
  constructor(cap) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.depth = new Float32Array(cap);
    this.mag = new Float32Array(cap);
    this.t = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.head = 0; this.n = 0;
  }
  push(x, y, depth, mag, t, kind) {
    const i = this.head;
    this.x[i] = x; this.y[i] = y; this.depth[i] = depth;
    this.mag[i] = mag; this.t[i] = t; this.kind[i] = kind;
    this.head = (i + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  *recent(now, window) {
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - 1 - k + this.cap) % this.cap;
      if (now - this.t[i] > window) continue;
      yield i;
    }
  }
}

const KIND_SEISMICITY = [0.45, 0.5, 1.0, 0.9, 0.85, 0.8];  // by KIND

export function generateQuakes(world) {
  const { cfg, boundaries, crust, slabs, slabHash, quakes, rng, t, W, H } = world;
  const dt = cfg.dt;

  for (let e = 0; e < boundaries.count; e++) {
    const rate = boundaries.rate[e];
    if (rate < 2) continue;
    const L = boundaries.len[e];
    const weak = 0.5 * (crust.weakness[boundaries.ptA[e]] + crust.weakness[boundaries.ptB[e]]);
    const k = boundaries.kind[e];
    // Weak faults slip aseismically; strong, fast, locked ones do not.
    const lambda = cfg.quakeRate * (L / 1000) * (rate / 50) * KIND_SEISMICITY[k]
                 * (1.25 - 0.75 * weak) * dt;
    let n = Math.floor(lambda);
    if (rng.next() < lambda - n) n++;
    if (n > 6) n = 6;

    for (let q = 0; q < n; q++) {
      const s = rng.next();
      const x = wrapPos(boundaries.ax[e] + (boundaries.bx[e] - boundaries.ax[e]) * s + rng.normal(0, 18), W);
      const y = wrapPos(boundaries.ay[e] + (boundaries.by[e] - boundaries.ay[e]) * s + rng.normal(0, 18), H);
      let depth;
      if (k === KIND.TRENCH || k === KIND.ISLAND_ARC) {
        // Sample the slab beneath so the hypocentres trace the real geometry.
        const cands = [];
        slabHash.forEachInRadius(x, y, world.spacing * 4, (si) => cands.push(si));
        depth = cands.length
          ? slabs.depth[cands[(rng.next() * cands.length) | 0]] + rng.normal(0, 12)
          : rng.float(5, 40);
      } else if (k === KIND.SUTURE) {
        depth = Math.abs(rng.normal(0, 45));
      } else {
        depth = Math.abs(rng.normal(0, 12)) + 2;
      }
      const mag = 4.2 + 2.6 * Math.pow(rng.next(), 2.2) + 0.5 * (rate / 100);
      quakes.push(x, y, Math.max(0, depth), mag, t, k);
    }
  }
}
