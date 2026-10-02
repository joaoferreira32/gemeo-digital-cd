import { describe, expect, it } from 'vitest';
import type { Fleet } from '../src/sim/fleet';
import { World, type SimConfig } from '../src/sim/world';

const MINUTE = 60 * 60;

interface RunReport {
  minDistance: number;
  maxLag: number;
  brakingViolations: number;
  maxFailingSeconds: number;
  jobsPerWindow: number[];
  jobsDone: number;
  batteryDepleted: number;
  charged: boolean;
  conserved: boolean;
}

/** Smallest center-to-center distance between any two robots right now. */
function minPairDistance(fleet: Fleet): number {
  let best = Infinity;
  const rs = fleet.robots;
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i]!.motion;
    for (let j = i + 1; j < rs.length; j++) {
      const b = rs[j]!.motion;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < best) best = d;
    }
  }
  return best;
}

function conserved(w: World): boolean {
  const s = w.stats;
  return (
    w.metrics.created ===
    s.backlog +
      s.onConveyors +
      s.staged +
      w.metrics.shipped +
      s.inBypass +
      s.onRobots +
      s.rackPending
  );
}

/**
 * Runs the world for `ticks` steps with failures injected along the way and
 * measures safety (distances, lag, braking) and liveness (jobs keep finishing).
 */
function run(config: Partial<SimConfig>, ticks: number, chaos = true): RunReport {
  const w = new World(config);
  const fleet = w.fleet!;
  const a4s1 = w.lanes[0]!.edgeId;
  const report: RunReport = {
    minDistance: Infinity,
    maxLag: 0,
    brakingViolations: 0,
    maxFailingSeconds: 0,
    jobsPerWindow: [],
    jobsDone: 0,
    batteryDepleted: 0,
    charged: false,
    conserved: true,
  };
  const window = 2000;
  let jobsAtWindowStart = 0;
  for (let i = 1; i <= ticks; i++) {
    if (chaos) {
      if (i === 1500) w.setConveyorStatus(a4s1, 'broken');
      if (i === 1500 + 120 * 60) w.setConveyorStatus(a4s1, 'ok');
      if (i === 2500) fleet.setDefect(5, w.time + 40);
      if (i === 3200) fleet.setDefect(17, w.time + 45);
      if (i === 4000) w.setDockBlocked(2, w.time + 40);
    }
    w.step();
    report.minDistance = Math.min(report.minDistance, minPairDistance(fleet));
    if (i % 10 === 0) {
      for (const r of fleet.robots) report.maxLag = Math.max(report.maxLag, r.motion.lag(w.time));
    }
    if (fleet.robots.some((r) => r.stage === 'charging')) report.charged = true;
    if (i % window === 0) {
      report.jobsPerWindow.push(fleet.stats.jobsDone - jobsAtWindowStart);
      jobsAtWindowStart = fleet.stats.jobsDone;
    }
    if (i % 500 === 0 && !conserved(w)) report.conserved = false;
  }
  report.brakingViolations = fleet.robots.reduce((n, r) => n + r.motion.brakingViolations, 0);
  report.maxFailingSeconds = fleet.stats.maxFailingSeconds;
  report.jobsDone = fleet.stats.jobsDone;
  report.batteryDepleted = fleet.stats.batteryDepleted;
  return report;
}

describe('Fleet of 40 robots', () => {
  // Robots are 0.7 m long and 0.55 m wide: their bounding circles (radius
  // 0.445 m) never overlap above 0.89 m between centers.
  const SAFE_DISTANCE = 0.89;

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: 10 000 steps with failures, no collision, no deadlock`, () => {
      const r = run({ seed, rackOrderRate: 0.45 }, 10_000);
      expect(r.minDistance).toBeGreaterThanOrEqual(SAFE_DISTANCE);
      expect(r.brakingViolations).toBe(0);
      expect(r.maxLag).toBeLessThan(0.6);
      // Liveness: after the first trips out of the depots (about a minute),
      // jobs keep finishing in every 33 s window and nobody stays stuck.
      expect(r.jobsPerWindow.slice(2).every((n) => n > 0)).toBe(true);
      expect(r.maxFailingSeconds).toBeLessThan(60);
      expect(r.batteryDepleted).toBe(0);
      expect(r.conserved).toBe(true);
    }, 120_000);
  }

  it('keeps working for a long shift (1 000 s) under heavy order load', () => {
    const r = run({ seed: 42, rackOrderRate: 0.6, arrivalRate: 4 }, 60_000);
    expect(r.minDistance).toBeGreaterThanOrEqual(SAFE_DISTANCE);
    expect(r.brakingViolations).toBe(0);
    expect(r.jobsPerWindow.slice(2).every((n) => n > 0)).toBe(true);
    expect(r.maxFailingSeconds).toBeLessThan(60);
    expect(r.batteryDepleted).toBe(0);
    expect(r.charged).toBe(true);
    expect(r.conserved).toBe(true);
  }, 300_000);

  it('is deterministic for the same seed', () => {
    const snap = (w: World) => w.fleet!.robots.map((r) => [r.motion.x, r.motion.z, r.battery]);
    const a = new World({ seed: 7 });
    const b = new World({ seed: 7 });
    a.stepMany(3 * MINUTE);
    b.stepMany(3 * MINUTE);
    expect(snap(a)).toEqual(snap(b));
  }, 60_000);
});

describe('Robot bypass of a conveyor without alternative', () => {
  it('carries packets around A4→S1 while it is broken', () => {
    const w = new World({ seed: 11 });
    const lane = w.lanes[0]!;
    expect(lane.label).toBe('A4→S1');
    w.stepMany(MINUTE);
    w.setConveyorStatus(lane.edgeId, 'broken');
    w.stepMany(3 * MINUTE);
    expect(lane.carried).toBeGreaterThan(30);
    expect(w.metrics.misrouted).toBe(0);
    expect(conserved(w)).toBe(true);
  }, 60_000);
});
