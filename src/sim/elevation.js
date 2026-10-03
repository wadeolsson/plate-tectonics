// Elevation is derived, never painted. Height is a pure function of crustal
// thickness, lithospheric thickness, density and seafloor age. No code path
// anywhere in this project writes an elevation; if something needs to be
// higher it gets thicker or younger.

export function smoothstep(lo, hi, t) {
  if (hi === lo) return t < lo ? 0 : 1;
  let x = (t - lo) / (hi - lo);
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

const mix = (a, b, t) => a + (b - a) * t;

// --- empirical age-bathymetry model -------------------------------------
// NOT half-space cooling: the sqrt law is the well-established part and holds
// to ~70-80 Myr, after which real seafloor flattens. Blend the two regimes
// with a smoothstep. A pure exponential would be linear in age at small t and
// would discard the sqrt relation entirely.
export function oceanDepthMetres(cfg, ageMyr) {
  const t = Math.max(0, ageMyr);
  const w = smoothstep(cfg.coolingBlendLo, cfg.coolingBlendHi, t);
  const sqrtPart = cfg.ridgeDepth + cfg.coolingCoef * Math.sqrt(t);
  return (1 - w) * sqrtPart + w * cfg.coolingFlatten;
}

// --- two-layer Airy isostasy --------------------------------------------
// Crust over mantle lithosphere over asthenosphere. The lithospheric term is
// what lets a thick depleted craton stand high and stable and stops the DATUM
// from silently doing that work.
export function isostaticElevation(cfg, thickness, continental, litho) {
  const rhoC = mix(cfg.rhoCrustOcean, cfg.rhoCrustCont, continental);
  const rhoL = mix(cfg.rhoLithOcean, cfg.rhoLithCont, continental);
  const rhoM = cfg.rhoMantle;
  return thickness * (1 - rhoC / rhoM) + litho * (1 - rhoL / rhoM) - cfg.datum;
}

// Mixed crust interpolates between the isostatic and age-depth results. The
// transition zone IS the continental shelf and slope, so the blend has to be
// smooth or every coastline gets a cliff.
export function elevationOf(cfg, thickness, continental, litho, age, edifice = 0) {
  const iso = isostaticElevation(cfg, thickness, continental, litho);
  const rhoC = mix(cfg.rhoCrustOcean, cfg.rhoCrustCont, continental);
  // The age-depth curve describes seafloor of NORMAL crustal thickness. Crust
  // thicker than that floats higher, by Airy: without this term an oceanic
  // plateau or a young island arc has no bathymetric expression at all, and
  // nothing built on ocean floor can ever emerge.
  const excess = (thickness - cfg.thickOcean) * (1 - rhoC / cfg.rhoMantle);
  const oceanic = -oceanDepthMetres(cfg, age) / 1000 + excess;
  const w = smoothstep(0.12, 0.62, continental);
  // The edifice rides on top, largely uncompensated (see pointsets.js).
  return mix(oceanic, iso, w) + edifice * cfg.edificeSupport;
}

// Vectorised form for the rasterised grid.
export function elevationField(cfg, thickness, continental, litho, age, out, edifice = null) {
  const n = thickness.length;
  const rhoM = cfg.rhoMantle;
  for (let i = 0; i < n; i++) {
    const c = continental[i];
    const rhoC = mix(cfg.rhoCrustOcean, cfg.rhoCrustCont, c);
    const rhoL = mix(cfg.rhoLithOcean, cfg.rhoLithCont, c);
    const iso = thickness[i] * (1 - rhoC / rhoM) + litho[i] * (1 - rhoL / rhoM) - cfg.datum;
    const t = Math.max(0, age[i]);
    const w2 = smoothstep(cfg.coolingBlendLo, cfg.coolingBlendHi, t);
    const excess = (thickness[i] - cfg.thickOcean) * (1 - rhoC / rhoM);
    const oceanic = -((1 - w2) * (cfg.ridgeDepth + cfg.coolingCoef * Math.sqrt(t))
                    + w2 * cfg.coolingFlatten) / 1000 + excess;
    const w = smoothstep(0.12, 0.62, c);
    out[i] = oceanic + (iso - oceanic) * w + (edifice ? edifice[i] * cfg.edificeSupport : 0);
  }
  return out;
}

// --- lithosphere evolution ----------------------------------------------
export function lithoTarget(cfg, continental, age, defAge) {
  const oceanic = Math.min(cfg.lithoOceanMax, cfg.lithoOceanCoef * Math.sqrt(Math.max(0, age)));
  const cont = Math.min(cfg.lithoContMax, cfg.lithoContNew + cfg.lithoContGrow * Math.max(0, defAge));
  return mix(oceanic, cont, smoothstep(0.1, 0.65, continental));
}

export function updateLithosphere(world) {
  const { cfg, crust } = world;
  const dt = cfg.dt;
  const k = 1 - Math.exp(-cfg.lithoRelax * dt);
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    crust.age[i] += dt;
    crust.defAge[i] += dt;
    const target = lithoTarget(cfg, crust.continental[i], crust.age[i], crust.defAge[i]);
    crust.litho[i] += (target - crust.litho[i]) * k;
    if (crust.litho[i] < 4) crust.litho[i] = 4;
  }
}

// --- dynamic sea level ---------------------------------------------------
// Total ocean water is fixed. When a lot of young, shallow seafloor exists the
// basins hold less water and sea level rises, flooding continental margins --
// the Cretaceous epicontinental seas.
export function solveSeaLevel(cfg, elevGrid, cellArea, targetVolume) {
  let lo = -8, hi = 6;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) * 0.5;
    let vol = 0;
    for (let i = 0; i < elevGrid.length; i++) {
      const d = mid - elevGrid[i];
      if (d > 0) vol += d;
    }
    vol *= cellArea;
    if (vol > targetVolume) hi = mid; else lo = mid;
  }
  return (lo + hi) * 0.5;
}

export function waterVolume(elevGrid, level, cellArea) {
  let vol = 0;
  for (let i = 0; i < elevGrid.length; i++) {
    const d = level - elevGrid[i];
    if (d > 0) vol += d;
  }
  return vol * cellArea;
}
