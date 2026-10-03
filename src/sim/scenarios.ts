import type { Fleet, Robot } from './fleet';
import type { World } from './world';

/**
 * Waits built on purpose on the default floor, shared by the tests, the
 * benchmarks and the cinema mode. The gates at (12, ±6) and (12, ±12) are the
 * only way into the dock strips: one cell between two conveyor walls, the
 * narrowest corridor the robots use.
 */
export const SINGLE_ENTRANCE_GATES = [-12, -6, 6, 12] as const;
export type GateZ = (typeof SINGLE_ENTRANCE_GATES)[number];

const EAST = 0;
const WEST = 2;

/** Docks whose nearest drop is inside the strip behind each gate. */
const DOCK_INSIDE: Record<GateZ, readonly [number, number]> = {
  [-12]: [0, 1],
  [-6]: [2, 1],
  [6]: [3, 4],
  [12]: [5, 4],
};
/** A dock reached through the gate from inside the strip. */
const DOCK_THROUGH: Record<GateZ, number> = { [-12]: 2, [-6]: 0, [6]: 5, [12]: 3 };

/** West and east x of the two robots: around the gate, or one of them inside it. */
export const FACE_TO_FACE_PLACEMENTS = [
  [11, 13],
  [12, 13],
  [11, 12],
] as const;
export type Loaded = 'none' | 'west' | 'east';

/**
 * Two robots stopped face to face across a gate, each with its goal on the
 * other side: robot 0 west of it heading east, robot 1 east of it heading
 * west. Neither can plan: the only way through is the other robot's cell.
 * `loaded` makes one of them a delivery (loaded) instead of an empty move.
 */
export function faceToFace(
  fleet: Fleet,
  z: GateZ,
  [westX, eastX]: readonly [number, number] = [11, 13],
  loaded: Loaded = 'none',
): void {
  const cell = (x: number) => fleet.grid.cellOf(x, z);
  fleet.place(0, cell(westX), EAST);
  fleet.place(1, cell(eastX), WEST);
  if (loaded === 'west') fleet.deliver(0, DOCK_INSIDE[z][0], 3);
  else fleet.sendTo(0, cell(20));
  if (loaded === 'east') fleet.deliver(1, DOCK_THROUGH[z], 3);
  else fleet.sendTo(1, cell(4));
}

/**
 * Robot 0 breaks inside the gate until `repairAt`. Robot 1 is shut in the
 * strip behind it (its goal is outside); robots 2 and 3 are outside and must
 * deliver to docks whose nearest drop is behind the gate. Each of those docks
 * has a second drop reached another way. Needs at least 4 robots.
 */
export function brokenGate(fleet: Fleet, z: GateZ, repairAt: number): void {
  const cell = (x: number) => fleet.grid.cellOf(x, z);
  fleet.place(0, cell(12), EAST);
  fleet.setDefect(0, repairAt);
  fleet.place(1, cell(18), WEST);
  fleet.sendTo(1, cell(4));
  fleet.place(2, cell(8), EAST);
  fleet.deliver(2, DOCK_INSIDE[z][0], 3);
  fleet.place(3, cell(5), EAST);
  fleet.deliver(3, DOCK_INSIDE[z][1], 2);
}

export interface ScenarioRun {
  /** Longest stretch each watched robot spent unable to plan (seconds). */
  wait: Map<number, number>;
  /** When each watched robot first got past x = 12 toward its goal. */
  crossed: Map<number, number>;
  /** When each watched robot finished its scripted move. */
  arrived: Map<number, number>;
  /** First time any watched robot failed to plan. */
  firstFailure: number;
  /** Smallest distance between any two robot centers (m). */
  minDistance: number;
  /** Times any robot had to brake harder than allowed. */
  braking: number;
}

/** Runs the world for `seconds` and measures how the watched robots fared. */
export function runScenario(world: World, seconds: number, watch: readonly number[]): ScenarioRun {
  const fleet = world.fleet as Fleet;
  const goingEast = new Map(
    watch.map((id) => [id, fleet.grid.x((fleet.robots[id] as Robot).goalCell) > 12]),
  );
  const out: ScenarioRun = {
    wait: new Map(watch.map((id) => [id, 0])),
    crossed: new Map(),
    arrived: new Map(),
    firstFailure: Infinity,
    minDistance: Infinity,
    braking: 0,
  };
  const ticks = Math.round(seconds / world.config.dt);
  const rs = fleet.robots;
  for (let i = 0; i < ticks; i++) {
    world.step();
    for (const id of watch) {
      const r = rs[id] as Robot;
      if (r.failures > 0) {
        out.firstFailure = Math.min(out.firstFailure, r.failingSince);
        out.wait.set(id, Math.max(out.wait.get(id) as number, world.time - r.failingSince));
      }
      const across = goingEast.get(id) ? r.motion.x > 12.5 : r.motion.x < 11.5;
      if (across && !out.crossed.has(id)) out.crossed.set(id, world.time);
      if (r.job?.kind !== 'goto' && !out.arrived.has(id)) out.arrived.set(id, world.time);
    }
    for (let a = 0; a < rs.length; a++) {
      const ma = (rs[a] as Robot).motion;
      for (let b = a + 1; b < rs.length; b++) {
        const mb = (rs[b] as Robot).motion;
        out.minDistance = Math.min(out.minDistance, Math.hypot(ma.x - mb.x, ma.z - mb.z));
      }
    }
  }
  out.braking = rs.reduce((n, r) => n + r.motion.brakingViolations, 0);
  return out;
}
