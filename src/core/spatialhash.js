import { wrapDelta } from './torus.js';

// Uniform bucket grid over the torus, rebuilt from scratch each step. Points
// move far enough per step that incremental updates are not worth the
// complexity. Buckets are CSR-style (counts -> offsets -> items) so the whole
// structure is three typed arrays and no per-cell allocation.
export class SpatialHash {
  constructor(W, H, cell) {
    this.W = W; this.H = H;
    this.setCell(cell);
    this.starts = new Int32Array(this.nx * this.ny + 1);
    this.items = new Int32Array(0);
    this.count = 0;
  }

  setCell(cell) {
    this.cell = cell;
    this.nx = Math.max(1, Math.floor(this.W / cell));
    this.ny = Math.max(1, Math.floor(this.H / cell));
    this.cx = this.W / this.nx;   // actual cell size, so the grid tiles exactly
    this.cy = this.H / this.ny;
  }

  cellX(x) { const i = Math.floor(x / this.cx); return ((i % this.nx) + this.nx) % this.nx; }
  cellY(y) { const j = Math.floor(y / this.cy); return ((j % this.ny) + this.ny) % this.ny; }

  // xs, ys: Float32Array of positions. alive: Uint8Array or null. n: capacity.
  build(xs, ys, alive, n) {
    const { nx, ny } = this;
    const nCells = nx * ny;
    if (this.starts.length !== nCells + 1) this.starts = new Int32Array(nCells + 1);
    const counts = this.starts;
    counts.fill(0);

    let live = 0;
    for (let i = 0; i < n; i++) {
      if (alive && !alive[i]) continue;
      live++;
      counts[this.cellY(ys[i]) * nx + this.cellX(xs[i]) + 1]++;
    }
    for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];

    if (this.items.length < live) this.items = new Int32Array(Math.ceil(live * 1.25));
    const cursor = this._cursor && this._cursor.length === nCells
      ? this._cursor : (this._cursor = new Int32Array(nCells));
    cursor.set(counts.subarray(0, nCells));

    for (let i = 0; i < n; i++) {
      if (alive && !alive[i]) continue;
      const c = this.cellY(ys[i]) * nx + this.cellX(xs[i]);
      this.items[cursor[c]++] = i;
    }
    this.count = live;
    this.xs = xs; this.ys = ys;
    return this;
  }

  // Visit every stored index whose cell lies within `radius` of (x, y).
  // The callback receives (index, squaredDistance); it is pre-filtered by the
  // true torus distance so callers never need to re-check.
  forEachInRadius(x, y, radius, fn) {
    const { nx, ny, cx, cy, W, H } = this;
    const rx = Math.min(nx >> 1, Math.ceil(radius / cx));
    const ry = Math.min(ny >> 1, Math.ceil(radius / cy));
    const r2 = radius * radius;
    const gx = this.cellX(x), gy = this.cellY(y);
    const xs = this.xs, ys = this.ys;
    for (let j = -ry; j <= ry; j++) {
      const yy = ((gy + j) % ny + ny) % ny;
      for (let i = -rx; i <= rx; i++) {
        const xx = ((gx + i) % nx + nx) % nx;
        const c = yy * nx + xx;
        const s = this.starts[c], e = this.starts[c + 1];
        for (let k = s; k < e; k++) {
          const p = this.items[k];
          const dx = wrapDelta(xs[p] - x, W);
          const dy = wrapDelta(ys[p] - y, H);
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) fn(p, d2, dx, dy);
        }
      }
    }
  }

  // Nearest stored index to (x, y) within radius, or -1.
  nearest(x, y, radius) {
    let best = -1, bestD2 = radius * radius;
    this.forEachInRadius(x, y, radius, (p, d2) => {
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    });
    return best;
  }
}
