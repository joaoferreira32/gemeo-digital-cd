/**
 * Cooperative A* statistics in a busy shift: time per plan, search size,
 * failed attempts and how much longer the planned routes are than the
 * shortest path ignoring other robots (the price of coordination).
 *
 *   npx tsx bench/mapf.ts
 */
import { performance } from 'node:perf_hooks';
import { CooperativePlanner, type Plan, type PlanGoal, type PlanStart } from '../src/sim/planner';
import { World } from '../src/sim/world';

const SEEDS = [1, 2, 3];
const MINUTES = 10;

const times: number[] = [];
const stretches: number[] = [];
let plans = 0;
let failed = 0;
let expansions = 0;
let minDistance = Infinity;

const original = CooperativePlanner.prototype.plan;
for (const seed of SEEDS) {
  const w = new World({ seed, rackOrderRate: 0.45 });
  const grid = w.fleet!.grid;
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
      return plan;
    }
    plans++;
    expansions += plan.expansions;
    if (goal.cell >= 0) {
      const shortest = grid.distanceMap(goal.cell)[start.cell] as number;
      if (shortest > 3) stretches.push((plan.cells.length - 1) / shortest);
    }
    return plan;
  };
  for (let i = 0; i < MINUTES * 3600; i++) {
    w.step();
    if (i % 6 === 0) {
      const rs = w.fleet!.robots;
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
}
CooperativePlanner.prototype.plan = original;

const sorted = [...times].sort((a, b) => a - b);
const pct = (p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(
  JSON.stringify(
    {
      seeds: SEEDS,
      minutesEach: MINUTES,
      robots: 40,
      plans,
      failedAttempts: failed,
      failedShare: failed / (plans + failed),
      msPerPlanMean: mean(times),
      msPerPlanP95: pct(0.95),
      msPerPlanMax: sorted[sorted.length - 1],
      expansionsMean: expansions / plans,
      routeStretchMean: mean(stretches),
      routeStretchP95: [...stretches].sort((a, b) => a - b)[Math.floor(stretches.length * 0.95)],
      minDistanceBetweenRobotsM: minDistance,
    },
    null,
    2,
  ),
);
