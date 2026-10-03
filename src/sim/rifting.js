import { KIND } from './boundaries.js';
import { wrapPos, wrapDelta } from '../core/torus.js';
import { smoothstep } from './elevation.js';
import { deform, stretchThin } from './crustops.js';
import { scaleColumn } from './rocks.js';

// Rifting and suturing are what generate Wilson cycles. Without them the world
// is dead after a few hundred Myr, so this is core, not polish.

// ---------------------------------------------------------------------------
// Stress state per plate
// ---------------------------------------------------------------------------
// Rifting is driven by stress first and weakness second. Scoring on
// continental area alone would make the largest continent rift simply for
// being large.
export function plateStress(world) {
  const { boundaries, plates, trenches } = world;
  const S = new Map();
  const get = (id) => {
    let s = S.get(id);
    if (!s) S.set(id, s = { xx: 0, xy: 0, yy: 0, len: 0 });
    return s;
  };

  for (let e = 0; e < boundaries.count; e++) {
    const L = boundaries.len[e];
    const vn = boundaries.vn[e];        // positive = opening = tension
    const nx = boundaries.nx[e], ny = boundaries.ny[e];
    // Outward normal of A is +n; outward normal of B is -n. The dyad is the
    // same either way, only the traction sign matters.
    for (const [id, sign] of [[boundaries.plateA[e], 1], [boundaries.plateB[e], 1]]) {
      const s = get(id);
      const t = vn * L * sign;
      s.xx += t * nx * nx; s.xy += t * nx * ny; s.yy += t * ny * ny;
      s.len += L;
    }
  }

  // Trench rollback puts the overriding plate into extension whether or not
  // its boundary is already opening.
  for (const z of trenches.all()) {
    if (z.isCollision || z.overriding < 0 || z.rollbackRate <= 0) continue;
    const s = get(z.overriding);
    const nx = z.oceanX || 0, ny = z.oceanY || 0;
    const t = z.rollbackRate * z.length * 0.6;
    s.xx += t * nx * nx; s.xy += t * nx * ny; s.yy += t * ny * ny;
  }

  // Large continents insulate the mantle beneath them and go into extension.
  // Without this term a world that has assembled into a single plate has no
  // boundaries, therefore no boundary tension, therefore no rift score, and
  // the supercontinent is permanent -- the Wilson cycle dies at its own
  // halfway point.
  const domain = world.W * world.H;
  for (const p of plates.alive()) {
    const insul = smoothstep(0.10, 0.45, p.continentalArea / domain);
    if (insul <= 0) continue;
    const s = get(p.id);
    const dl = Math.hypot(p.bgX || 0, p.bgY || 0) || 1;
    const nx = (p.bgX || 1) / dl, ny = (p.bgY || 0) / dl;
    const t = world.cfg.insulationStress * insul * p.area;
    s.xx += t * nx * nx; s.xy += t * nx * ny; s.yy += t * ny * ny;
  }

  const out = new Map();
  for (const [id, s] of S) {
    const p = plates.get(id);
    const inv = 1 / Math.max(1, p ? p.area : 1);
    const xx = s.xx * inv * 1e5, xy = s.xy * inv * 1e5, yy = s.yy * inv * 1e5;
    // Principal values of the symmetric 2x2 tensor.
    const tr = xx + yy, det = xx * yy - xy * xy;
    const disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
    const l1 = tr * 0.5 + disc, l2 = tr * 0.5 - disc;
    // Eigenvector for l1 = the maximum-extension direction.
    let ex = xy, ey = l1 - xx;
    if (Math.hypot(ex, ey) < 1e-9) { ex = l1 - yy; ey = xy; }
    const el = Math.hypot(ex, ey) || 1;
    out.set(id, { tension: l1, compression: l2, extX: ex / el, extY: ey / el });
    if (p) p.stressAccum = l1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rift nucleation
// ---------------------------------------------------------------------------
export function maybeRift(world) {
  const { cfg, plates, crust, rng, t, W, H } = world;
  const stress = world.stress;
  const domain = W * H;

  const candidates = [];
  for (const p of plates.alive()) {
    if (t - p.lastReorg < cfg.riftCooldown) continue;
    if (p.area < cfg.riftMinArea * domain) continue;
    if (p.continentalArea < cfg.riftMinContArea * domain) continue;
    const st = stress.get(p.id);
    if (!st || st.tension <= 0) continue;

    let weakSum = 0, weakN = 0;
    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i] || crust.plate[i] !== p.id) continue;
      if (crust.continental[i] < 0.4) continue;
      weakSum += crust.weakness[i]; weakN++;
    }
    const weak = weakN ? weakSum / weakN : 0;

    const sStress = smoothstep(0, 600, st.tension);
    const sWeak = smoothstep(0.05, 0.5, weak);
    const sArea = smoothstep(cfg.riftMinArea, 0.28, p.area / domain);
    const score = cfg.riftStressWeight * sStress
                + cfg.riftWeaknessWeight * sWeak
                + cfg.riftAreaWeight * sArea;
    if (score <= 0.15) continue;
    candidates.push({ p, score, st });
  }
  if (!candidates.length) return false;
  candidates.sort((a, b) => b.score - a.score);
  const c = candidates[0];
  world.riftEligible = candidates.length;
  if (rng.next() > cfg.riftBaseChance * c.score * cfg.dt) return false;
  world.riftAttempts = (world.riftAttempts || 0) + 1;
  return splitPlate(world, c.p, c.st);
}

// A least-cost path across the plate, with cost inversely proportional to
// weakness and rising with lithospheric thickness. That is what makes rifts
// reopen old sutures and route around cratonic shields rather than cutting
// randomly across them.
function note(world, why) {
  world.riftFail = why;
  world.riftFails = (world.riftFails || 0) + 1;
  return false;
}

export function splitPlate(world, plate, st) {
  const { cfg, crust, plates, rng, t, W, H } = world;

  // Work in the plate's own unwrapped frame -- no seam inside it by
  // construction, because the frame is a continuous lift.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const members = [];
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i] || crust.plate[i] !== plate.id) continue;
    members.push(i);
    const ux = crust.ux[i], uy = crust.uy[i];
    if (ux < minX) minX = ux; if (ux > maxX) maxX = ux;
    if (uy < minY) minY = uy; if (uy > maxY) maxY = uy;
  }
  if (members.length < 60) return note(world, 'too few points');

  const cell = Math.max(world.spacing * 1.6, (maxX - minX + maxY - minY) / 260);
  const nx = Math.min(240, Math.max(4, Math.ceil((maxX - minX) / cell) + 3));
  const ny = Math.min(240, Math.max(4, Math.ceil((maxY - minY) / cell) + 3));
  const ox = minX - cell, oy = minY - cell;
  const N = nx * ny;
  const occ = new Uint8Array(N);
  const weak = new Float32Array(N);
  const lith = new Float32Array(N);
  const cnt = new Float32Array(N);

  for (const i of members) {
    const gx = Math.floor((crust.ux[i] - ox) / cell);
    const gy = Math.floor((crust.uy[i] - oy) / cell);
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
    const c = gy * nx + gx;
    occ[c] = 1; weak[c] += crust.weakness[i]; lith[c] += crust.litho[i]; cnt[c]++;
  }
  for (let c = 0; c < N; c++) if (cnt[c]) { weak[c] /= cnt[c]; lith[c] /= cnt[c]; }

  // A plate can be disconnected on this coarse grid -- an arc chain, a
  // scattered fringe -- and Dijkstra would simply fail. Keep only the largest
  // connected block of cells.
  keepLargestComponent(nx, ny, occ);

  // The rift axis runs perpendicular to the maximum-extension direction.
  const ax = -st.extY, ay = st.extX;
  const proj = new Float32Array(N);
  let pMin = Infinity, pMax = -Infinity;
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const c = gy * nx + gx;
    if (!occ[c]) continue;
    const px = ox + (gx + 0.5) * cell, py = oy + (gy + 0.5) * cell;
    const v = px * ax + py * ay;
    proj[c] = v;
    if (v < pMin) pMin = v;
    if (v > pMax) pMax = v;
  }
  if (!(pMax > pMin)) return note(world, 'degenerate extension axis');

  const band = (pMax - pMin) * 0.06;
  const starts = [], goals = [];
  for (let c = 0; c < N; c++) {
    if (!occ[c]) continue;
    if (proj[c] <= pMin + band) starts.push(c);
    if (proj[c] >= pMax - band) goals.push(c);
  }
  if (!starts.length || !goals.length) return note(world, 'no start/goal band');

  const cost = (c) => (1 / (0.15 + weak[c])) * (1 + cfg.riftLithoCost * (lith[c] / cfg.lithoContMax));
  const path = dijkstra(nx, ny, occ, cost, starts, goals);
  if (!path) return note(world, 'no least-cost path across the plate');

  // Record how much weaker the chosen cut was than the plate it crossed. This
  // is the direct measurement of "rifts reopen old sutures": comparing the
  // weakness of currently-active rift boundaries against a plate mean tests
  // something else entirely, and is dominated by whatever happens to be
  // rifting at the moment you look.
  let pw = 0, pn = 0, aw = 0, an = 0, pl = 0, al = 0;
  for (const c of path) { if (cnt[c]) { pw += weak[c]; pl += lith[c]; pn++; } }
  for (let c = 0; c < N; c++) if (occ[c] && cnt[c]) { aw += weak[c]; al += lith[c]; an++; }
  const pathWeak = pn ? pw / pn : 0, plateWeak = an ? aw / an : 0;
  const pathLitho = pn ? pl / pn : 0, plateLitho = an ? al / an : 0;

  // Cut: knock out the path cells and flood-fill what remains. If the cut does
  // not separate the plate into two pieces, abandon this rift.
  const cut = new Uint8Array(N);
  for (const c of path) {
    cut[c] = 1;
    const gx = c % nx, gy = (c / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x2 = gx + dx, y2 = gy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
      cut[y2 * nx + x2] = 1;
    }
  }
  const label = new Int32Array(N).fill(-1);
  let nLabels = 0;
  const stack = [];
  for (let c = 0; c < N; c++) {
    if (!occ[c] || cut[c] || label[c] >= 0) continue;
    const id = nLabels++;
    label[c] = id; stack.push(c);
    while (stack.length) {
      const q = stack.pop();
      const gx = q % nx, gy = (q / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x2 = gx + dx, y2 = gy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
        const c2 = y2 * nx + x2;
        if (!occ[c2] || cut[c2] || label[c2] >= 0) continue;
        label[c2] = id; stack.push(c2);
      }
    }
  }
  if (nLabels < 2) return note(world, 'cut did not separate the plate');

  const sizes = new Int32Array(nLabels);
  for (let c = 0; c < N; c++) if (label[c] >= 0) sizes[label[c]]++;
  let big = 0, second = -1;
  for (let i = 1; i < nLabels; i++) if (sizes[i] > sizes[big]) big = i;
  for (let i = 0; i < nLabels; i++) if (i !== big && (second < 0 || sizes[i] > sizes[second])) second = i;
  if (second < 0 || sizes[second] < 20) return note(world, 'second fragment too small');

  // Points in the second component -- plus cut cells nearer to it -- move to a
  // new plate.
  const newPlate = plates.create(plate.id, t);
  newPlate.vx = plate.vx; newPlate.vy = plate.vy; newPlate.omega = plate.omega;
  newPlate.ucx = plate.ucx; newPlate.ucy = plate.ucy;
  newPlate.cx = plate.cx; newPlate.cy = plate.cy;
  newPlate.hue = (plate.hue + 0.37) % 1;
  newPlate.rotOk = plate.rotOk;

  let moved = 0;
  const axisPts = [];
  for (const i of members) {
    const gx = Math.floor((crust.ux[i] - ox) / cell);
    const gy = Math.floor((crust.uy[i] - oy) / cell);
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
    const c = gy * nx + gx;
    let lab = label[c];
    if (lab < 0) {                 // on the cut: assign by nearest labelled cell
      lab = nearestLabel(nx, ny, label, gx, gy);
      axisPts.push(i);
    }
    if (lab === second) { crust.plate[i] = newPlate.id; moved++; }
  }
  if (moved < 20) { plates.retire(newPlate.id, -1); return note(world, 'too few points moved'); }

  // Re-establish the unwrapped frame for everything that changed hands, then
  // recompute both plates' geometry before imposing the new velocities.
  plates.recomputeGeometry(crust, W, H, world.pointArea);
  for (let i = 0; i < crust.n; i++) {
    if (crust.alive[i] && crust.plate[i] === newPlate.id) plates.reframe(crust, i, newPlate.id, W, H);
  }
  plates.recomputeGeometry(crust, W, H, world.pointArea);

  // Diverging velocities perpendicular to the rift axis, plus a small
  // differential rotation so the rift opens like a zipper rather than
  // uniformly. Real rifts propagate.
  const half = cfg.riftOpenSpeed * 0.5;
  const ex = st.extX, ey = st.extY;
  const sign = sideSign(world, plate, newPlate, ex, ey);
  plate.vx -= ex * half * sign; plate.vy -= ey * half * sign;
  newPlate.vx += ex * half * sign; newPlate.vy += ey * half * sign;
  const dOmega = rng.normal(0, cfg.omegaMax * 0.25);
  newPlate.omega = plate.omega + dOmega;
  plate.lastReorg = t; newPlate.lastReorg = t;

  // Mark the axis so thinning starts immediately: the rift valley forms
  // before any ocean exists.
  for (const i of axisPts) {
    crust.weakness[i] = Math.min(1, crust.weakness[i] + cfg.weakRift * 0.5);
    deform(crust, i, 0.9);
  }

  world.riftHistory.push({ t, plate: plate.id, child: newPlate.id, pathWeak, plateWeak, pathLitho, plateLitho });
  world.events.push({
    t, kind: 'rift',
    text: `plate ${plate.id} rifted → ${newPlate.id}  (cut weakness ${pathWeak.toFixed(2)} vs plate ${plateWeak.toFixed(2)})`,
  });
  return true;
}

function sideSign(world, a, b, ex, ey) {
  const dx = wrapDelta(b.cx - a.cx, world.W), dy = wrapDelta(b.cy - a.cy, world.H);
  return (dx * ex + dy * ey) >= 0 ? 1 : -1;
}

function keepLargestComponent(nx, ny, occ) {
  const N = nx * ny;
  const lab = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = [];
  for (let c = 0; c < N; c++) {
    if (!occ[c] || lab[c] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    lab[c] = id; stack.push(c);
    while (stack.length) {
      const q = stack.pop(); n++;
      const gx = q % nx, gy = (q / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x2 = gx + dx, y2 = gy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
        const c2 = y2 * nx + x2;
        if (!occ[c2] || lab[c2] >= 0) continue;
        lab[c2] = id; stack.push(c2);
      }
    }
    sizes.push(n);
  }
  if (sizes.length < 2) return;
  let big = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[big]) big = i;
  for (let c = 0; c < N; c++) if (occ[c] && lab[c] !== big) occ[c] = 0;
}

function nearestLabel(nx, ny, label, gx, gy) {
  for (let r = 1; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x2 = gx + dx, y2 = gy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
      const l = label[y2 * nx + x2];
      if (l >= 0) return l;
    }
  }
  return -1;
}

// Plain binary-heap Dijkstra over the occupied cells.
function dijkstra(nx, ny, occ, costFn, starts, goals) {
  const N = nx * ny;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const goalSet = new Set(goals);
  const heap = new MinHeap();
  for (const s of starts) { dist[s] = 0; heap.push(0, s); }

  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  let hit = -1;
  while (heap.size) {
    const [d, c] = heap.pop();
    if (d > dist[c]) continue;
    if (goalSet.has(c)) { hit = c; break; }
    const gx = c % nx, gy = (c / nx) | 0;
    for (const [dx, dy, w] of nb) {
      const x2 = gx + dx, y2 = gy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
      const c2 = y2 * nx + x2;
      if (!occ[c2]) continue;
      const nd = d + costFn(c2) * w;
      if (nd < dist[c2]) { dist[c2] = nd; prev[c2] = c; heap.push(nd, c2); }
    }
  }
  if (hit < 0) return null;
  const path = [];
  for (let c = hit; c >= 0; c = prev[c]) path.push(c);
  return path;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this._swap(p, i); i = p;
    }
  }
  pop() {
    const rk = this.k[0], rv = this.v[0];
    const lk = this.k.pop(), lv = this.v.pop();
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this._swap(m, i); i = m;
      }
    }
    return [rk, rv];
  }
  _swap(a, b) {
    const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
}

// ---------------------------------------------------------------------------
// Rift thinning and breakup
// ---------------------------------------------------------------------------
// Stage 1: thin the crust on the axis -- isostasy immediately drops the
// elevation, producing a rift valley before any ocean exists. Stage 2: once
// thinning passes a threshold the segment starts making seafloor. That gives
// the East African Rift -> Red Sea -> Atlantic progression as one continuous
// process rather than as discrete states.
export function riftThinning(world) {
  const { cfg, crust, boundaries, crustHash, segments, pointArea } = world;
  const dt = cfg.dt;
  const R = cfg.riftThinRange * world.spacing;

  for (let e = 0; e < boundaries.count; e++) {
    if (boundaries.kind[e] !== KIND.RIFT) continue;
    const open = boundaries.vn[e];
    if (open <= 0) continue;
    const mx = boundaries.mx[e], my = boundaries.my[e];
    const rate = cfg.riftThinRate * Math.min(2.5, open / 25);
    crustHash.forEachInRadius(mx, my, R, (p, d2) => {
      if (!crust.alive[p] || crust.continental[p] < 0.25) return;
      const w = Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
      stretchThin(world, p, rate * w * dt, { floor: 6, range: 3.2, inner: 1.5 });
      crust.litho[p] = Math.max(20, crust.litho[p] - rate * 2.2 * w * dt);
      crust.weakness[p] = Math.min(1, crust.weakness[p] + cfg.weakRift * 0.02 * w * dt);
      deform(crust, p, Math.min(0.8, 0.30 * w * dt));
    });
  }

  // Breakup test per segment.
  for (const seg of segments.active()) {
    if (seg.continental <= 0.5 || seg.brokeUp) continue;
    let thick = 0, n = 0;
    const mx = wrapPos(seg.x0 + wrapDelta(seg.x1 - seg.x0, world.W) * 0.5, world.W);
    const my = wrapPos(seg.y0 + wrapDelta(seg.y1 - seg.y0, world.H) * 0.5, world.H);
    crustHash.forEachInRadius(mx, my, R, (p) => {
      if (!crust.alive[p]) return;
      thick += crust.thickness[p]; n++;
    });
    if (n > 3 && thick / n < cfg.riftBreakupThickness) {
      seg.brokeUp = true;
      world.events.push({ t: world.t, kind: 'breakup', text: `segment ${seg.id} reached seafloor spreading` });
    }
  }
}
