import { wrapPos } from '../core/torus.js';

// Plate motions are prescribed and perturbed, not solved from mantle
// convection. Slab pull is the piece worth the effort: it is the dominant
// driver on the real Earth, and it closes the loop between boundary processes
// and plate kinematics, which is what makes the system self-organising rather
// than merely random.
export function updateVelocities(world) {
  const { cfg, plates, slabs, boundaries, rng, pointArea } = world;
  const dt = cfg.dt;

  // Velocities come from a force balance against viscous drag, not from a
  // random walk fighting a damping term -- that arrangement sets the
  // equilibrium speed to sigma/sqrt(2*damping) and quietly strands every plate
  // at a few km/Myr no matter what the driving forces are doing.
  //
  //     dv/dt = (background + slab pull + ridge push) - drag * v
  //
  // so a plate's steady speed is force/drag and the sliders mean something.
  // The background term is an Ornstein-Uhlenbeck process on the FORCE with a
  // long correlation time, which gives smooth, persistent drift instead of
  // per-step jitter.

  // --- slab pull, integrated over coherent slabs -----------------------
  // Summing independent points would let a shredded slab pull as hard as a
  // continuous one, so accumulate per slab_id and weight by coherence.
  for (const p of plates.alive()) { p.slabPullX = 0; p.slabPullY = 0; }
  const bySlab = new Map();
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i]) continue;
    const c = slabs.coupling[i];
    if (c < 0.04) continue;
    let s = bySlab.get(slabs.slabId[i]);
    if (!s) bySlab.set(slabs.slabId[i], s = { fx: 0, fy: 0, plate: slabs.parentPlate[i], maxAlong: 0 });
    const neg = negativeBuoyancy(cfg, slabs, i);
    s.fx += slabs.dirX[i] * neg * c;
    s.fy += slabs.dirY[i] * neg * c;
    if (slabs.along[i] > s.maxAlong) s.maxAlong = slabs.along[i];
  }
  for (const s of bySlab.values()) {
    const p = plates.get(s.plate);
    if (!p || !p.alive) continue;
    const coherence = Math.min(1, s.maxAlong / cfg.rollbackLengthRef);
    p.slabPullX += s.fx * (0.35 + 0.65 * coherence);
    p.slabPullY += s.fy * (0.35 + 0.65 * coherence);
  }

  // --- ridge push (much weaker) ----------------------------------------
  const push = new Map();
  for (let e = 0; e < boundaries.count; e++) {
    if (boundaries.vn[e] <= 0) continue;
    const wgt = boundaries.vn[e] * boundaries.len[e];
    accum(push, boundaries.plateA[e], -boundaries.nx[e] * wgt, -boundaries.ny[e] * wgt);
    accum(push, boundaries.plateB[e], boundaries.nx[e] * wgt, boundaries.ny[e] * wgt);
  }

  let totMx = 0, totMy = 0, totArea = 0;
  const tauF = cfg.forceCorrelation;
  const kOU = Math.exp(-dt / tauF);
  const sOU = cfg.bgForce * Math.sqrt(1 - kOU * kOU);

  for (const p of plates.alive()) {
    // Background drive: everything not explicitly modelled (basal traction,
    // mantle flow). Persistent, not jittery.
    p.bgX = (p.bgX || 0) * kOU + rng.normal(0, sOU);
    p.bgY = (p.bgY || 0) * kOU + rng.normal(0, sOU);
    p.bgW = (p.bgW || 0) * kOU + rng.normal(0, sOU * cfg.bgTorque);

    // Slab pull, normalised by how many crust points the plate has, so the
    // force is "how much of this plate's edge is being pulled down" rather
    // than an absolute point count.
    const nPts = Math.max(1, p.area / pointArea);
    const inv = 1 / (nPts * cfg.slabPullRef);
    let fx = p.bgX + cfg.slabPullGain * p.slabPullX * inv;
    let fy = p.bgY + cfg.slabPullGain * p.slabPullY * inv;

    // Basal traction from the convecting mantle underneath. This is the main
    // driver now; the plate is dragged toward whatever the flow beneath it is
    // doing, and slab pull modifies that rather than being the whole story.
    if (cfg.mantleEnabled && world.mantle) {
      fx += cfg.basalDrag * (p.basalX || 0);
      fy += cfg.basalDrag * (p.basalY || 0);
    }

    const pu = push.get(p.id);
    if (pu) {
      const pinv = cfg.ridgePushGain / Math.max(1, p.area);
      fx += pu[0] * pinv; fy += pu[1] * pinv;
    }

    p.driveX = fx; p.driveY = fy;
    p.vx += (fx - cfg.drag * p.vx) * dt;
    p.vy += (fy - cfg.drag * p.vy) * dt;
    // Shear across the base of the plate spins it. A plate straddling a
    // divergent cell and a convergent one feels a real couple, which is where
    // most plate rotation on Earth comes from.
    const basalTq = (cfg.mantleEnabled && world.mantle)
      ? cfg.basalDrag * cfg.basalTorqueGain * (p.basalTorque || 0) : 0;
    if (p.rotOk) p.omega += (p.bgW + basalTq - cfg.drag * p.omega) * dt;

    const sp = Math.hypot(p.vx, p.vy);
    if (sp > cfg.speedMax) { p.vx *= cfg.speedMax / sp; p.vy *= cfg.speedMax / sp; }

    // Cap omega so the fastest point on the plate stays under the rim limit.
    const radius = Math.max(1, 0.5 * Math.hypot(p.extentX, p.extentY));
    const headroom = Math.max(0, cfg.rimSpeedCap - Math.min(sp, cfg.rimSpeedCap * 0.85));
    const omegaCap = p.rotOk ? Math.min(cfg.omegaMax, headroom / radius) : 0;
    if (Math.abs(p.omega) > omegaCap) p.omega = Math.sign(p.omega) * omegaCap;

    totMx += p.vx * p.area; totMy += p.vy * p.area; totArea += p.area;
  }

  // Damp net momentum so the whole system does not drift across the torus.
  if (totArea > 0) {
    const dx = (totMx / totArea) * cfg.momentumDamping;
    const dy = (totMy / totArea) * cfg.momentumDamping;
    for (const p of plates.alive()) { p.vx -= dx; p.vy -= dy; }
  }
}

// Negative buoyancy of one slab point: cold dense lithosphere pulls down,
// crust (especially continental crust) resists.
export function negativeBuoyancy(cfg, slabs, i) {
  const thermal = 0.35 + 0.65 * Math.min(1, Math.sqrt(Math.max(0, slabs.ageAtSub[i])) / 11);
  const lith = slabs.litho[i] / cfg.lithoOceanMax;
  const buoyantCrust = 1 - 0.9 * slabs.continental[i];
  // Eclogitised crust is denser than the mantle around it, so a slab that has
  // converted pulls appreciably harder than one that has not. This is the
  // feedback that makes descent self-reinforcing.
  const eclog = 1 + cfg.eclogitePullGain * (slabs.eclogite ? slabs.eclogite[i] : 0);
  return thermal * (0.45 + 0.55 * lith) * Math.max(0, buoyantCrust) * eclog;
}

function accum(map, id, x, y) {
  const v = map.get(id);
  if (v) { v[0] += x; v[1] += y; } else map.set(id, [x, y]);
}

// Forward Euler is fine at 1 Myr steps: velocities are constant within a step
// and there is no stiff coupling. Advection happens in each plate's unwrapped
// frame; the wrapped render position is then derived from it.
export function advect(world) {
  const { cfg, crust, slabs, plates, W, H } = world;
  const dt = cfg.dt;
  const n = plates.count;
  const vx = new Float64Array(n), vy = new Float64Array(n), om = new Float64Array(n);
  const ucx = new Float64Array(n), ucy = new Float64Array(n), ok = new Uint8Array(n);
  for (const p of plates.alive()) {
    vx[p.id] = p.vx; vy[p.id] = p.vy;
    om[p.id] = p.rotOk ? p.omega : 0;
    ucx[p.id] = p.ucx; ucy[p.id] = p.ucy; ok[p.id] = 1;
  }

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const p = crust.plate[i];
    if (!ok[p]) continue;
    const dx = crust.ux[i] - ucx[p], dy = crust.uy[i] - ucy[p];
    crust.ux[i] += (vx[p] - om[p] * dy) * dt;
    crust.uy[i] += (vy[p] + om[p] * dx) * dt;
    crust.x[i] = wrapPos(crust.ux[i], W);
    crust.y[i] = wrapPos(crust.uy[i], H);
  }

  // A slab point travels down its own dip. One speed drives both components:
  // giving the vertical and horizontal parts independent rates (a "sink rate"
  // and a separately derived horizontal step) produces slabs whose geometry
  // does not match their stated dip, and a Wadati-Benioff zone that is flat no
  // matter what the dip says.
  //
  // The downdip speed is set by the trench that fed the point -- material
  // going in at the convergence rate has to travel downdip at that rate --
  // with negative buoyancy as a floor once the zone is gone. The trench's own
  // motion is added on top, so a rolling-back hinge drags its slab oceanward.
  for (let i = 0; i < slabs.n; i++) {
    if (!slabs.alive[i]) continue;
    const vdd = slabs.vdd[i];
    const dip = slabs.dip[i];
    const vx2 = slabs.dirX[i] * vdd * Math.cos(dip);
    const vy2 = slabs.dirY[i] * vdd * Math.cos(dip);
    const drift = world.trenchDrift ? world.trenchDrift.get(slabs.slabId[i]) : null;
    const dx2 = (vx2 + (drift ? drift[0] : 0)) * dt;
    const dy2 = (vy2 + (drift ? drift[1] : 0)) * dt;
    slabs.x[i] = wrapPos(slabs.x[i] + dx2, W);
    slabs.y[i] = wrapPos(slabs.y[i] + dy2, H);
    slabs.along[i] += vdd * dt;
  }
}

// Vertical descent rate. Older, colder crust sinks faster; buoyant
// continental material resists sharply, which is the mechanism behind
// collision-zone slab behaviour.
export function sinkRateOf(cfg, slabs, i) {
  const age = Math.max(0, slabs.ageAtSub[i]);
  const base = cfg.slabSinkBase + cfg.slabSinkAgeGain * Math.sqrt(age) * 10;
  return Math.max(0.4, base * (1 - cfg.slabSinkContResist * slabs.continental[i]));
}
