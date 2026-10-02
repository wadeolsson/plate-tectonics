import { wrapPos, wrapDelta } from '../core/torus.js';

// Ridge segmentation -- the orthogonal staircase.
//
// Raw Voronoi polylines will not produce it on their own: they are jagged at
// the point-spacing scale, which is noise, not structure, and it re-randomises
// every step so it has no memory. The staircase is constructed explicitly.
//
// Why it exists: a spreading centre can only create crust symmetrically,
// perpendicular to the spreading direction. If the boundary trend is oblique
// to that direction, no single continuous ridge can accommodate the motion, so
// the boundary decomposes into pure-mode pieces -- ridge segments perpendicular
// to spreading, transforms parallel to it. That decomposition is fully
// determined by spreading direction plus a segmentation length, so this is
// construction, not simulation. (Nature does not always adopt pure modes; this
// is the idealisation, and the noise term below stands in for the rest.)
export class SegmentRegistry {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.segments = new Map();     // id -> RidgeSegment, active and recently dead
    this.transforms = [];          // rebuilt each step; they are geometry, not state
    this.nextId = 1;
  }

  active() {
    const out = [];
    for (const s of this.segments.values()) if (s.death < 0) out.push(s);
    return out;
  }

  get(id) { return this.segments.get(id); }

  update(world) {
    const { cfg, boundaries, crust, t } = world;
    const { W, H } = this;

    const fresh = [];
    const transforms = [];

    for (const f of boundaries.faults) {
      if (f.length < 40) continue;
      // Any fault with net opening gets the staircase, not only those whose
      // dominant class is ridge or rift. A strongly oblique boundary then
      // decomposes into short ridge segments joined by long transforms --
      // which is the correct answer for a leaky transform, and is also what
      // keeps the area budget closed: every square kilometre that opens
      // somewhere gets crust made in it.
      if (f.meanObliquity < Math.PI * 0.375) continue;   // convergent overall
      let net = 0;
      for (const e of f.edges) net += boundaries.vn[e] * boundaries.len[e];
      if (net <= 0) continue;
      const built = this._staircase(world, f);
      if (built) { fresh.push(...built.segments); transforms.push(...built.transforms); }
    }

    this._reconcile(world, fresh);
    this.transforms = transforms;
  }

  // Build the staircase for one divergent fault.
  _staircase(world, f) {
    const { cfg, boundaries, crust, rng, t } = world;
    const { W, H } = this;

    // --- spreading frame ---------------------------------------------
    // x-hat is the mean relative velocity: the direction the two plates
    // actually separate. Using the mean edge normal instead would make `rate`
    // the mean of vn rather than the full spreading speed, and an oblique
    // ridge would then accrete less area than its boundary is opening.
    let sx = 0, sy = 0, wsum = 0, weak = 0, cont = 0, speed = 0;
    for (const e of f.edges) {
      if (boundaries.vn[e] <= 0) continue;
      const L = boundaries.len[e];
      const nx = boundaries.nx[e], ny = boundaries.ny[e];
      const vn = boundaries.vn[e], vt = boundaries.vt[e];
      const rx = vn * nx + vt * -ny, ry = vn * ny + vt * nx;
      sx += rx * L; sy += ry * L;
      // The frame direction comes from the vector mean, but the RATE is the
      // mean speed. Along a boundary where the relative velocity rotates --
      // which is most of them, once plates spin -- the vector mean's magnitude
      // is far below the typical speed, and using it would report every ridge
      // as slow-spreading and give them all the same segment length.
      speed += Math.hypot(rx, ry) * L;
      weak += 0.5 * (crust.weakness[boundaries.ptA[e]] + crust.weakness[boundaries.ptB[e]]) * L;
      cont += 0.5 * (boundaries.contA[e] + boundaries.contB[e]) * L;
      wsum += L;
    }
    if (wsum < 30) return null;
    const dl = Math.hypot(sx, sy);
    if (dl < 1e-6) return null;
    const hx = sx / dl, hy = sy / dl;         // x-hat, spreading direction
    const px = -hy, py = hx;                  // y-hat, along the ridge trend
    const rate = speed / wsum;                // full spreading rate, km/Myr
    if (rate < 0.8) return null;
    weak /= wsum; cont /= wsum;

    // --- segment length ----------------------------------------------
    // Keyed off spreading rate, then modulated by inherited weakness and
    // noise so ridges are not a periodic comb. Fast ridges are long and
    // smooth with small offsets; slow ridges are short with big transform
    // offsets.
    const fr = clamp01((rate - cfg.segRateSlow) / Math.max(1, cfg.segRateFast - cfg.segRateSlow));
    let Lseg = cfg.segLenSlow + (cfg.segLenFast - cfg.segLenSlow) * fr;
    Lseg *= (1 - cfg.segWeaknessMod * weak);
    Lseg *= 1 + cfg.segNoiseMod * (hash01(f.id * 7919 + Math.floor(t / 25)) - 0.5) * 2;
    // Oblique continental rifting performs the identical decomposition:
    // rift segments linked by transfer zones. Same geometry, shorter scale.
    if (cont > 0.4) Lseg *= 0.55;
    Lseg = Math.max(35, Lseg);

    // --- unwrap the trace into the spreading frame --------------------
    const n = f.poly.length / 2;
    if (n < 2) return null;
    const uu = new Float64Array(n), vv = new Float64Array(n);
    let cx = f.poly[0], cy = f.poly[1];
    let accX = 0, accY = 0;
    uu[0] = 0; vv[0] = 0;
    for (let i = 1; i < n; i++) {
      accX += wrapDelta(f.poly[2 * i] - f.poly[2 * i - 2], W);
      accY += wrapDelta(f.poly[2 * i + 1] - f.poly[2 * i - 1], H);
      uu[i] = accX * hx + accY * hy;
      vv[i] = accX * px + accY * py;
    }

    // --- staircase approximation --------------------------------------
    // Structurally Bresenham: runs of length Lseg along the ridge trend,
    // jogs in the spreading direction to track the original trace. The more
    // oblique the boundary over a stretch, the longer the jogs come out --
    // which is exactly how real transform offsets scale with obliquity.
    const segs = [];
    let start = 0;
    const uSamples = [uu[0]];
    for (let i = 1; i < n; i++) {
      uSamples.push(uu[i]);
      const dv = vv[i] - vv[start];
      const last = i === n - 1;
      if (Math.abs(dv) >= Lseg || (last && Math.abs(dv) > Lseg * 0.35)) {
        segs.push(makeSeg(uSamples, vv[start], vv[i]));
        start = i;
        uSamples.length = 0; uSamples.push(uu[i]);
      }
    }
    if (segs.length === 0) {
      // Boundary shorter than one segment, or running nearly parallel to
      // the spreading direction (an all-transform stretch). Emit a single
      // segment only if there is real opening length to accommodate.
      const dv = vv[n - 1] - vv[0];
      if (Math.abs(dv) < Lseg * 0.3) return { segments: [], transforms: [] };
      const all = []; for (let i = 0; i < n; i++) all.push(uu[i]);
      segs.push(makeSeg(all, vv[0], vv[n - 1]));
    }

    // --- rotate back ---------------------------------------------------
    const ox = f.poly[0], oy = f.poly[1];
    const toWorld = (u, v) => [
      wrapPos(ox + u * hx + v * px, W),
      wrapPos(oy + u * hy + v * py, H),
    ];

    const out = [];
    for (const s of segs) {
      const [x0, y0] = toWorld(s.u, s.v0);
      const [x1, y1] = toWorld(s.u, s.v1);
      out.push({
        id: 0, plateA: f.plateA, plateB: f.plateB, faultId: f.id,
        x0, y0, x1, y1,
        dirX: hx, dirY: hy,          // spreading direction (unit)
        axX: px, axY: py,            // along-axis direction (unit)
        length: Math.abs(s.v1 - s.v0),
        rate,                        // full spreading rate, km/Myr
        continental: cont,
        birth: t, death: -1, lastSeen: t,
        u: s.u, v0: s.v0, v1: s.v1,
      });
    }

    // Transforms link consecutive segments: parallel to the spreading
    // direction, length equal to the offset between the segments.
    const tf = [];
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i], b = segs[i + 1];
      const v = (a.v1 + b.v0) * 0.5;
      const [ax, ay] = toWorld(a.u, v);
      const [bx, by] = toWorld(b.u, v);
      tf.push({
        faultId: f.id, x0: ax, y0: ay, x1: bx, y1: by,
        offset: Math.abs(b.u - a.u), rate,
        sense: Math.sign(b.u - a.u),
      });
    }

    return { segments: out, transforms: tf };
  }

  // Segments persist. They lengthen, shorten, propagate and occasionally die,
  // but are never re-derived from scratch: a transform that exists for one
  // timestep leaves no trace, and the fracture-zone machinery depends on
  // segments having continuous identity.
  _reconcile(world, fresh) {
    const { cfg, t } = world;
    const { W, H } = this;
    const claimed = new Set();

    for (const f of fresh) {
      const mx = midX(f, W), my = midY(f, H);
      // Require only that the pair overlaps. When a plate rifts, one side of
      // every segment on its boundary becomes a brand-new ID; demanding an
      // exact pair match orphans them all and throws away their identity at
      // exactly the moment the geography is being made.
      let best = null, bestD = cfg.segMatchRadius * cfg.segMatchRadius, bestExact = false;
      for (const s of this.segments.values()) {
        if (s.death >= 0 || claimed.has(s.id)) continue;
        const exact = (s.plateA === f.plateA && s.plateB === f.plateB)
                   || (s.plateA === f.plateB && s.plateB === f.plateA);
        const shares = s.plateA === f.plateA || s.plateA === f.plateB
                    || s.plateB === f.plateA || s.plateB === f.plateB;
        if (!shares) continue;
        const d = sq(wrapDelta(midX(s, W) - mx, W)) + sq(wrapDelta(midY(s, H) - my, H));
        // An exact pair match always beats a partial one at the same distance.
        const score = exact ? d : d * 2.2;
        if (score < bestD || (exact && !bestExact && d < bestD * 2.2)) {
          bestD = Math.min(bestD, score); best = s; bestExact = exact;
        }
      }
      if (best) {
        claimed.add(best.id);
        // Relax toward the new geometry rather than replacing it.
        const k = 0.3;
        best.x0 = lerpWrap(best.x0, f.x0, k, W); best.y0 = lerpWrap(best.y0, f.y0, k, H);
        best.x1 = lerpWrap(best.x1, f.x1, k, W); best.y1 = lerpWrap(best.y1, f.y1, k, H);
        best.dirX = best.dirX + (f.dirX - best.dirX) * k;
        best.dirY = best.dirY + (f.dirY - best.dirY) * k;
        const dl = Math.hypot(best.dirX, best.dirY) || 1;
        best.dirX /= dl; best.dirY /= dl;
        best.axX = -best.dirY; best.axY = best.dirX;
        best.length += (f.length - best.length) * k;
        best.rate += (f.rate - best.rate) * k;
        best.continental = f.continental;
        best.faultId = f.faultId;
        best.plateA = f.plateA; best.plateB = f.plateB;
        best.lastSeen = t;
      } else {
        f.id = this.nextId++;
        f.birth = t;
        this.segments.set(f.id, f);
        claimed.add(f.id);
      }
    }

    // Kill segments that have gone unmatched for a while, but keep the record:
    // crust points still carry the ID and the fracture-zone machinery needs it.
    // The grace period matters -- a segment that vanishes because the fault was
    // re-walked into different components for one step, and comes back with a
    // new ID, leaves no trace and no fracture zone.
    for (const s of this.segments.values()) {
      if (s.death < 0 && t - s.lastSeen > cfg.segGraceSteps * cfg.dt) s.death = t;
    }
  }
}

function makeSeg(uSamples, v0, v1) {
  const a = uSamples.slice().sort((p, q) => p - q);
  const u = a.length % 2 ? a[(a.length - 1) >> 1] : 0.5 * (a[a.length / 2 - 1] + a[a.length / 2]);
  return { u, v0, v1 };
}

const sq = (v) => v * v;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const midX = (s, W) => wrapPos(s.x0 + wrapDelta(s.x1 - s.x0, W) * 0.5, W);
const midY = (s, H) => wrapPos(s.y0 + wrapDelta(s.y1 - s.y0, H) * 0.5, H);
const lerpWrap = (a, b, k, L) => wrapPos(a + wrapDelta(b - a, L) * k, L);

function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
