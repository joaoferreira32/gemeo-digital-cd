/**
 * Cooperative A* statistics: time per plan, search size, how much longer the
 * planned routes are than the free shortest path, and what happens when a
 * plan fails — how many failures in a row a robot accumulates before it gets
 * a path, for how long, and where it is standing meanwhile.
 *
 * Two scenarios: the normal shift used in the README, and a harsh one
 * (automatic failures, almost twice the stock orders, more inbound demand).
 *
 *   npm run bench:mapf
 */
import { performance } from 'node:perf_hooks';
import { CooperativePlanner, type Plan, type PlanGoal, type PlanStart } from '../src/sim/planner';
import { World, type SimConfig } from '../src/sim/world';

interface Scenario {
  name: string;
  config: Partial<SimConfig>;
  autoFailures: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'normal', config: { rackOrderRate: 0.45 }, autoFailures: false },
  { name: 'duro', config: { rackOrderRate: 0.8, arrivalRate: 5 }, autoFailures: true },
];
const SEEDS = [1, 2, 3];
const MINUTES = 10;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};

function run(sc: Scenario) {
  const times: number[] = [];
  const stretches: number[] = [];
  /** Consecutive failures before a robot got a path again: attempts and seconds. */
  const streakAttempts: number[] = [];
  const streakSeconds: number[] = [];
  const where = { holdable: 0, corridor: 0, gate: 0, station: 0 };
  let plans = 0;
  let failed = 0;
  let expansions = 0;
  let minDistance = Infinity;
  let jobs = 0;
  let evades = 0;
  let openStreaks = 0;

  const original = CooperativePlanner.prototype.plan;
  for (const seed of SEEDS) {
    const w = new World({ seed, ...sc.config });
    if (sc.autoFailures) w.failures.setAuto(true, 0);
    const fleet = w.fleet!;
    const grid = fleet.grid;
    const open = new Map<number, { start: number; attempts: number }>();
    CooperativePlanner.prototype.plan = function (
      robot: number,
      start: PlanStart,
      goal: PlanGoal,
    ): Plan | null {
      const t0 = performance.now();
      const plan = original.call(this, robot, start, goal);
      times.push(performance.now() - t0);
      if (!plan) {
        failed++;
        const s = open.get(robot) ?? { start: w.time, attempts: 0 };
        s.attempts++;
        open.set(robot, s);
        // Where the robot waits: the cell it stops on and holds.
        const c = start.cell;
        if (grid.gate[c]) where.gate++;
        else if ((grid.stationAt[c] as number) >= 0) where.station++;
        else if (grid.holdable[c]) where.holdable++;
        else where.corridor++;
        return plan;
      }
      plans++;
      expansions += plan.expansions;
      const s = open.get(robot);
      if (s) {
        streakAttempts.push(s.attempts);
        streakSeconds.push(w.time - s.start);
        open.delete(robot);
      }
      if (goal.cell >= 0) {
        const shortest = grid.distanceMap(goal.cell)[start.cell] as number;
        if (shortest > 3) stretches.push((plan.cells.length - 1) / shortest);
      }
      return plan;
    };
    for (let i = 0; i < MINUTES * 3600; i++) {
      w.step();
      if (i % 6 === 0) {
        const rs = fleet.robots;
        for (let a = 0; a < rs.length; a++) {
          for (let b = a + 1; b < rs.length; b++) {
            const d = Math.hypot(
              rs[a]!.motion.x - rs[b]!.motion.x,
              rs[a]!.motion.z - rs[b]!.motion.z,
            );
            if (d < minDistance) minDistance = d;
          }
        }
      }
    }
    // Streaks still open at the end of the run count with their age so far.
    for (const s of open.values()) {
      streakAttempts.push(s.attempts);
      streakSeconds.push(w.time - s.start);
      openStreaks++;
    }
    jobs += fleet.stats.jobsDone;
    evades += fleet.stats.evades;
  }
  CooperativePlanner.prototype.plan = original;

  const total = plans + failed;
  return {
    scenario: sc.name,
    seeds: SEEDS,
    minutesEach: MINUTES,
    robots: 40,
    jobsDone: jobs,
    plans,
    failedAttempts: failed,
    failedShare: failed / total,
    msPerPlanMean: mean(times),
    msPerPlanP95: quantile(times, 0.95),
    msPerPlanMax: quantile(times, 1),
    expansionsMean: expansions / plans,
    routeStretchMean: mean(stretches),
    routeStretchP95: quantile(stretches, 0.95),
    minDistanceBetweenRobotsM: minDistance,
    failureStreaks: {
      count: streakAttempts.length,
      resolvedAtFirstRetry: streakAttempts.filter((a) => a === 1).length,
      attemptsP95: quantile(streakAttempts, 0.95),
      attemptsMax: quantile(streakAttempts, 1),
      secondsMean: mean(streakSeconds),
      secondsP95: quantile(streakSeconds, 0.95),
      secondsMax: quantile(streakSeconds, 1),
      stillOpenAtEnd: openStreaks,
      waitingOn: where,
      stepAsideRequests: evades,
    },
  };
}

console.log(JSON.stringify(SCENARIOS.map(run), null, 2));
