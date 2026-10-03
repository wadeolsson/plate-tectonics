import { elevationOf } from '../sim/elevation.js';
import { wrapDelta, wrapPos } from '../core/torus.js';
import { KIND_NAME } from '../sim/boundaries.js';
import * as CM from './colormaps.js';
import { ROCKS, rockName } from '../sim/rocks.js';
import { MAX_LAYERS } from '../core/pointsets.js';

// Cross-section. This is the primary debugging tool, not a later feature:
// slab dips will be wrong at first and a map view will never reveal it, while
// a section shows a Wadati-Benioff zone that is either plausible or obviously
// broken in about a second. Same for crustal roots, thinning under rifts and
// wedge geometry -- all invisible from above, all immediately legible here.
//
// The thing a section has to show that nothing else can is one plate beneath
// another. A scatter of slab dots does not do that, so slabs are assembled
// into ribbons -- a descending sheet of known thickness, tinted with its
// parent plate's colour -- and the surface band is broken at every plate
// boundary the line crosses.

// The vertical axis is piecewise. A single linear depth scale reaching 700 km
// renders 7 km of oceanic crust as two pixels and flattens the entire
// bathymetric range into a line, which defeats the purpose of the view. Three
// bands instead: exaggerated topography, a crust-and-lithosphere band, and a
// compressed mantle band.
export function makeDepthScale(top, y0, height, exag) {
  // Four bands, not three. Most of the geology lives in the top 50 km, but a
  // single shallow band shared with the whole lithosphere gave 7 km of oceanic
  // crust about seven pixels -- invisible exactly where the section is most
  // diagnostic. The crustal band now has its own generous allocation, and the
  // deep mantle is compressed hard because nothing in it needs resolving.
  const skyKm = 12, crustKm = 50, litKm = 150, botKm = 700;
  const skyPx = height * 0.17 * (exag / 24);
  const crustPx = height * 0.34;
  const litPx = height * 0.17;
  const botPx = height - skyPx - crustPx - litPx;
  const seaY = y0 + skyPx;
  const crustY = seaY + crustPx;          // 50 km
  const litY = crustY + litPx;            // 150 km

  const f = (km) => {
    if (km >= 0) return seaY - Math.min(skyKm, km) / skyKm * skyPx;
    const d = -km;
    if (d <= crustKm) return seaY + (d / crustKm) * crustPx;
    if (d <= litKm) return crustY + ((d - crustKm) / (litKm - crustKm)) * litPx;
    return litY + Math.min(1, (d - litKm) / (botKm - litKm)) * botPx;
  };
  f.inverse = (py) => {
    if (py <= seaY) return (seaY - py) / Math.max(1e-6, skyPx) * skyKm;
    if (py <= crustY) return -((py - seaY) / crustPx) * crustKm;
    if (py <= litY) return -(crustKm + ((py - crustY) / litPx) * (litKm - crustKm));
    return -(litKm + ((py - litY) / botPx) * (botKm - litKm));
  };
  f.seaY = seaY; f.crustY = crustY; f.litY = litY;
  f.top = y0; f.bottom = y0 + height;
  f.skyKm = skyKm; f.crustKm = crustKm; f.litKm = litKm; f.botKm = botKm;
  return f;
}

export class SectionView {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.line = null;                  // {x0,y0,x1,y1}
    this.halfWidth = 75;               // km
    this.vertExag = 26;
    this.showQuakes = true;
    this.showMoho = true;
    this.showSlabs = true;
    this.showLabels = true;
    this.showMagma = true;
    this.colorBy = 'rock';             // 'rock' | 'crust' | 'plate'
    this.hover = null;                 // {sx, sy} in canvas pixels
    this.layout = null;                // set by draw(), used for hover lookup
  }

  setLine(x0, y0, x1, y1) { this.line = { x0, y0, x1, y1 }; }
  get hasLine() { return !!this.line; }

  // Section perpendicular to the nearest trench, which is the orientation you
  // want nine times out of ten.
  presetAcrossTrench(x, y) {
    const w = this.world;
    // Among zones that actually have a slab worth looking at, take the nearest.
    // The nearest trench outright is often a days-old sliver with nothing
    // beneath it, which makes the shortcut feel broken.
    const count = new Map();
    for (let i = 0; i < w.slabs.n; i++) {
      if (!w.slabs.alive[i]) continue;
      count.set(w.slabs.slabId[i], (count.get(w.slabs.slabId[i]) || 0) + 1);
    }
    let best = null, bestD = Infinity, fallback = null, fbD = Infinity;
    for (const z of w.trenches.all()) {
      if (z.isCollision) continue;
      const d = w.torus.dist2(x, y, z.trenchX, z.trenchY);
      if (d < fbD) { fbD = d; fallback = z; }
      if ((count.get(z.slabId) || 0) < 60) continue;
      if (d < bestD) { bestD = d; best = z; }
    }
    if (!best) best = fallback;
    if (!best) return false;
    const ox = best.oceanX || 1, oy = best.oceanY || 0;

    // Reach far enough inland to contain the zone's own slab rather than
    // guessing a length. The far end of the slab is what the section is for.
    let reach = 500;
    for (let i = 0; i < w.slabs.n; i++) {
      if (!w.slabs.alive[i] || w.slabs.slabId[i] !== best.slabId) continue;
      const dx = wrapDelta(w.slabs.x[i] - best.trenchX, w.W);
      const dy = wrapDelta(w.slabs.y[i] - best.trenchY, w.H);
      const inland = -(dx * ox + dy * oy);
      if (inland > reach) reach = inland;
    }
    reach = Math.min(reach * 1.15 + 200, Math.min(w.W, w.H) * 0.45);
    const ocean = Math.min(400, reach * 0.35);
    this.setLine(
      wrapPos(best.trenchX + ox * ocean, w.W),
      wrapPos(best.trenchY + oy * ocean, w.H),
      wrapPos(best.trenchX - ox * reach, w.W),
      wrapPos(best.trenchY - oy * reach, w.H));
    return true;
  }

  // Geometry of the line in world units, shared by the map overlay and here.
  geometry() {
    const w = this.world, L = this.line;
    if (!L) return null;
    const dx = wrapDelta(L.x1 - L.x0, w.W), dy = wrapDelta(L.y1 - L.y0, w.H);
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    return { dx, dy, len, tx: dx / len, ty: dy / len };
  }

  // Map a distance along the section back to a world position, for drawing the
  // corridor on the map and for reading coordinates out of a hover.
  worldAt(s) {
    const g = this.geometry();
    if (!g) return null;
    return [wrapPos(this.line.x0 + g.tx * s, this.world.W),
            wrapPos(this.line.y0 + g.ty * s, this.world.H)];
  }

  // ---- data gathering --------------------------------------------------
  // Collect everything in the corridor and project onto the line. Sampling
  // along the line keeps the projection unambiguous even when the line is
  // longer than half the domain or crosses the seam.
  collect() {
    const w = this.world, L = this.line;
    const g = this.geometry();
    if (!g) return null;
    const { len, tx, ty } = g;
    const step = this.halfWidth;
    const nSamples = Math.max(2, Math.ceil(len / step) + 1);

    const crustPts = [], slabPts = [], quakePts = [];
    const seenC = new Set(), seenS = new Set();
    const hw2 = this.halfWidth * this.halfWidth;

    for (let k = 0; k < nSamples; k++) {
      const s0 = (k / (nSamples - 1)) * len;
      const qx = wrapPos(L.x0 + tx * s0, w.W), qy = wrapPos(L.y0 + ty * s0, w.H);
      const R = step + this.halfWidth;

      w.crustHash.forEachInRadius(qx, qy, R, (p, d2, ddx, ddy) => {
        if (!w.crust.alive[p] || seenC.has(p)) return;
        const s = s0 + ddx * tx + ddy * ty;
        const off = ddx * -ty + ddy * tx;
        if (off * off > hw2 || s < 0 || s > len) return;
        seenC.add(p);
        crustPts.push({ s, i: p });
      });

      w.slabHash.forEachInRadius(qx, qy, R, (p, d2, ddx, ddy) => {
        if (!w.slabs.alive[p] || seenS.has(p)) return;
        const s = s0 + ddx * tx + ddy * ty;
        const off = ddx * -ty + ddy * tx;
        if (off * off > hw2 || s < 0 || s > len) return;
        seenS.add(p);
        slabPts.push({ s, i: p });
      });
    }

    for (const qi of w.quakes.recent(w.t, 12)) {
      const ddx = wrapDelta(w.quakes.x[qi] - L.x0, w.W);
      const ddy = wrapDelta(w.quakes.y[qi] - L.y0, w.H);
      const s = ddx * tx + ddy * ty;
      const off = ddx * -ty + ddy * tx;
      if (off * off > hw2 || s < 0 || s > len) continue;
      quakePts.push({ s, depth: w.quakes.depth[qi], mag: w.quakes.mag[qi], age: w.t - w.quakes.t[qi] });
    }

    crustPts.sort((a, b) => a.s - b.s);
    const profile = this.profile(crustPts, len);
    return {
      crustPts, slabPts, quakePts, len, profile,
      breaks: this.plateBreaks(profile, len),
      ribbons: this.slabRibbons(slabPts, len),
    };
  }

  // Bin the corridor's points into columns and take a weighted mean in each.
  // Drawing one bar per point leaves ragged gaps where the cloud is sparse and
  // double-draws where it is dense; the section has to read as a continuous
  // crustal profile or it is useless as a debugging view.
  profile(crustPts, len, nCols = 260) {
    const w = this.world, cfg = w.cfg;
    const cols = new Array(nCols);
    const acc = new Float64Array(nCols * 5);
    const wsum = new Float64Array(nCols);
    const votes = new Array(nCols);
    const best = new Int32Array(nCols);
    const bestW = new Float64Array(nCols);
    const melt = new Float64Array(nCols);
    const edif = new Float64Array(nCols);
    const meltD = new Float64Array(nCols);
    const erupt = new Float64Array(nCols);
    const span = len / nCols;
    const sigma = span * 1.1;

    for (const { s, i } of crustPts) {
      const c0 = Math.max(0, Math.floor(s / span) - 2);
      const c1 = Math.min(nCols - 1, Math.floor(s / span) + 2);
      for (let c = c0; c <= c1; c++) {
        const d = (c + 0.5) * span - s;
        const wt = Math.exp(-(d * d) / (2 * sigma * sigma));
        acc[c * 5] += wt * w.crust.thickness[i];
        acc[c * 5 + 1] += wt * w.crust.continental[i];
        acc[c * 5 + 2] += wt * w.crust.litho[i];
        acc[c * 5 + 3] += wt * w.crust.age[i];
        acc[c * 5 + 4] += wt * w.crust.weakness[i];
        melt[c] += wt * w.crust.melt[i];
        meltD[c] += wt * w.crust.melt[i] * w.crust.meltDepth[i];
        erupt[c] += wt * w.crust.erupting[i];
        edif[c] += wt * w.crust.edifice[i];
        wsum[c] += wt;
        // Plate identity cannot be averaged. Weighted vote instead, so a
        // column straddling a boundary picks the side that dominates it.
        const v = votes[c] || (votes[c] = new Map());
        const pid = w.crust.plate[i];
        v.set(pid, (v.get(pid) || 0) + wt);
        // Keep the closest point to this column. Layer stacks cannot be
        // averaged -- the mean of two stratigraphies is not a stratigraphy --
        // so the bands are drawn from one real column, scaled to the smoothed
        // thickness the rest of the profile reports.
        if (!best[c] || wt > bestW[c]) { best[c] = i + 1; bestW[c] = wt; }
      }
    }

    for (let c = 0; c < nCols; c++) {
      if (wsum[c] <= 0) { cols[c] = null; continue; }
      const k = 1 / wsum[c];
      let plate = -1, bestV = 0;
      for (const [pid, vv] of votes[c]) if (vv > bestV) { bestV = vv; plate = pid; }
      cols[c] = {
        s: (c + 0.5) * span,
        thickness: acc[c * 5] * k,
        continental: acc[c * 5 + 1] * k,
        litho: acc[c * 5 + 2] * k,
        age: acc[c * 5 + 3] * k,
        weakness: acc[c * 5 + 4] * k,
        plate,
        rep: best[c] - 1,
        melt: melt[c] / wsum[c],
        meltDepth: melt[c] > 1e-9 ? meltD[c] / melt[c] : 0,
        erupting: erupt[c] / wsum[c],
        edifice: edif[c] / wsum[c],
      };
      cols[c].elev = elevationOf(cfg, cols[c].thickness, cols[c].continental,
        cols[c].litho, cols[c].age, cols[c].edifice);
    }

    // Bridge short empty runs: a one- or two-column hole is sampling noise,
    // not a hole in the crust, and it reads as a chasm in the section.
    for (let c = 0; c < nCols; c++) {
      if (cols[c]) continue;
      let a = c - 1; while (a >= 0 && !cols[a]) a--;
      let b = c + 1; while (b < nCols && !cols[b]) b++;
      if (a < 0 || b >= nCols || b - a > 12) continue;
      const f = (c - a) / (b - a);
      const A = cols[a], B = cols[b];
      const mix = (k) => A[k] + (B[k] - A[k]) * f;
      cols[c] = {
        s: (c + 0.5) * span, thickness: mix('thickness'), continental: mix('continental'),
        litho: mix('litho'), age: mix('age'), weakness: mix('weakness'), elev: mix('elev'),
        plate: f < 0.5 ? A.plate : B.plate,
        rep: f < 0.5 ? A.rep : B.rep,
        melt: mix('melt'), meltDepth: mix('meltDepth'), erupting: mix('erupting'),
        edifice: mix('edifice'),
      };
    }
    // Spatial coherence of the representative column.
    //
    // Each column picked its own nearest point, independently of its
    // neighbours. Two adjacent columns 20 km apart would often pick two
    // different real points whose stratigraphies differ in detail, so every
    // layer boundary in the drawing jumped up and down from one column to the
    // next -- the "funky mountains" look. The surface was smooth, because
    // thickness is averaged, but the bands under it were hashed.
    //
    // The fix is not to average the stratigraphy, which would be meaningless.
    // It is to let a column KEEP its neighbour's representative point when
    // that point is a reasonable stand-in for it, so a run of columns shares
    // one real column and the bands are continuous. A genuine lateral change
    // -- a different plate, a very different thickness -- still breaks the run,
    // which is correct: that IS a geological boundary.
    let held = -1, heldPlate = -1, heldThick = 0;
    for (let c = 0; c < nCols; c++) {
      const q = cols[c];
      if (!q) { held = -1; continue; }
      const samePlate = q.plate === heldPlate;
      const close = heldThick > 0
        && Math.abs(q.thickness - heldThick) < 0.28 * Math.max(q.thickness, heldThick);
      if (held >= 0 && samePlate && close && w.crust.alive[held]) {
        q.rep = held;
      } else {
        held = q.rep; heldPlate = q.plate; heldThick = q.thickness;
      }
    }

    return cols;
  }

  // Where the surface plate changes along the profile. Each break is looked up
  // against the real boundary network so it can be labelled with what it
  // actually is rather than just "a plate changes here".
  plateBreaks(cols, len) {
    const w = this.world;
    const out = [];
    let prev = null;
    for (const q of cols) {
      if (!q) continue;
      if (prev !== null && q.plate !== prev) {
        const s = q.s;
        const at = this.worldAt(s);
        out.push({ s, from: prev, to: q.plate, ...this.classifyAt(at, prev, q.plate) });
      }
      prev = q.plate;
    }
    // Collapse breaks that land within a point spacing of each other: the
    // profile can flicker between two plates right at the boundary.
    const merged = [];
    for (const b of out) {
      const last = merged[merged.length - 1];
      if (last && b.s - last.s < w.spacing * 1.2) continue;
      merged.push(b);
    }
    return merged;
  }

  // Name a crossing from the stretch of boundary around it that separates the
  // two plates involved, weighted by edge length. Taking the single nearest
  // edge instead reports whatever noisy sliver happens to be closest, which
  // routinely labels a trench as a transform.
  classifyAt(at, from, to) {
    const w = this.world;
    if (!at) return { kind: -1, label: '' };
    const [x, y] = at;
    const b = w.boundaries;
    const R2 = (w.spacing * 4) ** 2;
    const byKind = new Float64Array(6);
    let rate = 0, ob = 0, total = 0, faultId = 0, bestLen = 0;
    for (let e = 0; e < b.count; e++) {
      const pa = b.plateA[e], pb = b.plateB[e];
      const matches = from === undefined
        || (pa === from && pb === to) || (pa === to && pb === from);
      if (!matches) continue;
      if (w.torus.dist2(x, y, b.mx[e], b.my[e]) > R2) continue;
      const L = b.len[e];
      byKind[b.kind[e]] += L;
      rate += b.rate[e] * L;
      ob += b.obliquity[e] * L;
      total += L;
      if (L > bestLen) { bestLen = L; faultId = b.faultId[e]; }
    }
    if (total <= 0) {
      // No edge for that pair nearby: fall back to whatever boundary is here.
      if (from !== undefined) return this.classifyAt(at);
      return { kind: -1, label: 'plate boundary' };
    }
    let dom = 0;
    for (let k = 1; k < 6; k++) if (byKind[k] > byKind[dom]) dom = k;
    return {
      kind: dom, label: KIND_NAME[dom],
      rate: rate / total, obliquity: ob / total, faultId,
    };
  }

  // Assemble the slab point cloud into ribbons, one per coherent slab. This is
  // the whole reason to have a section: a descending sheet of finite thickness
  // with a plate identity reads as one plate going under another, and a
  // scatter of dots does not.
  slabRibbons(slabPts, len, nCols = 110) {
    const w = this.world;
    const bySlab = new Map();
    for (const { s, i } of slabPts) {
      const id = w.slabs.slabId[i];
      let r = bySlab.get(id);
      if (!r) bySlab.set(id, r = { id, parent: w.slabs.parentPlate[i], cols: new Array(nCols), acc: null });
      if (!r.acc) { r.acc = new Float64Array(nCols * 5); r.wsum = new Float64Array(nCols); }
      const span = len / nCols;
      const c0 = Math.max(0, Math.floor(s / span) - 2);
      const c1 = Math.min(nCols - 1, Math.floor(s / span) + 2);
      const sigma = span * 1.3;
      for (let c = c0; c <= c1; c++) {
        const d = (c + 0.5) * span - s;
        const wt = Math.exp(-(d * d) / (2 * sigma * sigma));
        r.acc[c * 5] += wt * w.slabs.depth[i];
        r.acc[c * 5 + 1] += wt * w.slabs.litho[i];
        r.acc[c * 5 + 2] += wt * w.slabs.thickness[i];
        r.acc[c * 5 + 3] += wt * w.slabs.coupling[i];
        r.acc[c * 5 + 4] += wt * w.slabs.eclogite[i];
        r.wsum[c] += wt;
      }
    }

    const out = [];
    for (const r of bySlab.values()) {
      const span = len / nCols;
      const pts = [];
      for (let c = 0; c < nCols; c++) {
        if (!r.wsum[c] || r.wsum[c] < 0.12) continue;
        const k = 1 / r.wsum[c];
        pts.push({
          s: (c + 0.5) * span,
          depth: r.acc[c * 5] * k,
          litho: r.acc[c * 5 + 1] * k,
          crust: r.acc[c * 5 + 2] * k,
          coupling: r.acc[c * 5 + 3] * k,
          eclogite: r.acc[c * 5 + 4] * k,
        });
      }
      // A ribbon needs a run to be a ribbon; two isolated bins are noise.
      if (pts.length < 3) continue;
      out.push({ id: r.id, parent: r.parent, pts });
    }
    // Draw shallow slabs last so a young slab overrides an old one it crosses.
    out.sort((a, b) => b.pts[0].depth - a.pts[0].depth);
    return out;
  }

  // ---- drawing ---------------------------------------------------------
  draw() {
    const ctx = this.ctx, w = this.world, cfg = w.cfg;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, width, height);

    const data = this.line ? this.collect() : null;
    if (!data || data.crustPts.length < 2) {
      ctx.fillStyle = 'rgba(200,210,230,0.55)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('drag a line across the map to cut a section  ·  press T for a trench-normal section',
        16, 24);
      this.layout = null;
      return;
    }

    const pad = { l: 52, r: 14, t: 14, b: 22 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const { len } = data;
    const yOf = makeDepthScale(pad.t, pad.t, plotH, this.vertExag);
    const sx = (s) => pad.l + (s / len) * plotW;
    const sOf = (px) => ((px - pad.l) / plotW) * len;
    this.layout = { pad, plotW, plotH, yOf, sx, sOf, len, data };

    this.drawBackground(ctx, data, yOf, sx, plotW, pad);
    if (this.showSlabs) this.drawRibbons(ctx, data, yOf, sx);
    this.drawCrust(ctx, data, yOf, sx, plotW);
    if (this.showMagma) this.drawMagma(ctx, data, yOf, sx, plotW);
    if (this.showMoho) this.drawHorizons(ctx, data, yOf, sx);
    if (this.showQuakes) this.drawQuakes(ctx, data, yOf, sx);
    this.drawAxes(ctx, yOf, pad, plotW, width, height, len);
    if (this.showLabels) this.drawAnnotations(ctx, data, yOf, sx, pad);
    this.drawHoverReadout(ctx, data, yOf, sx, sOf, width, height);
  }

  drawBackground(ctx, data, yOf, sx, plotW, pad) {
    const w = this.world;
    const x0 = pad.l, x1 = pad.l + plotW;
    // Mantle, with the transition zone picked out.
    ctx.fillStyle = '#1b1410';
    ctx.fillRect(x0, yOf.seaY, plotW, yOf.bottom - yOf.seaY);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(x0, yOf(-410), plotW, yOf(-660) - yOf(-410));
    // Sky and sea.
    ctx.fillStyle = 'rgba(30,86,150,0.75)';
    ctx.fillRect(x0, yOf(Math.max(0, w.seaLevel)), plotW, yOf.seaY - yOf(Math.max(0, w.seaLevel)));
  }

  // Each slab is a sheet: the subducted crust on top, its mantle lithosphere
  // beneath, tinted with the colour of the plate it came from.
  drawRibbons(ctx, data, yOf, sx) {
    const w = this.world;
    for (const rb of data.ribbons) {
      const pl = w.plates.get(rb.parent);
      const base = pl ? CM.plateColor(pl.hue, true) : [150, 150, 160];

      // Lithospheric body of the slab.
      ctx.beginPath();
      for (let k = 0; k < rb.pts.length; k++) {
        const p = rb.pts[k];
        const y = yOf(-(p.depth + p.litho));
        if (k === 0) ctx.moveTo(sx(p.s), y); else ctx.lineTo(sx(p.s), y);
      }
      for (let k = rb.pts.length - 1; k >= 0; k--) {
        const p = rb.pts[k];
        ctx.lineTo(sx(p.s), yOf(-p.depth));
      }
      ctx.closePath();
      ctx.fillStyle = CM.rgb([base[0] * 0.55, base[1] * 0.55, base[2] * 0.6], 0.82);
      ctx.fill();
      ctx.strokeStyle = CM.rgb(base, 0.85);
      ctx.lineWidth = 1.1;
      ctx.stroke();

      // The subducted crust itself, as a skin on the slab top, coloured by how
      // far it has eclogitised -- the density change that makes the slab pull
      // harder is visible rather than merely asserted.
      ctx.beginPath();
      for (let k = 0; k < rb.pts.length; k++) {
        const p = rb.pts[k];
        const y = yOf(-p.depth);
        if (k === 0) ctx.moveTo(sx(p.s), y); else ctx.lineTo(sx(p.s), y);
      }
      for (let k = rb.pts.length - 1; k >= 0; k--) {
        const p = rb.pts[k];
        ctx.lineTo(sx(p.s), yOf(-(p.depth + Math.max(2, p.crust))));
      }
      ctx.closePath();
      const ecl = rb.pts.reduce((a, p) => a + (p.eclogite || 0), 0) / rb.pts.length;
      const fresh = ROCKS[1].color, done = ROCKS[9].color;
      ctx.fillStyle = CM.rgb([
        fresh[0] + (done[0] - fresh[0]) * ecl,
        fresh[1] + (done[1] - fresh[1]) * ecl,
        fresh[2] + (done[2] - fresh[2]) * ecl], 0.95);
      ctx.fill();

      // Label the slab with the plate it belongs to, at its shallow end.
      if (this.showLabels && rb.pts.length > 4) {
        const p = rb.pts[0];
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = CM.rgb(base, 0.95);
        ctx.fillText(`slab of plate ${rb.parent}`, sx(p.s) + 6, yOf(-p.depth) - 4);
      }
    }
  }

  drawCrust(ctx, data, yOf, sx, plotW) {
    const w = this.world;
    const cols = data.profile;
    const colW = plotW / cols.length + 0.9;
    for (const q of cols) {
      if (!q) continue;
      const x = sx(q.s);
      const yTop = yOf(q.elev);
      const yMoho = yOf(q.elev - q.thickness);
      const yLab = yOf(q.elev - q.thickness - q.litho);

      // Mantle lithosphere, tinted by plate so the boundary is visible through
      // the whole column and not only at the surface. Kept deliberately muted:
      // it is a hundred-odd km thick and would otherwise swamp the few km of
      // crust that most of the geology lives in.
      const pl = w.plates.get(q.plate);
      const hue = pl ? CM.plateColor(pl.hue, true) : [120, 100, 86];
      ctx.fillStyle = CM.rgb([hue[0] * 0.20 + 34, hue[1] * 0.18 + 28, hue[2] * 0.16 + 24], 0.95);
      ctx.fillRect(x - colW / 2, yMoho, colW, Math.max(0.5, yLab - yMoho));

      // Crust gets a floor of a few pixels: 7 km of oceanic crust is a hairline
      // at any scale that also reaches 660 km, and it is the part you are
      // usually trying to read.
      if (this.colorBy === 'rock' && q.rep >= 0 && w.crust.alive[q.rep]) {
        this.drawColumnRocks(ctx, w, q, x, colW, yOf, yTop, yMoho);
      } else {
        ctx.fillStyle = this.colorBy === 'plate'
          ? CM.rgb([hue[0] * 1.15 + 20, hue[1] * 1.15 + 20, hue[2] * 1.15 + 20], 1)
          : CM.rgb(CM.crustSection(q.continental), 1);
        ctx.fillRect(x - colW / 2, yTop, colW, Math.max(3, yMoho - yTop));
      }

      if (q.elev < w.seaLevel) {            // water column over the seabed
        ctx.fillStyle = 'rgba(34,96,166,0.55)';
        ctx.fillRect(x - colW / 2, yOf(w.seaLevel), colW, yTop - yOf(w.seaLevel));
      }
    }
  }

  // Draw one real crustal column's layers, rescaled to the smoothed thickness
  // this profile column reports. Each band is its rock's colour, so a
  // sediment wedge, a volcanic pile, a granite batholith or a thrust stack all
  // read directly off the section.
  drawColumnRocks(ctx, w, q, x, colW, yOf, yTop, yMoho) {
    const i = q.rep;
    const base = i * MAX_LAYERS, n = w.crust.nLayers[i];
    const own = w.crust.thickness[i];
    if (n === 0 || own <= 0) {
      ctx.fillStyle = CM.rgb(CM.crustSection(q.continental), 1);
      ctx.fillRect(x - colW / 2, yTop, colW, Math.max(3, yMoho - yTop));
      return;
    }
    // Oceanic crust is 7 km on an axis that also reaches 660, so its two
    // layers come out two pixels each and the stratigraphy is invisible
    // exactly where it is most diagnostic. Give the band a floor and
    // distribute the layers proportionally inside it; the Moho line still
    // marks the true depth.
    const MIN_BAND = 4;
    const trueBand = yMoho - yTop;
    const band = Math.max(MIN_BAND, trueBand);
    const scale = own > 0 ? band / own : 0;
    let y = yTop;
    for (let k = 0; k < n; k++) {
      const h = w.crust.layerThick[base + k] * scale;
      const col = ROCKS[w.crust.layerType[base + k]].color;
      ctx.fillStyle = CM.rgb(col, 1);
      ctx.fillRect(x - colW / 2, y, colW, Math.max(1, h));
      y += h;
    }
    const yEnd = yTop + band;
    if (yEnd - y > 0.6) {
      ctx.fillStyle = CM.rgb(ROCKS[w.crust.layerType[base + n - 1]].color, 1);
      ctx.fillRect(x - colW / 2, y, colW, yEnd - y);
    }
  }

  // The magmatic system: a chamber where melt is in residence, and a conduit
  // to the surface where it is actually erupting. Everything the chamber
  // crystallises instead of erupting is already in the column as a pluton at
  // that same depth -- so the sills read straight off the stratigraphy rather
  // than needing to be drawn separately.
  drawMagma(ctx, data, yOf, sx, plotW) {
    const cols = data.profile;
    const colW = plotW / cols.length;
    const cfg = this.world.cfg;

    // Chambers first, as a glow under the crust.
    for (const q of cols) {
      if (!q || q.melt <= cfg.meltVisibleMin) continue;
      const x = sx(q.s);
      const top = q.elev - Math.max(0, q.meltDepth - q.melt * 0.6);
      const bot = q.elev - (q.meltDepth + q.melt * 0.6);
      const y0 = yOf(top), y1 = yOf(bot);
      const h = Math.max(2.5, y1 - y0);
      const heat = Math.min(1, q.melt / 3);
      const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
      g.addColorStop(0, `rgba(255,${120 + 90 * heat | 0},40,${0.25 + 0.5 * heat})`);
      g.addColorStop(0.5, `rgba(255,${190 + 50 * heat | 0},90,${0.45 + 0.5 * heat})`);
      g.addColorStop(1, `rgba(220,70,30,${0.2 + 0.45 * heat})`);
      ctx.fillStyle = g;
      ctx.fillRect(x - colW * 1.4, y0, colW * 2.8, h);
    }

    // Conduits where magma is reaching the surface.
    ctx.lineCap = 'round';
    for (const q of cols) {
      if (!q || q.erupting <= 1e-4) continue;
      const x = sx(q.s);
      const yTop = yOf(q.elev);
      const yCh = yOf(q.elev - Math.max(0.5, q.meltDepth));
      const w = Math.min(3.4, 0.7 + q.erupting * 26);
      ctx.strokeStyle = `rgba(255,170,60,${Math.min(0.95, 0.35 + q.erupting * 24)})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, yCh); ctx.lineTo(x, yTop);
      ctx.stroke();
      // A small vent flare at the surface.
      ctx.fillStyle = 'rgba(255,214,130,0.9)';
      ctx.beginPath();
      ctx.moveTo(x, yTop - 5); ctx.lineTo(x - 2.6, yTop + 1); ctx.lineTo(x + 2.6, yTop + 1);
      ctx.closePath(); ctx.fill();
    }
  }

  drawHorizons(ctx, data, yOf, sx) {
    const cols = data.profile;
    const line = (get, style, dash) => {
      ctx.save();
      ctx.strokeStyle = style; ctx.lineWidth = 1;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      let first = true;
      for (const q of cols) {
        if (!q) { first = true; continue; }
        const y = get(q);
        if (first) { ctx.moveTo(sx(q.s), y); first = false; } else ctx.lineTo(sx(q.s), y);
      }
      ctx.stroke();
      ctx.restore();
    };
    line((q) => yOf(q.elev - q.thickness - q.litho), 'rgba(190,150,255,0.55)', [4, 3]);  // LAB
    line((q) => yOf(q.elev - q.thickness), 'rgba(255,230,180,0.75)');                    // Moho
    line((q) => yOf(q.elev), 'rgba(255,255,255,0.7)');                                   // surface
  }

  drawQuakes(ctx, data, yOf, sx) {
    for (const q of data.quakePts) {
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - q.age / 12)})`;
      ctx.beginPath();
      ctx.arc(sx(q.s), yOf(-q.depth), 0.9 + (q.mag - 4) * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawAxes(ctx, yOf, pad, plotW, width, height, len) {
    const w = this.world;
    ctx.font = '10px ui-monospace, monospace';
    ctx.strokeStyle = 'rgba(180,200,225,0.14)';
    ctx.fillStyle = 'rgba(190,205,225,0.8)';
    for (const d of [0, 10, 25, 50, 100, 150, 300, 410, 660]) {
      const y = yOf(-d);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
      ctx.fillText(String(d), 8, y + 3);
    }
    // Mark where the depth axis changes scale, so nobody reads the deep part
    // as being at the same exaggeration as the shallow part.
    ctx.strokeStyle = 'rgba(230,180,110,0.8)';
    for (const yb of [yOf.crustY, yOf.litY]) {
      ctx.beginPath();
      for (let x = pad.l; x < width - pad.r; x += 8) {
        ctx.moveTo(x, yb - 2); ctx.lineTo(x + 4, yb + 2);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(230,180,110,0.85)';
    ctx.fillText('scale break', width - pad.r - 66, yOf.crustY - 4);
    ctx.fillText('scale break', width - pad.r - 66, yOf.litY - 4);

    ctx.strokeStyle = 'rgba(150,190,230,0.8)';
    ctx.beginPath();
    ctx.moveTo(pad.l, yOf(w.seaLevel)); ctx.lineTo(width - pad.r, yOf(w.seaLevel));
    ctx.stroke();

    // Horizontal scale bar in round numbers.
    const targetPx = plotW * 0.22;
    const rawKm = (targetPx / plotW) * len;
    const pow = Math.pow(10, Math.floor(Math.log10(rawKm)));
    const barKm = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawKm * 0.6) || pow;
    const barPx = (barKm / len) * plotW;
    const bx = pad.l + 6, by = height - 10;
    ctx.strokeStyle = 'rgba(210,225,245,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.lineTo(bx + barPx, by - 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(210,225,245,0.9)';
    ctx.fillText(`${barKm >= 1000 ? (barKm / 1000).toFixed(barKm % 1000 ? 1 : 0) + '×10³' : barKm} km`,
      bx + barPx + 6, by);
    ctx.fillStyle = 'rgba(160,178,200,0.75)';
    ctx.fillText(`topography ×${this.vertExag}   corridor ±${this.halfWidth} km`, width - pad.r - 210, by);
    ctx.fillStyle = 'rgba(190,205,225,0.7)';
    ctx.fillText('km', 8, pad.t + 9);

    // End labels, matching the A / A' handles drawn on the map.
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText('A', pad.l - 2, pad.t + 11);
    ctx.fillText('A′', width - pad.r - 12, pad.t + 11);
  }

  // Label every plate boundary the line crosses, with what kind it is.
  drawAnnotations(ctx, data, yOf, sx, pad) {
    ctx.font = '10px ui-monospace, monospace';
    for (const b of data.breaks) {
      const x = sx(b.s);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = b.kind >= 0 ? CM.rgb(CM.obliquityColor(b.obliquity ?? Math.PI / 2), 0.9)
                                    : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, pad.t + 14); ctx.lineTo(x, yOf.bottom);
      ctx.stroke();
      ctx.restore();

      const text = `${b.label || 'boundary'}  ${b.from}|${b.to}`;
      const tw = ctx.measureText(text).width;
      const tx = Math.min(Math.max(x - tw / 2, pad.l + 2), this.canvas.width - tw - 6);
      ctx.fillStyle = 'rgba(8,11,18,0.82)';
      ctx.fillRect(tx - 3, pad.t + 2, tw + 6, 13);
      ctx.fillStyle = b.kind >= 0 ? CM.rgb(CM.obliquityColor(b.obliquity ?? Math.PI / 2), 1) : '#fff';
      ctx.fillText(text, tx, pad.t + 12);
    }
  }

  // What is under the cursor. The section is where you go to find out why
  // something happened, so it has to answer questions about specific places.
  drawHoverReadout(ctx, data, yOf, sx, sOf, width, height) {
    const h = this.hover;
    if (!h) return;
    const { pad, plotW } = this.layout;
    if (h.sx < pad.l || h.sx > pad.l + plotW || h.sy < pad.t || h.sy > yOf.bottom) return;
    const s = sOf(h.sx);
    const depth = yOf.inverse(h.sy);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(h.sx, pad.t); ctx.lineTo(h.sx, yOf.bottom);
    ctx.moveTo(pad.l, h.sy); ctx.lineTo(pad.l + plotW, h.sy);
    ctx.stroke();
    ctx.restore();

    const cols = data.profile;
    const idx = Math.max(0, Math.min(cols.length - 1, Math.floor((s / data.len) * cols.length)));
    const q = cols[idx];
    const at = this.worldAt(s);
    const lines = [
      `${(s / 1000).toFixed(2)}×10³ km along  ·  ${depth >= 0 ? '+' : ''}${depth.toFixed(depth >= 0 ? 2 : 0)} km`,
    ];
    if (at) lines.push(`map ${at[0].toFixed(0)}, ${at[1].toFixed(0)} km`);
    if (q) {
      lines.push(`plate ${q.plate}  ·  elev ${q.elev.toFixed(2)} km`);
      // Which layer the cursor is actually inside.
      if (q.rep >= 0 && this.world.crust.alive[q.rep] && depth < q.elev) {
        const i = q.rep, b = i * MAX_LAYERS, n = this.world.crust.nLayers[i];
        const scale = q.thickness / Math.max(1e-6, this.world.crust.thickness[i]);
        let top = q.elev;
        for (let k = 0; k < n; k++) {
          const h = this.world.crust.layerThick[b + k] * scale;
          if (depth <= top && depth > top - h) {
            lines.push(`rock: ${rockName(this.world.crust.layerType[b + k])}`
              + `  ${h.toFixed(1)} km, emplaced ${this.world.crust.layerAge[b + k].toFixed(0)} Myr`);
            break;
          }
          top -= h;
        }
      }
      lines.push(`crust ${q.thickness.toFixed(1)} km  litho ${q.litho.toFixed(0)} km`);
      lines.push(`continental ${q.continental.toFixed(2)}  age ${q.age.toFixed(0)} Myr`);
      if (q.melt > this.world.cfg.meltVisibleMin) {
        lines.push(`magma ${q.melt.toFixed(2)} km at ${q.meltDepth.toFixed(0)} km depth`
          + (q.erupting > 1e-4 ? `, erupting ${(q.erupting * 1000).toFixed(0)} m/Myr` : ', not erupting'));
      }
    }
    // Name the slab under the cursor, if there is one.
    for (const rb of data.ribbons) {
      for (const p of rb.pts) {
        if (Math.abs(p.s - s) > data.len / 110) continue;
        if (depth > -(p.depth - 40) || depth < -(p.depth + p.litho + 40)) continue;
        lines.push(`slab of plate ${rb.parent} at ${p.depth.toFixed(0)} km`
          + `, coupling ${p.coupling.toFixed(2)}, ${(p.eclogite * 100).toFixed(0)}% eclogite`);
        break;
      }
    }

    ctx.font = '10px ui-monospace, monospace';
    let bw = 0;
    for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
    const bx = Math.min(h.sx + 12, width - bw - 14);
    const by = Math.min(h.sy + 12, height - lines.length * 13 - 10);
    ctx.fillStyle = 'rgba(8,11,18,0.9)';
    ctx.fillRect(bx - 5, by - 4, bw + 10, lines.length * 13 + 8);
    ctx.strokeStyle = 'rgba(120,140,175,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 5, by - 4, bw + 10, lines.length * 13 + 8);
    ctx.fillStyle = 'rgba(225,235,250,0.95)';
    for (let k = 0; k < lines.length; k++) ctx.fillText(lines[k], bx, by + 9 + k * 13);
    ctx.restore?.();
  }
}
