import { MAX_LAYERS } from '../core/pointsets.js';

// Crust as a stack of rock layers rather than a pair of scalars.
//
// `crust.thickness` and `crust.continental` are no longer primitives: they are
// caches recomputed from the column after every operation here. Everything that
// modifies crust goes through these functions, so the two can never drift
// apart -- and the validation suite asserts they haven't.
//
// Each layer carries its own felsic fraction alongside a named rock type. That
// matters for a reason worth stating: rock types have discrete compositions, so
// if a layer were snapped to the nearest named rock, adding 0.22-felsic
// material would land on basalt (0.05) or sediment (0.35) and the derived
// `continental` would no longer equal what the old scalar arithmetic produced.
// Carrying the exact fraction keeps the behaviour identical while the type
// supplies density, colour and metamorphic behaviour.

export const ROCK = {
  PERIDOTITE: 0,
  BASALT: 1,
  GABBRO: 2,
  SEDIMENT: 3,
  ANDESITE: 4,
  GRANITE: 5,
  FLOOD_BASALT: 6,
  GREENSTONE: 7,
  AMPHIBOLITE: 8,
  ECLOGITE: 9,
  SLATE: 10,
  SCHIST: 11,
  GNEISS: 12,
};

// density kg/m^3, nominal felsic fraction, display colour, short name, and
// resistance to weathering (1.0 = granite). Differential erosion is most of
// what gives a landscape structure rather than smooth domes: hard beds stand
// out as ridges and escarpments, soft ones are hollowed into valleys. The
// Appalachians are ridge-and-valley for exactly this reason.
export const ROCKS = [
  { id: 0,  name: 'peridotite',   rho: 3300, felsic: 0.00, color: [84, 92, 70], resist: 1.3 },
  { id: 1,  name: 'basalt',       rho: 2950, felsic: 0.05, color: [112, 142, 170], resist: 1.1 },
  { id: 2,  name: 'gabbro',       rho: 2950, felsic: 0.05, color: [74, 100, 134], resist: 1.2 },
  { id: 3,  name: 'sediment',     rho: 2400, felsic: 0.35, color: [226, 206, 152], resist: 0.35 },
  { id: 4,  name: 'andesite',     rho: 2750, felsic: 0.70, color: [196, 118, 96], resist: 0.9 },
  { id: 5,  name: 'granite',      rho: 2680, felsic: 0.95, color: [236, 164, 160], resist: 1.0 },
  { id: 6,  name: 'flood basalt', rho: 2900, felsic: 0.15, color: [142, 86, 78], resist: 1.05 },
  { id: 7,  name: 'greenstone',   rho: 2980, felsic: 0.10, color: [96, 150, 116], resist: 1.15 },
  { id: 8,  name: 'amphibolite',  rho: 3050, felsic: 0.15, color: [72, 124, 118], resist: 1.35 },
  { id: 9,  name: 'eclogite',     rho: 3500, felsic: 0.05, color: [128, 64, 96], resist: 1.4 },
  { id: 10, name: 'slate',        rho: 2600, felsic: 0.40, color: [120, 118, 134], resist: 0.55 },
  { id: 11, name: 'schist',       rho: 2700, felsic: 0.55, color: [158, 142, 170], resist: 0.75 },
  { id: 12, name: 'gneiss',       rho: 2750, felsic: 0.80, color: [206, 176, 196], resist: 1.25 },
];

// Pick a plausible named rock for material of a given composition. Used by the
// generic thickening façade, where the caller knows how continental the new
// material is but has not said what it actually is. Processes that DO know --
// arc magmatism, plume basalt, wedge sediment -- name the rock directly.
export function rockFor(felsic) {
  if (felsic < 0.12) return ROCK.BASALT;
  if (felsic < 0.30) return ROCK.FLOOD_BASALT;
  if (felsic < 0.52) return ROCK.SEDIMENT;
  if (felsic < 0.80) return ROCK.ANDESITE;
  return ROCK.GRANITE;
}

// ---------------------------------------------------------------------------
// cache maintenance
// ---------------------------------------------------------------------------
// Recompute the derived scalars from the column. Called after every mutation.
export function recompute(crust, i) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  let t = 0, f = 0;
  for (let k = 0; k < n; k++) {
    const h = crust.layerThick[base + k];
    t += h;
    f += h * crust.layerFelsic[base + k];
  }
  crust.thickness[i] = t;
  crust.continental[i] = t > 0 ? Math.min(1, f / t) : 0;
  return t;
}

// Volume-weighted density of the column, for isostasy. Strictly better than
// mixing two end members: an eclogitised slab or a sediment-loaded margin now
// weighs what its rocks actually weigh.
export function columnDensity(crust, i, fallback) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  let t = 0, m = 0;
  for (let k = 0; k < n; k++) {
    const h = crust.layerThick[base + k];
    t += h;
    m += h * ROCKS[crust.layerType[base + k]].rho;
  }
  return t > 0 ? m / t : fallback;
}

// ---------------------------------------------------------------------------
// column construction
// ---------------------------------------------------------------------------
// Build a plausible column for a point of a given bulk thickness and
// composition. Every layer starts at the bulk felsic fraction so the derived
// `continental` is exactly the value asked for; the TYPES give the stratigraphy
// and the colours, and compositions diverge from here as new material arrives.
export function initColumn(crust, i, thickness, felsic, age, cfg) {
  const base = i * MAX_LAYERS;
  crust.nLayers[i] = 0;
  const put = (h, type) => {
    if (h <= 1e-4) return;
    const k = crust.nLayers[i];
    if (k >= MAX_LAYERS) return;
    crust.layerThick[base + k] = h;
    crust.layerType[base + k] = type;
    crust.layerFelsic[base + k] = felsic;
    crust.layerAge[base + k] = age;
    crust.layerTmax[base + k] = 0;
    crust.nLayers[i] = k + 1;
  };

  if (felsic < 0.25) {
    // Oceanic: a thin extrusive pile over gabbro, in roughly the real ratio.
    put(thickness * 0.3, ROCK.BASALT);
    put(thickness * 0.7, ROCK.GABBRO);
  } else {
    // Continental: a sediment veneer, a granitic upper crust and a mafic lower
    // crust. Proportions are the conventional first-order picture.
    put(thickness * 0.06, ROCK.SEDIMENT);
    put(thickness * 0.49, ROCK.GRANITE);
    put(thickness * 0.45, ROCK.GABBRO);
  }
  recompute(crust, i);
}

// Copy one column over another, used when a point is created from neighbours.
export function copyColumn(crust, src, dst) {
  const a = src * MAX_LAYERS, b = dst * MAX_LAYERS;
  const n = crust.nLayers[src];
  for (let k = 0; k < n; k++) {
    crust.layerThick[b + k] = crust.layerThick[a + k];
    crust.layerType[b + k] = crust.layerType[a + k];
    crust.layerFelsic[b + k] = crust.layerFelsic[a + k];
    crust.layerAge[b + k] = crust.layerAge[a + k];
    crust.layerTmax[b + k] = crust.layerTmax[a + k];
  }
  crust.nLayers[dst] = n;
  recompute(crust, dst);
}

// ---------------------------------------------------------------------------
// mutation
// ---------------------------------------------------------------------------
// Add material on top of the column. If the topmost layer is already the same
// rock of nearly the same composition, thicken it rather than starting a new
// one -- otherwise a process that fires every step would burn through the stack
// in eight steps.
export function pushTop(crust, i, thickness, type, felsic, age) {
  if (thickness <= 0) return;
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  if (n > 0 && crust.layerType[base] === type
      && Math.abs(crust.layerFelsic[base] - felsic) < 0.08) {
    const h0 = crust.layerThick[base];
    const h1 = h0 + thickness;
    crust.layerFelsic[base] = (crust.layerFelsic[base] * h0 + felsic * thickness) / h1;
    crust.layerAge[base] = (crust.layerAge[base] * h0 + age * thickness) / h1;
    crust.layerThick[base] = h1;
  } else {
    if (n >= MAX_LAYERS) mergeThinnest(crust, i);
    const m = crust.nLayers[i];
    // Shift down to make room at the top.
    for (let k = Math.min(m, MAX_LAYERS - 1); k > 0; k--) {
      crust.layerThick[base + k] = crust.layerThick[base + k - 1];
      crust.layerType[base + k] = crust.layerType[base + k - 1];
      crust.layerFelsic[base + k] = crust.layerFelsic[base + k - 1];
      crust.layerAge[base + k] = crust.layerAge[base + k - 1];
      crust.layerTmax[base + k] = crust.layerTmax[base + k - 1];
    }
    crust.layerThick[base] = thickness;
    crust.layerType[base] = type;
    crust.layerFelsic[base] = felsic;
    crust.layerAge[base] = age;
    crust.layerTmax[base] = 0;
    crust.nLayers[i] = Math.min(m + 1, MAX_LAYERS);
  }
  recompute(crust, i);
}

// Stretch or shorten the whole column proportionally. This is what extension
// and compression do -- every layer thins or thickens together, nothing is
// added or removed.
export function scaleColumn(crust, i, factor) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  for (let k = 0; k < n; k++) crust.layerThick[base + k] *= factor;
  recompute(crust, i);
}

// Merge the thinnest adjacent pair, conserving volume and composition.
export function mergeThinnest(crust, i) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  if (n < 2) return;
  let best = 0, bestSum = Infinity;
  for (let k = 0; k + 1 < n; k++) {
    // Prefer merging neighbours that are the same rock.
    const same = crust.layerType[base + k] === crust.layerType[base + k + 1] ? 0.4 : 1;
    const sum = (crust.layerThick[base + k] + crust.layerThick[base + k + 1]) * same;
    if (sum < bestSum) { bestSum = sum; best = k; }
  }
  const a = base + best, b = base + best + 1;
  const ha = crust.layerThick[a], hb = crust.layerThick[b], h = ha + hb;
  if (h > 0) {
    crust.layerFelsic[a] = (crust.layerFelsic[a] * ha + crust.layerFelsic[b] * hb) / h;
    crust.layerAge[a] = (crust.layerAge[a] * ha + crust.layerAge[b] * hb) / h;
    crust.layerTmax[a] = Math.max(crust.layerTmax[a], crust.layerTmax[b]);
    // The thicker of the two gives the merged layer its identity.
    if (hb > ha) crust.layerType[a] = crust.layerType[b];
  }
  crust.layerThick[a] = h;
  for (let k = best + 1; k + 1 < n; k++) {
    crust.layerThick[base + k] = crust.layerThick[base + k + 1];
    crust.layerType[base + k] = crust.layerType[base + k + 1];
    crust.layerFelsic[base + k] = crust.layerFelsic[base + k + 1];
    crust.layerAge[base + k] = crust.layerAge[base + k + 1];
    crust.layerTmax[base + k] = crust.layerTmax[base + k + 1];
  }
  crust.nLayers[i] = n - 1;
}

// Drop layers that have thinned to nothing, so the stack does not fill with
// slivers that crowd out real stratigraphy.
export function pruneColumn(crust, i, minThick = 0.05) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  let w = 0;
  for (let k = 0; k < n; k++) {
    if (crust.layerThick[base + k] < minThick && n > 1) continue;
    if (w !== k) {
      crust.layerThick[base + w] = crust.layerThick[base + k];
      crust.layerType[base + w] = crust.layerType[base + k];
      crust.layerFelsic[base + w] = crust.layerFelsic[base + k];
      crust.layerAge[base + w] = crust.layerAge[base + k];
      crust.layerTmax[base + w] = crust.layerTmax[base + k];
    }
    w++;
  }
  if (w === 0) w = 1;
  crust.nLayers[i] = w;
  recompute(crust, i);
}

// The rock at the surface. With a thickness threshold this reports BEDROCK
// geology, skipping a thin veneer -- which is what a geological map shows.
// Pelagic sediment blankets essentially the whole sea floor at a few hundred
// metres, so without this every map is one colour and the crust beneath is
// invisible. A genuinely thick basin fill still reads as sediment.
export function topRock(crust, i, minThick = 0) {
  const n = crust.nLayers[i];
  if (n === 0) return ROCK.BASALT;
  const base = i * MAX_LAYERS;
  for (let k = 0; k < n; k++) {
    if (crust.layerThick[base + k] >= minThick) return crust.layerType[base + k];
  }
  return crust.layerType[base + n - 1];
}

// Emplace material at depth rather than on top. Arc magma differentiates: the
// andesite erupts, but the complementary granite freezes in the middle crust.
// Putting it on top instead would bury the volcanics under their own plutons,
// which is the wrong way round.
export function intrude(crust, i, thickness, type, felsic, age, depthFrac = 0.55) {
  if (thickness <= 0) return;
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  if (n === 0) { pushTop(crust, i, thickness, type, felsic, age); return; }

  const total = crust.thickness[i];
  const target = total * depthFrac;
  let acc = 0, at = n;
  for (let k = 0; k < n; k++) {
    acc += crust.layerThick[base + k];
    if (acc >= target) { at = k + 1; break; }
  }
  // Merge into a neighbouring layer of the same rock rather than fragmenting.
  for (const k of [at - 1, at]) {
    if (k < 0 || k >= n) continue;
    if (crust.layerType[base + k] !== type) continue;
    if (Math.abs(crust.layerFelsic[base + k] - felsic) > 0.12) continue;
    const h0 = crust.layerThick[base + k], h1 = h0 + thickness;
    crust.layerFelsic[base + k] = (crust.layerFelsic[base + k] * h0 + felsic * thickness) / h1;
    crust.layerThick[base + k] = h1;
    recompute(crust, i);
    return;
  }

  if (n >= MAX_LAYERS) { mergeThinnest(crust, i); }
  const m = crust.nLayers[i];
  const pos = Math.min(at, m);
  for (let k = Math.min(m, MAX_LAYERS - 1); k > pos; k--) {
    crust.layerThick[base + k] = crust.layerThick[base + k - 1];
    crust.layerType[base + k] = crust.layerType[base + k - 1];
    crust.layerFelsic[base + k] = crust.layerFelsic[base + k - 1];
    crust.layerAge[base + k] = crust.layerAge[base + k - 1];
    crust.layerTmax[base + k] = crust.layerTmax[base + k - 1];
  }
  crust.layerThick[base + pos] = thickness;
  crust.layerType[base + pos] = type;
  crust.layerFelsic[base + pos] = felsic;
  crust.layerAge[base + pos] = age;
  crust.layerTmax[base + pos] = 0;
  crust.nLayers[i] = Math.min(m + 1, MAX_LAYERS);
  recompute(crust, i);
}

// Read a column out before its point is destroyed, so collision can stack the
// actual rocks of the consumed crust into its neighbours instead of smearing a
// bulk composition over them. This is what puts a recognisable thrust stack in
// the section.
export function readColumn(crust, i) {
  const base = i * MAX_LAYERS, n = crust.nLayers[i];
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      thick: crust.layerThick[base + k],
      type: crust.layerType[base + k],
      felsic: crust.layerFelsic[base + k],
      age: crust.layerAge[base + k],
      tmax: crust.layerTmax[base + k],
    });
  }
  return out;
}

// Thrust a (scaled) copy of a captured column onto a point, youngest last so
// the stacking order comes out right.
export function stackLayers(crust, i, layers, fraction, cap) {
  for (let k = layers.length - 1; k >= 0; k--) {
    const l = layers[k];
    const h = l.thick * fraction;
    if (h <= 1e-4) continue;
    if (cap !== undefined && crust.thickness[i] + h > cap) {
      const room = cap - crust.thickness[i];
      if (room <= 1e-4) return;
      pushTop(crust, i, room, l.type, l.felsic, l.age);
      return;
    }
    pushTop(crust, i, h, l.type, l.felsic, l.age);
  }
}

export const rockName = (id) => ROCKS[id].name;
export const rockResistance = (id) => ROCKS[id].resist;
export const rockColor = (id) => ROCKS[id].color;

// ---------------------------------------------------------------------------
// metamorphism
// ---------------------------------------------------------------------------
// Burial cooks rock. Pressure comes from the weight of the column above;
// temperature from the local geotherm, which the heat-flow model already
// gives us. The two paths that matter are the pelitic one (sediment through
// slate and schist to gneiss) and the mafic one (basalt through greenstone and
// amphibolite to eclogite).
//
// The split between them is the whole point of plotting P against T rather
// than just depth. A thick orogen is hot at moderate pressure, so its buried
// sediment becomes gneiss. A subducting slab is cold at very high pressure, so
// its basalt becomes eclogite instead of amphibolite -- and eclogite is 550
// kg/m^3 denser than the basalt it came from, which is why slabs pull harder
// the deeper they go.

const PELITIC = [ROCK.SEDIMENT, ROCK.SLATE, ROCK.SCHIST, ROCK.GNEISS];
const MAFIC = [ROCK.BASALT, ROCK.GREENSTONE, ROCK.AMPHIBOLITE];

// Grade index 0-3 from the conditions. Returns -1 for "unchanged".
function gradeFor(P, T) {
  if (T < 300) return 0;
  if (T < 500) return 1;
  if (T < 700) return 2;
  return 3;
}

export function metamorphoseColumn(cfg, crust, i, surfaceT, gradient) {
  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  if (n === 0) return;
  let loadKm = 0, loadPressure = 0;
  let changed = false;

  for (let k = 0; k < n; k++) {
    const h = crust.layerThick[base + k];
    const type = crust.layerType[base + k];
    const rho = ROCKS[type].rho;
    // Mid-layer conditions.
    const mid = loadKm + h * 0.5;
    const P = loadPressure + rho * 9.81 * (h * 0.5 * 1000) / 1e8;   // kbar
    const T = surfaceT + gradient * mid;

    const grade = gradeFor(P, T);
    // Peak conditions are remembered, so a rock that cooled on the way back up
    // does not un-metamorphose. Retrograde reactions are slow and incomplete;
    // the mineralogy of an exhumed gneiss is the one it got at depth.
    if (T > crust.layerTmax[base + k]) crust.layerTmax[base + k] = T;
    const peakGrade = gradeFor(P, crust.layerTmax[base + k]);

    let next = type;
    if (P > cfg.eclogiteP && crust.layerTmax[base + k] < cfg.eclogiteTmax
        && (type === ROCK.BASALT || type === ROCK.GABBRO
            || type === ROCK.GREENSTONE || type === ROCK.AMPHIBOLITE)) {
      // High pressure, low temperature: the slab path.
      next = ROCK.ECLOGITE;
    } else if (peakGrade > 0) {
      const felsic = crust.layerFelsic[base + k];
      const pel = PELITIC.indexOf(type), maf = MAFIC.indexOf(type);
      if (pel >= 0 && peakGrade > pel) next = PELITIC[Math.min(3, peakGrade)];
      else if (maf >= 0 && peakGrade > maf) next = MAFIC[Math.min(2, peakGrade)];
      else if (type === ROCK.GRANITE && peakGrade >= 3) next = ROCK.GNEISS;
      else if (type === ROCK.ANDESITE && peakGrade >= 3) next = ROCK.GNEISS;
      else if (type === ROCK.GABBRO && peakGrade >= 2) next = ROCK.AMPHIBOLITE;
      else if (type === ROCK.FLOOD_BASALT && peakGrade >= 1) next = MAFIC[Math.min(2, peakGrade)];
    }
    if (next !== type) { crust.layerType[base + k] = next; changed = true; }

    loadPressure += rho * 9.81 * (h * 1000) / 1e8;
    loadKm += h;
  }
  if (changed) recompute(crust, i);
}

// ---------------------------------------------------------------------------
// delamination
// ---------------------------------------------------------------------------
// Why mountains cannot grow without limit. Isostasy is linear in crustal
// thickness, so nothing in the elevation model stops a 125 km root standing 16
// km high -- and the simulation duly produced 11 km peaks against Earth's 8.8.
//
// What actually limits them is that over-thickened mafic lower crust crosses
// into the eclogite field, and eclogite at 3500 kg/m^3 is DENSER than the
// mantle it is sitting on. It stops being crust in any buoyant sense and
// founders off into the mantle, taking the root with it. The surface drops,
// the orogen stops growing, and the crust is permanently recycled.
export function delaminate(world, i) {
  const { cfg, crust, pointArea } = world;
  if (crust.thickness[i] < cfg.delaminationThickness) return 0;
  if (crust.continental[i] < 0.35) return 0;        // oceanic lithosphere already sinks

  const base = i * MAX_LAYERS;
  const n = crust.nLayers[i];
  let shed = 0, shedCont = 0;
  // Work from the bottom: only the deepest layers are in the eclogite field.
  for (let k = n - 1; k >= 0 && crust.thickness[i] - shed > cfg.delaminationFloor; k--) {
    const type = crust.layerType[base + k];
    if (type !== ROCK.ECLOGITE && type !== ROCK.AMPHIBOLITE && type !== ROCK.GABBRO) break;
    const h = crust.layerThick[base + k];
    const take = Math.min(h, crust.thickness[i] - shed - cfg.delaminationFloor);
    if (take <= 1e-4) break;
    shed += take;
    shedCont += take * crust.layerFelsic[base + k];
    crust.layerThick[base + k] = h - take;
  }
  if (shed <= 1e-4) return 0;
  pruneColumn(crust, i);
  // The root has gone into the mantle. It is genuinely leaving the model, so
  // the ledger records it rather than pretending it went somewhere.
  world.budget.destroyed += shed * pointArea;
  world.delaminated = (world.delaminated || 0) + shed * pointArea;
  return shed;
}
