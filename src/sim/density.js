import { nextHalfedge } from './delaunay.js';
import { spreadVolume } from './processes.js';
import { copyColumn, scaleColumn } from './rocks.js';

// Point density management.
//
// Rifting stretches the point cloud and collision compresses it. Left alone,
// spacing drifts badly over a few hundred Myr -- gaps in extended crust,
// pileups in orogens -- and the run degrades quietly rather than failing. Both
// operations conserve crustal volume; the small unavoidable discrepancy is
// booked to the `regrid` line of the mass ledger so it stays visible instead
// of hiding inside the physics.

export function manageDensity(world) {
  const { cfg, crust, plates, td, W, H, pointArea, spacing } = world;
  let ops = 0, merged = 0, inserted = 0;

  // Every area budget in the simulator assumes one point stands for exactly
  // `pointArea`. Nothing enforces that on its own, and the cloud will happily
  // settle at a different density, which silently rescales accretion and
  // subduction. A proportional term on both thresholds holds the population at
  // the nominal value: too few points and merging backs off while insertion
  // gets eager, and the reverse when there are too many.
  const fill = Math.max(0.5, Math.min(1.6, crust.live * pointArea / (W * H)));
  world.fill = fill;
  const bias = Math.max(0.78, Math.min(1.3, fill));

  // --- merge overly close pairs ---------------------------------------
  const mergeDist = cfg.densityMergeFactor * bias * spacing;
  const md2 = mergeDist * mergeDist;
  const dead = new Uint8Array(crust.n);
  const tri = td.triangles, orig = td.orig, coords = td.coords;

  for (let e = 0; e < tri.length && ops < cfg.densityMaxOpsPerStep; e++) {
    const pi = tri[e], qi = tri[nextHalfedge(e)];
    const a = orig[pi], b = orig[qi];
    if (a >= b) continue;                       // handle each pair once
    if (dead[a] || dead[b]) continue;
    if (!crust.alive[a] || !crust.alive[b]) continue;
    if (crust.plate[a] !== crust.plate[b]) continue;   // boundaries are physics
    const dx = coords[2 * qi] - coords[2 * pi];
    const dy = coords[2 * qi + 1] - coords[2 * pi + 1];
    const d2 = dx * dx + dy * dy;
    if (d2 >= md2) continue;

    // Merging used to fold the two columns into one thickness, which either
    // loses volume (if the result is thinner than the sum) or doubles the
    // thickness of ordinary oceanic crust (if it is not). Neither is right.
    // Instead the dropped point's whole column is returned to the
    // neighbourhood, which conserves volume exactly and distorts nothing: two
    // 7 km oceanic points merging raise their ~12 neighbours by half a km
    // rather than producing one 14 km column.
    const ta = crust.thickness[a], tb = crust.thickness[b];
    const keep = ta >= tb ? a : b, drop = ta >= tb ? b : a;
    const vol = crust.thickness[drop] * pointArea;
    const cvol = vol * crust.continental[drop];
    const mx = crust.x[drop], my = crust.y[drop];
    const plate = crust.plate[drop];
    crust.weakness[keep] = Math.max(crust.weakness[keep], crust.weakness[drop]);
    crust.defAge[keep] = Math.min(crust.defAge[keep], crust.defAge[drop]);

    dead[drop] = 1;
    crust.kill(drop);
    spreadVolume(world, mx, my, spacing * 1.8, vol, cvol, (q) => crust.plate[q] === plate,
      vol > 0 ? cvol / vol : 0);
    ops++; merged++;
  }

  // --- insert into gaps -------------------------------------------------
  // A Delaunay triangle whose circumradius is well above the target spacing is
  // a hole in the cloud. Only fill holes interior to a plate: a hole spanning
  // two plates is a divergent boundary, which accretion owns.
  const splitR = cfg.densitySplitFactor * bias * spacing;
  const nTri = td.nTriangles;
  for (let k = 0; k < nTri && ops < cfg.densityMaxOpsPerStep; k++) {
    const i0 = tri[3 * k], i1 = tri[3 * k + 1], i2 = tri[3 * k + 2];
    const a = orig[i0], b = orig[i1], c = orig[i2];
    if (dead[a] || dead[b] || dead[c]) continue;
    if (!crust.alive[a] || !crust.alive[b] || !crust.alive[c]) continue;
    const pl = crust.plate[a];
    if (crust.plate[b] !== pl || crust.plate[c] !== pl) continue;
    const cx = td.ccx[k], cy = td.ccy[k];
    const r2 = (cx - coords[2 * i0]) ** 2 + (cy - coords[2 * i0 + 1]) ** 2;
    if (r2 < splitR * splitR) continue;
    // Skip absurd slivers: a near-degenerate triangle has a huge circumradius
    // without representing a real gap.
    const e01 = dist2c(coords, i0, i1), e12 = dist2c(coords, i1, i2), e20 = dist2c(coords, i2, i0);
    if (Math.max(e01, e12, e20) > (4 * splitR) ** 2) continue;

    const th = (crust.thickness[a] + crust.thickness[b] + crust.thickness[c]) / 3;
    const plate = plates.get(pl);
    if (!plate || !plate.alive) continue;
    // Stretching thins: each donor gives up a third of the new point's volume.
    const give = th / 3;
    if (crust.thickness[a] - give < 4 || crust.thickness[b] - give < 4 || crust.thickness[c] - give < 4) continue;
    // Stretching thins the donors' whole columns, not just a bulk number.
    // Writing `thickness` here directly is what the column-consistency check
    // in the validation suite exists to catch.
    for (const d of [a, b, c]) {
      const t0 = crust.thickness[d];
      if (t0 > give) scaleColumn(crust, d, (t0 - give) / t0);
    }

    const nx = ((cx % W) + W) % W, ny = ((cy % H) + H) % H;
    const i = crust.spawn({
      x: nx, y: ny,
      plate: pl,
      continental: (crust.continental[a] + crust.continental[b] + crust.continental[c]) / 3,
      thickness: th,
      litho: (crust.litho[a] + crust.litho[b] + crust.litho[c]) / 3,
      age: (crust.age[a] + crust.age[b] + crust.age[c]) / 3,
      defAge: Math.min(crust.defAge[a], crust.defAge[b], crust.defAge[c]),
      segment: crust.segment[a],
      weakness: (crust.weakness[a] + crust.weakness[b] + crust.weakness[c]) / 3,
    });
    plates.reframe(crust, i, pl, W, H);
    // A newly inserted point inherits the stratigraphy of the thickest donor
    // rather than being rebuilt from a bulk composition: it is the same crust,
    // stretched, not new crust.
    const donor = crust.thickness[a] >= crust.thickness[b]
      ? (crust.thickness[a] >= crust.thickness[c] ? a : c)
      : (crust.thickness[b] >= crust.thickness[c] ? b : c);
    copyColumn(crust, donor, i);
    if (crust.thickness[i] > 1e-6) scaleColumn(crust, i, th / crust.thickness[i]);
    ops++; inserted++;
  }

  crust.compactTail();
  world.densityOps = ops;
  world.densityMerged = merged;
  world.densityInserted = inserted;
}

function dist2c(coords, i, j) {
  const dx = coords[2 * i] - coords[2 * j];
  const dy = coords[2 * i + 1] - coords[2 * j + 1];
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Boundary cleanup
// ---------------------------------------------------------------------------
// A point of plate A stranded inside plate B is a modelling artifact, and each
// one manufactures a spurious closed-loop "fault" in the Voronoi dual. Left
// alone they accumulate along every boundary, the fault network shatters into
// hundreds of fragments, and each fragment then spawns its own subduction zone
// with its own polarity and its own slab. That is how a long run dies.
//
// A majority filter over the Delaunay neighbourhood fixes it: a point whose
// neighbourhood is dominated by another plate joins it. Two passes, because
// clearing the worst offenders exposes the next layer.
export function reassignStrays(world) {
  const { crust, plates, td, W, H } = world;
  const tri = td.triangles, orig = td.orig;
  const n = crust.n;
  const deg = new Int32Array(n), same = new Int32Array(n);
  let ops = 0;

  for (let pass = 0; pass < 2; pass++) {
    deg.fill(0); same.fill(0);
    for (let e = 0; e < tri.length; e++) {
      const a = orig[tri[e]], b = orig[tri[nextHalfedge(e)]];
      if (a === b) continue;
      deg[a]++;
      if (crust.plate[a] === crust.plate[b]) same[a]++;
    }

    const flagged = [];
    for (let i = 0; i < n; i++) {
      if (!crust.alive[i]) continue;
      if (deg[i] >= 4 && same[i] <= deg[i] * 0.3) flagged.push(i);
    }
    if (!flagged.length) break;

    const isFlagged = new Set(flagged);
    const votes = new Map();
    for (let e = 0; e < tri.length; e++) {
      const a = orig[tri[e]];
      if (!isFlagged.has(a)) continue;
      const b = orig[tri[nextHalfedge(e)]];
      if (a === b) continue;
      let m = votes.get(a);
      if (!m) votes.set(a, m = new Map());
      const p = crust.plate[b];
      m.set(p, (m.get(p) || 0) + 1);
    }

    let changed = 0;
    for (const i of flagged) {
      const m = votes.get(i);
      if (!m) continue;
      let bestP = -1, bestN = 0;
      for (const [p, c] of m) if (c > bestN) { bestN = c; bestP = p; }
      if (bestP < 0 || bestP === crust.plate[i]) continue;
      // Only move if the majority is decisive; a 50/50 point is on a real
      // boundary and belongs where it is.
      if (bestN < deg[i] * 0.5) continue;
      const pl = plates.get(bestP);
      if (!pl || !pl.alive) continue;
      plates.reframe(crust, i, bestP, W, H);
      ops++; changed++;
    }
    if (!changed) break;
  }
  world.strayOps = ops;
}
