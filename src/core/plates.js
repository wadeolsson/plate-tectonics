import { wrapPos, wrapDelta } from './torus.js';

// Rigid rotation is not globally well defined on a flat torus, so each plate
// carries an unwrapped local frame. Crust points store (ux, uy), a continuous
// lift of their wrapped render position, and the rotation term is evaluated
// from unwrapped offsets. Any plate whose unwrapped extent exceeds W or H
// wraps the whole domain, where rotation is genuinely undefined, and has
// omega forced to zero.
export class Plate {
  constructor(id, parent = -1) {
    this.id = id;
    this.parent = parent;
    this.alive = true;
    this.vx = 0; this.vy = 0;
    this.omega = 0;
    this.ucx = 0; this.ucy = 0;      // unwrapped centroid (the rotation pivot)
    this.cx = 0; this.cy = 0;        // wrapped centroid, for display only
    this.extentX = 0; this.extentY = 0;
    this.rotOk = true;
    this.area = 0;
    this.continentalArea = 0;
    this.nPoints = 0;
    this.birth = 0;
    this.lastReorg = 0;
    this.hue = 0;
    this.slabPullX = 0; this.slabPullY = 0;
    this.mergedInto = -1;
    this.stressAccum = 0;            // net boundary tension, positive = extensional
  }

  // Velocity of the material point whose unwrapped position is (ux, uy).
  velAtU(ux, uy, out) {
    const dx = ux - this.ucx, dy = uy - this.ucy;
    const om = this.rotOk ? this.omega : 0;
    out[0] = this.vx - om * dy;
    out[1] = this.vy + om * dx;
    return out;
  }

  // Velocity at a wrapped world position. Lifts into the plate frame first.
  velAtWorld(x, y, W, H, out) {
    return this.velAtU(this.liftX(x, W), this.liftY(y, H), out);
  }

  // Lift a wrapped coordinate into this plate's frame, choosing the branch
  // nearest the centroid.
  liftX(x, W) { return this.ucx + wrapDelta(x - wrapPos(this.ucx, W), W); }
  liftY(y, H) { return this.ucy + wrapDelta(y - wrapPos(this.ucy, H), H); }
}

export class PlateRegistry {
  constructor() { this.list = []; this.nextId = 0; }

  create(parent = -1, birth = 0) {
    const p = new Plate(this.nextId++, parent);
    p.birth = birth; p.lastReorg = birth;
    this.list.push(p);
    return p;
  }

  get(id) { return this.list[id]; }
  get count() { return this.list.length; }
  *alive() { for (const p of this.list) if (p.alive) yield p; }
  aliveCount() { let n = 0; for (const p of this.list) if (p.alive) n++; return n; }

  retire(id, intoId) {
    const p = this.list[id];
    if (!p) return;
    p.alive = false;
    p.mergedInto = intoId;
    p.nPoints = 0; p.area = 0; p.continentalArea = 0;
  }

  // Re-establish a point's unwrapped frame. Ownership changes constantly --
  // subduction, rifting and suturing all reassign it -- and a stale lift puts
  // the point a whole domain width away from its new plate's pivot.
  reframe(crust, i, plateId, W, H) {
    const p = this.list[plateId];
    crust.plate[i] = plateId;
    if (!p) { crust.ux[i] = crust.x[i]; crust.uy[i] = crust.y[i]; return; }
    crust.ux[i] = p.liftX(crust.x[i], W);
    crust.uy[i] = p.liftY(crust.y[i], H);
  }

  // Centroid, extent, area and point count from the crust cloud. The lift
  // makes this a plain arithmetic mean; the frame is then recentred so the
  // unwrapped coordinates stay bounded over a multi-Gyr run.
  recomputeGeometry(crust, W, H, pointArea) {
    const n = this.list.length;
    const sx = new Float64Array(n), sy = new Float64Array(n), cnt = new Float64Array(n);
    const minX = new Float64Array(n).fill(Infinity), maxX = new Float64Array(n).fill(-Infinity);
    const minY = new Float64Array(n).fill(Infinity), maxY = new Float64Array(n).fill(-Infinity);
    for (const p of this.list) { p.nPoints = 0; p.area = 0; p.continentalArea = 0; }

    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const id = crust.plate[i];
      const p = this.list[id];
      if (!p) continue;
      const ux = crust.ux[i], uy = crust.uy[i];
      sx[id] += ux; sy[id] += uy; cnt[id]++;
      if (ux < minX[id]) minX[id] = ux;
      if (ux > maxX[id]) maxX[id] = ux;
      if (uy < minY[id]) minY[id] = uy;
      if (uy > maxY[id]) maxY[id] = uy;
      p.nPoints++;
      p.area += pointArea;
      p.continentalArea += pointArea * crust.continental[i];
    }

    const shiftX = new Float64Array(n), shiftY = new Float64Array(n);
    for (const p of this.list) {
      if (!p.alive) continue;
      if (p.nPoints === 0) { this.retire(p.id, -1); continue; }
      p.ucx = sx[p.id] / cnt[p.id];
      p.ucy = sy[p.id] / cnt[p.id];
      p.extentX = maxX[p.id] - minX[p.id];
      p.extentY = maxY[p.id] - minY[p.id];
      // A plate spanning the full domain has no well-defined pivot.
      p.rotOk = p.extentX < W * 0.98 && p.extentY < H * 0.98;
      if (!p.rotOk) p.omega = 0;
      // Keep the lift bounded: shift by whole domain widths, which leaves
      // every ux congruent to its wrapped x.
      shiftX[p.id] = -Math.floor(p.ucx / W) * W;
      shiftY[p.id] = -Math.floor(p.ucy / H) * H;
      p.ucx += shiftX[p.id]; p.ucy += shiftY[p.id];
      p.cx = wrapPos(p.ucx, W); p.cy = wrapPos(p.ucy, H);
    }

    for (let i = 0; i < crust.n; i++) {
      if (!crust.alive[i]) continue;
      const id = crust.plate[i];
      if (shiftX[id] || shiftY[id]) { crust.ux[i] += shiftX[id]; crust.uy[i] += shiftY[id]; }
    }
  }
}
