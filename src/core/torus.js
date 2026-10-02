// Torus geometry. NOTHING in this codebase subtracts raw coordinates; every
// difference goes through wrapDelta. A single unwrapped dx produces phantom
// interactions across the map that the sim will happily keep running with.

export function wrapDelta(d, L) {
  if (d > L * 0.5) d -= L;
  else if (d < -L * 0.5) d += L;
  return d;
}

export function wrapPos(p, L) {
  p %= L;
  return p < 0 ? p + L : p;
}

// A Torus binds W and H so call sites cannot accidentally wrap x against H.
export class Torus {
  constructor(W, H) { this.W = W; this.H = H; }

  dx(ax, bx) { return wrapDelta(bx - ax, this.W); }
  dy(ay, by) { return wrapDelta(by - ay, this.H); }

  dist2(ax, ay, bx, by) {
    const dx = wrapDelta(bx - ax, this.W);
    const dy = wrapDelta(by - ay, this.H);
    return dx * dx + dy * dy;
  }
  dist(ax, ay, bx, by) { return Math.sqrt(this.dist2(ax, ay, bx, by)); }

  wrapX(x) { return wrapPos(x, this.W); }
  wrapY(y) { return wrapPos(y, this.H); }

  // Midpoint of the shortest connection between two points.
  midX(ax, bx) { return wrapPos(ax + wrapDelta(bx - ax, this.W) * 0.5, this.W); }
  midY(ay, by) { return wrapPos(ay + wrapDelta(by - ay, this.H) * 0.5, this.H); }

  get area() { return this.W * this.H; }
}

// Circular mean of one coordinate axis. A plain arithmetic average puts the
// centroid of a seam-straddling plate on the opposite side of the map, which
// then corrupts its rotation term. `resultant` reports how well defined the
// answer is; near zero (a plate wrapping the full width) the caller must fall
// back to the previous centroid.
export function circularMeanAccum() {
  return { sx: 0, sy: 0, n: 0 };
}

export function circularMeanAdd(acc, value, L, weight = 1) {
  const a = (value / L) * Math.PI * 2;
  acc.sx += Math.cos(a) * weight;
  acc.sy += Math.sin(a) * weight;
  acc.n += weight;
}

export function circularMeanResult(acc, L) {
  if (acc.n === 0) return { value: 0, resultant: 0 };
  const rx = acc.sx / acc.n, ry = acc.sy / acc.n;
  const resultant = Math.hypot(rx, ry);
  let a = Math.atan2(ry, rx);
  if (a < 0) a += Math.PI * 2;
  return { value: wrapPos((a / (Math.PI * 2)) * L, L), resultant };
}

export function circularMean(values, L) {
  const acc = circularMeanAccum();
  for (const v of values) circularMeanAdd(acc, v, L);
  return circularMeanResult(acc, L).value;
}
