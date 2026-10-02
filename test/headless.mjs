// Headless driver: run the simulator without a browser and print the
// diagnostics that matter. This is the harness used for tuning.
import { makeConfig } from '../src/core/config.js';
import { World } from '../src/core/world.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const cfg = makeConfig(args.preset || 'small', {
  seed: args.seed ? +args.seed : 1234,
});
const steps = args.steps ? +args.steps : 100;
const every = args.every ? +args.every : 20;

const w = new World(cfg);
console.log(`domain ${cfg.W}x${cfg.H} km, spacing ${cfg.spacing} km, ${w.crust.live} crust points, ${w.plates.aliveCount()} plates`);
console.log('');
const hdr = ['t(Myr)', 'pts', 'slabs', 'plates', 'faults', 'segs', 'tfms', 'trench', 'TJ', 'win', 'relErr', 'ms/step'];
console.log(hdr.map((h, i) => h.padStart(i ? 8 : 7)).join(''));

let acc = 0;
for (let i = 0; i < steps; i++) {
  const a = performance.now();
  w.step();
  acc += performance.now() - a;
  if ((i + 1) % every === 0 || i === 0) {
    const s = w.stats();
    const row = [
      s.t.toFixed(0), s.crustPoints, s.slabPoints, s.plates, s.faults, s.segments,
      s.transforms, s.trenches, s.tripleJunctions, s.slabWindows,
      (s.audit.relError * 100).toFixed(3) + '%', (acc / (i + 1)).toFixed(1),
    ];
    console.log(row.map((c, k) => String(c).padStart(k ? 8 : 7)).join(''));
  }
}

console.log('');
const T = Object.entries(w.timings).sort((a, b) => b[1] - a[1]);
console.log('slowest stages (ms, last step): ' + T.slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
console.log('events: ' + w.events.slice(-6).map((e) => `${e.t}Myr ${e.kind}`).join(' | '));
const a = w.audit;
console.log(`crust ${(a.crustVolume / 1e9).toFixed(2)}e9 km^3, slab ${(a.slabVolume / 1e9).toFixed(2)}e9, cont area ${(a.continentalArea / (cfg.W * cfg.H) * 100).toFixed(1)}%`);
