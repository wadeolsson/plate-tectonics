// Palettes. The hypsometric ramp has a hard break at sea level by design --
// that discontinuity is the coastline and it is what makes the map legible.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function ramp(stops) {
  return (t) => {
    t = clamp01(t);
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const f = (t - t0) / Math.max(1e-9, t1 - t0);
        return [
          c0[0] + (c1[0] - c0[0]) * f,
          c0[1] + (c1[1] - c0[1]) * f,
          c0[2] + (c1[2] - c0[2]) * f,
        ];
      }
    }
    return stops[stops.length - 1][1];
  };
}

export const bathymetry = ramp([
  [0.00, [4, 12, 38]],
  [0.30, [8, 32, 78]],
  [0.60, [16, 62, 122]],
  [0.82, [34, 102, 163]],
  [0.95, [70, 146, 196]],
  [1.00, [132, 189, 220]],
]);

export const hypsometric = ramp([
  [0.00, [58, 110, 66]],
  [0.12, [96, 142, 74]],
  [0.30, [160, 170, 92]],
  [0.50, [190, 160, 96]],
  [0.68, [160, 120, 84]],
  [0.82, [132, 104, 92]],
  [0.92, [186, 182, 180]],
  [1.00, [252, 252, 255]],
]);

export const ageRamp = ramp([
  [0.00, [216, 38, 44]],
  [0.12, [242, 110, 40]],
  [0.26, [248, 196, 52]],
  [0.42, [176, 212, 70]],
  [0.58, [66, 182, 122]],
  [0.74, [44, 150, 190]],
  [0.88, [56, 82, 172]],
  [1.00, [96, 44, 146]],
]);

export const crustRamp = ramp([
  [0.00, [26, 62, 104]],
  [0.35, [58, 104, 128]],
  [0.55, [150, 142, 106]],
  [1.00, [214, 196, 152]],
]);

// Brighter than the map ramp. In section the crust is a thin band sitting on
// a hundred km of lithosphere, so it has to hold its own against it rather
// than blend into the sea above and the mantle below.
export const crustSection = ramp([
  [0.00, [70, 128, 186]],
  [0.35, [116, 156, 178]],
  [0.55, [198, 184, 132]],
  [1.00, [242, 224, 176]],
]);

export const weaknessRamp = ramp([
  [0.00, [18, 18, 26]],
  [0.35, [78, 42, 96]],
  [0.70, [196, 78, 92]],
  [1.00, [255, 226, 150]],
]);

export const slabRamp = ramp([
  [0.00, [255, 236, 170]],
  [0.35, [246, 154, 64]],
  [0.70, [180, 60, 92]],
  [1.00, [60, 24, 92]],
]);

// Thermal: cold dark rock through to incandescent. Reads the same way a
// heat-flow map does in print.
export const heatRamp = ramp([
  [0.00, [18, 20, 44]],
  [0.25, [76, 32, 104]],
  [0.48, [172, 50, 78]],
  [0.70, [236, 122, 40]],
  [0.88, [250, 202, 78]],
  [1.00, [255, 250, 220]],
]);

// Diverging, symmetric about zero: gravity anomalies are signed and the sign
// is the whole point.
export const gravityRamp = ramp([
  [0.00, [26, 48, 120]],
  [0.25, [72, 130, 194]],
  [0.46, [186, 210, 226]],
  [0.50, [238, 238, 238]],
  [0.54, [232, 206, 176]],
  [0.75, [206, 112, 60]],
  [1.00, [120, 22, 28]],
]);

// Basement age: young orogens warm, cratons cold and dark, the way a
// basement-province map is drawn.
export const provinceRamp = ramp([
  [0.00, [246, 122, 60]],
  [0.14, [232, 176, 70]],
  [0.32, [150, 186, 96]],
  [0.52, [72, 162, 146]],
  [0.72, [54, 104, 168]],
  [0.88, [76, 56, 140]],
  [1.00, [42, 26, 72]],
]);

// Strain rate: black where nothing is happening, hot where it is.
export const strainRamp = ramp([
  [0.00, [10, 12, 20]],
  [0.18, [24, 52, 96]],
  [0.42, [40, 150, 170]],
  [0.68, [188, 216, 96]],
  [0.86, [248, 186, 58]],
  [1.00, [255, 248, 230]],
]);

// Mantle temperature anomaly: cold downwellings blue, hot upwellings red,
// with a neutral band so the ambient mantle does not shout.
export const mantleRamp = ramp([
  [0.00, [22, 46, 110]],
  [0.28, [48, 104, 166]],
  [0.46, [36, 40, 54]],
  [0.54, [54, 40, 40]],
  [0.74, [194, 86, 48]],
  [1.00, [255, 212, 120]],
]);

export const stressRamp = ramp([
  [0.00, [30, 74, 168]],     // compression
  [0.48, [20, 22, 30]],
  [0.52, [20, 22, 30]],
  [1.00, [200, 54, 44]],     // extension
]);

// Hue from obliquity, width from rate. This single choice is most of the
// difference between a map that looks like a textbook diagram and one that
// looks like an actual tectonic map: 0 = pure convergence, pi/2 = pure
// transform, pi = pure divergence, and everything real lives in between.
export function obliquityColor(ob) {
  const t = clamp01(ob / Math.PI);
  return ramp([
    [0.00, [222, 62, 48]],    // convergent, red
    [0.35, [214, 120, 52]],
    [0.50, [236, 206, 86]],   // transform, yellow
    [0.65, [104, 196, 132]],
    [1.00, [58, 138, 226]],   // divergent, blue
  ])(t);
}

export function plateColor(hue, alive = true) {
  const h = hue * 360;
  const s = alive ? 0.42 : 0.12;
  const l = alive ? 0.55 : 0.3;
  return hslToRgb(h, s, l);
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// A 256-entry lookup per ramp. buildImage evaluates a ramp once per grid cell
// per frame; walking the stop list each time is the single biggest cost in the
// draw path.
const _luts = new Map();
export function lut(ramp, n = 256) {
  let t = _luts.get(ramp);
  if (t && t.n === n) return t;
  const a = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = ramp(i / (n - 1));
    a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2];
  }
  t = { n, a };
  _luts.set(ramp, t);
  return t;
}

export const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
