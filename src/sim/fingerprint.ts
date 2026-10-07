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
    mix(c.status === 'ok' ? 1 : c.status === 'broken' ? 0 : 2);
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
  for (let i = 0; i < world.conveyors.length; i++) {
    mix(world.health.sum[i] as number);
    mix(world.health.temperature[i] as number);
  }
  // The maintenance schedule only exists when it is on (the earlier runs keep their prints).
  const schedule = world.schedule;
  if (schedule.enabled) {
    mix(schedule.avoided);
    mix(schedule.unneeded);
    mix(schedule.lost);
    for (const p of schedule.plans) {
      mix(p.target);
      mix(p.deadline);
      mix(p.drainedBy);
    }
    for (const s of schedule.services) {
      mix(s.target);
      mix(s.endsAt);
    }
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
