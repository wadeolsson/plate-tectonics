import Delaunator from '../vendor/delaunator.js';
import { wrapPos } from '../core/torus.js';

// Periodic Delaunay by ghosting. Points within `pad` of an edge are replicated
// on the far side, the padded set is triangulated with a standard library, and
// ghost vertices are mapped back to their originals. A true periodic Delaunay
// is more elegant and not worth writing; two to three cell widths of padding
// is plenty.
export class TorusDelaunay {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.coords = new Float64Array(0);   // padded, may fall outside [0,W)x[0,H)
    this.orig = new Int32Array(0);       // padded index -> crust index
    this.isGhost = new Uint8Array(0);
    this.nPadded = 0;
    this.triangles = null;
    this.halfedges = null;
    this.ccx = new Float64Array(0);      // circumcentre per triangle, padded space
    this.ccy = new Float64Array(0);
  }

  build(crust, pad) {
    const { W, H } = this;
    const nMax = crust.n;
    // Worst case each point spawns 3 ghosts (corner), but in practice the
    // fringe is thin; size generously then trim.
    let cap = this.coords.length >> 1;
    const estimate = crust.live + Math.ceil(crust.live * (2 * pad / W + 2 * pad / H) * 2.5) + 64;
    if (cap < estimate) {
      cap = Math.ceil(estimate * 1.3);
      this.coords = new Float64Array(cap * 2);
      this.orig = new Int32Array(cap);
      this.isGhost = new Uint8Array(cap);
    }

    const coords = this.coords, orig = this.orig, ghost = this.isGhost;
    let m = 0;
    const push = (x, y, i, g) => {
      if (m >= orig.length) {                     // grow, rare
        const c2 = new Float64Array(coords.length * 2);   c2.set(coords);
        const o2 = new Int32Array(orig.length * 2);       o2.set(orig);
        const g2 = new Uint8Array(ghost.length * 2);      g2.set(ghost);
        this.coords = c2; this.orig = o2; this.isGhost = g2;
        return push.call(this, x, y, i, g);
      }
      this.coords[2 * m] = x; this.coords[2 * m + 1] = y;
      this.orig[m] = i; this.isGhost[m] = g;
      m++;
    };

    for (let i = 0; i < nMax; i++) {
      if (!crust.alive[i]) continue;
      const x = crust.x[i], y = crust.y[i];
      push(x, y, i, 0);
      const lo = x < pad, hi = x > W - pad;
      const bo = y < pad, to = y > H - pad;
      if (lo) push(x + W, y, i, 1);
      if (hi) push(x - W, y, i, 1);
      if (bo) push(x, y + H, i, 1);
      if (to) push(x, y - H, i, 1);
      if (lo && bo) push(x + W, y + H, i, 1);
      if (lo && to) push(x + W, y - H, i, 1);
      if (hi && bo) push(x - W, y + H, i, 1);
      if (hi && to) push(x - W, y - H, i, 1);
    }
    this.nPadded = m;

    const view = this.coords.subarray(0, m * 2);
    const d = new Delaunator(view);
    this.triangles = d.triangles;
    this.halfedges = d.halfedges;
    this._circumcentres();
    return this;
  }

  _circumcentres() {
    const t = this.triangles, c = this.coords;
    const nt = t.length / 3;
    if (this.ccx.length < nt) { this.ccx = new Float64Array(nt); this.ccy = new Float64Array(nt); }
    for (let k = 0; k < nt; k++) {
      const a = t[3 * k] * 2, b = t[3 * k + 1] * 2, e = t[3 * k + 2] * 2;
      const ax = c[a], ay = c[a + 1];
      const bx = c[b] - ax, by = c[b + 1] - ay;
      const cx = c[e] - ax, cy = c[e + 1] - ay;
      const bl = bx * bx + by * by, cl = cx * cx + cy * cy;
      const dd = bx * cy - by * cx;
      if (Math.abs(dd) < 1e-12) {          // degenerate sliver
        this.ccx[k] = ax + (bx + cx) / 3;
        this.ccy[k] = ay + (by + cy) / 3;
      } else {
        const f = 0.5 / dd;
        this.ccx[k] = ax + (cy * bl - by * cl) * f;
        this.ccy[k] = ay + (bx * cl - cx * bl) * f;
      }
    }
    this.nTriangles = nt;
  }

  wrappedCC(k) {
    return [wrapPos(this.ccx[k], this.W), wrapPos(this.ccy[k], this.H)];
  }
}

export const triOfEdge = (e) => (e / 3) | 0;
export const nextHalfedge = (e) => (e % 3 === 2 ? e - 2 : e + 1);
export const prevHalfedge = (e) => (e % 3 === 0 ? e + 2 : e - 1);
