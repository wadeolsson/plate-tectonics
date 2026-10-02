// Quantities that follow from the crustal and lithospheric state without any
// extra simulation. They are computed from the RASTERISED fields, for the same
// reason elevation is: they are nonlinear in thickness and lithospheric depth,
// and interpolating the result instead of the inputs smears every boundary.

const TWO_PI_G = 4.19343e-10;      // 2*pi*G, m^3 kg^-1 s^-2
const MGAL = 1e5;                  // m/s^2 -> mGal

// --- surface heat flow ----------------------------------------------------
// Conduction through the lithosphere plus radiogenic production in the crust.
// Oceanic lithosphere thickens as sqrt(age), so this reproduces the observed
// 1/sqrt(age) fall-off automatically: hundreds of mW/m^2 at a ridge axis,
// ~40 over old sea floor, 40-55 over a craton where a thick conductive lid is
// offset by radiogenic granite above it.
export function heatFlowField(cfg, litho, thickness, continental, out) {
  const k = cfg.thermalConductivity;
  const dT = cfg.asthenosphereT;
  const A = cfg.crustHeatProduction;      // W/m^3 at continental = 1
  for (let i = 0; i < out.length; i++) {
    const L = Math.max(cfg.heatFlowMinLitho, litho[i]) * 1000;   // km -> m
    const conduct = k * dT / L;
    const radio = A * continental[i] * thickness[i] * 1000;
    out[i] = (conduct + radio) * 1000;    // W/m^2 -> mW/m^2
  }
  return out;
}

// --- gravity --------------------------------------------------------------
// Free air is the mass anomaly of the whole column against a reference column,
// down to a compensation depth. Anywhere isostasy balances, it is zero -- so
// what the map shows is precisely what is NOT compensated: trenches, thickened
// crust that has not yet found its level, plateaux, young loads.
//
// The reference is blended between an oceanic and a continental column exactly
// as the elevation model blends its two branches. It has to be: oceanic depth
// comes from the empirical age-depth curve rather than from floating a column,
// so referencing the ocean against a continental column would report a
// permanent 400 mGal step at every coastline and drown everything real.
export function gravityFields(cfg, thickness, continental, litho, age, elevation, bouguer, freeAir) {
  const rhoM = cfg.rhoMantle, rhoW = 1030;
  const D = cfg.gravityCompensationDepth * 1000;

  // Continental reference: normal crust on a mature root, at sea level.
  const t0 = cfg.gravityRefCrust * 1000, L0 = cfg.gravityRefLitho * 1000;
  const M0cont = cfg.rhoCrustCont * t0 + cfg.rhoLithCont * L0 + rhoM * (D - t0 - L0);

  // Oceanic reference: normal crust of the local age, sitting at the depth the
  // age-depth curve puts it. Tabulated, because this runs once per grid cell
  // per frame and the sqrt and smoothstep inside it are the whole cost.
  const tO = cfg.thickOcean * 1000;
  const N = 256, AGE_MAX = 400;
  const tab = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const a = (k / (N - 1)) * AGE_MAX;
    const L = Math.min(cfg.lithoOceanMax, cfg.lithoOceanCoef * Math.sqrt(a)) * 1000;
    const e = -oceanDepth(cfg, a);
    tab[k] = cfg.rhoCrustOcean * tO + cfg.rhoLithOcean * L
           + rhoM * (D + e - tO - L) + rhoW * (-e);
  }
  const refOcean = (a) => {
    let k = (Math.max(0, a) / AGE_MAX) * (N - 1);
    if (k >= N - 1) return tab[N - 1];
    const i0 = k | 0, f = k - i0;
    return tab[i0] + (tab[i0 + 1] - tab[i0]) * f;
  };

  for (let i = 0; i < thickness.length; i++) {
    const c = continental[i];
    const rhoC = cfg.rhoCrustOcean + (cfg.rhoCrustCont - cfg.rhoCrustOcean) * c;
    const rhoL = cfg.rhoLithOcean + (cfg.rhoLithCont - cfg.rhoLithOcean) * c;
    const t = thickness[i] * 1000, L = litho[i] * 1000, e = elevation[i] * 1000;

    let M = rhoC * t + rhoL * L + rhoM * (D + e - t - L);
    if (e < 0) M += rhoW * (-e);

    const w = smooth(0.12, 0.62, c);
    const M0 = refOcean(age[i]) * (1 - w) + M0cont * w;

    freeAir[i] = TWO_PI_G * (M - M0) * MGAL;
    // Bouguer correction: strip the topographic slab on land, fill the ocean
    // with rock at sea. What remains reads as the crustal root.
    bouguer[i] = e >= 0
      ? freeAir[i] - TWO_PI_G * rhoC * e * MGAL
      : freeAir[i] + TWO_PI_G * (rhoC - rhoW) * (-e) * MGAL;
  }
}

function smooth(lo, hi, t) {
  let x = (t - lo) / (hi - lo);
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

function oceanDepth(cfg, a) {
  const t = Math.max(0, a);
  const w = smooth(cfg.coolingBlendLo, cfg.coolingBlendHi, t);
  return (1 - w) * (cfg.ridgeDepth + cfg.coolingCoef * Math.sqrt(t)) + w * cfg.coolingFlatten;
}

// --- strain rate ----------------------------------------------------------
// Deformation is concentrated at plate boundaries, so the field is built by
// splatting each boundary edge's relative velocity over the width it is
// actually taken up across. Units are nanostrain per year, which is how
// published global strain-rate maps are scaled.
export function strainRateField(world, raster, out) {
  const { boundaries, spacing } = world;
  const { gw, gh, cw, ch } = raster;
  out.fill(0);
  // Wide enough that the zone has a visible falloff rather than a hard edge:
  // real deformation is distributed across a belt, not a line.
  const R = spacing * 3.4;
  const sigma = spacing * 1.5;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const rx = Math.max(1, Math.ceil(R / cw));
  const ry = Math.max(1, Math.ceil(R / ch));

  for (let e = 0; e < boundaries.count; e++) {
    const rate = boundaries.rate[e];
    if (rate <= 0) continue;
    // km/Myr across a zone ~one point spacing wide, expressed per year.
    const eps = (rate / spacing) * 1e-6 * 1e9;      // 1/Myr -> nanostrain/yr
    const px = boundaries.mx[e] / cw, py = boundaries.my[e] / ch;
    const gx0 = Math.floor(px), gy0 = Math.floor(py);
    for (let dy = -ry; dy <= ry; dy++) {
      const gy = ((gy0 + dy) % gh + gh) % gh;
      const ddy = (gy0 + dy + 0.5 - py) * ch;
      for (let dx = -rx; dx <= rx; dx++) {
        const ddx = (gx0 + dx + 0.5 - px) * cw;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > R * R) continue;
        const gx = ((gx0 + dx) % gw + gw) % gw;
        const c = gy * gw + gx;
        const v = eps * Math.exp(-d2 * inv2s2);
        if (v > out[c]) out[c] = v;      // a boundary is a maximum, not a sum
      }
    }
  }
  return out;
}
