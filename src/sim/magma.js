import { ROCK, pushTop, intrude } from './rocks.js';
import { deform } from './crustops.js';

// Magma as a reservoir rather than an event.
//
// Arc and plume volcanism used to emplace rock the instant their trigger was
// satisfied: the slab reached 100 km and andesite appeared on the surface in
// the same step. That has two costs. There is nothing to draw -- no chamber,
// no conduit, nothing between the mantle and the finished rock -- and an arc
// switches off the moment its slab moves, when a real magmatic system drains
// and crystallises over several Myr.
//
// Here melt is supplied to a chamber, and each step the chamber partitions
// three ways: a fraction erupts to the surface, a fraction crystallises in
// place as a pluton, and the rest stays molten. Arc shutdown then becomes a
// process -- the old chamber dies slowly while a new one builds inland, which
// is what flat-slab arc migration actually looks like.

export function supplyMelt(world, i, volume, felsic, depthFrac) {
  const { crust } = world;
  if (volume <= 0) return;
  const have = crust.melt[i];
  const total = have + volume;
  // The chamber sits where the magma is delivered, weighted by how much of it
  // is already there.
  const d = crust.thickness[i] * depthFrac;
  crust.meltDepth[i] = (crust.meltDepth[i] * have + d * volume) / total;
  crust.meltFelsic[i] = (crust.meltFelsic[i] * have + felsic * volume) / total;
  // Melt in residence is deliberately OUTSIDE the mass ledger: it is mantle
  // material that has not been emplaced yet, and it is credited as created
  // only when it becomes rock. Counting it on supply instead meant that a
  // chamber whose point was later subducted, merged or consumed had already
  // been booked and then vanished -- a small permanent leak. Anything over the
  // chamber ceiling simply never arrives.
  crust.melt[i] = Math.min(world.cfg.meltMax, total);
}

export function magmatism(world) {
  const { cfg, crust, pointArea } = world;
  const dt = cfg.dt;
  let erupted = 0, frozen = 0, held = 0, chambers = 0;

  for (let i = 0; i < crust.n; i++) {
    if (!crust.alive[i]) continue;
    const m = crust.melt[i];
    if (m <= 1e-6) { crust.erupting[i] = 0; continue; }

    const felsic = crust.meltFelsic[i];
    const erupt = Math.min(m, m * cfg.meltEruptFrac * dt);
    const freeze = Math.min(m - erupt, m * cfg.meltFreezeFrac * dt);

    if (erupt > 1e-6) {
      // What reaches the surface is the volcanic member: andesite for arc
      // magma, basalt for anything more mafic.
      const vol = felsic > 0.5 ? ROCK.ANDESITE : ROCK.BASALT;
      pushTop(crust, i, erupt, vol, felsic, world.t);
      erupted += erupt * pointArea;
      world.budget.created += erupt * pointArea;
    }
    if (freeze > 1e-6) {
      // What does not is the plutonic member, frozen at chamber depth. It is
      // emplaced along the column rather than on top, which is what makes it
      // read as a sill or a laccolith in section rather than a lava pile.
      const plut = felsic > 0.5 ? ROCK.GRANITE : ROCK.GABBRO;
      const frac = crust.thickness[i] > 0
        ? Math.max(0.1, Math.min(0.92, crust.meltDepth[i] / crust.thickness[i])) : 0.5;
      intrude(crust, i, freeze, plut, felsic, world.t, frac);
      frozen += freeze * pointArea;
      world.budget.created += freeze * pointArea;
      deform(crust, i, Math.min(0.4, 0.2 * freeze));
    }

    crust.melt[i] = m - erupt - freeze;
    crust.erupting[i] = erupt / dt;
    if (crust.melt[i] > cfg.meltVisibleMin) { held += crust.melt[i]; chambers++; }
  }

  world.meltErupted = erupted;
  world.meltFrozen = frozen;
  world.meltHeld = held * pointArea;
  world.meltChambers = chambers;
}

// Melt still in the ground has been created but not yet emplaced, so the mass
// ledger has to count it or conservation drifts by whatever is in residence.
export function meltVolume(world) {
  const { crust, pointArea } = world;
  let v = 0;
  for (let i = 0; i < crust.n; i++) if (crust.alive[i]) v += crust.melt[i];
  return v * pointArea;
}
