import { KIND } from './boundaries.js';
import { wrapPos } from '../core/torus.js';
import { negativeBuoyancy } from './motion.js';

// Subduction zones are explicit, persistent kinematic objects. Two things
// depend on that:
//
//  * Polarity. Which plate goes down is scored once at initiation and then
//    locked. Re-scoring every step makes boundaries flip between steps and
//    shreds the slab layer into incoherent fragments.
//  * Rollback. It is a state of the trench hinge, driven by slab negative
//    buoyancy, dip, length, convergence and trench anchoring -- not something
//    to be inferred by comparing a sink rate to a convergence rate.
export class TrenchRegistry {
  constructor() {
    this.zones = new Map();        // faultId -> zone
    this.nextSlabId = 1;
  }

  get(faultId) { return this.zones.get(faultId); }
  *all() { yield* this.zones.values(); }

  // Rebuild the per-step view: which faults are convergent, what their mean
  // properties are. Zones persist across steps by fault ID.
  update(world) {
    const { cfg, boundaries, plates, crust, slabs, t, W, H } = world;

    // Aggregate convergent edges per fault.
    const agg = new Map();
    for (let e = 0; e < boundaries.count; e++) {
      const k = boundaries.kind[e];
      if (k !== KIND.TRENCH && k !== KIND.ISLAND_ARC && k !== KIND.SUTURE) continue;
      if (boundaries.vn[e] >= 0) continue;
      const fid = boundaries.faultId[e];
      if (!fid) continue;
      let a = agg.get(fid);
      if (!a) agg.set(fid, a = {
        fid, len: 0, conv: 0, shear: 0, edges: [],
        plateA: boundaries.plateA[e], plateB: boundaries.plateB[e],
        contA: 0, contB: 0, ageA: 0, ageB: 0, lithoA: 0, lithoB: 0, weak: 0,
        cxAcc: 0, cyAcc: 0, nxAcc: 0, nyAcc: 0, sutureLen: 0,
      });
      const L = boundaries.len[e];
      a.len += L;
      a.conv += -boundaries.vn[e] * L;
      a.shear += Math.abs(boundaries.vt[e]) * L;
      a.edges.push(e);
      const ia = boundaries.ptA[e], ib = boundaries.ptB[e];
      a.contA += crust.continental[ia] * L; a.contB += crust.continental[ib] * L;
      a.ageA += crust.age[ia] * L;          a.ageB += crust.age[ib] * L;
      a.lithoA += crust.litho[ia] * L;      a.lithoB += crust.litho[ib] * L;
      a.weak += 0.5 * (crust.weakness[ia] + crust.weakness[ib]) * L;
      // Circular accumulation of the trench trace position.
      a.cxAcc += Math.cos(boundaries.mx[e] / W * 2 * Math.PI) * L;
      a.cyAcc += Math.sin(boundaries.mx[e] / W * 2 * Math.PI) * L;
      a.nxAcc += boundaries.nx[e] * L; a.nyAcc += boundaries.ny[e] * L;
      if (k === KIND.SUTURE) a.sutureLen += L;
    }

    const alive = new Set();
    for (const a of agg.values()) {
      // A one- or two-edge fragment is noise, not a subduction zone. Giving it
      // its own slab ID and its own locked polarity is how the slab layer gets
      // shredded into incoherent pieces.
      if (a.len < world.spacing * 2.5) continue;
      const inv = 1 / Math.max(1e-6, a.len);
      a.conv *= inv; a.shear *= inv;
      a.contA *= inv; a.contB *= inv; a.ageA *= inv; a.ageB *= inv;
      a.lithoA *= inv; a.lithoB *= inv; a.weak *= inv;
      let nx = a.nxAcc * inv, ny = a.nyAcc * inv;
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;

      let z = this.zones.get(a.fid);
      if (!z) {
        z = this._initiate(world, a, nx, ny);
        this.zones.set(a.fid, z);
      } else if (!z.polarityLocked || (t - z.polarityTime) > cfg.polarityReviewInterval) {
        // Re-evaluate only on what amounts to a reorganisation: the plates on
        // either side changed, or a long interval has elapsed.
        if (z.plateA !== a.plateA || z.plateB !== a.plateB) {
          const fresh = this._initiate(world, a, nx, ny);
          fresh.slabId = z.slabId;
          this.zones.set(a.fid, z = fresh);
        } else {
          z.polarityTime = t;
        }
      }

      z.lastSeen = t;
      z.length = a.len;
      z.convergence = a.conv;
      z.shear = a.shear;
      z.normX = nx; z.normY = ny;
      z.isCollision = a.sutureLen > a.len * 0.5;
      z.edges = a.edges;
      z.agg = a;
      alive.add(a.fid);
    }

    // Retire zones whose fault has gone.
    for (const [fid, z] of this.zones) {
      if (!alive.has(fid) && t - z.lastSeen > 3) this.zones.delete(fid);
    }

    this._updateHinges(world);
  }

  // Polarity scoring. Ocean-under-continent is deterministic. Ocean-ocean is
  // probabilistic: age dominates, but boundary weakness, lithospheric
  // thickness, convergence and a small random term all contribute, so the sim
  // does not lock into "older always wins" everywhere.
  _initiate(world, a, nx, ny) {
    const { cfg, rng, t } = world;
    const CT = 0.4;
    const contA = a.contA > CT, contB = a.contB > CT;
    let down, over, scoreA = 0, scoreB = 0, mode;

    if (contA && contB) {
      down = -1; over = -1; mode = 'collision';
    } else if (contA !== contB) {
      down = contA ? a.plateB : a.plateA;         // ocean subducts, always
      over = contA ? a.plateA : a.plateB;
      mode = 'oceanic-continental';
    } else {
      const norm = (v, s) => Math.min(1, v / s);
      scoreA = cfg.polarityAgeWeight * norm(a.ageA, 160)
             + cfg.polarityLithoWeight * norm(a.lithoA, cfg.lithoOceanMax)
             + cfg.polarityWeaknessWeight * a.weak * (rng.next() - 0.5)
             + cfg.polarityNoise * (rng.next() - 0.5) * 2;
      scoreB = cfg.polarityAgeWeight * norm(a.ageB, 160)
             + cfg.polarityLithoWeight * norm(a.lithoB, cfg.lithoOceanMax)
             + cfg.polarityWeaknessWeight * a.weak * (rng.next() - 0.5)
             + cfg.polarityNoise * (rng.next() - 0.5) * 2;
      down = scoreA > scoreB ? a.plateA : a.plateB;
      over = scoreA > scoreB ? a.plateB : a.plateA;
      mode = 'oceanic-oceanic';
    }

    return {
      faultId: a.fid, plateA: a.plateA, plateB: a.plateB,
      downgoing: down, overriding: over, mode,
      polarityLocked: true, polarityTime: t, scoreA, scoreB,
      slabId: this.nextSlabId++,
      birth: t, lastSeen: t,
      length: a.len, convergence: a.conv, shear: 0,
      normX: nx, normY: ny,
      trenchX: 0, trenchY: 0, trenchVx: 0, trenchVy: 0,
      hingeX: 0, hingeY: 0,
      rollbackRate: 0, dip: world.cfg.slabDipInit,
      meanAgeAtSub: 0, negBuoy: 0, slabLength: 0,
      collisionClosure: 0, isCollision: false,
      edges: [], agg: null,
    };
  }

  // Trench position, trench velocity, hinge and rollback rate.
  _updateHinges(world) {
    const { cfg, plates, slabs, boundaries, W, H } = world;

    // Per-slab aggregates for buoyancy and length.
    const slabAgg = new Map();
    for (let i = 0; i < slabs.n; i++) {
      if (!slabs.alive[i]) continue;
      const id = slabs.slabId[i];
      let s = slabAgg.get(id);
      if (!s) slabAgg.set(id, s = { nb: 0, n: 0, maxAlong: 0, dip: 0, age: 0, maxDepth: 0 });
      s.nb += negativeBuoyancy(cfg, slabs, i);
      s.dip += slabs.dip[i];
      s.age += slabs.ageAtSub[i];
      s.n++;
      if (slabs.along[i] > s.maxAlong) s.maxAlong = slabs.along[i];
      if (slabs.depth[i] > s.maxDepth) s.maxDepth = slabs.depth[i];
    }

    const vOver = [0, 0], vDown = [0, 0];
    for (const z of this.zones.values()) {
      if (!z.edges || z.edges.length === 0) continue;

      // Representative trench position: length-weighted circular mean of the
      // convergent edge midpoints.
      let ax = 0, ay = 0, bx = 0, by = 0, wsum = 0;
      for (const e of z.edges) {
        const L = boundaries.len[e];
        const pa = (boundaries.mx[e] / W) * Math.PI * 2;
        const pb = (boundaries.my[e] / H) * Math.PI * 2;
        ax += Math.cos(pa) * L; ay += Math.sin(pa) * L;
        bx += Math.cos(pb) * L; by += Math.sin(pb) * L;
        wsum += L;
      }
      z.trenchX = wrapPos(Math.atan2(ay, ax) / (Math.PI * 2) * W, W);
      z.trenchY = wrapPos(Math.atan2(by, bx) / (Math.PI * 2) * H, H);

      const s = slabAgg.get(z.slabId);
      z.negBuoy = s && s.n ? s.nb / s.n : 0;
      z.dip = s && s.n ? s.dip / s.n : cfg.slabDipInit;
      z.meanAgeAtSub = s && s.n ? s.age / s.n : 0;
      z.slabLength = s ? s.maxAlong : 0;
      z.slabMaxDepth = s ? s.maxDepth : 0;

      const over = plates.get(z.overriding), down = plates.get(z.downgoing);
      if (!over || !over.alive || !down || !down.alive) { z.rollbackRate = 0; continue; }
      over.velAtWorld(z.trenchX, z.trenchY, W, H, vOver);
      down.velAtWorld(z.trenchX, z.trenchY, W, H, vDown);

      // Oceanward normal: points from the overriding plate toward the
      // downgoing one.
      let ox = z.normX, oy = z.normY;
      if (z.overriding === z.plateB) { ox = -ox; oy = -oy; }

      // Trench anchoring: an overriding plate advancing on the trench resists
      // hinge retreat; one retreating from it lets the hinge go.
      const advance = vOver[0] * ox + vOver[1] * oy;
      const lengthFactor = Math.min(1, z.slabLength / cfg.rollbackLengthRef);
      const target = cfg.rollbackBuoyGain * z.negBuoy * 100
                   * (0.35 + cfg.rollbackDipGain * Math.sin(z.dip))
                   * lengthFactor
                   - cfg.rollbackAnchorGain * advance;

      z.rollbackRate += (target - z.rollbackRate) * cfg.trenchSmoothing;

      // Trench velocity = overriding plate motion plus hinge retreat, which is
      // oceanward (positive rollback) or advancing (negative).
      z.trenchVx = vOver[0] + ox * z.rollbackRate;
      z.trenchVy = vOver[1] + oy * z.rollbackRate;

      // The hinge sits a short way oceanward of the trench trace.
      z.hingeX = wrapPos(z.trenchX + ox * 40, W);
      z.hingeY = wrapPos(z.trenchY + oy * 40, H);
      z.oceanX = ox; z.oceanY = oy;
    }
  }
}
