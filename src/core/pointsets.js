// Structure-of-arrays point sets with free lists. Point counts are large and
// the hot loops are numeric, so nothing here is an array of objects. Churn is
// high and steady -- every step creates points at divergent boundaries and
// destroys them at convergent ones -- so slots are recycled rather than spliced.

// Fields may be strided: a field declared with a stride of k holds k values
// per point, laid out contiguously, so a per-point stack (a crustal column, for
// instance) stays in the same structure-of-arrays discipline as everything
// else rather than becoming an array of little objects.
class SoA {
  constructor(capacity, fields) {
    this.capacity = capacity;
    this.n = 0;              // high-water mark; iterate [0, n) and test alive
    this.live = 0;
    this._fields = fields;
    this.free = [];
    this.alive = new Uint8Array(capacity);
    for (const [name, Ctor, stride = 1] of fields) this[name] = new Ctor(capacity * stride);
  }

  _grow() {
    const cap = Math.ceil(this.capacity * 1.6) + 1024;
    for (const [name, Ctor, stride = 1] of this._fields) {
      const next = new Ctor(cap * stride);
      next.set(this[name]);
      this[name] = next;
    }
    const a = new Uint8Array(cap); a.set(this.alive); this.alive = a;
    this.capacity = cap;
  }

  alloc() {
    let i;
    if (this.free.length) i = this.free.pop();
    else {
      if (this.n >= this.capacity) this._grow();
      i = this.n++;
    }
    this.alive[i] = 1;
    this.live++;
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.free.push(i);
    this.live--;
  }

  clear() {
    this.alive.fill(0);
    this.free.length = 0;
    this.n = 0;
    this.live = 0;
  }

  compactTail() {
    while (this.n > 0 && !this.alive[this.n - 1]) this.n--;
    if (this.free.length) {
      const n = this.n;
      let w = 0;
      for (let k = 0; k < this.free.length; k++) {
        if (this.free[k] < n) this.free[w++] = this.free[k];
      }
      this.free.length = w;
    }
  }

  snapshotFields() {
    const out = { n: this.n, live: this.live, alive: this.alive.slice(0, this.n) };
    for (const [name, , stride = 1] of this._fields) out[name] = this[name].slice(0, this.n * stride);
    return out;
  }

  restoreFields(s) {
    this.clear();
    while (this.capacity < s.n) this._grow();
    this.alive.set(s.alive);
    for (const [name] of this._fields) this[name].set(s[name]);
    this.n = s.n; this.live = s.live;
    for (let i = 0; i < this.n; i++) if (!this.alive[i]) this.free.push(i);
  }
}

// How many layers a crustal column may carry. Enough for sediment, a volcanic
// pile, upper and lower crust and a couple of accreted or underplated slices;
// beyond that the thinnest adjacent pair is merged.
export const MAX_LAYERS = 8;

export class CrustSet extends SoA {
  constructor(capacity) {
    super(capacity, [
      ['x', Float32Array],           // km, always within [0,W)  -- render frame
      ['y', Float32Array],
      ['ux', Float32Array],          // unwrapped lift of x in the owning plate's
      ['uy', Float32Array],          // local frame; rigid rotation needs this
      ['plate', Uint16Array],
      ['continental', Float32Array], // 0 = pure oceanic, 1 = pure continental
      ['thickness', Float32Array],   // km of crust
      ['litho', Float32Array],       // km of mantle lithosphere below the crust
      ['age', Float32Array],         // Myr since formation (oceanic)
      ['defAge', Float32Array],      // Myr since last deformation (continental)
      ['segment', Uint32Array],      // ridge segment that made it; never reassigned
      ['weakness', Float32Array],    // 0-1 inherited structural weakness

      // Magma in residence. Volcanism used to be instantaneous -- the slab
      // reached arc depth and rock appeared the same step -- which left
      // nothing to draw and made arcs switch off the moment the slab moved.
      // A reservoir with a residence time gives chambers, dikes and a
      // magmatic system that drains over a few Myr instead of vanishing.
      ['melt', Float32Array],        // km of magma held in the column
      ['meltDepth', Float32Array],   // km below the surface the chamber sits
      ['meltFelsic', Float32Array],  // composition of that magma
      ['erupting', Float32Array],    // km/Myr reaching the surface right now
      // Height of volcanic construct standing on this column. Kept apart from
      // thickness because a narrow edifice is NOT Airy-compensated -- the
      // lithosphere carries it flexurally, which is why Mauna Loa stands 9 km
      // above the sea floor instead of the 1.5 km local isostasy would allow.
      ['edifice', Float32Array],

      // The crustal column, top (youngest) first. `thickness` and
      // `continental` above are CACHES derived from these -- see rocks.js.
      // Each layer carries its own felsic fraction as well as a rock type, so
      // a layer can be a mixture rather than being snapped to the nominal
      // composition of the nearest named rock.
      ['layerThick', Float32Array, MAX_LAYERS],   // km
      ['layerType', Uint8Array, MAX_LAYERS],      // ROCK id
      ['layerFelsic', Float32Array, MAX_LAYERS],  // 0-1, continental character
      ['layerAge', Float32Array, MAX_LAYERS],     // Myr when emplaced
      ['layerTmax', Float32Array, MAX_LAYERS],    // peak metamorphic T seen
      ['nLayers', Uint8Array],
    ]);
  }

  spawn(o) {
    const i = this.alloc();
    // Slots are recycled, so the column is cleared here. A spawn site that
    // forgets to build one then trips the empty-column check in validation
    // instead of silently inheriting the previous occupant's rocks.
    this.nLayers[i] = 0;
    this.x[i] = o.x; this.y[i] = o.y;
    this.ux[i] = o.ux !== undefined ? o.ux : o.x;
    this.uy[i] = o.uy !== undefined ? o.uy : o.y;
    this.plate[i] = o.plate;
    this.continental[i] = o.continental;
    this.thickness[i] = o.thickness;
    this.litho[i] = o.litho !== undefined ? o.litho : 10;
    this.age[i] = o.age || 0;
    this.defAge[i] = o.defAge || 0;
    this.segment[i] = o.segment || 0;
    this.weakness[i] = o.weakness || 0;
    return i;
  }
}

export class SlabSet extends SoA {
  constructor(capacity) {
    super(capacity, [
      ['x', Float32Array],
      ['y', Float32Array],
      ['depth', Float32Array],        // km below surface, 0 -> ~660
      ['dip', Float32Array],          // radians
      ['ageAtSub', Float32Array],
      ['continental', Float32Array],  // buoyant material resists sinking
      ['thickness', Float32Array],    // crustal thickness carried down (mass budget)
      ['litho', Float32Array],        // lithospheric thickness carried down
      ['parentPlate', Uint16Array],
      ['coupling', Float32Array],     // 0-1 grip on the parent plate
      ['dirX', Float32Array],         // unit vector of downdip travel
      ['dirY', Float32Array],
      ['birth', Float32Array],
      ['slabId', Uint32Array],        // coherent slab this point belongs to
      ['along', Float32Array],        // distance travelled along the slab from the trench
      ['vdd', Float32Array],          // downdip speed, km/Myr
      ['eclogite', Float32Array],     // 0-1 of the subducted crust converted
    ]);
  }

  spawn(o) {
    const i = this.alloc();
    this.x[i] = o.x; this.y[i] = o.y;
    this.depth[i] = o.depth || 0;
    this.dip[i] = o.dip;
    this.ageAtSub[i] = o.ageAtSub;
    this.continental[i] = o.continental;
    this.thickness[i] = o.thickness;
    this.litho[i] = o.litho;
    this.parentPlate[i] = o.parentPlate;
    this.coupling[i] = 1;
    this.dirX[i] = o.dirX; this.dirY[i] = o.dirY;
    this.birth[i] = o.birth;
    this.slabId[i] = o.slabId;
    this.along[i] = 0;
    this.vdd[i] = o.vdd;
    this.eclogite[i] = 0;
    return i;
  }
}
