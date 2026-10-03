import { KIND } from './boundaries.js';
import { wrapPos, wrapDelta } from '../core/torus.js';
import { smoothstep } from './elevation.js';
import { applyThickness, deform } from './crustops.js';
import { ROCK, rockFor, pushTop, scaleColumn, initColumn, readColumn, stackLayers } from './rocks.js';
import { supplyMelt } from './magma.js';

// ---------------------------------------------------------------------------
// Divergent -- accretion
// ---------------------------------------------------------------------------
// Walk each active ridge segment and seed symmetrically about the spreading
// axis. Area created per step is exactly length * rate * dt, which keeps the
// point cloud area-conserving instead of relying on gap detection.
//
// Ridge topography is not drawn anywhere: it emerges from the age-depth
// relation in the elevation model.
export function accrete(world) {
  const { cfg, crust, plates, boundaries, segments, rng, W, H, pointArea } = world;
  const dt = cfg.dt;
  world.accretedPts = 0; world.accretedArea = 0; world.riftArea = 0;

  // Index the active segments by the fault they belong to. The staircase
  // decides WHERE crust appears and which segment ID stamps it; how MUCH
  // appears is taken straight from the opening integral below, so the area
  // budget closes exactly regardless of how well the staircase approximates
  // the trace.
  const byFault = new Map();
  for (const seg of segments.active()) {
    if (seg.rate <= 0.3 || seg.length < 5) continue;
    let l = byFault.get(seg.faultId);
    if (!l) byFault.set(seg.faultId, l = []);
    l.push(seg);
  }

  for (const f of boundaries.faults) {
    // Area opened this step is the integral of the normal velocity along the
    // boundary: exactly what the convergent side consumes elsewhere.
    let oceanArea = 0, contArea = 0;
    const openEdges = [];
    const segs = byFault.get(f.id);
    const brokeUp = segs ? segs.some((s) => s.brokeUp) : false;
    for (const e of f.edges) {
      const vn = boundaries.vn[e];
      if (vn <= 0) continue;
      const a = vn * boundaries.len[e] * dt;
      const meanCont = 0.5 * (boundaries.contA[e] + boundaries.contB[e]);
      // Continental lithosphere that has not reached breakup stretches and
      // thins rather than making ocean floor; rifting.js owns that area.
      const oceanW = brokeUp ? 1 : 1 - smoothstep(0.30, 0.62, meanCont);
      oceanArea += a * oceanW;
      contArea += a * (1 - oceanW);
      openEdges.push(e);
    }
    world.riftArea += contArea;
    if (oceanArea <= 0 || !openEdges.length) continue;
    world.accretedArea += oceanArea;

    if (segs && segs.length) {
      let total = 0;
      for (const seg of segs) total += seg.length;
      if (total > 0) {
        for (const seg of segs) {
          // Accumulate until the new strip is at least a point spacing wide.
          // Releasing every step would stack points in a line along the axis
          // and the density pass would immediately merge them back out.
          seg.pending = (seg.pending || 0) + oceanArea * (seg.length / total);
          const width = seg.pending / Math.max(1, seg.length);
          if (width < world.spacing * 0.9) continue;
          seg.pending = seedOnSegment(world, seg, seg.pending, width);
        }
        continue;
      }
    }
    // No staircase for this fault (too short, or nearly parallel to the
    // spreading direction). Seed along the opening edges themselves.
    let total = 0;
    for (const e of openEdges) total += boundaries.vn[e] * boundaries.len[e];
    const pend = (world.faultPending.get(f.id) || 0) + oceanArea;
    const width = pend / Math.max(1, f.length);
    if (width < world.spacing * 0.9) { world.faultPending.set(f.id, pend); continue; }
    world.faultPending.set(f.id, 0);
    for (const e of openEdges) {
      seedOnEdge(world, e, pend * (boundaries.vn[e] * boundaries.len[e]) / total, width);
    }
  }
  world.budget.created += world.accretedPts * cfg.thickOcean * pointArea;
}

function countFor(rng, area, pointArea) {
  const want = area / pointArea;
  let n = Math.floor(want);
  if (rng.next() < want - n) n++;
  return n;
}

// Seed symmetrically about a spreading axis. New crust is laid down on a
// stratified lattice inside the strip rather than at uniformly random
// positions: random placement clusters, and every cluster is a merge the
// density pass then has to undo, which quietly bleeds points out of the run.
//
// Age is zero at the axis and grows outward. Ridge topography is never drawn;
// it comes out of the age-depth relation applied to these ages.
function seedOnSegment(world, seg, area, width) {
  const { cfg, plates, rng, W, H, pointArea, spacing } = world;
  const dt = cfg.dt;
  const A = plates.get(seg.plateA), B = plates.get(seg.plateB);
  if (!A || !A.alive || !B || !B.alive) return area;
  let rejected = 0;

  const va = [0, 0], vb = [0, 0];
  const mx = wrapPos(seg.x0 + wrapDelta(seg.x1 - seg.x0, W) * 0.5, W);
  const my = wrapPos(seg.y0 + wrapDelta(seg.y1 - seg.y0, H) * 0.5, H);
  A.velAtWorld(mx, my, W, H, va);
  B.velAtWorld(mx, my, W, H, vb);
  const ua = va[0] * seg.dirX + va[1] * seg.dirY;
  const ub = vb[0] * seg.dirX + vb[1] * seg.dirY;
  const minusPlate = ua < ub ? A : B;
  const plusPlate = ua < ub ? B : A;

  const ex = wrapDelta(seg.x1 - seg.x0, W), ey = wrapDelta(seg.y1 - seg.y0, H);
  lattice(world, area, width, (s, off, side) => {
    const bx = seg.x0 + ex * s, by = seg.y0 + ey * s;
    const ok = spawnOcean(world,
      bx + seg.dirX * off * side, by + seg.dirY * off * side,
      side < 0 ? minusPlate : plusPlate,
      off / Math.max(1e-3, seg.rate * 0.5), seg.id);
    if (!ok) rejected += pointArea;
  });
  return rejected;
}

function seedOnEdge(world, e, area, width) {
  const { plates, boundaries, W, H } = world;
  const A = plates.get(boundaries.plateA[e]), B = plates.get(boundaries.plateB[e]);
  if (!A || !A.alive || !B || !B.alive) return;
  const nx = boundaries.nx[e], ny = boundaries.ny[e];
  const ex = wrapDelta(boundaries.bx[e] - boundaries.ax[e], W);
  const ey = wrapDelta(boundaries.by[e] - boundaries.ay[e], H);
  lattice(world, area, width, (s, off, side) => {
    const bx = boundaries.ax[e] + ex * s, by = boundaries.ay[e] + ey * s;
    spawnOcean(world, bx + nx * off * side, by + ny * off * side, side < 0 ? A : B,
      off / Math.max(1e-3, boundaries.vn[e] * 0.5), 0);
  });
}

// Walk a stratified lattice across the accretion strip: `rows` rows of points
// on each side of the axis, stratified along it, jittered by well under the
// point spacing.
function lattice(world, area, width, place) {
  const { rng, pointArea, spacing } = world;
  const n = area / pointArea;
  if (n <= 0) return;
  const halfW = Math.max(spacing * 0.5, width * 0.5);
  const rows = Math.max(1, Math.round(halfW / spacing));
  const perSide = n * 0.5;
  const perRow = perSide / rows;
  for (const side of [-1, 1]) {
    for (let r = 0; r < rows; r++) {
      const off = ((r + 0.5) / rows) * halfW;
      let count = Math.floor(perRow);
      if (rng.next() < perRow - count) count++;
      if (count <= 0) continue;
      const stagger = (r % 2 ? 0.5 : 0) + (side < 0 ? 0.25 : 0);
      for (let k = 0; k < count; k++) {
        const s = ((k + stagger + rng.float(-0.18, 0.18)) % count + count) % count / count;
        place(s, off * (1 + rng.float(-0.12, 0.12)), side);
      }
    }
  }
}

function spawnOcean(world, x, y, plate, age, segmentId) {
  const { cfg, crust, plates, crustHash, W, H } = world;
  // The staircase axis is an approximation of the boundary trace and can sit a
  // jog-length inside existing crust. Seeding there produces a pair the
  // density pass immediately merges back out, so refuse the spot instead.
  const wx = wrapPos(x, W), wy = wrapPos(y, H);
  if (crustHash.nearest(wx, wy, world.spacing * 0.62) >= 0) return false;
  const i = crust.spawn({
    x: wx, y: wy,
    plate: plate.id,
    continental: 0,
    thickness: cfg.thickOcean,
    litho: Math.max(3, cfg.lithoOceanCoef * Math.sqrt(Math.max(0, age))),
    age,
    defAge: age,
    segment: segmentId,   // stamped once, never reassigned: this is what makes
    weakness: 0.10,       // fracture zones fall out for free
  });
  plates.reframe(crust, i, plate.id, W, H);
  initColumn(crust, i, cfg.thickOcean, 0, age);
  world.accretedPts++;
  return true;
}

// ---------------------------------------------------------------------------
// Convergent -- subduction
// ---------------------------------------------------------------------------
export function subduct(world) {
  world.subductedPts = 0; world.subductedArea = 0;
  const { cfg, crust, slabs, plates, boundaries, trenches, crustHash, rng, t, W, H, pointArea } = world;
  const dt = cfg.dt;
  const CT = 0.4;

  for (const z of trenches.all()) {
    if (z.isCollision || z.downgoing < 0) continue;
    const down = plates.get(z.downgoing), over = plates.get(z.overriding);
    if (!down || !down.alive || !over || !over.alive) continue;

    for (const e of z.edges) {
      const conv = -boundaries.vn[e];
      if (conv <= 0) continue;
      const L = boundaries.len[e];
      let budget = L * conv * dt;               // area to consume, km^2
      if (budget <= 0) continue;
      world.subductedArea += budget;

      const mx = boundaries.mx[e], my = boundaries.my[e];
      // Downdip direction: from the downgoing plate toward the overriding one.
      let dx = boundaries.nx[e], dy = boundaries.ny[e];
      if (boundaries.plateA[e] === z.downgoing) { /* n points A->B = down->over */ }
      else { dx = -dx; dy = -dy; }

      const searchR = world.spacing * 3.0;
      const cands = [];
      crustHash.forEachInRadius(mx, my, searchR, (p, d2) => {
        if (!crust.alive[p] || crust.plate[p] !== z.downgoing) return;
        cands.push([d2, p]);
      });
      if (!cands.length) continue;
      cands.sort((a, b) => a[0] - b[0]);

      const dip = slabDipFor(world, z, crust, cands[0][1]);
      z.jamming = z.jamming || 0;
      for (const [, p] of cands) {
        if (budget <= 0) break;
        if (!crust.alive[p]) continue;
        budget -= pointArea;
        const thick = crust.thickness[p];
        const contFrac = crust.continental[p];
        // Continental crust is too buoyant to go down. Arriving at a trench it
        // jams the zone: the convergence is taken up as shortening instead,
        // which is how a subduction zone turns into a collision.
        if (contFrac > cfg.subductBuoyancyLimit) {
          jamTrench(world, p, mx, my, z);
          continue;
        }
        const wedgeVol = thick * pointArea * cfg.wedgeFraction;
        const downVol = thick * pointArea - wedgeVol;

        // The subducted point becomes a slab point -- do not simply delete it,
        // the slab layer is a core feature.
        slabs.spawn({
          x: crust.x[p], y: crust.y[p],
          dip,
          ageAtSub: crust.age[p],
          continental: contFrac,
          thickness: downVol / pointArea,
          litho: crust.litho[p],
          parentPlate: z.downgoing,
          dirX: dx, dirY: dy,
          birth: t,
          slabId: z.slabId,
          vdd: Math.max(4, conv),
        });
        crust.kill(p);
        world.budget.toSlab += downVol;

        // Accretionary wedge: an explicit, mass-conserving transfer to the
        // overriding plate, falling off with distance from the trench.
        depositWedge(world, mx, my, z.overriding, wedgeVol, contFrac);
      }
    }

    if (z.collisionClosure > cfg.sutureConvergence) {
      const A = plates.get(z.plateA), B = plates.get(z.plateB);
      if (A && A.alive && B && B.alive) sutureplates(world, A, B);
      z.collisionClosure = 0;
    }
  }
}

// Convergence that cannot be subducted is absorbed by shortening: the point is
// consumed and its crustal volume -- continental fraction included -- goes to
// its neighbours.
function jamTrench(world, p, mx, my, z) {
  const { cfg, crust, crustHash, pointArea } = world;
  const R = cfg.collisionRange * world.spacing;
  if (!crust.alive[p]) return;
  const vol = crust.thickness[p] * pointArea;
  const contVol = vol * crust.continental[p];
  const plate = crust.plate[p];
  crust.kill(p);

  const idx = [], wts = [];
  let wsum = 0;
  crustHash.forEachInRadius(mx, my, R, (q, d2) => {
    if (!crust.alive[q]) return;
    if (crust.plate[q] !== plate && crust.plate[q] !== z.overriding) return;
    const w = Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
    idx.push(q); wts.push(w); wsum += w;
  });
  if (wsum <= 0) { world.budget.lost += vol; return; }
  spreadVolume(world, mx, my, R, vol, contVol,
    (q) => crust.plate[q] === plate || crust.plate[q] === z.overriding,
    contVol / Math.max(1e-9, vol));
  for (let k = 0; k < idx.length; k++) {
    const q = idx[k];
    if (!crust.alive[q]) continue;
    crust.weakness[q] = Math.min(1, crust.weakness[q] + cfg.weakCollision * 0.03 * cfg.dt);
    deform(crust, q, 0.06);
  }
  // Jamming is incipient collision. Counting it toward the same closure
  // budget is what lets an arriving continent eventually weld the two plates
  // and stop the convergence. Without it the trench grinds away at the margin
  // indefinitely and the continent is slowly milled into a narrow, absurdly
  // over-thickened ribbon.
  z.collisionClosure += cfg.jamClosureGain * pointArea / Math.max(1, z.length);
  z.jamming = (z.jamming || 0) + 1;
}

function slabDipFor(world, z, crust, samplePoint) {
  const { cfg } = world;
  // Young, buoyant downgoing crust starts shallow; old cold crust starts steep.
  const age = crust.age[samplePoint];
  const f = smoothstep(cfg.flatSlabAgeMax, 120, age);
  return cfg.slabDipInit * (0.55 + 0.9 * f);
}

// Mass-conserving transfer of crustal volume into a neighbourhood, with the
// continental content carried along. Whatever will not fit under the orogenic
// cap is pushed out to a wider ring rather than discarded; only what survives
// three passes is booked as a loss.
// `rInner` excludes a core region from receiving. Extension needs this: the
// volume thinned out of a rift axis has to go somewhere, but putting it back
// on the axis would undo the thinning. It belongs on the shoulders.
export function spreadVolume(world, mx, my, R0, volume, contVolume, accept, contRef, rockType, rInner = 0) {
  const { cfg, crust, crustHash, pointArea } = world;
  let vol = volume, cvol = contVolume;
  // contRef biases the transfer toward crust of similar composition. Without
  // it, continental volume leaks steadily onto oceanic neighbours and after a
  // few hundred Myr there are no continents left, only a wide band of
  // half-continental mush sitting below sea level.
  const ref = contRef === undefined ? -1 : contRef;
  for (let pass = 0; pass < 3 && vol > 1e-6; pass++) {
    const R = R0 * (1 + pass);
    const idx = [], wts = [];
    let wsum = 0;
    // Two sweeps: first only crust of similar composition, then anything.
    // A soft weighting is not enough -- oceanic points outnumber continental
    // ones so heavily that even a small residual weight bleeds continental
    // volume into the sea floor, and after a few hundred Myr the continents
    // have been smeared into a uniform half-continental wash.
    for (const strict of (ref >= 0 ? [true, false] : [false])) {
      crustHash.forEachInRadius(mx, my, R, (p, d2) => {
        if (!crust.alive[p] || !accept(p)) return;
        if (rInner > 0 && d2 < rInner * rInner) return;
        if (crust.thickness[p] >= cfg.thickHardCap - 1e-6) return;
        if (strict && Math.abs(crust.continental[p] - ref) > 0.3) return;
        const w = Math.exp(-d2 / (2 * (R * 0.45) * (R * 0.45)));
        idx.push(p); wts.push(w); wsum += w;
      });
      if (wsum > 0) break;
      idx.length = 0; wts.length = 0;
    }
    if (wsum <= 0) break;
    let placed = 0, cplaced = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const f = wts[k] / wsum;
      const want = vol * f;
      const dThick = want / pointArea;
      const before = crust.thickness[p];
      const after = Math.min(cfg.thickHardCap, before + dThick);
      const gained = after - before;
      if (gained <= 0) continue;
      const cShare = (cvol * f) * (gained / Math.max(1e-9, dThick));
      // Composition of the material actually placed, as a fraction.
      const addFelsic = Math.min(1, cShare / Math.max(1e-9, gained * pointArea));
      pushTop(crust, p, gained, rockType !== undefined ? rockType : rockFor(addFelsic),
        addFelsic, world.t);
      placed += gained * pointArea;
      cplaced += cShare;
    }
    vol -= placed; cvol -= cplaced;
  }
  if (vol > 0) {
    // Volume that could not be placed anywhere under the hard thickness cap.
    // Attributed to the stage that produced it, because a growing entry here
    // names the process that is leaking.
    world.budget.lost += vol;
    const k = world.stage || 'other';
    world.budget.lostBy[k] = (world.budget.lostBy[k] || 0) + vol;
  }
}

function depositWedge(world, mx, my, overPlate, volume, contFrac) {
  const { cfg, crust, crustHash, pointArea } = world;
  const R = cfg.wedgeRange * world.spacing;
  // What an accretionary prism is made of: sediment off the trench floor and
  // slivers of the downgoing basalt, scraped off and piled against the margin.
  spreadVolume(world, mx, my, R, volume, volume * contFrac,
    (p) => crust.plate[p] === overPlate, undefined, ROCK.SEDIMENT);
  // The toe of the wedge is structurally weak. Composition is not touched
  // here: spreadVolume already mixed the scraped-off material in by volume.
  crustHash.forEachInRadius(mx, my, R, (p) => {
    if (!crust.alive[p] || crust.plate[p] !== overPlate) return;
    // Per subducted point, not per Myr: this fires many times a step along a
    // busy margin, so the increment has to be small or the whole forearc
    // saturates and the contrast rift nucleation depends on is destroyed.
    crust.weakness[p] = Math.min(1, crust.weakness[p] + 0.0025);
    deform(crust, p, 0.02);
  });
}

// ---------------------------------------------------------------------------
// Volcanic arcs
// ---------------------------------------------------------------------------
// The arc sits where the slab reaches roughly 100 km -- a target with local
// variation, not a threshold test; real arcs span about 65-130 km. Querying
// the slab layer for this rather than hardcoding an inland distance is what
// makes flat-slab arc migration work for free.
export function volcanicArcs(world) {
  const { cfg, crust, slabs, slabHash, plates, W, H } = world;
  const dt = cfg.dt;
  const R = cfg.arcWidth * world.spacing;
  const lo = cfg.arcSlabDepthLo, hi = cfg.arcSlabDepthHi, target = cfg.arcSlabDepth;
  const sigma = (hi - lo) * 0.28;

  // Most of the map has no slab under it. Skipping those points with a cheap
  // cell test first turns this from a hash query per crust point into a hash
  // query per crust point that might actually be over an arc.
  const gnx = slabHash.nx, gny = slabHash.ny;
  const has = new Uint8Array(gnx * gny);
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i] || slabs.depth[i] < lo - 40 || slabs.depth[i] > hi + 40) continue;
    has[slabHash.cellY(slabs.y[i]) * gnx + slabHash.cellX(slabs.x[i])] = 1;
  }
  const near = (x, y) => {
    const gx = slabHash.cellX(x), gy = slabHash.cellY(y);
    for (let dy = -1; dy <= 1; dy++) {
      const yy = ((gy + dy) % gny + gny) % gny;
      for (let dx = -1; dx <= 1; dx++) {
        if (has[yy * gnx + (((gx + dx) % gnx + gnx) % gnx)]) return true;
      }
    }
    return false;
  };

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    if (!near(crust.x[i], crust.y[i])) continue;
    let w = 0;
    slabHash.forEachInRadius(crust.x[i], crust.y[i], R, (s, d2) => {
      if (!slabs.alive[s] || slabs.parentPlate[s] === crust.plate[i]) return;  // own slab, not an arc
      const d = slabs.depth[s];
      if (d < lo || d > hi) return;
      const dz = (d - target) / sigma;
      w += Math.exp(-0.5 * dz * dz) * Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
    });
    if (w <= 0) continue;
    const g = Math.min(1.5, w * 0.28);
    const add = cfg.arcThicknessRate * g * dt;
    // Arcs manufacture continental crust, but they do it by ADDING andesitic
    // magma, so the composition change has to ride on the volume change.
    // Raising `continental` independently of thickness invents continental
    // material and, because the arc band sweeps across the overriding plate,
    // paints a thin wash of it over the whole ocean.
    // Arc magma differentiates. The andesite erupts and builds the volcanic
    // edifice; the complementary granite never reaches the surface and freezes
    // in the middle crust. Emplacing it all on top would bury the volcanics
    // under their own plutons, which is the wrong way round -- and it is the
    // granite, not the lava, that makes this crust continental.
    // Supplied to a chamber, not emplaced on the spot. magma.js decides what
    // erupts and what freezes, and over how long.
    supplyMelt(world, i, add, cfg.arcMagmaContinental, cfg.arcPlutonDepth);
    crust.weakness[i] = Math.min(1, crust.weakness[i] + cfg.weakArc * 0.02 * g * dt);
    deform(crust, i, Math.min(0.9, 0.35 * g * dt));
    world.arcActivity += g;
  }
}

// ---------------------------------------------------------------------------
// Continental collision -- suture
// ---------------------------------------------------------------------------
// Neither side subducts. Convergence is taken up as shortening: points in the
// collision zone are consumed and their crustal volume redistributed into the
// survivors, which conserves mass and simultaneously keeps the point cloud
// from piling up in the orogen.
export function collide(world) {
  const { cfg, crust, plates, boundaries, trenches, crustHash, W, H, pointArea } = world;
  const dt = cfg.dt;
  world.collidedPts = 0;

  for (const z of trenches.all()) {
    if (!z.isCollision) continue;
    const A = plates.get(z.plateA), B = plates.get(z.plateB);
    if (!A || !A.alive || !B || !B.alive) continue;

    // Work per zone, not per edge. Adjacent edges share a neighbourhood, so
    // consuming per edge counts the same points several times -- inventing
    // volume that then cannot be placed anywhere and is written off.
    const R = cfg.collisionRange * world.spacing;
    let budget = 0, closure = 0;
    const openEdges = [];
    for (const e of z.edges) {
      const conv = -boundaries.vn[e];
      if (conv <= 0) continue;
      budget += boundaries.len[e] * conv * dt;
      closure += conv * boundaries.len[e];
      openEdges.push(e);
    }
    if (budget <= 0 || !openEdges.length) continue;

    // Candidate points, nearest-edge distance, deduplicated across the zone.
    const dist = new Map();
    for (const e of openEdges) {
      crustHash.forEachInRadius(boundaries.mx[e], boundaries.my[e], R, (p, d2) => {
        if (!crust.alive[p]) return;
        const pl = crust.plate[p];
        if (pl !== z.plateA && pl !== z.plateB) return;
        const prev = dist.get(p);
        if (prev === undefined || d2 < prev) dist.set(p, d2);
      });
    }
    if (dist.size < 8) continue;
    const near = [...dist.entries()].sort((a, b) => a[1] - b[1]);

    // Shortening: consume the innermost points. Never take more than a share
    // of the zone, or the orogen tears a hole in the cloud. Each consumed
    // column is READ before its point dies, so the rocks themselves can be
    // thrust onto the survivors rather than smeared over them as a bulk
    // composition -- that is the difference between an orogen with a visible
    // nappe stack in section and one that is a uniform thick slab.
    const maxConsume = Math.floor(near.length * 0.35);
    let volume = 0, contVolume = 0, taken = 0;
    const stacks = [];
    for (const [p] of near) {
      if (budget <= 0 || taken >= maxConsume) break;
      if (!crust.alive[p]) continue;
      budget -= pointArea;
      volume += crust.thickness[p] * pointArea;
      contVolume += crust.thickness[p] * crust.continental[p] * pointArea;
      stacks.push(readColumn(crust, p));
      crust.kill(p);
      taken++; world.collidedPts++;
    }
    if (volume <= 0) continue;

    // Thrust the captured columns onto the survivors, spread along the whole
    // suture rather than piled onto one midpoint.
    const receivers = [];
    let wsum = 0;
    for (const [d2, p] of near) {
      if (!crust.alive[p]) continue;
      if (crust.thickness[p] >= cfg.thickHardCap - 1e-6) continue;
      const wgt = Math.exp(-d2 / (2 * (R * 0.55) * (R * 0.55)));
      receivers.push([p, wgt]); wsum += wgt;
    }
    if (wsum <= 0) { world.budget.lost += volume; continue; }
    let placed = 0;
    for (const [p, wgt] of receivers) {
      const f = wgt / wsum;
      const before = crust.thickness[p];
      for (const col of stacks) stackLayers(crust, p, col, f, cfg.thickHardCap);
      placed += (crust.thickness[p] - before) * pointArea;
    }
    // Whatever the thrust stack could not place -- because its receivers were
    // already at the cap -- is pushed out over a wider area as bulk volume
    // instead of being written off. A broad orogen has no internal gradient
    // for gravitational spreading to work with, so without this the middle of
    // a collision zone fills to the cap and the excess is simply discarded.
    if (placed < volume) {
      const rest = volume - placed;
      const restCont = contVolume * (rest / Math.max(1e-9, volume));
      const before2 = world.budget.lost;
      spreadVolume(world, z.trenchX, z.trenchY, R * 2.2, rest, restCont,
        (p) => crust.plate[p] === z.plateA || crust.plate[p] === z.plateB,
        restCont / Math.max(1e-9, rest));
      world.budget.lostBy.collide =
        (world.budget.lostBy.collide || 0) + (world.budget.lost - before2);
    }

    // The collision zone becomes a durable lineament, and the mantle root is
    // removed by shortening and delamination.
    for (const e of openEdges) {
      crustHash.forEachInRadius(boundaries.mx[e], boundaries.my[e], R, (p, d2) => {
        if (!crust.alive[p]) return;
        const pl = crust.plate[p];
        if (pl !== z.plateA && pl !== z.plateB) return;
        const wgt = Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
        crust.weakness[p] = Math.min(1, crust.weakness[p] + cfg.weakCollision * 0.028 * wgt * dt);
        deform(crust, p, Math.min(0.95, 0.45 * wgt * dt));
        crust.litho[p] = Math.min(crust.litho[p], cfg.lithoContNew);
      });
    }

    z.collisionClosure += closure * dt / Math.max(1, z.length);
    // Suturing is half of what generates supercontinent assembly, so the merge
    // is mandatory once enough has closed.
    if (z.collisionClosure > cfg.sutureConvergence) {
      sutureplates(world, A, B);
      z.collisionClosure = 0;
    }
  }
}

export function sutureplates(world, A, B) {
  const { crust, plates, slabs, W, H, t } = world;
  const keep = A.area >= B.area ? A : B;
  const gone = A.area >= B.area ? B : A;
  if (keep.id === gone.id) return;

  // Momentum-weighted average of the two motions.
  const ma = keep.area, mb = gone.area, mt = Math.max(1, ma + mb);
  keep.vx = (keep.vx * ma + gone.vx * mb) / mt;
  keep.vy = (keep.vy * ma + gone.vy * mb) / mt;
  keep.omega = (keep.omega * ma + gone.omega * mb) / mt;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    if (crust.plate[i] === gone.id) plates.reframe(crust, i, keep.id, W, H);
  }
  for (let i = 0; i < slabs.n; i++) {
    if (slabs.alive[i] && slabs.parentPlate[i] === gone.id) slabs.parentPlate[i] = keep.id;
  }
  // Anything holding a plate ID has to be remapped, or every ridge segment and
  // subduction zone on the absorbed plate is orphaned. They then die out and
  // come back with new IDs a few steps later, which silently wipes the history
  // the whole design depends on -- fracture zones included.
  for (const seg of world.segments.segments.values()) {
    if (seg.plateA === gone.id) seg.plateA = keep.id;
    if (seg.plateB === gone.id) seg.plateB = keep.id;
  }
  for (const z of world.trenches.all()) {
    if (z.plateA === gone.id) z.plateA = keep.id;
    if (z.plateB === gone.id) z.plateB = keep.id;
    if (z.downgoing === gone.id) z.downgoing = keep.id;
    if (z.overriding === gone.id) z.overriding = keep.id;
  }
  plates.retire(gone.id, keep.id);
  keep.lastReorg = t;
  plates.recomputeGeometry(crust, W, H, world.pointArea);
  world.events.push({ t, kind: 'suture', text: `plate ${gone.id} welded into ${keep.id}` });
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------
// Nothing created or destroyed, but two cheap effects are worth having: the
// fault trace inherits weakness, and the component of motion normal to a fault
// that is not perfectly parallel to the relative velocity gives transpression
// at restraining bends and transtension at releasing bends -- pull-apart
// basins and pop-up ranges.
export function transformEffects(world) {
  const { cfg, crust, boundaries, crustHash } = world;
  const dt = cfg.dt;
  const R = world.spacing * 1.4;

  for (let e = 0; e < boundaries.count; e++) {
    if (boundaries.kind[e] !== KIND.TRANSFORM) continue;
    const shear = Math.abs(boundaries.vt[e]);
    if (shear < 1) continue;
    const vn = boundaries.vn[e];
    const dThick = cfg.transpressionGain * -vn * dt;   // vn<0 closing -> thicken
    const mx = boundaries.mx[e], my = boundaries.my[e];
    crustHash.forEachInRadius(mx, my, R, (p, d2) => {
      if (!crust.alive[p]) return;
      const w = Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
      crust.weakness[p] = Math.min(1, crust.weakness[p] + cfg.weakTransform * 0.012 * shear / 30 * dt * w);
      // Transpression shortens the crust that is already there, so the
      // material it stacks up has the local composition.
      if (dThick !== 0) applyThickness(world, p, dThick * w, crust.continental[p]);
      deform(crust, p, Math.min(0.5, 0.02 * (shear / 30) * w * dt));
    });
  }
}

// ---------------------------------------------------------------------------
// Gravitational spreading (orogenic collapse)
// ---------------------------------------------------------------------------
// Crust well above the orogenic cap cannot stand: the hot lower crust flows
// laterally. This is not erosion -- no mass leaves the plate, nothing is
// transported downhill by water -- it is the mass-conserving lateral flow that
// turns a needle of over-thickened crust into a plateau, and it is what keeps
// thickening processes from saturating a handful of points.
export function gravitationalSpreading(world) {
  const { cfg, crust, crustHash, pointArea } = world;
  if (!cfg.spreadEnabled) return;
  world.collapseEvents = 0;
  const dt = cfg.dt;
  // Wide enough to see past a plateau. Flow is downhill only, and the interior
  // of a broad orogen has no local gradient at all, so a short reach leaves
  // the middle of it piling up against the thickness cap.
  const R = world.spacing * cfg.spreadRange;
  const donors = [];
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    if (crust.thickness[i] > cfg.spreadThreshold) donors.push(i);
  }
  for (const i of donors) {
    const excess = crust.thickness[i] - cfg.spreadThreshold;
    // Crustal strength falls off sharply with depth and temperature, both of
    // which climb with thickness, so collapse is not linear in the excess --
    // it runs away. Below the limit this is ordinary slow lower-crustal flow;
    // above it the pile is actively failing under its own weight.
    const over = Math.max(0, crust.thickness[i] - cfg.collapseThickness);
    const rate = cfg.spreadRate * (1 + cfg.collapseGain * over * over);
    const move = excess * Math.min(0.6, rate * dt);
    if (move < 1e-4) continue;
    const idx = [], wts = [];
    let wsum = 0;
    crustHash.forEachInRadius(crust.x[i], crust.y[i], R, (p, d2) => {
      if (!crust.alive[p] || p === i) return;
      if (crust.plate[p] !== crust.plate[i]) return;
      const drop = crust.thickness[i] - crust.thickness[p];
      if (drop <= 0) return;                       // flow runs downhill only
      // Lower-crustal flow stays within crust of similar composition. Letting
      // a thick continental root bleed into the oceanic crust next door is how
      // continents dissolve into mush over a few hundred Myr.
      const dc = (crust.continental[p] - crust.continental[i]) / 0.4;
      const w = drop * Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5))) * Math.exp(-dc * dc);
      idx.push(p); wts.push(w); wsum += w;
    });
    // A collision thickens every point in the orogen at once, so in the
    // interior NOBODY has a downhill neighbour and the gradient rule above
    // finds nothing. That is how crust reaches 120 km here when the thickest
    // on Earth is ~80: the pile has no way to shed. Real crust does not get
    // the choice. Past roughly 60 km the lower crust is hot enough to flow,
    // and the orogen's own weight drives it outward whether or not there is a
    // local slope -- this is gravitational collapse, and it is what caps the
    // Himalaya and spread the Basin and Range. So above that limit we fall
    // back to pushing into the THINNEST neighbours regardless of gradient.
    if (wsum <= 0) {
      if (crust.thickness[i] < cfg.collapseThickness) continue;
      let tmax = 0;
      crustHash.forEachInRadius(crust.x[i], crust.y[i], R, (p) => {
        if (!crust.alive[p] || p === i) return;
        if (crust.plate[p] !== crust.plate[i]) return;
        if (crust.thickness[p] > tmax) tmax = crust.thickness[p];
      });
      crustHash.forEachInRadius(crust.x[i], crust.y[i], R, (p, d2) => {
        if (!crust.alive[p] || p === i) return;
        if (crust.plate[p] !== crust.plate[i]) return;
        const dc = (crust.continental[p] - crust.continental[i]) / 0.4;
        const room = tmax - crust.thickness[p] + 1.0;   // +1 so a flat pile still flows
        const w = room * Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5))) * Math.exp(-dc * dc);
        if (w <= 0) return;
        idx.push(p); wts.push(w); wsum += w;
      });
      if (wsum <= 0) continue;
      world.collapseEvents = (world.collapseEvents || 0) + 1;
    }
    const contFrac = crust.continental[i];
    const t0 = crust.thickness[i];
    if (t0 <= move) continue;
    scaleColumn(crust, i, (t0 - move) / t0);
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const f = wts[k] / wsum;
      pushTop(crust, p, move * f, rockFor(contFrac), contFrac, world.t);
    }
  }
}

// ---------------------------------------------------------------------------
// Inherited weakness
// ---------------------------------------------------------------------------
// About twenty lines, and it is the difference between a map history that has
// memory and one that looks randomly regenerated each cycle: new rifts
// preferentially reopen old sutures.
export function decayWeakness(world) {
  const { cfg, crust } = world;
  const k = Math.pow(0.5, cfg.dt / cfg.weaknessHalfLife);
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    crust.weakness[i] *= k;
  }
}

// ---------------------------------------------------------------------------
// Hotspot volcanism
// ---------------------------------------------------------------------------
// Plumes are fixed in the mantle while plates slide over them, so the chain of
// edifices a plume builds is laid down in the order the plate passed -- an
// age-progressive island chain, for free, because the crust is Lagrangian and
// each point keeps whatever was piled onto it. On continental crust the same
// plume delivers flood basalt, weakens the lithosphere and thins it, which is
// what makes a plume a rifting agent rather than just a volcano.
export function hotspotVolcanism(world) {
  const { cfg, crust, crustHash, mantle } = world;
  if (!cfg.mantleEnabled || !mantle) return;
  const dt = cfg.dt;
  world.plumeActivity = 0;

  for (const plume of mantle.plumes) {
    const R = cfg.plumeRadius;
    const sigma = R * 0.45;
    crustHash.forEachInRadius(plume.x, plume.y, R, (p, d2) => {
      if (!crust.alive[p]) return;
      const w = Math.exp(-d2 / (2 * sigma * sigma)) * plume.strength;
      if (w < 0.02) return;
      supplyMelt(world, p, cfg.plumeThickening * w * dt, cfg.plumeMagmaContinental,
        cfg.plumeChamberDepth);
      crust.litho[p] = Math.max(22, crust.litho[p] - cfg.plumeLithoThinning * w * dt);
      crust.weakness[p] = Math.min(1, crust.weakness[p] + cfg.plumeWeakening * w * dt);
      deform(crust, p, Math.min(0.5, 0.12 * w * dt));
      world.plumeActivity += w;
    });
  }
}
