// Primitive operations on a crust point, shared by every process that modifies
// one. They live here rather than in whichever process happened to need them
// first, so the process modules do not have to import each other.
import { pushTop, scaleColumn, intrude, rockFor } from './rocks.js';

// Thicken or thin a crust point. Thickening lays a new layer on top of the
// column, carrying its own composition; thinning stretches the whole column
// proportionally, which is what extension actually does to stratigraphy.
// `rockType` names the rock when the caller knows it -- arc andesite, plume
// basalt, wedge sediment -- and is inferred from the composition otherwise.
export function applyThickness(world, i, d, addedCont = 0.22, rockType, intrudeAt) {
  const { cfg, crust, pointArea } = world;
  const before = crust.thickness[i];
  let after = before + d;
  if (after < 3) after = 3;
  if (after > cfg.thickHardCap) after = cfg.thickHardCap;
  const delta = after - before;
  if (delta > 0) {
    const type = rockType !== undefined ? rockType : rockFor(addedCont);
    if (intrudeAt !== undefined) intrude(crust, i, delta, type, addedCont, world.t, intrudeAt);
    else pushTop(crust, i, delta, type, addedCont, world.t);
  } else if (delta < 0 && before > 1e-6) {
    scaleColumn(crust, i, after / before);
  }
  const dv = delta * pointArea;
  if (dv > 0) world.budget.created += dv;
  else world.budget.destroyed += -dv;
}

// How long since this crust was last deformed. Every process that touched a
// point used to slam this to zero, which meant a whisper of transpression aged
// a craton back to newborn and nothing in the model ever got old: no basement
// provinces, and no thick cratonic roots, since the lithosphere target is keyed
// off this. Deformation is graded instead -- a collision resets the clock, a
// passing transform barely moves it.
export function deform(crust, i, intensity) {
  const k = intensity >= 1 ? 0 : 1 - intensity;
  crust.defAge[i] *= k > 0 ? k : 0;
}
