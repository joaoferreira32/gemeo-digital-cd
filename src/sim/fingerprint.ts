import type { World } from './world';

/**
 * Hash of the complete simulation state (FNV-1a over the exact float bits).
 * Two runs with the same seed and inputs must produce the same fingerprint at
 * every tick; this is what makes scenario comparisons reproducible.
 */
export function fingerprint(world: World): string {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    f64[0] = v;
    for (let i = 0; i < 2; i++) {
      h ^= u32[i] as number;
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(world.tick);
  mix(world.metrics.created);
  mix(world.metrics.delivered);
  mix(world.metrics.shipped);
  for (const inbound of world.inbounds) {
    mix(inbound.nextArrivalAt);
    mix(inbound.backlog.length);
    for (const p of inbound.backlog) mix(p.id);
  }
  for (const c of world.conveyors) {
    mix(c.status === 'ok' ? 1 : 0);
    mix(c.packets.length);
    for (const p of c.packets) {
      mix(p.id);
      mix(p.s);
      mix(p.destination);
    }
  }
  for (const d of world.docks) {
    mix(d.serviceProgress);
    mix(d.truck.load);
    mix(d.truck.awayLeft);
    for (const p of d.staged) mix(p.id);
  }
  for (const lane of world.lanes) {
    for (const p of lane.pickup) mix(p.id);
    for (const p of lane.drop) mix(p.id);
  }
  if (world.fleet) {
    for (const r of world.fleet.robots) {
      mix(r.motion.x);
      mix(r.motion.z);
      mix(r.motion.heading);
      mix(r.battery);
      mix(r.load.length);
      mix(r.cells.length);
      mix(r.planStart);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
