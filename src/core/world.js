import { makeConfig } from './config.js';
import { Rng, Fbm } from './rng.js';
import { Torus, wrapPos } from './torus.js';
import { SpatialHash } from './spatialhash.js';
import { CrustSet, SlabSet } from './pointsets.js';
import { PlateRegistry } from './plates.js';
import { TorusDelaunay } from '../sim/delaunay.js';
import { BoundaryNetwork } from '../sim/boundaries.js';
import { TrenchRegistry } from '../sim/trenches.js';
import { SegmentRegistry } from '../sim/segments.js';
import { updateVelocities, advect } from '../sim/motion.js';
import { accrete, subduct, volcanicArcs, collide, transformEffects, decayWeakness, gravitationalSpreading, hotspotVolcanism } from '../sim/processes.js';
import { updateSlabs, slabFeedback, ensureScratch } from '../sim/slablayer.js';
import { plateStress, maybeRift, riftThinning } from '../sim/rifting.js';
import { manageDensity, reassignStrays } from '../sim/density.js';
import { newBudget, auditMass, QuakeLog, generateQuakes } from '../sim/diagnostics.js';
import { MantleField } from '../sim/mantle.js';
import { lithoTarget, updateLithosphere, smoothstep } from '../sim/elevation.js';
import { initColumn } from '../sim/rocks.js';
import { surfaceProcesses } from '../sim/surface.js';
import { fluvialErosion } from '../sim/fluvial.js';
import { volcanicEdifices } from '../sim/volcanoes.js';
import { magmatism, meltVolume } from '../sim/magma.js';

export class World {
  constructor(cfg = makeConfig()) {
    this.cfg = cfg;
    this.reset(cfg);
  }

  reset(cfg = this.cfg) {
    this.cfg = cfg;
    this.W = cfg.W; this.H = cfg.H;
    this.spacing = cfg.spacing;
    this.pointArea = cfg.spacing * cfg.spacing;
    this.torus = new Torus(cfg.W, cfg.H);
    this.rng = new Rng(cfg.seed);
    this.t = 0;
    this.stepCount = 0;

    const target = Math.ceil((cfg.W / cfg.spacing) * (cfg.H / cfg.spacing) * 1.25);
    this.crust = new CrustSet(target);
    this.slabs = new SlabSet(Math.ceil(target * 0.6));
    this.plates = new PlateRegistry();
    this.td = new TorusDelaunay(cfg.W, cfg.H);
    this.boundaries = new BoundaryNetwork(cfg.W, cfg.H);
    this.trenches = new TrenchRegistry();
    this.segments = new SegmentRegistry(cfg.W, cfg.H);
    this.crustHash = new SpatialHash(cfg.W, cfg.H, cfg.spacing * 1.5);
    this.slabHash = new SpatialHash(cfg.W, cfg.H, cfg.spacing * 1.5);
    this.quakes = new QuakeLog(cfg.quakeMaxStore);
    this.mantle = new MantleField(this);
    this.budget = newBudget();
    this.scratch = {};
    this.events = [];
    this.faultPending = new Map();
    this.riftHistory = [];
    this.kinematics = [];
    this.contDelta = {};
    this.stress = new Map();
    this.arcActivity = 0;
    this.plumeActivity = 0;
    this.slabWindowCount = 0;
    this.densityOps = 0;
    this.seaLevel = cfg.seaLevel;
    this.waterTarget = null;
    this.timings = {};

    this._seed();
    ensureScratch(this);
    this.rebuildTopology();
    this.stress = plateStress(this);
    this.budget.initial = auditMass(this).actual;
    this.audit = auditMass(this);
  }

  // ---- initial condition ---------------------------------------------
  _seed() {
    const { cfg, crust, plates, rng, W, H } = this;
    const s = cfg.spacing;
    // Hexagonal lattice: rows offset by half a cell, row pitch s*sqrt(3)/2.
    // Nearest-neighbour distance is then s everywhere, which keeps the initial
    // cloud clear of the density-merge threshold.
    const nx = Math.max(4, Math.round(W / s));
    const ny = Math.max(4, Math.round(H / (s * Math.sqrt(3) / 2)));
    const dx = W / nx, dy = H / ny;
    this.pointArea = (W * H) / (nx * ny);

    // Continental blobs from tileable fBm so there is no seam.
    const land = new Fbm(rng, 3, 2, 5, 0.52);
    const ageN = new Fbm(rng, 4, 3, 4, 0.5);
    const weakN = new Fbm(rng, 6, 4, 3, 0.5);

    // Pick the threshold that yields the requested continental fraction.
    const samples = [];
    for (let k = 0; k < 6000; k++) samples.push(land.at(rng.next(), rng.next()));
    samples.sort((a, b) => a - b);
    const thr = samples[Math.floor((1 - cfg.continentalFraction) * samples.length)];

    // Plate seeds: multiplicatively weighted Voronoi so plates vary in size.
    const seeds = [];
    for (let i = 0; i < cfg.nPlates; i++) {
      const p = plates.create(-1, 0);
      p.hue = (i * 0.6180339887) % 1;
      const [ux, uy] = rng.dir();
      const sp = rng.float(cfg.speedMin, cfg.speedMax);
      p.vx = ux * sp; p.vy = uy * sp;
      p.omega = rng.normal(0, cfg.omegaMax * 0.35);
      seeds.push({ x: rng.float(0, W), y: rng.float(0, H), w: rng.float(0.75, 1.35), id: p.id });
    }

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = wrapPos((i + (j % 2 ? 0.75 : 0.25) + rng.float(-0.14, 0.14)) * dx, W);
        const y = wrapPos((j + 0.5 + rng.float(-0.14, 0.14)) * dy, H);

        let best = -1, bestD = Infinity;
        for (const sd of seeds) {
          const d = this.torus.dist2(x, y, sd.x, sd.y) / (sd.w * sd.w);
          if (d < bestD) { bestD = d; best = sd.id; }
        }

        const u = x / W, v = y / H;
        const n = land.at(u, v);
        const cont = smoothstep(thr - 0.055, thr + 0.055, n);
        // Cap the initial seafloor near the real maximum: crust much older
        // than ~180 Myr has been subducted on Earth, and starting with a lot of
        // it puts the whole age map into the saturated end of the ramp.
        const oceanAge = 3 + 118 * Math.pow(ageN.at(u * 1.7 + 0.31, v * 1.7 + 0.77), 1.35);
        const defAge = cont > 0.4 ? 200 + 1600 * ageN.at(u * 0.9, v * 0.9) : oceanAge;
        const thickness = cfg.thickOcean + (cfg.thickContinent - cfg.thickOcean) * cont
                        + rng.normal(0, 0.55) * cont;
        const idx = crust.spawn({
          x, y,
          plate: best,
          continental: cont,
          thickness: Math.max(5, thickness),
          litho: lithoTarget(cfg, cont, oceanAge, defAge),
          age: oceanAge,
          defAge,
          segment: 0,
          weakness: 0.08 + 0.35 * Math.pow(weakN.at(u * 2.3, v * 2.3), 2),
        });
        plates.reframe(crust, idx, best, W, H);
        initColumn(crust, idx, Math.max(5, thickness), cont, cont > 0.4 ? defAge : oceanAge);
      }
    }

    plates.recomputeGeometry(crust, W, H, this.pointArea);
    for (let i = 0; i < crust.n; i++) {
      if (crust.alive[i]) plates.reframe(crust, i, crust.plate[i], W, H);
    }
    plates.recomputeGeometry(crust, W, H, this.pointArea);
  }

  // ---- topology -------------------------------------------------------
  rebuildTopology() {
    this.crustHash.build(this.crust.x, this.crust.y, this.crust.alive, this.crust.n);
    this.slabHash.build(this.slabs.x, this.slabs.y, this.slabs.alive, this.slabs.n);
    this.td.build(this.crust, this.spacing * 3);
    reassignStrays(this);
    this.boundaries.extract(this.td, this.crust, this.plates);
  }

  // ---- one timestep ---------------------------------------------------
  step() {
    const cfg = this.cfg;
    const T = this.timings;
    // Optional per-stage accounting of continental volume. Counting killed
    // points is misleading -- jamTrench and the density merge both destroy
    // points while conserving their volume elsewhere -- so the only honest
    // measure is the change in total continental volume ACROSS each stage.
    const mark = this.trackContinental
      ? (k, fn) => {
          const a = performance.now();
          const before = this.continentalVolume();
          this.stage = k; fn();
          T[k] = performance.now() - a;
          this.contDelta[k] = (this.contDelta[k] || 0) + (this.continentalVolume() - before);
        }
      : (k, fn) => { const a = performance.now(); this.stage = k; fn(); T[k] = performance.now() - a; };

    this.arcActivity = 0;

    // The mantle is solved first: plate velocities this step are the response
    // to the flow beneath them, and the flow is the response to what the
    // plates did last step.
    if (cfg.mantleEnabled) {
      mark('mantle', () => { this.mantle.update(this); this.mantle.tractions(this); });
    }
    mark('velocity', () => updateVelocities(this));
    mark('advect', () => advect(this));

    mark('topology', () => {
      this.crustHash.build(this.crust.x, this.crust.y, this.crust.alive, this.crust.n);
      this.slabHash.build(this.slabs.x, this.slabs.y, this.slabs.alive, this.slabs.n);
      this.td.build(this.crust, this.spacing * 3);
      reassignStrays(this);
    });
    mark('boundaries', () => this.boundaries.extract(this.td, this.crust, this.plates));
    mark('trenches', () => this.trenches.update(this));
    mark('segments', () => this.segments.update(this));

    mark('accrete', () => accrete(this));
    mark('rift-thin', () => riftThinning(this));
    mark('subduct', () => subduct(this));
    mark('collide', () => collide(this));

    // New slab points exist now; refresh the slab index before anything reads it.
    this.slabHash.build(this.slabs.x, this.slabs.y, this.slabs.alive, this.slabs.n);

    mark('arcs', () => volcanicArcs(this));
    mark('hotspots', () => hotspotVolcanism(this));
    mark('volcanoes', () => volcanicEdifices(this));
    mark('magma', () => magmatism(this));
    mark('transform', () => transformEffects(this));
    mark('slabs', () => updateSlabs(this));

    this.slabHash.build(this.slabs.x, this.slabs.y, this.slabs.alive, this.slabs.n);
    mark('slab-feedback', () => slabFeedback(this));

    mark('spread', () => gravitationalSpreading(this));
    mark('surface', () => surfaceProcesses(this));
    mark('rivers', () => fluvialErosion(this));
    mark('litho', () => updateLithosphere(this));
    mark('weakness', () => decayWeakness(this));
    mark('quakes', () => generateQuakes(this));
    mark('density', () => manageDensity(this));

    mark('reorg', () => {
      this.stress = plateStress(this);
      maybeRift(this);
      this.crust.compactTail();
      this.plates.recomputeGeometry(this.crust, this.W, this.H, this.pointArea);
    });

    this.t += cfg.dt;
    this.stepCount++;
    // A rolling record of what each plate is doing and what is attached to it.
    // Any question about what drives plate motion needs many samples over time:
    // a correlation taken across the three or four plates that happen to exist
    // at one instant is determined by three or four points and says nothing.
    if (this.stepCount % 8 === 0) this.sampleKinematics();
    if (this.stepCount % 5 === 0 || this.stepCount < 3) this.audit = auditMass(this);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    return this;
  }

  continentalVolume() {
    let v = 0;
    for (let i = 0; i < this.crust.n; i++) {
      if (this.crust.alive[i]) v += this.crust.continental[i] * this.crust.thickness[i];
    }
    return v * this.pointArea;
  }

  sampleKinematics() {
    const slabPer = new Map();
    for (let k = 0; k < this.slabs.n; k++) {
      if (!this.slabs.alive[k] || this.slabs.coupling[k] < 0.15) continue;
      const id = this.slabs.parentPlate[k];
      slabPer.set(id, (slabPer.get(id) || 0) + 1);
    }
    const minArea = this.W * this.H * 0.02;
    for (const p of this.plates.alive()) {
      if (p.area < minArea) continue;
      this.kinematics.push({
        t: this.t,
        speed: Math.hypot(p.vx, p.vy),
        slabPerArea: (slabPer.get(p.id) || 0) / (p.area / this.pointArea),
        continental: p.continentalArea / p.area,
        areaFrac: p.area / (this.W * this.H),
      });
    }
    if (this.kinematics.length > 4000) this.kinematics.splice(0, this.kinematics.length - 4000);
  }

  stats() {
    return {
      t: this.t,
      crustPoints: this.crust.live,
      slabPoints: this.slabs.live,
      plates: this.plates.aliveCount(),
      faults: this.boundaries.faults.length,
      segments: this.segments.active().length,
      transforms: this.segments.transforms.length,
      trenches: [...this.trenches.all()].length,
      tripleJunctions: (this.boundaries.tripleJunctions || []).length,
      plumes: this.mantle ? this.mantle.plumes.length : 0,
      slabWindows: this.slabWindowCount,
      magmaChambers: this.meltChambers || 0,
      densityOps: this.densityOps,
      audit: this.audit,
      seaLevel: this.seaLevel,
    };
  }

  // ---- snapshots ------------------------------------------------------
  // Snapshot/replay is essential for understanding why a feature formed, and
  // it gets used constantly during tuning.
  snapshot() {
    return {
      t: this.t,
      stepCount: this.stepCount,
      seaLevel: this.seaLevel,
      crust: this.crust.snapshotFields(),
      slabs: this.slabs.snapshotFields(),
      plates: this.plates.list.map((p) => ({ ...p })),
      nextPlateId: this.plates.nextId,
      budget: { ...this.budget },
      rngSeedState: this.rng.seed,
      stats: this.stats(),
    };
  }

  restore(s) {
    this.t = s.t;
    this.stepCount = s.stepCount;
    this.seaLevel = s.seaLevel;
    this.crust.restoreFields(s.crust);
    this.slabs.restoreFields(s.slabs);
    this.plates.list = s.plates.map((o) => Object.assign(Object.create(
      Object.getPrototypeOf(this.plates.list[0] || {})), o));
    this.plates.nextId = s.nextPlateId;
    this.budget = { ...s.budget };
    ensureScratch(this);
    this.rebuildTopology();
    this.audit = auditMass(this);
  }
}
