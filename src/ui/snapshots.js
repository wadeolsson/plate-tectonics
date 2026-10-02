// Snapshot every N Myr so history can be replayed. This is essential for
// understanding why a feature formed, and it gets used constantly during
// tuning -- which is why it is built before most of the physics is finished.
export class SnapshotStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.list = [];
  }
  maybeCapture(world) {
    const every = this.cfg.snapshotEvery;
    if (this.list.length && world.t - this.list[this.list.length - 1].t < every) return;
    this.list.push(world.snapshot());
    if (this.list.length > this.cfg.maxSnapshots) this.list.shift();
  }
  clear() { this.list.length = 0; }
  get count() { return this.list.length; }
  at(i) { return this.list[Math.max(0, Math.min(this.list.length - 1, i))]; }
  nearestTo(t) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const d = Math.abs(this.list[i].t - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}
