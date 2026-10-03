import { ROCK, pushTop, topRock } from './rocks.js';
import { elevationOf } from './elevation.js';

// Volcanoes as edifices.
//
// Until now melt erupted wherever it happened to be: every point along an arc
// pushed a thin lava layer onto itself, so a 2000 km arc got a 2000 km low
// welt. Real arcs do not look like that. The melt collects into a handful of
// discrete, long-lived centres thirty to eighty kilometres apart, and each one
// builds a CONE -- a pile of its own making, standing above everything around
// it. Fuji, Rainier, Cotopaxi. The welt is the thing you get when you smear a
// volcano's output over the whole region it belongs to, and smearing is
// exactly what we were doing.
//
// So: a register of persistent vents. A vent captures the melt rising under
// its neighbourhood, and emplaces it as a radially-decaying pile instead of a
// flat layer. The pile is ordinary crust -- it weighs on the isostasy, it
// erodes, it shows up in section as a cone of andesite or basalt -- so a
// volcano here is a real landform and not a decal.
//
// Honest limit: at 40-50 km point spacing a stratovolcano's 20-40 km base is
// one or two points. A vent is therefore about as sharp as the grid allows,
// and the summit point IS the mountain. Shields, which are 100 km+ across on
// Earth, are resolved properly; stratocones are at the resolution floor.

const MAXV = 4096;

export class Volcanoes {
  constructor() {
    this.x = new Float32Array(MAXV);
    this.y = new Float32Array(MAXV);
    this.plate = new Int32Array(MAXV);
    this.kind = new Uint8Array(MAXV);     // 0 = arc (steep, andesitic), 1 = shield
    this.height = new Float32Array(MAXV); // km of edifice built so far
    this.vigour = new Float32Array(MAXV); // recent eruption rate, km^3/Myr
    this.born = new Float32Array(MAXV);
    this.idle = new Float32Array(MAXV);   // Myr since last eruption
    this.alive = new Uint8Array(MAXV);
    this.n = 0;
    this.live = 0;
  }
  spawn(x, y, plate, kind, t) {
    let i = -1;
    for (let k = 0; k < this.n; k++) if (!this.alive[k]) { i = k; break; }
    if (i < 0) { if (this.n >= MAXV) return -1; i = this.n++; }
    this.x[i] = x; this.y[i] = y; this.plate[i] = plate; this.kind[i] = kind;
    this.height[i] = 0; this.vigour[i] = 0; this.born[i] = t; this.idle[i] = 0;
    this.alive[i] = 1;
    this.live++;
    return i;
  }
  kill(i) { if (this.alive[i]) { this.alive[i] = 0; this.live--; } }
  liveCount() { return this.live; }
}

// Emplace a cone: a radially decaying pile centred on the vent, normalised so
// the total volume is exactly what erupted. Shape matters -- a Gaussian makes
// a dome, while real edifices have a concave profile that is steep near the
// summit and flattens into the apron. exp(-(r/a)^1.4) is close enough and
// costs nothing.
function emplaceCone(world, vx, vy, radius, volume, felsic, rockType) {
  const { crust, crustHash, pointArea } = world;
  const idx = [], wts = [];
  let wsum = 0;
  crustHash.forEachInRadius(vx, vy, radius, (p, d2) => {
    if (!crust.alive[p]) return;
    const r = Math.sqrt(d2) / radius;
    const w = Math.exp(-Math.pow(r * 1.9, 1.4));
    if (w < 1e-3) return;
    idx.push(p); wts.push(w); wsum += w;
  });
  if (wsum <= 0) return { peak: 0, placed: 0 };

  // Distribute the volume across the cone, but no point may carry more than a
  // stable edifice height: past that the flanks fail and the debris ends up in
  // the apron. Enforcing it as a hard per-point ceiling with redistribution --
  // rather than by reshaping the profile once -- is what actually holds the
  // limit, because a vent erupts over and over onto the same summit and a
  // per-eruption test never sees the accumulated pile.
  const cap = world.cfg.edificeMax;
  const give = new Float64Array(idx.length);
  let left = volume;
  for (let pass = 0; pass < 4 && left > 1e-9 && wsum > 0; pass++) {
    const scale = left / (wsum * pointArea);
    let spilled = 0, nextW = 0;
    for (let k = 0; k < idx.length; k++) {
      if (wts[k] <= 0) continue;
      const room = cap - (crust.edifice[idx[k]] + give[k]);
      const want = scale * wts[k];
      if (room <= 1e-9) { spilled += want * pointArea; wts[k] = 0; continue; }
      const take = Math.min(want, room);
      give[k] += take;
      spilled += (want - take) * pointArea;
      if (want - take > 1e-9) { wts[k] = 0; } else { nextW += wts[k]; }
    }
    left = spilled;
    wsum = nextW;
  }

  let peak = 0, placed = 0;
  for (let k = 0; k < idx.length; k++) {
    const h = give[k];
    // Anything skipped here has to be reported, not quietly dropped: the
    // caller credits the mass ledger with what was actually emplaced, and a
    // silent drop here showed up as a steady negative drift in conservation.
    if (h <= 1e-9) continue;
    pushTop(crust, idx[k], h, rockType, felsic, world.t);
    crust.edifice[idx[k]] += h;
    placed += h * pointArea;
    if (h > peak) peak = h;
  }
  return { peak, placed };
}

export function volcanicEdifices(world) {
  const { cfg, crust, crustHash, plates, pointArea, W, H } = world;
  if (!cfg.volcanoesEnabled) return;
  const dt = cfg.dt;
  const V = world.volcanoes || (world.volcanoes = new Volcanoes());

  // --- 1. carry existing vents with their plate --------------------------
  // An arc volcano is built on the overriding plate and rides with it. A
  // hotspot shield is built on a plate too -- the SOURCE is fixed in the
  // mantle, but the cone it built is not, which is the whole reason island
  // chains exist. Either way the edifice moves with the crust under it.
  const vel = [0, 0];
  for (let i = 0; i < V.n; i++) {
    if (!V.alive[i]) continue;
    const pl = plates.get(V.plate[i]);
    if (pl && pl.alive) {
      pl.velAtWorld(V.x[i], V.y[i], W, H, vel);
      V.x[i] = ((V.x[i] + vel[0] * dt) % W + W) % W;
      V.y[i] = ((V.y[i] + vel[1] * dt) % H + H) % H;
    }
    else if (!pl || !pl.alive) { V.kill(i); continue; }
    V.idle[i] += dt;
    V.vigour[i] *= Math.exp(-dt / cfg.volcanoMemory);
    // A vent that has not erupted in a long time is extinct. Its cone stays --
    // that is what a seamount chain is -- but it stops capturing melt.
    if (V.idle[i] > cfg.volcanoLifetime) V.kill(i);
  }

  // Flexural support is not permanent. Over tens of Myr the plate relaxes
  // under the load and a compensating root grows, so an old edifice settles
  // toward the Airy elevation its mass alone would give. That is why ancient
  // seamounts are drowned and young ones are islands.
  const keep = Math.exp(-dt / cfg.edificeRelax);
  for (let p = 0; p < crust.n; p++) if (crust.alive[p]) crust.edifice[p] *= keep;

  // --- 2. capture melt into vents ----------------------------------------
  const capture = cfg.spacing ? cfg.spacing * cfg.volcanoCaptureRange
                              : world.spacing * cfg.volcanoCaptureRange;
  const claimed = world.scratch.vClaim
    || (world.scratch.vClaim = new Int32Array(crust.capacity));
  if (claimed.length < crust.capacity) world.scratch.vClaim = new Int32Array(crust.capacity);
  claimed.fill(-1, 0, crust.n);

  // Each point goes to its NEAREST vent. First-come claiming gave whole
  // swaths to whichever vent happened to be created first, which put mafic
  // plume melt into andesitic arc cones and erased the shields entirely.
  const cdist = world.scratch.vDist
    || (world.scratch.vDist = new Float32Array(crust.capacity));
  if (cdist.length < crust.capacity) world.scratch.vDist = new Float32Array(crust.capacity);
  cdist.fill(Infinity, 0, crust.n);
  for (let i = 0; i < V.n; i++) {
    if (!V.alive[i]) continue;
    crustHash.forEachInRadius(V.x[i], V.y[i], capture, (p, d2) => {
      if (!crust.alive[p]) return;
      if (d2 < cdist[p]) { cdist[p] = d2; claimed[p] = i; }
    });
  }

  // --- 3. nucleate new vents where melt is rising and nothing claims it ---
  // Candidates are sorted by melt so the biggest supply gets the vent, and a
  // minimum separation keeps them as discrete centres rather than a ridge.
  const cands = [];
  for (let p = 0; p < crust.n; p++) {
    if (!crust.alive[p] || claimed[p] >= 0) continue;
    if (crust.melt[p] < cfg.volcanoNucleateMelt) continue;
    cands.push(p);
  }
  cands.sort((a, b) => crust.melt[b] - crust.melt[a]);
  const sep = cfg.volcanoSpacing * (cfg.spacing || world.spacing);
  const sep2 = sep * sep;
  // Bucket the vents on a grid one separation across, so the minimum-distance
  // test is nine cells rather than a scan of every vent. With a thousand vents
  // and tens of thousands of candidates the scan was the whole step.
  const bw = Math.max(1, Math.floor(W / sep)), bh = Math.max(1, Math.floor(H / sep));
  const buckets = new Map();
  const key = (bx, by) => ((by % bh + bh) % bh) * bw + ((bx % bw + bw) % bw);
  const put = (i) => {
    const k = key(Math.floor(V.x[i] / W * bw), Math.floor(V.y[i] / H * bh));
    let a = buckets.get(k); if (!a) buckets.set(k, a = []);
    a.push(i);
  };
  for (let i = 0; i < V.n; i++) if (V.alive[i]) put(i);
  const nearAny = (x, y) => {
    const bx = Math.floor(x / W * bw), by = Math.floor(y / H * bh);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = buckets.get(key(bx + dx, by + dy));
      if (!a) continue;
      for (const i of a) {
        if (!V.alive[i]) continue;
        let ex = x - V.x[i]; if (ex > W / 2) ex -= W; if (ex < -W / 2) ex += W;
        let ey = y - V.y[i]; if (ey > H / 2) ey -= H; if (ey < -H / 2) ey += H;
        if (ex * ex + ey * ey < sep2) return true;
      }
    }
    return false;
  };
  for (const p of cands) {
    if (V.liveCount() >= cfg.volcanoMax) break;
    if (nearAny(crust.x[p], crust.y[p])) continue;
    // Felsic melt builds a steep stratocone; mafic melt builds a shield.
    const kind = crust.meltFelsic[p] > 0.45 ? 0 : 1;
    const v = V.spawn(crust.x[p], crust.y[p], crust.plate[p], kind, world.t);
    if (v < 0) break;
    put(v);
    crustHash.forEachInRadius(crust.x[p], crust.y[p], capture, (q, d2) => {
      if (crust.alive[q] && d2 < cdist[q]) { cdist[q] = d2; claimed[q] = v; }
    });
  }

  // --- 4. erupt ------------------------------------------------------------
  // Pool each vent's captured melt, drain it from the host points, and build.
  const pooled = new Float64Array(V.n);
  const pooledF = new Float64Array(V.n);
  const took = world.scratch.vTook
    || (world.scratch.vTook = new Float32Array(crust.capacity));
  if (took.length < crust.capacity) world.scratch.vTook = new Float32Array(crust.capacity);
  took.fill(0, 0, crust.n);
  for (let p = 0; p < crust.n; p++) {
    if (!crust.alive[p]) continue;
    const v = claimed[p];
    if (v < 0 || !V.alive[v]) continue;
    const m = crust.melt[p];
    if (m <= 1e-6) continue;
    const take = m * cfg.meltEruptFrac * dt;
    if (take <= 1e-9) continue;
    crust.melt[p] = m - take;
    took[p] = take;
    pooled[v] += take * pointArea;
    pooledF[v] += take * pointArea * crust.meltFelsic[p];
  }

  let built = 0, erupting = 0;
  const leftover = new Float64Array(V.n);
  for (let i = 0; i < V.n; i++) {
    if (!V.alive[i] || pooled[i] <= 1e-6) continue;
    const felsic = pooledF[i] / pooled[i];
    // A shield spreads its lava far; a stratocone piles it up. This is the
    // viscosity contrast between basalt and andesite, and it is the only
    // reason the two look nothing alike.
    const radius = (cfg.spacing || world.spacing)
      * (V.kind[i] === 1 ? cfg.shieldRadius : cfg.stratoRadius);
    const rock = felsic > 0.5 ? ROCK.ANDESITE : ROCK.BASALT;
    const { peak, placed } = emplaceCone(world, V.x[i], V.y[i], radius,
      pooled[i], felsic, rock);
    V.height[i] += peak;
    V.vigour[i] += placed / dt;
    // Only a real eruption resets the clock. A column holds melt for tens of
    // Myr after the arc that fed it has moved on, and a vent sipping that
    // residue was counting as active forever -- which is how extinct arcs
    // ended up drifting a thousand kilometres into continental interiors and
    // still erupting there. Below this rate the vent is dying, not alive.
    if (placed / dt > cfg.volcanoMinRate) V.idle[i] = 0;
    // Only what reached the ground is mass. Whatever could not be emplaced --
    // no live crust in reach, or rounding -- goes back into the reservoir it
    // came from rather than evaporating.
    world.budget.created += placed;
    built += placed;
    leftover[i] = pooled[i] - placed;
    if (placed > 0) erupting++;
  }

  // Hand unemplaced melt back to the columns it was drained from, in the
  // proportion they contributed, so nothing is created or destroyed here.
  let owed = 0;
  for (let i = 0; i < V.n; i++) owed += leftover[i];
  if (owed > 1e-9) {
    for (let p = 0; p < crust.n; p++) {
      if (!crust.alive[p]) continue;
      const v = claimed[p];
      if (v < 0 || leftover[v] <= 0 || pooled[v] <= 0) continue;
      crust.melt[p] += (leftover[v] / pooled[v]) * took[p];
    }
  }

  world.volcanoBuilt = built;
  world.volcanoActive = erupting;
  world.volcanoCount = V.liveCount();
}
