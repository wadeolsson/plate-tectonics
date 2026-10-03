import { ROCK, pushTop, scaleColumn, topRock, rockResistance } from './rocks.js';
import { elevationOf } from './elevation.js';

// Rivers.
//
// Everything else in this file's neighbourhood -- hillslope transfer, pelagic
// deposition -- is LOCAL: a column looks at the ground beside it and moves
// material a short way downhill. Local rules make smooth domes. They cannot
// make a landscape, because the thing that organises real topography is not
// local at all: a river at the bottom of a continent carries the water that
// fell a thousand kilometres away, and it cuts in proportion to that
// accumulated discharge. Valleys deepen where water collects, divides stay
// high between them, and the whole surface becomes a branching network rather
// than a set of blobs. That is the single biggest difference between terrain
// that reads as a planet and terrain that reads as noise.
//
// So this is a proper drainage model, on a grid, run on an interval:
//
//   1. sample the point cloud onto a grid, nearest-point so that nothing is
//      invented between points and the mapping back is exact;
//   2. fill depressions (priority flood) so every land cell has a path to the
//      sea -- without this most of the map is undrained pits and no network
//      forms at all. What the filling adds is a lake;
//   3. route D8 down the filled surface and accumulate drainage area;
//   4. incise by stream power, dz = K A^m S^n, divided by rock resistance;
//   5. carry the debris downstream and drop it in lakes, basins and the sea.
//
// Mass is conserved exactly: the grid is a nearest-point partition, so the
// volume taken off a point's cells is the volume put back on some other
// point's cells, and the remainder is handed to the ocean as sediment.

// --- a small binary heap, keyed on elevation ------------------------------
class MinHeap {
  constructor(cap) {
    this.k = new Float32Array(cap);     // key (elevation)
    this.v = new Int32Array(cap);       // value (cell index)
    this.n = 0;
  }
  clear() { this.n = 0; }
  push(key, val) {
    let i = this.n++;
    const { k, v } = this;
    k[i] = key; v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p], tv = v[p]; k[p] = k[i]; v[p] = v[i]; k[i] = tk; v[i] = tv;
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    this.n--;
    if (this.n > 0) {
      k[0] = k[this.n]; v[0] = v[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.n && k[l] < k[m]) m = l;
        if (r < this.n && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m], tv = v[m]; k[m] = k[i]; v[m] = v[i]; k[i] = tk; v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

export class Drainage {
  constructor(world) {
    const { cfg } = world;
    // One cell per crust point, near enough. Finer would be inventing detail
    // the cloud cannot store; coarser would lose the valleys.
    this.gw = Math.max(16, Math.round(cfg.W / cfg.spacing));
    this.gh = Math.max(16, Math.round(cfg.H / cfg.spacing));
    this.cw = cfg.W / this.gw;
    this.ch = cfg.H / this.gh;
    this.cellArea = this.cw * this.ch;
    const n = this.gw * this.gh;
    this.owner = new Int32Array(n);      // nearest live crust point
    this.elev = new Float32Array(n);
    this.filled = new Float32Array(n);
    this.recv = new Int32Array(n);       // D8 receiver, -1 = sink/sea
    this.area = new Float32Array(n);     // drainage area, km^2
    this.order = new Int32Array(n);      // cells sorted by filled elev, desc
    this.dz = new Float32Array(n);       // incision this pass, km (positive = removed)
    this.flux = new Float32Array(n);     // sediment in transit, km^3
    this.heap = new MinHeap(n);
    this.seen = new Uint8Array(n);
    this.riverArea = new Float32Array(n); // exposed for the map layer
  }

  // --- sample the cloud -----------------------------------------------------
  // Nearest live point wins each cell. Done by scattering from the points so
  // the cost is O(points x footprint) rather than O(cells x points).
  sample(world) {
    const { cfg, crust } = world;
    const { gw, gh, cw, ch, owner, elev } = this;
    owner.fill(-1);
    const best = this._best || (this._best = new Float32Array(gw * gh));
    best.fill(Infinity);
    const R = cfg.spacing * 1.4, R2 = R * R;
    const rx = Math.max(1, Math.ceil(R / cw)), ry = Math.max(1, Math.ceil(R / ch));
    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const px = crust.x[i] / cw, py = crust.y[i] / ch;
      const gx0 = Math.floor(px), gy0 = Math.floor(py);
      for (let dy = -ry; dy <= ry; dy++) {
        const gy = ((gy0 + dy) % gh + gh) % gh;
        const ddy = (gy0 + dy + 0.5 - py) * ch;
        for (let dx = -rx; dx <= rx; dx++) {
          const ddx = (gx0 + dx + 0.5 - px) * cw;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > R2) continue;
          const c = gy * gw + ((gx0 + dx) % gw + gw) % gw;
          if (d2 < best[c]) { best[c] = d2; owner[c] = i; }
        }
      }
    }
    for (let c = 0; c < owner.length; c++) {
      const i = owner[c];
      elev[c] = i < 0 ? -9 : elevationOf(cfg, crust.thickness[i], crust.continental[i],
        crust.litho[i], crust.age[i], crust.edifice[i]);
    }
  }

  // --- priority flood -------------------------------------------------------
  // Every cell at or below sea level is an outlet. Growing inward from the
  // outlets in elevation order, a cell can never be lower than the lowest path
  // it was reached by, which is precisely the filled surface. The epsilon keeps
  // a filled flat from being perfectly level, so D8 still finds a direction
  // across it instead of stalling.
  fill(seaLevel) {
    const { gw, gh, elev, filled, heap, seen } = this;
    const n = gw * gh;
    const EPS = 1e-4;
    heap.clear();
    seen.fill(0);
    for (let c = 0; c < n; c++) {
      filled[c] = elev[c];
      if (elev[c] <= seaLevel) { seen[c] = 1; heap.push(elev[c], c); }
    }
    // A world with no sea at all (or an all-land pass) still needs an outlet.
    if (heap.n === 0) {
      let lo = 0;
      for (let c = 1; c < n; c++) if (elev[c] < elev[lo]) lo = c;
      seen[lo] = 1; heap.push(elev[lo], lo);
    }
    while (heap.n > 0) {
      const c = heap.pop();
      const h = filled[c];
      const x = c % gw, y = (c / gw) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = (x + DX[k] + gw) % gw, ny = (y + DY[k] + gh) % gh;
        const d = ny * gw + nx;
        if (seen[d]) continue;
        seen[d] = 1;
        filled[d] = elev[d] > h ? elev[d] : h + EPS;
        heap.push(filled[d], d);
      }
    }
  }

  // --- D8 routing and drainage accumulation --------------------------------
  route(seaLevel) {
    const { gw, gh, cw, ch, filled, recv, area, order, cellArea } = this;
    const n = gw * gh;
    const diag = Math.hypot(cw, ch);
    const dist = [cw, diag, ch, diag, cw, diag, ch, diag];
    for (let c = 0; c < n; c++) {
      if (filled[c] <= seaLevel) { recv[c] = -1; area[c] = 0; continue; }
      const x = c % gw, y = (c / gw) | 0;
      let bestK = -1, bestS = 0;
      for (let k = 0; k < 8; k++) {
        const nx = (x + DX[k] + gw) % gw, ny = (y + DY[k] + gh) % gh;
        const d = ny * gw + nx;
        const s = (filled[c] - filled[d]) / dist[k];
        if (s > bestS) { bestS = s; bestK = k; }
      }
      if (bestK < 0) { recv[c] = -1; }
      else {
        const nx = (x + DX[bestK] + gw) % gw, ny = (y + DY[bestK] + gh) % gh;
        recv[c] = ny * gw + nx;
      }
      area[c] = cellArea;      // every land cell generates its own runoff
    }
    // Accumulate downstream. Processing in descending filled elevation is a
    // valid topological order because water only ever moves to lower ground.
    for (let c = 0; c < n; c++) order[c] = c;
    const f = filled;
    const arr = Array.from(order);
    arr.sort((a, b) => f[b] - f[a]);
    for (let j = 0; j < n; j++) order[j] = arr[j];
    for (let j = 0; j < n; j++) {
      const c = order[j];
      const r = recv[c];
      if (r >= 0) area[r] += area[c];
    }
  }

  // --- stream power incision and sediment routing --------------------------
  incise(world, dt) {
    const { cfg, crust } = world;
    const { gw, gh, cw, ch, filled, elev, recv, area, order, dz, flux, cellArea, owner } = this;
    const n = gw * gh;
    const sea = world.seaLevel;
    const diag = Math.hypot(cw, ch);
    const dist = [cw, diag, ch, diag, cw, diag, ch, diag];
    dz.fill(0); flux.fill(0);
    let incised = 0;

    // Downstream pass: cut, then hand the debris to the receiver.
    for (let j = 0; j < n; j++) {
      const c = order[j];
      const r = recv[c];
      const i = owner[c];
      if (r >= 0 && i >= 0 && filled[c] > sea) {
        // Slope on the FILLED surface: inside a lake this is the epsilon, so
        // lakes do not incise, which is correct -- they fill instead.
        let d = cw;
        const x = c % gw, y = (c / gw) | 0;
        const rx = r % gw, ry = (r / gw) | 0;
        let ddx = rx - x; if (ddx > gw / 2) ddx -= gw; if (ddx < -gw / 2) ddx += gw;
        let ddy = ry - y; if (ddy > gh / 2) ddy -= gh; if (ddy < -gh / 2) ddy += gh;
        d = Math.hypot(ddx * cw, ddy * ch);
        const S = Math.max(0, (filled[c] - filled[r]) / d);
        const resist = rockResistance(topRock(crust, i));
        // dz = K A^m S^n. m/n near 0.5/1 is the standard detachment-limited
        // form; it is why big rivers sit in deep valleys and headwaters do not.
        let cut = cfg.streamK * Math.pow(area[c], cfg.streamM)
                * Math.pow(S, cfg.streamN) * dt / resist;
        // Never cut below the receiver -- that would dig a new pit and the
        // next pass would spend all its effort filling it again.
        const headroom = Math.max(0, (filled[c] - filled[r]) * 0.5);
        if (cut > headroom) cut = headroom;
        if (cut > cfg.streamMaxCut * dt) cut = cfg.streamMaxCut * dt;
        if (cut > 0) {
          dz[c] = cut;
          flux[c] += cut * cellArea;
          incised += cut * cellArea;
        }
      }
      // Hand whatever this cell is carrying to its receiver. A cell that is a
      // sink (a lake floor or the sea) keeps it, and it is deposited below.
      if (r >= 0) flux[r] += flux[c];
    }

    // Deposition. Sinks hold what arrived: lake floors (filled above the real
    // surface) and the sea. The sea gets a share spread over the shelf rather
    // than piled on the single cell the river happens to reach.
    let deposited = 0, toSea = 0;
    const mouths = [], mouthFlux = [];
    for (let c = 0; c < n; c++) {
      const f = flux[c];
      if (f <= 0) continue;
      if (recv[c] >= 0) continue;              // not a sink; already passed on
      if (filled[c] > sea) {
        // An interior basin: the debris stays, up to the depth of the lake.
        const room = Math.max(0, filled[c] - elev[c]) + cfg.streamBasinFill;
        const take = Math.min(f, room * cellArea);
        dz[c] -= take / cellArea;
        deposited += take;
        toSea += f - take;
      } else {
        // A river mouth. The load does not vanish at the shoreline -- it
        // builds a delta and then a shelf wedge, and over a few hundred Myr
        // that is how a passive margin is constructed. Dropping it instead
        // was quietly deleting continental crust from the world: enough of it
        // to stop continents rifting at all, because there was progressively
        // less continent to rift.
        toSea += f;
        mouths.push(c); mouthFlux.push(f);
      }
    }

    // Spread each mouth's load over the submarine cells around it, preferring
    // the deepest, and never building above sea level -- a delta progrades,
    // it does not pile into a hill.
    let shelved = 0;
    for (let mi = 0; mi < mouths.length; mi++) {
      let left = mouthFlux[mi];
      const c0 = mouths[mi];
      const x0 = c0 % gw, y0 = (c0 / gw) | 0;
      for (let ring = 0; ring <= cfg.deltaRadius && left > 1e-9; ring++) {
        const cells = [], room = [];
        let rsum = 0;
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const cx = (x0 + dx + gw) % gw, cy = (y0 + dy + gh) % gh;
            const c = cy * gw + cx;
            if (owner[c] < 0) continue;
            const depth = sea - (elev[c] - dz[c]);
            if (depth <= 0.02) continue;              // already at the surface
            cells.push(c); room.push(depth); rsum += depth;
          }
        }
        if (rsum <= 0) continue;
        for (let k = 0; k < cells.length && left > 1e-9; k++) {
          const cap = room[k] * cellArea;
          const want = Math.min(cap, left * (room[k] / rsum));
          if (want <= 0) continue;
          dz[cells[k]] -= want / cellArea;
          left -= want;
          shelved += want;
        }
      }
      toSea -= mouthFlux[mi] - left;
    }
    deposited += shelved;
    this.lastShelved = shelved;
    this.lastIncised = incised;
    this.lastDeposited = deposited;
    this.toSea = toSea;

    // Keep the river map layer in sync.
    this.riverArea.set(area);
    return incised;
  }

  // --- write the result back onto the point cloud --------------------------
  // Each cell belongs to exactly one point, so summing cell volumes per point
  // is exact. Erosion scales the column; deposition pushes a sediment layer.
  apply(world) {
    const { crust, pointArea } = world;
    const { owner, dz, cellArea } = this;
    const sc = world.scratch;
    if (!sc.fluvDv || sc.fluvDv.length < crust.capacity) {
      sc.fluvDv = new Float32Array(crust.capacity);
    }
    const dv = sc.fluvDv;
    dv.fill(0, 0, crust.n);
    for (let c = 0; c < owner.length; c++) {
      const i = owner[c];
      if (i >= 0 && dz[c] !== 0) dv[i] += dz[c] * cellArea;
    }
    let eroded = 0, laid = 0;
    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i] || dv[i] === 0) continue;
      const dh = dv[i] / pointArea;
      if (dh > 0) {
        const t0 = crust.thickness[i];
        const take = Math.min(dh, t0 - 4);
        if (take <= 1e-5) continue;
        scaleColumn(crust, i, (t0 - take) / t0);
        eroded += take * pointArea;
      } else {
        const h = -dh;
        if (h <= 1e-5) continue;
        pushTop(crust, i, h, ROCK.SEDIMENT, crust.continental[i], world.t);
        laid += h * pointArea;
      }
    }
    this.lastEroded = eroded;
    this.lastLaid = laid;
    return eroded - laid;     // net volume owed to the ocean
  }
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

// --- the driver -----------------------------------------------------------
export function fluvialErosion(world) {
  const { cfg } = world;
  if (!cfg.fluvialEnabled) return;
  if (world.stepCount % cfg.fluvialInterval !== 0) return;
  const dt = cfg.fluvialInterval * cfg.dt;
  const d = world.drainage || (world.drainage = new Drainage(world));
  d.sample(world);
  d.fill(world.seaLevel);
  d.route(world.seaLevel);
  d.incise(world, dt);
  const net = d.apply(world);
  // Whatever the rivers delivered past the shoreline leaves the land budget.
  // It is not lost -- marine deposition puts sediment back every step -- but
  // the two are not the same material, so the ledger records the transfer.
  if (net > 0) world.budget.lost += net;
  else if (net < 0) world.budget.created += -net;
  world.fluvial = {
    incised: d.lastIncised, deposited: d.lastDeposited,
    eroded: d.lastEroded, laid: d.lastLaid, toSea: d.toSea,
  };
}
