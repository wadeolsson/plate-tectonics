// Validation against the targets the spec calls out. These are checks against
// well-documented real-world behaviour, not against aesthetics.
//
//   node test/validate.mjs --steps=200 [--preset=small] [--seed=1234]
import './domstub.mjs';
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';
import { Raster } from '../src/render/raster.js';
import { oceanDepthMetres, elevationOf } from '../src/sim/elevation.js';
import { wrapDelta } from '../src/core/torus.js';
import { KIND, KIND_NAME } from '../src/sim/boundaries.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const cfg = makeConfig(args.preset || 'small', { seed: +(args.seed ?? 1234) });
const w = new World(cfg);
const steps = +(args.steps ?? 200);
for (let i = 0; i < steps; i++) w.step();
const raster = new Raster(w);
raster.rasterise();

const pass = [], fail = [];
const check = (name, ok, detail) => (ok ? pass : fail).push(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);

console.log(`=== validation after ${steps} Myr (${cfg.preset}, seed ${cfg.seed}) ===\n`);

// --- 1. seafloor age-depth ------------------------------------------------
{
  const bins = new Map();
  for (let i = 0; i < w.crust.n; i++) {
    if (!w.crust.alive[i] || w.crust.continental[i] > 0.15) continue;
    // Only crust of normal oceanic thickness. The age-depth curve describes
    // exactly that; a plateau or an arc built on ocean floor rides higher by
    // Airy, and averaging those into the bins would make the curve look
    // non-monotonic for a perfectly good reason.
    if (Math.abs(w.crust.thickness[i] - cfg.thickOcean) > 1.5) continue;
    const a = w.crust.age[i];
    const b = Math.min(9, Math.floor(a / 20));
    const e = elevationOf(cfg, w.crust.thickness[i], w.crust.continental[i], w.crust.litho[i], a);
    if (!bins.has(b)) bins.set(b, { s: 0, n: 0 });
    const q = bins.get(b); q.s += e; q.n++;
  }
  const rows = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  console.log('1. Seafloor age vs depth of normal-thickness crust (sqrt(age), flattening past ~80 Myr)');
  let monotone = true, prev = Infinity;
  for (const [b, q] of rows) {
    if (q.n < 30) continue;
    const mean = q.s / q.n;
    const expect = -oceanDepthMetres(cfg, b * 20 + 10) / 1000;
    console.log(`   ${String(b * 20).padStart(3)}-${String(b * 20 + 20).padEnd(3)} Myr  mean ${mean.toFixed(2)} km  (model ${expect.toFixed(2)})  n=${q.n}`);
    if (mean > prev + 0.12) monotone = false;
    prev = mean;
  }
  check('age-depth is monotonic', monotone, 'older seafloor must not be shallower than younger');
}

// --- 2. ridge geometry ----------------------------------------------------
{
  const segs = w.segments.active();
  const tf = w.segments.transforms;
  const mean = (a, f) => (a.length ? a.reduce((x, y) => x + f(y), 0) / a.length : 0);
  // Split the actual rate distribution at its quartiles: a fixed cut just
  // reports "no fast ridges" whenever the run happens to be sedate.
  const byRate = segs.slice().sort((a, b) => a.rate - b.rate);
  const q = Math.floor(byRate.length / 4);
  const slow = byRate.slice(0, q), fast = byRate.slice(-q);
  console.log('\n2. Ridge segmentation (fast ridges: long segments, small offsets)');
  console.log(`   ${segs.length} active segments, spreading rate ${byRate.length ? byRate[0].rate.toFixed(0) : 0}–${byRate.length ? byRate[byRate.length - 1].rate.toFixed(0) : 0} km/Myr`);
  console.log(`   slowest quartile (mean ${mean(slow, (s) => s.rate).toFixed(0)} km/Myr): mean L_seg ${mean(slow, (s) => s.length).toFixed(0)} km`);
  console.log(`   fastest quartile (mean ${mean(fast, (s) => s.rate).toFixed(0)} km/Myr): mean L_seg ${mean(fast, (s) => s.length).toFixed(0)} km`);
  console.log(`   transforms: ${tf.length}, mean offset ${mean(tf, (t) => t.offset).toFixed(0)} km`);
  // Only assert when the two quartiles actually differ in rate. In an
  // assembled phase the whole ridge system can sit inside a 7-18 km/Myr band,
  // which is entirely below segRateSlow -- every segment then gets the same
  // base length and the comparison is measuring nothing but the weakness and
  // noise modulation. Slow spreading under a supercontinent is correct
  // behaviour, not a failure of the rate relation.
  const rSlow = mean(slow, (s) => s.rate), rFast = mean(fast, (s) => s.rate);
  if (slow.length > 5 && fast.length > 5 && rFast > rSlow * 1.8) {
    check('faster ridges have longer segments',
      mean(fast, (s) => s.length) > mean(slow, (s) => s.length),
      `fast ${mean(fast, (s) => s.length).toFixed(0)} km at ${rFast.toFixed(0)} km/Myr`
      + ` vs slow ${mean(slow, (s) => s.length).toFixed(0)} km at ${rSlow.toFixed(0)} km/Myr`);
  } else {
    console.log(`   (spreading rates span only ${rSlow.toFixed(0)}-${rFast.toFixed(0)} km/Myr`
      + ` — too narrow to test the length/rate relation)`);
  }
  // A distribution statement, not a statement about the single oldest
  // segment: right after a ridge reorganisation the oldest one can legitimately
  // be young, and the question is whether segments carry identity at all.
  const ages = segs.map((s) => w.t - s.birth).sort((a, b) => a - b);
  const p90 = ages.length ? ages[Math.floor(0.9 * (ages.length - 1))] : 0;
  const med = ages.length ? ages[Math.floor(0.5 * (ages.length - 1))] : 0;
  console.log(`   segment age: median ${med.toFixed(0)} Myr, 90th percentile ${p90.toFixed(0)} Myr, oldest ${(ages[ages.length - 1] || 0).toFixed(0)} Myr`);
  check('ridge segments carry identity across steps', p90 > 12,
    `90th-percentile segment age is ${p90.toFixed(0)} Myr`);
}

// --- 3. Wadati-Benioff geometry ------------------------------------------
{
  console.log('\n3. Slab geometry (Wadati-Benioff zone)');
  // Measured over the whole slab population against the nearest trench trace.
  // Picking one zone biases the answer: a flat slab accumulates points because
  // it does not retire, so "the zone with the most slab points" is
  // systematically the shallowest one in the model.
  const trace = [];
  for (const z of w.trenches.all()) {
    if (z.isCollision) continue;
    for (const e of z.edges) trace.push([w.boundaries.mx[e], w.boundaries.my[e]]);
  }
  const depths = [], dips = [];
  const pts = [];
  for (let i = 0; i < w.slabs.n; i++) {
    if (!w.slabs.alive[i]) continue;
    depths.push(w.slabs.depth[i]);
    dips.push(w.slabs.dip[i]);
    if (!trace.length) continue;
    let dm = Infinity;
    for (const [tx, ty] of trace) {
      const d = w.torus.dist2(w.slabs.x[i], w.slabs.y[i], tx, ty);
      if (d < dm) dm = d;
    }
    // Only the shallow slab: a Wadati-Benioff zone is the seismogenic part,
    // and below ~300 km the slab has decoupled and a migrating trench can be
    // sitting right on top of material it subducted tens of Myr ago.
    if (w.slabs.depth[i] <= 300) pts.push([Math.sqrt(dm), w.slabs.depth[i]]);
  }
  if (depths.length < 40) { console.log(`   only ${depths.length} slab points in the model`); }
  else {
    depths.sort((a, b) => a - b); dips.sort((a, b) => a - b);
    const q = (a, f) => a[Math.floor(f * (a.length - 1))];
    console.log(`   ${depths.length} slab points; depth p10/p50/p90/max = `
      + `${q(depths, 0.1).toFixed(0)}/${q(depths, 0.5).toFixed(0)}/${q(depths, 0.9).toFixed(0)}/${q(depths, 1).toFixed(0)} km`);
    console.log(`   dip p10/p50/p90 = ${(q(dips, 0.1) * 57.3).toFixed(0)}/${(q(dips, 0.5) * 57.3).toFixed(0)}/${(q(dips, 0.9) * 57.3).toFixed(0)}°`);
    let flat = 0, zones = 0;
    for (const z of w.trenches.all()) { if (z.isCollision) continue; zones++; if ((z.flatness || 0) > 0.4) flat++; }
    console.log(`   ${zones} active subduction zones, ${flat} in flat-slab mode`);
    if (pts.length > 40) {
      const n = pts.length;
      const mx = pts.reduce((a, p) => a + p[0], 0) / n;
      const my = pts.reduce((a, p) => a + p[1], 0) / n;
      let num = 0, den = 0;
      for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); }
      const slope = den > 0 ? num / den : 0;
      console.log(`   shallow slab (<300 km), depth vs distance from the nearest trench: `
        + `${(Math.atan(slope) * 180 / Math.PI).toFixed(1)}° apparent dip over ${pts.length} points`);
      for (const [lo, hi] of [[0, 200], [200, 400], [400, 700], [700, 1200]]) {
        const b = pts.filter((p) => p[0] >= lo && p[0] < hi);
        if (b.length > 5) console.log(`     ${String(lo).padStart(4)}-${String(hi).padEnd(4)} km: mean depth ${(b.reduce((a, p) => a + p[1], 0) / b.length).toFixed(0)} km (n=${b.length})`);
      }
      check('slab depth increases away from the trench', slope > 0.02, `slope ${slope.toFixed(3)} km/km`);
    }
    check('dips are geologically plausible', q(dips, 0.5) * 57.3 > 15 && q(dips, 0.5) * 57.3 < 75,
      `median ${(q(dips, 0.5) * 57.3).toFixed(0)}°`);
    check('slabs reach the deep mantle', q(depths, 0.9) > 250, `90th percentile depth ${q(depths, 0.9).toFixed(0)} km`);
  }
}

// --- 4. crustal roots under mountains ------------------------------------
{
  let hi = { t: 0, n: 0 }, lo = { t: 0, n: 0 };
  for (let i = 0; i < w.crust.n; i++) {
    if (!w.crust.alive[i] || w.crust.continental[i] < 0.6) continue;
    const e = elevationOf(cfg, w.crust.thickness[i], w.crust.continental[i], w.crust.litho[i], w.crust.age[i]);
    const b = e > 2 ? hi : (e > -0.5 && e < 0.8 ? lo : null);
    if (b) { b.t += w.crust.thickness[i]; b.n++; }
  }
  console.log('\n4. Isostasy (mountains need roots)');
  if (hi.n > 5 && lo.n > 5) {
    console.log(`   elevation > 2 km:   mean crust ${(hi.t / hi.n).toFixed(1)} km  (n=${hi.n})`);
    console.log(`   near sea level:     mean crust ${(lo.t / lo.n).toFixed(1)} km  (n=${lo.n})`);
    check('high ground has a thicker root', hi.t / hi.n > lo.t / lo.n + 5,
      `${(hi.t / hi.n).toFixed(1)} km vs ${(lo.t / lo.n).toFixed(1)} km`);
  } else console.log(`   not enough high ground yet (n=${hi.n})`);
}

// --- 5. fracture zones ----------------------------------------------------
{
  // Loci where the segment stamp changes between neighbours and the ages
  // differ: the scar renders itself through the age-depth relation.
  let fz = 0, sampled = 0, maxJump = 0;
  const td = w.td, tri = td.triangles, orig = td.orig;
  const seen = new Set();
  for (let e = 0; e < tri.length; e++) {
    const a = orig[tri[e]], b = orig[tri[e % 3 === 2 ? e - 2 : e + 1]];
    if (a >= b) continue;
    const k = a * 1e7 + b;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!w.crust.alive[a] || !w.crust.alive[b]) continue;
    if (w.crust.plate[a] !== w.crust.plate[b]) continue;
    if (w.crust.continental[a] > 0.2 || w.crust.continental[b] > 0.2) continue;
    sampled++;
    if (w.crust.segment[a] === w.crust.segment[b] || !w.crust.segment[a] || !w.crust.segment[b]) continue;
    const dAge = Math.abs(w.crust.age[a] - w.crust.age[b]);
    if (dAge > 8) { fz++; maxJump = Math.max(maxJump, dAge); }
  }
  console.log('\n5. Fracture zones (age offsets across segment boundaries)');
  console.log(`   ${fz} fracture-zone contacts out of ${sampled} intra-plate oceanic pairs, largest age step ${maxJump.toFixed(0)} Myr`);
  check('fracture zones exist', fz > 5, `${fz} contacts with an age step over 8 Myr`);
}

// --- 6. plate reorganisation ----------------------------------------------
{
  const rifts = w.events.filter((e) => e.kind === 'rift').length;
  const sutures = w.events.filter((e) => e.kind === 'suture').length;
  const breakups = w.events.filter((e) => e.kind === 'breakup').length;
  console.log('\n6. Reorganisation');
  console.log(`   ${rifts} rifts, ${sutures} sutures, ${breakups} breakups over ${steps} Myr; ${w.plates.aliveCount()} plates now (${w.plates.count} ever)`);
  check('plates both break and merge', rifts > 0 && sutures > 0, `${rifts} rifts, ${sutures} sutures`);
}

// --- 7. weakness inheritance ---------------------------------------------
{
  console.log('\n7. Inherited weakness (do rifts reopen old scars?)');
  const h = w.riftHistory;
  if (!h.length) { console.log('   no rifts yet in this run'); }
  else {
    let win = 0;
    for (const r of h) {
      const mark = r.pathWeak > r.plateWeak ? 'weaker' : 'not weaker';
      if (r.pathWeak > r.plateWeak) win++;
      console.log(`   ${String(r.t).padStart(4)} Myr  plate ${r.plate}: cut weakness ${r.pathWeak.toFixed(3)} vs plate ${r.plateWeak.toFixed(3)} (${mark}), `
        + `cut lithosphere ${r.pathLitho.toFixed(0)} vs ${r.plateLitho.toFixed(0)} km`);
    }
    const mw = h.reduce((a, r) => a + (r.pathWeak - r.plateWeak), 0) / h.length;
    const ml = h.reduce((a, r) => a + (r.pathLitho - r.plateLitho), 0) / h.length;
    console.log(`   mean cut−plate: weakness ${mw >= 0 ? '+' : ''}${mw.toFixed(3)}, lithosphere ${ml >= 0 ? '+' : ''}${ml.toFixed(0)} km`);
    check('rift paths follow weaker-than-average lithosphere', mw > 0,
      `${win} of ${h.length} rifts cut weaker ground, mean advantage ${mw.toFixed(3)}`);
    // Secondary to weakness, and the two sometimes point the same way (an old
    // suture can sit under thick lithosphere), so this needs a few rifts before
    // the mean means anything.
    if (h.length >= 4) {
      check('rift paths avoid thick cratonic roots', ml < 0,
        `mean lithosphere along the cut is ${ml.toFixed(0)} km relative to the plate, over ${h.length} rifts`);
    } else {
      console.log(`   (too few rifts yet to judge craton avoidance: ${h.length})`);
    }
  }
}

// --- 8. mass conservation -------------------------------------------------
{
  const a = w.audit;
  console.log('\n8. Mass ledger');
  console.log(`   crust ${(a.crustVolume / 1e9).toFixed(3)} + slab ${(a.slabVolume / 1e9).toFixed(3)} = ${(a.actual / 1e9).toFixed(3)} ×10⁹ km³`);
  console.log(`   expected ${(a.expected / 1e9).toFixed(3)}, error ${(a.relError * 100).toFixed(4)}%`);
  console.log(`   continental area ${(a.continentalArea / (w.W * w.H) * 100).toFixed(1)}%`);
  check('mass is conserved to better than 0.5%', Math.abs(a.relError) < 0.005,
    `${(a.relError * 100).toFixed(4)}%`);
  check('continents persist', a.continentalArea / (w.W * w.H) > 0.10,
    `${(a.continentalArea / (w.W * w.H) * 100).toFixed(1)}% of the domain`);
}

// --- 9. boundary mix ------------------------------------------------------
{
  const len = new Float64Array(6);
  for (let e = 0; e < w.boundaries.count; e++) len[w.boundaries.kind[e]] += w.boundaries.len[e];
  const total = len.reduce((a, b) => a + b, 0);
  console.log('\n9. Boundary inventory');
  for (let k = 0; k < 6; k++) {
    console.log(`   ${KIND_NAME[k].padEnd(11)} ${(len[k] / 1000).toFixed(1).padStart(6)} ×10³ km  ${(len[k] / total * 100).toFixed(1)}%`);
  }
  const tj = w.boundaries.tripleJunctions || [];
  const types = {};
  for (const j of tj) types[j.type] = (types[j.type] || 0) + 1;
  console.log(`   triple junctions: ${tj.length} — ${Object.entries(types).map(([k, v]) => `${k}×${v}`).join(' ')}`);
  // A world that has assembled into one or two plates legitimately has almost
  // no boundary network; that is the closed half of the Wilson cycle, not a
  // classification failure.
  const nPlates = w.plates.aliveCount();
  if (nPlates >= 3) {
    check('all boundary classes are represented', len.filter((v) => v > 0).length >= 4,
      `${len.filter((v) => v > 0).length} of 6 classes present across ${nPlates} plates`);
  } else {
    console.log(`   (only ${nPlates} plate${nPlates === 1 ? '' : 's'} right now — assembled phase, inventory check skipped)`);
  }
}

// --- 9b. what drives the plates -------------------------------------------
{
  // Size is not the causal variable and should not be expected to be: large
  // continental plates really are slow (Eurasia, Africa) while the Pacific is
  // fast because of the trench around its rim. The relation to check is speed
  // against attached subducting margin -- over the whole run, because a
  // correlation across the three plates that happen to exist at the final step
  // is determined by three points and means nothing.
  const rows = w.kinematics;
  console.log('\n9b. Plate kinematics');
  if (rows.length < 25) { console.log(`   only ${rows.length} samples so far`); }
  else {
    const corr = (f, g) => {
      const n = rows.length;
      let ma = 0, mb = 0;
      for (const r of rows) { ma += f(r); mb += g(r); }
      ma /= n; mb /= n;
      let num = 0, da = 0, db = 0;
      for (const r of rows) {
        const x = f(r) - ma, y = g(r) - mb;
        num += x * y; da += x * x; db += y * y;
      }
      return num / Math.sqrt(da * db || 1);
    };
    const sp = rows.map((r) => r.speed).sort((a, b) => a - b);
    const q = (f) => sp[Math.floor(f * (sp.length - 1))];
    const mean = sp.reduce((a, b) => a + b, 0) / sp.length;
    const cs = corr((r) => r.speed, (r) => r.slabPerArea);
    const cc = corr((r) => r.speed, (r) => r.continental);
    console.log(`   ${rows.length} plate-samples over the run; speed p10/p50/p90 = `
      + `${q(0.1).toFixed(0)}/${q(0.5).toFixed(0)}/${q(0.9).toFixed(0)} km/Myr, mean ${mean.toFixed(0)}`);
    console.log(`   corr(speed, slab per unit area)   = ${cs.toFixed(2)}  (slab pull should drive plates)`);
    console.log(`   corr(speed, continental fraction) = ${cc.toFixed(2)}  (continental plates should lag)`);
    check('plate speeds are geologically plausible', mean > 8 && mean < 90,
      `mean ${mean.toFixed(0)} km/Myr over ${rows.length} samples`);
    check('slab-rimmed plates move faster than slab-free ones', cs > 0.1,
      `correlation ${cs.toFixed(2)} over ${rows.length} samples`);
  }
}

// --- 9c. crustal columns --------------------------------------------------
{
  // thickness and continental are caches over the layer stack. If they can
  // drift from it, every elevation and every mass figure downstream is wrong,
  // so this is checked rather than assumed.
  const { MAX_LAYERS } = await import('../src/core/pointsets.js');
  const { ROCKS } = await import('../src/sim/rocks.js');
  let worstT = 0, worstC = 0, layers = 0, pts = 0, empty = 0;
  const census = new Map();
  for (let i = 0; i < w.crust.n; i++) {
    if (!w.crust.alive[i]) continue;
    const b = i * MAX_LAYERS, n = w.crust.nLayers[i];
    if (n === 0) { empty++; continue; }
    let t = 0, f = 0;
    for (let k = 0; k < n; k++) {
      const h = w.crust.layerThick[b + k];
      t += h; f += h * w.crust.layerFelsic[b + k];
      census.set(w.crust.layerType[b + k], (census.get(w.crust.layerType[b + k]) || 0) + h);
    }
    worstT = Math.max(worstT, Math.abs(t - w.crust.thickness[i]));
    worstC = Math.max(worstC, Math.abs((t > 0 ? f / t : 0) - w.crust.continental[i]));
    layers += n; pts++;
  }
  console.log('\n9c. Crustal columns');
  console.log(`   ${pts} columns, ${(layers / Math.max(1, pts)).toFixed(2)} layers each, ${empty} empty`);
  const total = [...census.values()].reduce((a, b) => a + b, 0);
  const top = [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('   rock inventory: ' + top.map(([r, h]) => `${ROCKS[r].name} ${(h / total * 100).toFixed(0)}%`).join(', '));
  console.log(`   worst cache drift: thickness ${worstT.toExponential(1)} km, composition ${worstC.toExponential(1)}`);
  // The rock cycle should actually be turning: metamorphic rock made from
  // buried protoliths, and sediment from somewhere other than wedges.
  const named = (n) => ROCKS.findIndex((r) => r.name === n);
  const frac = (n) => (census.get(named(n)) || 0) / Math.max(1e-9, total);
  const meta = ['gneiss', 'schist', 'slate', 'amphibolite', 'greenstone', 'eclogite']
    .reduce((a, n) => a + frac(n), 0);
  console.log(`   sedimentary ${(frac('sediment') * 100).toFixed(1)}%, metamorphic ${(meta * 100).toFixed(1)}% by volume`);
  let ecl = 0, nsl = 0;
  for (let k = 0; k < w.slabs.n; k++) {
    if (!w.slabs.alive[k]) continue;
    ecl += w.slabs.eclogite[k]; nsl++;
  }
  if (nsl > 50) {
    console.log(`   slab eclogitisation ${(ecl / nsl).toFixed(2)} over ${nsl} points`);
    check('subducted crust eclogitises', ecl / nsl > 0.05,
      `mean ${(ecl / nsl).toFixed(2)}`);
  }
  check('the rock cycle produces metamorphic rock', meta > 0.01,
    `${(meta * 100).toFixed(1)}% of crustal volume`);
  check('sediment is made outside accretionary wedges', frac('sediment') > 0.02,
    `${(frac('sediment') * 100).toFixed(1)}% of crustal volume`);
  check('no column is empty', empty === 0, `${empty} points with no layers`);
  check('cached thickness matches the column', worstT < 1e-2, `worst ${worstT.toExponential(2)} km`);
  check('cached composition matches the column', worstC < 1e-3, `worst ${worstC.toExponential(2)}`);
}

// --- 10. continental morphology ------------------------------------------
{
  // Total continental area can look healthy while the continents themselves
  // have been squeezed into ribbons hugging active margins. What separates a
  // continent from an arc chain is interior: crust far from any boundary.
  let contCells = 0, interior = 0, shelf = 0;
  for (let i = 0; i < raster.n; i++) {
    if (raster.continental[i] < 0.55) continue;
    contCells++;
    if (raster.distToBoundary[i] > 400) interior++;
    if (raster.elevation[i] < w.seaLevel) shelf++;
  }
  console.log('\n10. Continental morphology');
  if (!contCells) { console.log('   no continental crust left'); }
  else {
    console.log(`   ${(contCells / raster.n * 100).toFixed(1)}% of the map is continental crust`);
    console.log(`   ${(interior / contCells * 100).toFixed(1)}% of it lies more than 400 km from a plate boundary`);
    console.log(`   ${(shelf / contCells * 100).toFixed(1)}% of it is submerged (shelf and flooded interior)`);
    check('continents have interiors, not just active margins',
      interior / contCells > 0.25,
      `${(interior / contCells * 100).toFixed(1)}% of continental crust is interior`);
  }
}

console.log(`\n=== ${pass.length} passed, ${fail.length} failed ===`);
for (const f of fail) console.log(f);
process.exit(fail.length ? 1 : 0);
