import { describe, expect, it } from 'vitest';
import { FloorGrid } from '../src/sim/floor';
import { DEFAULT_MOTION, PathTimeline, RobotMotion } from '../src/sim/motion';
import { CooperativePlanner, type PlanStart } from '../src/sim/planner';
import { ReservationTable } from '../src/sim/reservations';
import { Rng } from '../src/sim/rng';

const DT = 1 / 60;
const P = DEFAULT_MOTION;

function openGrid(cols: number, rows: number): FloorGrid {
  return new FloorGrid({ minX: -0.5, maxX: cols - 0.5, minZ: -0.5, maxZ: rows - 0.5 });
}

interface Trace {
  maxLag: number;
  maxSpeed: number;
  maxAccel: number;
  maxDecel: number;
  maxTurnSpeed: number;
  maxJump: number;
  maxHeadingStep: number;
  aheadViolations: number;
  endTime: number;
  m: RobotMotion;
}

/** Runs a robot along a plan and records every invariant we care about. */
function run(grid: FloorGrid, cells: number[], heading: number, extraSeconds = 6): Trace {
  const m = new RobotMotion(grid, P, cells[0] as number, heading);
  m.setPlan(cells, 0, 0);
  const tl = m.timeline as PathTimeline;
  const ref = { s: 0, v: 0 };
  const trace: Trace = {
    maxLag: 0,
    maxSpeed: 0,
    maxAccel: 0,
    maxDecel: 0,
    maxTurnSpeed: 0,
    maxJump: 0,
    maxHeadingStep: 0,
    aheadViolations: 0,
    endTime: -1,
    m,
  };
  const total = (cells.length - 1) * P.stepSeconds + extraSeconds;
  let t = 0;
  for (let i = 0; i < Math.ceil(total / DT); i++) {
    const v0 = m.v;
    const x0 = m.x;
    const z0 = m.z;
    const h0 = m.heading;
    t += DT;
    m.update(t, DT);
    tl.reference(t, P.stepSeconds, ref);
    if (m.s > ref.s + 1e-9) trace.aheadViolations++;
    trace.maxLag = Math.max(trace.maxLag, m.lag(t));
    trace.maxSpeed = Math.max(trace.maxSpeed, m.v);
    trace.maxAccel = Math.max(trace.maxAccel, (m.v - v0) / DT);
    trace.maxDecel = Math.max(trace.maxDecel, (v0 - m.v) / DT);
    trace.maxJump = Math.max(trace.maxJump, Math.hypot(m.x - x0, m.z - z0));
    trace.maxHeadingStep = Math.max(
      trace.maxHeadingStep,
      Math.abs(Math.atan2(Math.sin(m.heading - h0), Math.cos(m.heading - h0))),
    );
    const piece = tl.pieces[tl.pieceIndex(m.s)];
    if (piece?.arc && m.s > piece.s0 + 1e-6 && m.s < piece.s0 + piece.len - 1e-6) {
      trace.maxTurnSpeed = Math.max(trace.maxTurnSpeed, m.v);
    }
    if (trace.endTime < 0 && m.arrived && t > 0.1) trace.endTime = t;
  }
  return trace;
}

function expectPhysical(tr: Trace) {
  expect(tr.aheadViolations).toBe(0);
  expect(tr.m.brakingViolations).toBe(0);
  expect(tr.maxSpeed).toBeLessThanOrEqual(P.vMax + 1e-9);
  expect(tr.maxAccel).toBeLessThanOrEqual(P.accel + 1e-6);
  expect(tr.maxDecel).toBeLessThanOrEqual(P.decel + 1e-6);
  expect(tr.maxJump).toBeLessThanOrEqual(P.vMax * DT + 1e-6);
  // Heading changes come from arcs (v / r) or rotation in place, both bounded.
  const maxYawRate = Math.max(P.turnRate, P.vMax / P.turnRadius);
  expect(tr.maxHeadingStep).toBeLessThanOrEqual(maxYawRate * DT + 1e-6);
}

describe('PathTimeline', () => {
  it('rounds corners passed in motion and keeps sharp corners where the robot stops', () => {
    const g = openGrid(5, 5);
    const c = (x: number, z: number) => g.cellOf(x, z);
    const through = new PathTimeline(g, [c(0, 0), c(1, 0), c(2, 0), c(2, 1), c(2, 2)], 0, 0.5);
    expect(through.pieces.filter((p) => p.arc)).toHaveLength(1);
    expect(through.length).toBeCloseTo(3 + Math.PI / 4, 9);
    const stopped = new PathTimeline(g, [c(0, 0), c(1, 0), c(2, 0), c(2, 0), c(2, 1)], 0, 0.5);
    expect(stopped.pieces.filter((p) => p.arc)).toHaveLength(0);
    expect(stopped.stops).toContain(2);
  });

  it('places the reference on cell centers (or arc middles) at every step', () => {
    const g = openGrid(5, 5);
    const c = (x: number, z: number) => g.cellOf(x, z);
    const tl = new PathTimeline(g, [c(0, 0), c(1, 0), c(1, 0), c(2, 0)], 3, 0.5);
    expect(tl.anchors).toEqual([0, 1, 1, 2]);
    const ref = { s: 0, v: 0 };
    expect(tl.reference(3.5, 1, ref)).toEqual({ s: 0.5, v: 1 });
    expect(tl.reference(4.5, 1, ref).v).toBe(0); // waiting on (1,0)
    expect(tl.timeAt(1.5, 1)).toBe(5.5);
  });
});

describe('RobotMotion', () => {
  it('accelerates, cruises and stops exactly at the goal within the physical limits', () => {
    const g = openGrid(12, 1);
    const cells = Array.from({ length: 11 }, (_, i) => g.cellOf(i, 0));
    const tr = run(g, cells, 0);
    expectPhysical(tr);
    expect(tr.m.x).toBeCloseTo(10, 6);
    expect(tr.maxLag).toBeLessThan(0.5);
    expect(tr.endTime).toBeGreaterThan(10);
    expect(tr.endTime).toBeLessThan(10.5);
  });

  it('slows down to the turn speed on arcs', () => {
    const g = openGrid(6, 6);
    const c = (x: number, z: number) => g.cellOf(x, z);
    const tr = run(g, [c(0, 0), c(1, 0), c(2, 0), c(3, 0), c(3, 1), c(3, 2), c(3, 3)], 0);
    expectPhysical(tr);
    expect(tr.maxTurnSpeed).toBeGreaterThan(0.3);
    expect(tr.maxTurnSpeed).toBeLessThanOrEqual(Math.sqrt(P.lateralAccel * P.turnRadius) + 1e-9);
    expect(tr.maxLag).toBeLessThan(0.5);
  });

  it('stops at a corner, rotates in place during the wait and goes on', () => {
    const g = openGrid(6, 6);
    const c = (x: number, z: number) => g.cellOf(x, z);
    const tr = run(g, [c(0, 0), c(1, 0), c(2, 0), c(2, 0), c(2, 1), c(2, 2)], 0);
    expectPhysical(tr);
    expect(tr.m.x).toBeCloseTo(2, 6);
    expect(tr.m.z).toBeCloseTo(2, 6);
    expect(tr.m.heading).toBeCloseTo(Math.PI / 2, 6);
    expect(tr.maxLag).toBeLessThan(0.5);
  });

  it('keeps moving continuously when the plan is replaced mid-way', () => {
    const g = openGrid(10, 10);
    const c = (x: number, z: number) => g.cellOf(x, z);
    const m = new RobotMotion(g, P, c(0, 5), 0);
    m.setPlan([c(0, 5), c(1, 5), c(2, 5), c(3, 5), c(4, 5), c(5, 5)], 0, 0);
    let t = 0;
    for (let i = 0; i < 2 * 60; i++) {
      t += DT;
      m.update(t, DT);
    }
    const before = { x: m.x, z: m.z, v: m.v };
    // At boundary 2 the robot is committed to (3,5) at step 3; from there it turns north.
    m.setPlan([c(1, 5), c(2, 5), c(3, 5), c(3, 4), c(3, 3), c(3, 2)], 1, 2);
    expect(Math.hypot(m.x - before.x, m.z - before.z)).toBeLessThan(1e-9);
    expect(m.v).toBe(before.v);
    for (let i = 0; i < 6 * 60; i++) {
      const x0 = m.x;
      const z0 = m.z;
      t += DT;
      m.update(t, DT);
      expect(Math.hypot(m.x - x0, m.z - z0)).toBeLessThanOrEqual(P.vMax * DT + 1e-6);
    }
    expect(m.x).toBeCloseTo(3, 6);
    expect(m.z).toBeCloseTo(2, 6);
  });

  it('stays within the limits and well under one step behind on random planned routes', () => {
    const rng = new Rng(99);
    const g = openGrid(14, 14);
    for (let i = 0; i < 25; i++) g.blocked[rng.int(g.cellCount)] = 1;
    let worstLag = 0;
    let routes = 0;
    for (let trial = 0; trial < 60; trial++) {
      const table = new ReservationTable(g.cellCount, 1, 256);
      const planner = new CooperativePlanner(g, table);
      const free = [...Array(g.cellCount).keys()].filter((c) => !g.blocked[c]);
      const start: PlanStart = {
        cell: free[rng.int(free.length)] as number,
        step: 0,
        heading: rng.int(4),
        moving: false,
        waited: 0,
      };
      const plan = planner.plan(0, start, { cell: free[rng.int(free.length)] as number });
      if (!plan || plan.cells.length < 3) continue;
      routes++;
      const tr = run(g, plan.cells, (start.heading * Math.PI) / 2);
      expectPhysical(tr);
      expect(tr.m.x).toBeCloseTo(g.x(plan.cells[plan.cells.length - 1] as number), 6);
      worstLag = Math.max(worstLag, tr.maxLag);
    }
    expect(routes).toBeGreaterThan(30);
    // Worst cases are short zig-zags (start, two arcs in a row, stop): about
    // 0.52 s late at the final stop. The one-step reservation margin covers up
    // to a full step; the fleet test checks real distances between robots.
    expect(worstLag).toBeLessThan(0.6);
  });
});
