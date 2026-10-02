// Seeded RNG plus tileable value noise. Every stochastic decision in the sim
// draws from one of these so a run is reproducible from (seed, config).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(seed);
    this._spare = null;
  }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n) % n; }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[this.int(arr.length)]; }
  // Box-Muller, cached second deviate.
  normal(mean = 0, sd = 1) {
    if (this._spare !== null) {
      const v = this._spare; this._spare = null;
      return mean + sd * v;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return mean + sd * u * m;
  }
  // Uniform direction.
  dir() {
    const a = this.next() * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  }
}

// Tileable value noise on an nx * ny lattice with smoothstep interpolation.
// Tileable matters: the domain is a torus, so the initial continents must not
// show a seam.
export class TileNoise {
  constructor(rng, nx, ny) {
    this.nx = nx; this.ny = ny;
    this.g = new Float32Array(nx * ny);
    for (let i = 0; i < this.g.length; i++) this.g[i] = rng.next();
  }
  at(u, v) {                       // u, v in [0,1)
    const { nx, ny, g } = this;
    const fx = u * nx, fy = v * ny;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    x0 = ((x0 % nx) + nx) % nx; y0 = ((y0 % ny) + ny) % ny;
    const x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * nx + x0], b = g[y0 * nx + x1];
    const c = g[y1 * nx + x0], d = g[y1 * nx + x1];
    const top = a + (b - a) * sx, bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }
}

// Fractal sum of tileable value noise. Returns roughly [0,1].
export class Fbm {
  constructor(rng, baseNx, baseNy, octaves = 5, gain = 0.5) {
    this.layers = [];
    this.gain = gain;
    let amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const nx = Math.max(2, Math.round(baseNx * Math.pow(2, o)));
      const ny = Math.max(2, Math.round(baseNy * Math.pow(2, o)));
      this.layers.push({ n: new TileNoise(rng, nx, ny), amp });
      norm += amp; amp *= gain;
    }
    this.norm = norm;
  }
  at(u, v) {
    let s = 0;
    for (const l of this.layers) s += l.amp * l.n.at(u, v);
    return s / this.norm;
  }
}
