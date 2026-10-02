import { triOfEdge, nextHalfedge } from './delaunay.js';
import { wrapPos, wrapDelta } from '../core/torus.js';

// Feature classes. These drive symbology and pick which convergent process
// runs; the *magnitude* of every process comes from the continuous vn / vt
// components, never from the bucket.
export const KIND = {
  RIDGE: 0,        // divergent, ocean / ocean
  RIFT: 1,         // divergent, continental involved
  TRENCH: 2,       // convergent, ocean under continent
  ISLAND_ARC: 3,   // convergent, ocean under ocean
  SUTURE: 4,       // convergent, continent vs continent
  TRANSFORM: 5,
};
export const KIND_NAME = ['ridge', 'rift', 'trench', 'island arc', 'suture', 'transform'];

const CONT_THRESHOLD = 0.4;   // continental fraction above which crust behaves continentally

// The boundary is the set of Voronoi edges separating points of different
// plates. The naive "flag every point whose neighbour is on another plate"
// gives a fuzzy band two points wide with no object to attach history to.
// This gives a genuine one-edge-wide polyline network instead.
export class BoundaryNetwork {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.count = 0;
    this._alloc(4096);
    this.faults = [];
    this.prevFaults = [];
    this.nextFaultId = 1;
  }

  _alloc(n) {
    this.cap = n;
    this.ax = new Float32Array(n); this.ay = new Float32Array(n);
    this.bx = new Float32Array(n); this.by = new Float32Array(n);
    this.mx = new Float32Array(n); this.my = new Float32Array(n);
    this.len = new Float32Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n);
    this.plateA = new Int32Array(n); this.plateB = new Int32Array(n);
    this.ptA = new Int32Array(n); this.ptB = new Int32Array(n);
    this.vn = new Float32Array(n); this.vt = new Float32Array(n);
    this.obliquity = new Float32Array(n); this.rate = new Float32Array(n);
    this.contA = new Float32Array(n); this.contB = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.faultId = new Int32Array(n);
    this.nodeA = new Int32Array(n); this.nodeB = new Int32Array(n);
  }

  _ensure(n) { if (n > this.cap) this._alloc(Math.ceil(n * 1.5)); }

  // ---- extraction ------------------------------------------------------
  extract(td, crust, plates) {
    const { W, H } = this;
    const tri = td.triangles, half = td.halfedges, orig = td.orig, ghost = td.isGhost;
    const coords = td.coords;
    const nHalf = tri.length;

    // Canonicalise dual vertices by wrapped position so a boundary crossing
    // the seam is one connected component, not two. Quantisation is far below
    // point spacing, so false merges are not a concern.
    const q = 1e-2;
    const nodeKey = new Map();
    const nodeX = [], nodeY = [];
    const canonNode = (t) => {
      const x = wrapPos(td.ccx[t], W), y = wrapPos(td.ccy[t], H);
      const k = Math.round(x / q) + ':' + Math.round(y / q);
      let id = nodeKey.get(k);
      if (id === undefined) { id = nodeX.length; nodeKey.set(k, id); nodeX.push(x); nodeY.push(y); }
      return id;
    };

    const seen = new Set();
    let m = 0;
    this._ensure(4096);
    const va = [0, 0], vb = [0, 0];

    for (let e = 0; e < nHalf; e++) {
      const o = half[e];
      if (o < 0 || o < e) continue;             // hull edge, or already handled
      const pi = tri[e], qi = tri[nextHalfedge(e)];
      if (ghost[pi] && ghost[qi]) continue;     // ghost-only duplicate
      const ia = orig[pi], ib = orig[qi];
      const pa = crust.plate[ia], pb = crust.plate[ib];
      if (pa === pb) continue;
      const key = ia < ib ? ia * 4294967296 + ib : ib * 4294967296 + ia;
      if (seen.has(key)) continue;
      seen.add(key);

      const t1 = triOfEdge(e), t2 = triOfEdge(o);
      const n1 = canonNode(t1), n2 = canonNode(t2);
      const cx1 = td.ccx[t1], cy1 = td.ccy[t1];
      const cx2 = td.ccx[t2], cy2 = td.ccy[t2];
      const dlx = cx2 - cx1, dly = cy2 - cy1;
      const L = Math.hypot(dlx, dly);
      if (!(L > 0) || L > Math.min(W, H) * 0.25) continue;   // degenerate / runaway sliver

      // Normal points from A into B: the Delaunay edge direction. Both
      // vertices live in the same padded frame, so this delta is already the
      // shortest torus connection.
      let ex = coords[2 * qi] - coords[2 * pi];
      let ey = coords[2 * qi + 1] - coords[2 * pi + 1];
      const eL = Math.hypot(ex, ey) || 1;
      ex /= eL; ey /= eL;

      this._ensure(m + 1);
      const mxw = wrapPos(cx1 + dlx * 0.5, W), myw = wrapPos(cy1 + dly * 0.5, H);
      this.ax[m] = wrapPos(cx1, W); this.ay[m] = wrapPos(cy1, H);
      this.bx[m] = wrapPos(cx2, W); this.by[m] = wrapPos(cy2, H);
      this.mx[m] = mxw; this.my[m] = myw;
      this.len[m] = L;
      this.nx[m] = ex; this.ny[m] = ey;
      this.plateA[m] = pa; this.plateB[m] = pb;
      this.ptA[m] = ia; this.ptB[m] = ib;
      this.contA[m] = crust.continental[ia];
      this.contB[m] = crust.continental[ib];
      this.nodeA[m] = n1; this.nodeB[m] = n2;
      this.faultId[m] = 0;
      m++;
    }
    this.count = m;
    this.nodeX = nodeX; this.nodeY = nodeY;

    this.classify(plates);
    this.assembleFaults();
    this.findTripleJunctions();
    return this;
  }

  // ---- classification --------------------------------------------------
  // Store the continuous obliquity angle. Transpressional and transtensional
  // boundaries are common and are lost the moment you snap to three types.
  classify(plates) {
    const { W, H } = this;
    const va = [0, 0], vb = [0, 0];
    for (let i = 0; i < this.count; i++) {
      const A = plates.get(this.plateA[i]), B = plates.get(this.plateB[i]);
      if (!A || !B) { this.kind[i] = KIND.TRANSFORM; continue; }
      const mx = this.mx[i], my = this.my[i];
      A.velAtWorld(mx, my, W, H, va);
      B.velAtWorld(mx, my, W, H, vb);
      const rx = vb[0] - va[0], ry = vb[1] - va[1];
      const nx = this.nx[i], ny = this.ny[i];
      const tx = -ny, ty = nx;
      const vn = rx * nx + ry * ny;     // positive = opening
      const vt = rx * tx + ry * ty;     // shear
      this.vn[i] = vn; this.vt[i] = vt;
      this.obliquity[i] = Math.atan2(Math.abs(vt), -vn);
      this.rate[i] = Math.hypot(vn, vt);
      this.kind[i] = this._kindOf(this.obliquity[i], this.contA[i], this.contB[i]);
    }
  }

  _kindOf(ob, ca, cb) {
    const contA = ca > CONT_THRESHOLD, contB = cb > CONT_THRESHOLD;
    if (ob > Math.PI * 0.625) {                       // divergent
      return (contA || contB) ? KIND.RIFT : KIND.RIDGE;
    }
    if (ob < Math.PI * 0.375) {                       // convergent
      if (contA && contB) return KIND.SUTURE;
      if (contA || contB) return KIND.TRENCH;
      return KIND.ISLAND_ARC;
    }
    return KIND.TRANSFORM;
  }

  // ---- fault assembly --------------------------------------------------
  // Walk connected components of the dual graph, per plate pair, into
  // polylines with length, endpoints and identity.
  assembleFaults() {
    const groups = new Map();
    for (let i = 0; i < this.count; i++) {
      const a = this.plateA[i], b = this.plateB[i];
      const k = a < b ? a * 65536 + b : b * 65536 + a;
      let g = groups.get(k);
      if (!g) groups.set(k, g = []);
      g.push(i);
    }

    const faults = [];
    for (const [k, idxs] of groups) {
      // adjacency over canonical dual nodes, restricted to this plate pair
      const adj = new Map();
      for (const i of idxs) {
        const a = this.nodeA[i], b = this.nodeB[i];
        let la = adj.get(a); if (!la) adj.set(a, la = []);
        let lb = adj.get(b); if (!lb) adj.set(b, lb = []);
        la.push([b, i]); lb.push([a, i]);
      }
      const usedEdge = new Set();
      const startNodes = [];
      for (const [n, l] of adj) if (l.length !== 2) startNodes.push(n);
      for (const [n] of adj) startNodes.push(n);      // cycles need a fallback seed

      for (const s of startNodes) {
        for (const [nbr, ei] of (adj.get(s) || [])) {
          if (usedEdge.has(ei)) continue;
          // walk a maximal chain from s through ei
          const edges = [ei];
          const nodes = [s, nbr];
          usedEdge.add(ei);
          let cur = nbr, prev = s;
          for (;;) {
            const l = adj.get(cur);
            if (!l || l.length !== 2) break;          // junction or dead end
            let nxt = -1, ne = -1;
            for (const [nn, ee] of l) if (ee !== edges[edges.length - 1]) { nxt = nn; ne = ee; }
            if (ne < 0 || usedEdge.has(ne)) break;
            usedEdge.add(ne); edges.push(ne); nodes.push(nxt);
            prev = cur; cur = nxt;
            if (cur === s) break;                     // closed loop
          }
          faults.push(this._makeFault(k, edges, nodes));
        }
      }
    }

    this.prevFaults = this.faults;
    this.faults = faults;
    this._matchFaultIds();
    for (const f of this.faults) for (const e of f.edges) this.faultId[e] = f.id;
  }

  _makeFault(key, edges, nodes) {
    const poly = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      poly[2 * i] = this.nodeX[nodes[i]];
      poly[2 * i + 1] = this.nodeY[nodes[i]];
    }
    let length = 0, rate = 0, ob = 0;
    const kindCount = new Int32Array(6);
    for (const e of edges) {
      length += this.len[e];
      rate += this.rate[e] * this.len[e];
      ob += this.obliquity[e] * this.len[e];
      kindCount[this.kind[e]] += this.len[e];
    }
    let dom = 0;
    for (let i = 1; i < 6; i++) if (kindCount[i] > kindCount[dom]) dom = i;
    return {
      id: 0,
      plateA: (key / 65536) | 0, plateB: key % 65536,
      edges, poly,
      length,
      meanRate: length > 0 ? rate / length : 0,
      meanObliquity: length > 0 ? ob / length : 0,
      kind: dom,
      birth: 0,
      matched: false,
    };
  }

  // Rebuilt every step, so IDs must be carried forward by matching or nothing
  // downstream can have history.
  _matchFaultIds() {
    const { W, H } = this;
    const prevByPair = new Map();
    for (const f of this.prevFaults) {
      const k = f.plateA * 65536 + f.plateB;
      let l = prevByPair.get(k); if (!l) prevByPair.set(k, l = []);
      l.push(f);
    }
    const claimed = new Set();
    const mid = (f) => [f.poly[0], f.poly[1], f.poly[f.poly.length - 2], f.poly[f.poly.length - 1]];
    for (const f of this.faults) {
      const cand = prevByPair.get(f.plateA * 65536 + f.plateB);
      if (!cand) continue;
      const [ax, ay, bx, by] = mid(f);
      let best = null, bestD = 600 * 600;
      for (const p of cand) {
        if (claimed.has(p.id)) continue;
        const [px, py, qx, qy] = mid(p);
        const d1 = sq(wrapDelta(px - ax, W)) + sq(wrapDelta(py - ay, H))
                 + sq(wrapDelta(qx - bx, W)) + sq(wrapDelta(qy - by, H));
        const d2 = sq(wrapDelta(qx - ax, W)) + sq(wrapDelta(qy - ay, H))
                 + sq(wrapDelta(px - bx, W)) + sq(wrapDelta(py - by, H));
        const d = Math.min(d1, d2);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) { f.id = best.id; f.birth = best.birth; claimed.add(best.id); f.matched = true; }
    }
    for (const f of this.faults) if (!f.id) { f.id = this.nextFaultId++; f.birth = -1; }
  }
}

// Voronoi vertices where three plate IDs meet. Nearly free once the dual
// network exists, and the best available plate-topology debugger: an RRR
// junction that should be stable but drifts, or a junction that flickers in
// and out, points straight at a bug in classification or fault assembly.
BoundaryNetwork.prototype.findTripleJunctions = function () {
  const atNode = new Map();
  for (let i = 0; i < this.count; i++) {
    for (const n of [this.nodeA[i], this.nodeB[i]]) {
      let e = atNode.get(n);
      if (!e) atNode.set(n, e = { plates: new Set(), edges: [] });
      e.plates.add(this.plateA[i]); e.plates.add(this.plateB[i]);
      e.edges.push(i);
    }
  }
  const out = [];
  for (const [n, e] of atNode) {
    if (e.plates.size < 3) continue;
    // Symbol letter per incident boundary, most-of-its-length wins.
    const letters = e.edges.map((i) => {
      const k = this.kind[i];
      if (k === KIND.RIDGE || k === KIND.RIFT) return 'R';
      if (k === KIND.TRANSFORM) return 'F';
      return 'T';
    });
    const tally = { R: 0, T: 0, F: 0 };
    for (const l of letters) tally[l]++;
    const type = 'R'.repeat(Math.min(3, tally.R)) + 'T'.repeat(Math.min(3, tally.T)) + 'F'.repeat(Math.min(3, tally.F));
    out.push({
      x: this.nodeX[n], y: this.nodeY[n],
      plates: [...e.plates],
      type: type.slice(0, 3) || 'RRR',
      order: e.plates.size,
    });
  }
  this.tripleJunctions = out;
  return out;
};

const sq = (v) => v * v;
