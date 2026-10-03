import { ROCK, pushTop, scaleColumn, metamorphoseColumn, delaminate, topRock, rockResistance } from './rocks.js';
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
  // Erosion and metamorphism are slow: a mountain range takes a hundred Myr to
  // strip and rock does not change facies on a 1 Myr timescale. Running them
  // every step costs real time for granularity nobody can observe, so they run
  // on an interval with the rate scaled up to match -- the same total mass
  // transfer and the same reactions, a fraction of the work. Deposition runs
  // every step because it is cheap and wants to accumulate smoothly.
  if (cfg.sedimentEnabled) deposition(world);
  if (cfg.erosionEnabled && world.stepCount % cfg.erosionInterval === 0) {
    erosion(world, cfg.erosionInterval * cfg.dt);
  }
  if (cfg.metamorphismEnabled && world.stepCount % cfg.metamorphismInterval === 0) {
    metamorphism(world);
    if (cfg.delaminationEnabled) rootFoundering(world);
  }
}

// Over-thickened roots founder. Checked alongside metamorphism because it is
// the metamorphic reaction -- mafic lower crust crossing into the eclogite
// field -- that makes the root denser than the mantle under it in the first
// place.
function rootFoundering(world) {
  const { crust } = world;
  let n = 0;
  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    if (delaminate(world, i) > 0) n++;
  }
  world.delaminationEvents = n;
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
      crust.litho[i], crust.age[i], crust.edifice[i]);
    const depth = world.seaLevel - e;
    if (depth <= 0) continue;                 // land gets no marine sediment

    // Shallow water close to land is where almost all of it accumulates; the
    // abyssal plain gets a slow pelagic rain and little else.
    const shelf = depth < 3 ? 1 - depth / 3 : 0;
    const pelagic = cfg.pelagicRate;
    const terrig = cfg.shelfSedimentRate * shelf * shelf;
    const h = (pelagic + terrig) * dt;
    if (h <= 1e-5) continue;
    // Composition follows the mix of the two sources, not a single constant.
    const felsic = (pelagic * cfg.pelagicFelsic + terrig * cfg.shelfFelsic)
                 / Math.max(1e-12, pelagic + terrig);
    pushTop(crust, i, h, ROCK.SEDIMENT, felsic, world.t);
    made += h * pointArea;
  }
  world.budget.created += made;
  world.sedimentMade = made;
}

// --- erosion as a conservative mass transfer ------------------------------
function erosion(world, dt) {
  const { cfg, crust, crustHash, pointArea } = world;
  const sc = world.scratch;
  if (!sc.elev || sc.elev.length < crust.capacity) sc.elev = new Float32Array(crust.capacity);
  const elev = sc.elev;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    elev[i] = elevationOf(cfg, crust.thickness[i], crust.continental[i],
      crust.litho[i], crust.age[i], crust.edifice[i]);
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
    // Differential erosion. Stripping the soft cover off a resistant bed slows
    // the attack to a crawl; a slate or a sediment pile goes three times
    // faster than the granite beside it. This is where structure in a
    // landscape comes from -- without it, relief is a set of smooth domes.
    const resist = rockResistance(topRock(crust, i));
    const strip = Math.min(cfg.erosionMaxStrip * dt,
      cfg.erosionRate * (e - world.seaLevel) * dt / resist);
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
    const srcFelsic = crust.continental[i];
    const before = crust.thickness[i];
    scaleColumn(crust, i, (before - strip) / before);
    moved += vol;

    if (wsum <= 0) { lost += vol; continue; }    // nowhere to put it
    for (let k = 0; k < idx.length; k++) {
      const share = (wts[k] / wsum) * strip;
      if (share <= 1e-6) continue;
      // Eroded debris carries the composition of the rock it came off, rather
      // than being assigned a generic one: stripping a granite highland should
      // deposit felsic sediment, stripping a basalt island should not.
      pushTop(crust, idx[k], share, ROCK.SEDIMENT, srcFelsic, world.t);
    }
  }

  // Eroded material that found nowhere to go has left the model.
  world.budget.destroyed += lost;
  world.erodedVolume = moved;
}
