import { ROCK, pushTop, scaleColumn, metamorphoseColumn } from './rocks.js';
import { elevationOf } from './elevation.js';
import { MAX_LAYERS } from '../core/pointsets.js';

// Where sedimentary rock comes from.
//
// Until now the only process making sediment was the accretionary wedge, so
// sediment was 2% of the rock inventory and the pelitic metamorphic path --
// slate, schist, gneiss -- had essentially nothing to work on. On Earth
// sedimentary rock covers most of the continental SURFACE even though it is a
// small fraction of crustal volume, so a geological map without it is simply
// wrong-looking.
//
// Two sources, neither of which requires a drainage model:
//
//   * Pelagic and shelf deposition. The sea floor accumulates continuously.
//     Abyssal plains get a slow rain of pelagic material; shallow water near
//     continents gets far more terrigenous input. This is a function of depth
//     alone and costs almost nothing.
//   * Erosion as mass transfer. High ground loses material and the debris is
//     deposited in neighbouring lows as sediment. This is the "mass-transfer
//     step feeding back into isostasy" the original spec said to leave room
//     for: deliberately NOT a stream-power model, just a conservative
//     hillslope-style transfer, which is enough to strip orogens and fill
//     basins. Mass is conserved exactly -- what leaves one column arrives in
//     others, and the ledger records it as a transfer, not a source.

export function surfaceProcesses(world) {
  const { cfg } = world;
  if (cfg.sedimentEnabled) deposition(world);
  if (cfg.erosionEnabled) erosion(world);
  if (cfg.metamorphismEnabled) metamorphism(world);
}

// Cook every column against its own geotherm. The gradient comes from the same
// heat-flow model the map layer uses, so a craton with a thick conductive lid
// has a cool geotherm and a thinned rift has a steep one -- and the rocks that
// come out differ accordingly.
function metamorphism(world) {
  const { cfg, crust } = world;
  const k = cfg.thermalConductivity;
  const A = cfg.crustHeatProduction;
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const L = Math.max(cfg.heatFlowMinLitho, crust.litho[i]) * 1000;
    const q = k * cfg.asthenosphereT / L + A * crust.continental[i] * crust.thickness[i] * 1000;
    // degrees per km: q/k, capped so a ridge axis does not report a geotherm
    // that melts the whole column.
    const gradient = Math.min(cfg.maxGeotherm, (q / k) * 1000);
    metamorphoseColumn(cfg, crust, i, cfg.surfaceT, gradient);
  }
}

// --- pelagic and shelf deposition -----------------------------------------
function deposition(world) {
  const { cfg, crust, pointArea } = world;
  const dt = cfg.dt;
  let made = 0;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const e = elevationOf(cfg, crust.thickness[i], crust.continental[i],
      crust.litho[i], crust.age[i]);
    const depth = world.seaLevel - e;
    if (depth <= 0) continue;                 // land gets no marine sediment

    // Shallow water close to land is where almost all of it accumulates; the
    // abyssal plain gets a slow pelagic rain and little else.
    const shelf = depth < 3 ? 1 - depth / 3 : 0;
    const rate = cfg.pelagicRate + cfg.shelfSedimentRate * shelf * shelf;
    const h = rate * dt;
    if (h <= 1e-5) continue;
    pushTop(crust, i, h, ROCK.SEDIMENT, cfg.sedimentFelsic, world.t);
    made += h * pointArea;
  }
  world.budget.created += made;
  world.sedimentMade = made;
}

// --- erosion as a conservative mass transfer ------------------------------
function erosion(world) {
  const { cfg, crust, crustHash, pointArea } = world;
  const dt = cfg.dt;
  const sc = world.scratch;
  if (!sc.elev || sc.elev.length < crust.capacity) sc.elev = new Float32Array(crust.capacity);
  const elev = sc.elev;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    elev[i] = elevationOf(cfg, crust.thickness[i], crust.continental[i],
      crust.litho[i], crust.age[i]);
  }

  const R = world.spacing * cfg.erosionRange;
  let moved = 0, lost = 0;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const e = elev[i];
    if (e <= world.seaLevel + 0.05) continue;       // only subaerial ground erodes

    // Strip at a rate set by how high the ground stands. Linear in relief is
    // the crudest defensible law and it is self-limiting through isostasy:
    // thinning the column lowers it, which slows the stripping.
    const strip = Math.min(cfg.erosionMaxStrip * dt,
      cfg.erosionRate * (e - world.seaLevel) * dt);
    if (strip <= 1e-5 || crust.thickness[i] - strip < 4) continue;

    // Find lower ground to put it on, preferring the lowest.
    const idx = [], wts = [];
    let wsum = 0;
    crustHash.forEachInRadius(crust.x[i], crust.y[i], R, (p, d2) => {
      if (!crust.alive[p] || p === i) return;
      const drop = e - elev[p];
      if (drop <= 0) return;
      const w = drop * Math.exp(-d2 / (2 * (R * 0.5) * (R * 0.5)));
      idx.push(p); wts.push(w); wsum += w;
    });

    const vol = strip * pointArea;
    const before = crust.thickness[i];
    scaleColumn(crust, i, (before - strip) / before);
    moved += vol;

    if (wsum <= 0) { lost += vol; continue; }    // nowhere to put it
    for (let k = 0; k < idx.length; k++) {
      const share = (wts[k] / wsum) * strip;
      if (share <= 1e-6) continue;
      pushTop(crust, idx[k], share, ROCK.SEDIMENT, cfg.sedimentFelsic, world.t);
    }
  }

  // Eroded material that found nowhere to go has left the model.
  world.budget.destroyed += lost;
  world.erodedVolume = moved;
}
