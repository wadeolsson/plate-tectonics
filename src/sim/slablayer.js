import { sinkRateOf } from './motion.js';
import { applyThickness, deform, stretchThin } from './crustops.js';
import { ROCK, topRock } from './rocks.js';
import { smoothstep } from './elevation.js';

// The slab layer is a second point set living beneath the crust. It is what
// lets plate material exist under another plate, and it is where the most
// interesting emergent behaviour comes from.
export function updateSlabs(world) {
  const { cfg, slabs, trenches, t } = world;
  const dt = cfg.dt;

  // Per-slab feed rate and hinge drift, looked up by slab ID in the hot loops.
  world.slabDownDip = new Map();
  world.trenchDrift = new Map();
  for (const z of trenches.all()) {
    world.slabDownDip.set(z.slabId, Math.max(4, z.convergence));
    // Only the hinge's own retreat drifts the slab sideways. Adding the
    // overriding plate's full velocity instead drags the slab across the
    // mantle with it, and the deep slab ends up thousands of km from any
    // trench -- slabs are anchored in the mantle, trenches migrate over them.
    const ox = z.oceanX || 0, oy = z.oceanY || 0;
    world.trenchDrift.set(z.slabId, [ox * z.rollbackRate, oy * z.rollbackRate]);
  }

  // Flat-slab state is decided per subduction zone, since the trigger is a
  // property of the zone (young buoyant downgoing crust, fast convergence, a
  // subducted ridge or plateau), not of individual points.
  const flat = new Map();
  for (const z of trenches.all()) {
    const young = smoothstep(cfg.flatSlabAgeMax + 25, cfg.flatSlabAgeMax - 10, z.meanAgeAtSub);
    const fast = smoothstep(cfg.flatSlabRateMin - 25, cfg.flatSlabRateMin + 30, z.convergence);
    const buoyant = slabPlateauness(world, z);
    // A flat slab cannot stay flat indefinitely: once it has scraped far enough
    // inland it tears or founders and the dip recovers.
    const spent = smoothstep(1100, 1900, z.slabLength || 0);
    const score = Math.max(young * fast, buoyant * fast) * (1 - spent);
    flat.set(z.slabId, score);
    z.flatness = score;
  }

  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i]) continue;
    // The downdip speed decays toward the free-sinking rate once the feeding
    // trench is gone, and is refreshed from it while it is alive.
    const zoneV = world.slabDownDip ? world.slabDownDip.get(slabs.slabId[i]) : undefined;
    const free = sinkRateOf(cfg, slabs, i);
    const target = zoneV !== undefined ? Math.max(free, zoneV) : free;
    slabs.vdd[i] += (target - slabs.vdd[i]) * Math.min(1, 0.25 * dt);
    // Floor the vertical component: a slab pinned at zero dip would otherwise
    // never reach the retirement depth and would accumulate without bound.
    slabs.depth[i] += Math.max(slabs.vdd[i] * 0.10, slabs.vdd[i] * Math.sin(slabs.dip[i])) * dt;

    // Dip evolution: steepen with depth and age, flatten where the zone is in
    // flat-slab mode.
    const f = flat.get(slabs.slabId[i]) || 0;
    // A slab's dip is largely decided where it enters: old dense lithosphere
    // goes down steeply, young buoyant lithosphere shallowly, and fast
    // convergence holds it shallower still. Depth should only nudge that.
    //
    // The previous form added 0.55 rad purely for being deeper than ~300 km,
    // which swamped every other term -- every deep slab converged on ~61
    // degrees and the whole population clustered in a 3 degree band. Real arcs
    // run from Cascadia at ~15 to Mariana at ~80, and that variety is set at
    // the trench, not acquired on the way down.
    const character = cfg.slabDipInit + cfg.slabDipAgeGain * smoothstep(10, 150, slabs.ageAtSub[i]);
    const targetDip = f > 0.4
      ? 0.10 + 0.25 * (1 - f)
      : Math.min(cfg.slabDipMax,
                 character + cfg.slabDipDepthGain * smoothstep(0, 450, slabs.depth[i]));
    slabs.dip[i] += (targetDip - slabs.dip[i]) * Math.min(1, cfg.slabDipRate * dt * 8);

    // Grip on the parent plate weakens as the slab descends.
    slabs.coupling[i] *= Math.pow(cfg.slabCouplingDecay, dt);
    slabs.coupling[i] *= (1 - 0.6 * smoothstep(250, 600, slabs.depth[i]) * dt * 0.1);

    // A slab that has not descended in a very long time has detached from its
    // surface plate; it leaves the model the same way a deep one does.
    // Basaltic crust on the slab converts to eclogite once it is deep enough.
    // Eclogite is ~550 kg/m^3 denser than the basalt it came from, so this is
    // not cosmetic: it is why a slab pulls harder the further it descends.
    // Continental material does not do this -- it stays buoyant, which is what
    // makes collision collision.
    if (slabs.eclogite[i] < 1) {
      const drive = smoothstep(cfg.eclogiteDepth - 20, cfg.eclogiteDepth + 60, slabs.depth[i]);
      const room = 1 - slabs.continental[i];
      slabs.eclogite[i] = Math.min(room, slabs.eclogite[i]
        + drive * room * cfg.eclogiteRate * dt);
    }

    if (slabs.depth[i] > cfg.slabRetireDepth || t - slabs.birth[i] > cfg.slabMaxAge) {
      world.budget.slabRetired += slabs.thickness[i] * world.pointArea;
      slabs.kill(i);
    }
  }
  slabs.compactTail();
}

// A subducted ridge or oceanic plateau -- thick, buoyant crust going down --
// is one of the flat-slab triggers.
function slabPlateauness(world, z) {
  const { slabs } = world;
  let thick = 0, n = 0;
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i] || slabs.slabId[i] !== z.slabId) continue;
    if (slabs.depth[i] > 180) continue;
    thick += slabs.thickness[i] + 30 * slabs.continental[i];
    n++;
  }
  if (!n) return 0;
  return smoothstep(world.cfg.thickOcean * 2.2, world.cfg.thickOcean * 4.5, thick / n);
}

// ---------------------------------------------------------------------------
// Feedback onto the overriding crust
// ---------------------------------------------------------------------------
// The slab layer applies stress upward: compression where it is shallow and
// strongly coupled, extension where it is rolling back or absent. That stress
// is expressed as a thickness modification and isostasy converts it into
// topography. Nothing here touches elevation.
export function slabFeedback(world) {
  const { cfg, crust, slabs, slabHash, trenches, plates, W, H } = world;
  const dt = cfg.dt;
  const R = world.spacing * 2.2;

  ensureScratch(world);
  const sc = world.scratch;
  sc.slabDepth.fill(-1);
  sc.slabCoupling.fill(0);
  sc.slabDens.fill(0);
  sc.slabDip.fill(1);
  sc.stress.fill(0);

  // Coarse presence grid over the slab hash cells. Two jobs: it lets the
  // per-point slab query skip the ~90% of the map with no slab under it, and
  // it turns slab-window detection into a neighbourhood test on cells instead
  // of a radius query per crust point.
  const gnx = slabHash.nx, gny = slabHash.ny, nCells = gnx * gny;
  if (!sc.slabCell || sc.slabCell.length !== nCells) sc.slabCell = new Uint8Array(nCells);
  const cellHas = sc.slabCell;
  cellHas.fill(0);
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i] || slabs.depth[i] > 320) continue;
    cellHas[slabHash.cellY(slabs.y[i]) * gnx + slabHash.cellX(slabs.x[i])] = 1;
  }
  const nearCell = (gx, gy) => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = ((gy + dy) % gny + gny) % gny;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = ((gx + dx) % gnx + gnx) % gnx;
        if (cellHas[yy * gnx + xx]) return true;
      }
    }
    return false;
  };

  // --- sample the slab layer beneath every crust point -----------------
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const gx = slabHash.cellX(crust.x[i]), gy = slabHash.cellY(crust.y[i]);
    if (!nearCell(gx, gy)) continue;
    let wsum = 0, dsum = 0, csum = 0, psum = 0, cnt = 0;
    slabHash.forEachInRadius(crust.x[i], crust.y[i], R, (s, d2) => {
      if (!slabs.alive[s] || slabs.parentPlate[s] === crust.plate[i]) return;
      const w = Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
      wsum += w; dsum += slabs.depth[s] * w; csum += slabs.coupling[s] * w;
      psum += slabs.dip[s] * w; cnt++;
    });
    if (wsum > 0) {
      sc.slabDepth[i] = dsum / wsum;
      sc.slabCoupling[i] = csum / wsum;
      sc.slabDip[i] = psum / wsum;
      sc.slabDens[i] = Math.min(1, cnt / 8);
    }
  }

  // --- rollback -> back-arc extension ----------------------------------
  // Rollback is read from the trench's explicit hinge state, never inferred by
  // comparing a sink rate to a convergence rate.
  for (const z of trenches.all()) {
    if (z.isCollision || z.overriding < 0) continue;
    const rb = z.rollbackRate;
    if (Math.abs(rb) < 1) continue;
    const over = plates.get(z.overriding);
    if (!over || !over.alive) continue;
    const ox = z.oceanX || 0, oy = z.oceanY || 0;
    const reach = 500;
    // A 500 km query at every edge of a long trench re-visits the same
    // back-arc dozens of times. Sample every few edges and scale up to match,
    // which is the same integral for a fraction of the work.
    const stride = Math.max(1, Math.round(z.edges.length / 12));
    for (let k = 0; k < z.edges.length; k += stride) {
      const e = z.edges[k];
      const mx = world.boundaries.mx[e], my = world.boundaries.my[e];
      world.crustHash.forEachInRadius(mx - ox * reach * 0.5, my - oy * reach * 0.5, reach, (p, d2) => {
        if (!crust.alive[p] || crust.plate[p] !== z.overriding) return;
        const w = Math.exp(-d2 / (2 * (reach * 0.45) * (reach * 0.45))) * stride;
        const d = -cfg.rollbackGain * rb * 0.02 * w * dt;   // rb>0 retreating -> thinning
        // Back-arc extension stretches the overriding plate; it does not
        // consume it, so the thinned volume moves outward rather than
        // vanishing.
        if (d < 0) stretchThin(world, p, -d, { floor: 5, range: 3.0, inner: 1.3 });
        else applyThickness(world, p, d);
        sc.stress[p] += rb * w * 0.02;
        if (rb > 0) {
          crust.weakness[p] = Math.min(1, crust.weakness[p] + 0.004 * w * dt);
          crust.litho[p] = Math.max(25, crust.litho[p] - 0.25 * w * dt);
          deform(crust, p, Math.min(0.6, 0.05 * w * dt));
        }
      });
    }
  }

  // --- flat slab -> inland compression ---------------------------------
  // The slab scrapes along the base of the overriding plate for hundreds of km,
  // transmitting compression well away from the trench: thick-skinned basement
  // uplift, the Laramide signature.
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const d = sc.slabDepth[i];
    if (d < 0) continue;
    // The trigger is flatness, not shallowness. Every normal subduction zone
    // has shallow slab under its forearc; only a genuinely flat slab scrapes
    // along the base of the plate and drives uplift hundreds of km inland.
    const flat = smoothstep(0.42, 0.14, sc.slabDip[i]);
    const compress = flat * smoothstep(200, 70, d) * sc.slabCoupling[i] * sc.slabDens[i];
    if (compress > 0.02) {
      // Flat-slab uplift is tectonic shortening of the crust that is already
      // there, not an addition of new magma, so it thickens with the local rock.
      applyThickness(world, i, cfg.flatSlabGain * compress * dt,
        crust.continental[i], topRock(crust, i));
      sc.stress[i] -= compress * 40;
      deform(crust, i, Math.min(0.6, 0.06 * compress * dt));
    }
  }

  // --- slab windows ----------------------------------------------------
  // Where a ridge has been subducted or a slab has broken off there is a hole
  // in the slab field. A hole is a cell with no slab that is ringed by cells
  // that have some -- not merely a cell on the edge of a slab, which is what a
  // simple "most neighbours have slab" test would flag along every margin.
  const holeCell = sc.holeCell && sc.holeCell.length === nCells
    ? sc.holeCell : (sc.holeCell = new Uint8Array(nCells));
  holeCell.fill(0);
  for (let gy = 0; gy < gny; gy++) {
    for (let gx = 0; gx < gnx; gx++) {
      const c = gy * gnx + gx;
      if (cellHas[c]) continue;
      // Require slab on opposite sides in both axes: a genuine enclosure.
      let left = false, right = false, up = false, down = false, ring = 0;
      for (let d = 1; d <= 2; d++) {
        if (cellHas[gy * gnx + ((gx - d + gnx) % gnx)]) left = true;
        if (cellHas[gy * gnx + ((gx + d) % gnx)]) right = true;
        if (cellHas[(((gy - d + gny) % gny)) * gnx + gx]) up = true;
        if (cellHas[(((gy + d) % gny)) * gnx + gx]) down = true;
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (cellHas[(((gy + dy) % gny + gny) % gny) * gnx + (((gx + dx) % gnx + gnx) % gnx)]) ring++;
      }
      if (left && right && up && down && ring >= 5) holeCell[c] = 1;
    }
  }

  world.slabWindowCount = 0;
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i] || sc.slabDepth[i] >= 0) continue;
    const c = slabHash.cellY(crust.y[i]) * gnx + slabHash.cellX(crust.x[i]);
    if (!holeCell[c]) continue;
    world.slabWindowCount++;
    // Slab-window volcanism is mantle-derived: basaltic, not andesitic.
    applyThickness(world, i, cfg.slabWindowUplift * dt, 0.30, ROCK.FLOOD_BASALT);
    crust.weakness[i] = Math.min(1, crust.weakness[i] + 0.006 * dt);
    deform(crust, i, Math.min(0.7, 0.10 * dt));
    sc.stress[i] += 8;
  }
}

export function ensureScratch(world) {
  const cap = world.crust.capacity;
  const sc = world.scratch;
  if (!sc.slabDepth || sc.slabDepth.length < cap) {
    sc.slabDepth = new Float32Array(cap);
    sc.slabCoupling = new Float32Array(cap);
    sc.slabDens = new Float32Array(cap);
    sc.slabDip = new Float32Array(cap);
    sc.stress = new Float32Array(cap);
  }
}
