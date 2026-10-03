/**
 * Watchdog and "no path" proof, measured on the default floor:
 *
 *  1. two robots face to face across each single-entrance gate, step-aside
 *     requests failing (36 cases): stuck for good without the watchdog? how
 *     long until both are through with it?
 *  2. a robot broken inside each of those gates for 60 s: longest wait of the
 *     robot shut in behind it and of robots that have another dock drop;
 *  3. cost of a planning attempt that has no path (a robot shut in behind a
 *     stopped robot), with and without the proof, and the CPU time of case 1.
 *
 *   npm run bench:vigia
 */
import { performance } from 'node:perf_hooks';
import { createFloorGrid } from '../src/sim/floor';
import type { Fleet } from '../src/sim/fleet';
import { createDefaultLayout } from '../src/sim/layout';
import { CooperativePlanner, type PlanGoal, type PlanStart } from '../src/sim/planner';
import { ReservationTable } from '../src/sim/reservations';
import {
  FACE_TO_FACE_PLACEMENTS,
  SINGLE_ENTRANCE_GATES,
  brokenGate,
  faceToFace,
  runScenario,
  swapPlaces,
} from '../src/sim/scenarios';
import { World } from '../src/sim/world';

const PERIOD = 6;
const REPAIR = 60;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};
const round = (x: number, digits = 1) => Number(x.toFixed(digits));

function world(robots: number, stepAside: boolean, watchdogSeconds: number): [World, Fleet] {
  const w = new World({ robots, rackOrderRate: 0, fleet: { stepAside, watchdogSeconds } });
  return [w, w.fleet as Fleet];
}

/** Case 1 for every gate, placement and load; returns times until both robots are through. */
function mutualWaits(watchdogSeconds: number, seconds: number) {
  const times: number[] = [];
  let stuck = 0;
  let minDistance = Infinity;
  let braking = 0;
  for (const z of SINGLE_ENTRANCE_GATES) {
    for (const at of FACE_TO_FACE_PLACEMENTS) {
      for (const loaded of ['none', 'west', 'east'] as const) {
        const [w, f] = world(4, false, watchdogSeconds);
        faceToFace(f, z, at, loaded);
        const r = runScenario(w, seconds, [0, 1]);
        minDistance = Math.min(minDistance, r.minDistance);
        braking += r.braking;
        if (r.crossed.size < 2) stuck++;
        else times.push(Math.max(...r.crossed.values()) - r.firstFailure);
      }
    }
  }
  return { times, stuck, minDistance, braking };
}

// 1. Mutual waits.
const without = mutualWaits(0, 120);
const t0 = performance.now();
const withWatchdog = mutualWaits(PERIOD, 40);
const cpuWithProof = (performance.now() - t0) / 1000;

// 1b. Swap of places, step-aside requests failing.
const swap = (watchdogSeconds: number) => {
  const [w, f] = world(4, false, watchdogSeconds);
  swapPlaces(f);
  const r = runScenario(w, 90, [1, 2]);
  return { arrived: r.arrived.size, longestWait: round(Math.max(...r.wait.values())) };
};
const swapWithout = swap(0);
const swapWith = swap(PERIOD);

// 2. Broken robot inside each gate.
const broken = SINGLE_ENTRANCE_GATES.map((z) => {
  const out: Record<string, number> = { gate: z };
  for (const [key, period] of [
    ['withoutWatchdog', 0],
    ['withWatchdog', PERIOD],
  ] as const) {
    const [w, f] = world(6, true, period);
    brokenGate(f, z, REPAIR);
    const r = runScenario(w, 120, [1, 2, 3]);
    out[`${key}ShutInWait`] = round(r.wait.get(1) as number);
    out[`${key}RerouteWait`] = round(Math.max(r.wait.get(2) as number, r.wait.get(3) as number));
  }
  return out;
});

// 3. Cost of an attempt without a path: robot inside the strip behind (12, -6),
// the gate held by a stopped robot, going out to (4, -6).
const grid = createFloorGrid(createDefaultLayout());
const table = new ReservationTable(grid.cellCount, 2, 512);
table.hold(grid.cellOf(12, -6), 0, 1);
table.hold(grid.cellOf(18, -6), 0, 0);
const start: PlanStart = {
  cell: grid.cellOf(18, -6),
  step: 0,
  heading: 2,
  moving: false,
  waited: 0,
};
const goal: PlanGoal = { cell: grid.cellOf(4, -6) };
function attempt(planner: CooperativePlanner, n: number): number[] {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    if (planner.plan(0, start, goal)) throw new Error('expected no path');
    ms.push(performance.now() - t);
  }
  return ms;
}
const proof = new CooperativePlanner(grid, table);
const search = new CooperativePlanner(grid, table, {
  maxExpansions: 60_000,
  maxSteps: 320,
  precheck: false,
});
attempt(proof, 20);
attempt(search, 3);
const proofMs = median(attempt(proof, 200));
const searchMs = median(attempt(search, 20));

// CPU of case 1 with the proof turned off in every planner.
type Patchable = { reachable: (...args: unknown[]) => boolean };
const proto = CooperativePlanner.prototype as unknown as Patchable;
const reachable = proto.reachable;
proto.reachable = () => true;
const t1 = performance.now();
mutualWaits(PERIOD, 40);
const cpuWithoutProof = (performance.now() - t1) / 1000;
proto.reachable = reachable;

console.log(
  JSON.stringify(
    {
      mutualWait: {
        cases: without.stuck + without.times.length,
        stuckWithoutWatchdog: without.stuck,
        secondsUntilBothThroughMax: round(Math.max(...withWatchdog.times)),
        secondsUntilBothThroughMedian: round(median(withWatchdog.times)),
        stuckWithWatchdog: withWatchdog.stuck,
        minDistanceBetweenRobotsM: round(withWatchdog.minDistance, 3),
        brakingViolations: withWatchdog.braking,
      },
      swapOfPlaces: { withoutWatchdog: swapWithout, withWatchdog: swapWith },
      brokenRobotInGate: { repairSeconds: REPAIR, gates: broken },
      attemptWithoutPath: {
        msWithProof: round(proofMs, 4),
        msSearchOnly: round(searchMs, 2),
        speedup: Math.round(searchMs / proofMs),
        cpuSecondsCase1WithProof: round(cpuWithProof, 2),
        cpuSecondsCase1SearchOnly: round(cpuWithoutProof, 2),
      },
    },
    null,
    2,
  ),
);
