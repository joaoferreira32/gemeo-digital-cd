import { describe, expect, it } from 'vitest';
import { FloorGrid } from '../src/sim/floor';
import {
  CooperativePlanner,
  validatePlanMotion,
  type Plan,
  type PlanStart,
} from '../src/sim/planner';
import { ReservationTable } from '../src/sim/reservations';
import { Rng } from '../src/sim/rng';

const E = 0;
const S = 1;
const N = 3;

/** Grid from ASCII art: '#' wall, anything else free; 'h' marks a holdable cell. */
function gridFrom(art: string[]): FloorGrid {
  const g = new FloorGrid({
    minX: -0.5,
    maxX: (art[0] as string).length - 0.5,
    minZ: -0.5,
    maxZ: art.length - 0.5,
  });
  art.forEach((row, z) => {
    [...row].forEach((ch, x) => {
      const cell = g.cellOf(x, z);
      if (ch === '#') g.blocked[cell] = 1;
      if (ch === 'h') g.holdable[cell] = 1;
    });
  });
  return g;
}

function setup(art: string[], robots = 4) {
  const grid = gridFrom(art);
  const table = new ReservationTable(grid.cellCount, robots, 256);
  const planner = new CooperativePlanner(grid, table);
  return { grid, table, planner };
}

const at = (grid: FloorGrid, x: number, z: number) => grid.cellOf(x, z);
const rest = (cell: number, heading: number, step = 0): PlanStart => ({
  cell,
  step,
  heading,
  moving: false,
  waited: 0,
});

/** Asserts that no two plans use a cell within one step of each other (1-robust), holds included. */
function assertRobust(plans: Plan[], horizon = 200) {
  for (let a = 0; a < plans.length; a++) {
    for (let b = a + 1; b < plans.length; b++) {
      const pa = plans[a] as Plan;
      const pb = plans[b] as Plan;
      const cellAt = (p: Plan, step: number) => {
        const i = step - p.startStep;
        if (i < 0) return -1;
        return p.cells[Math.min(i, p.cells.length - 1)] as number;
      };
      for (let s = 0; s < horizon; s++) {
        const ca = cellAt(pa, s);
        if (ca < 0) continue;
        for (const ds of [-1, 0, 1]) {
          expect(cellAt(pb, s + ds), `robots ${a}/${b} at step ${s}`).not.toBe(ca);
        }
      }
    }
  }
}

describe('CooperativePlanner', () => {
  it('finds the straight shortest path when the robot already faces the goal', () => {
    const { grid, planner } = setup(['..........']);
    const plan = planner.plan(0, rest(at(grid, 0, 0), E), { cell: at(grid, 6, 0) })!;
    expect(plan.cells.map((c) => grid.x(c))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('waits one step to rotate 90° and two steps to reverse from a stop', () => {
    const { grid, planner } = setup(['.....', '.....', '.....']);
    const turn = planner.plan(0, rest(at(grid, 2, 1), E), { cell: at(grid, 2, 0) })!;
    expect(turn.cells).toEqual([at(grid, 2, 1), at(grid, 2, 1), at(grid, 2, 0)]);
    const back = planner.plan(1, rest(at(grid, 2, 2), E), { cell: at(grid, 0, 2) })!;
    expect(back.cells.slice(0, 3)).toEqual([at(grid, 2, 2), at(grid, 2, 2), at(grid, 2, 2)]);
    expect(validatePlanMotion(grid, back.cells, rest(at(grid, 2, 2), E))).toBeNull();
  });

  it('never reverses in motion', () => {
    const { grid, planner } = setup(['......']);
    // Moving east into (2,0) with the goal behind it: must stop twice before going back.
    const start: PlanStart = { cell: at(grid, 2, 0), step: 0, heading: E, moving: true, waited: 0 };
    const plan = planner.plan(0, start, { cell: at(grid, 0, 0) })!;
    expect(validatePlanMotion(grid, plan.cells, start)).toBeNull();
    expect(plan.cells.slice(0, 3).every((c) => c === at(grid, 2, 0))).toBe(true);
  });

  it('routes around walls', () => {
    const { grid, planner } = setup(['......', '.####.', '......']);
    const plan = planner.plan(0, rest(at(grid, 0, 1), N), { cell: at(grid, 5, 1) })!;
    expect(validatePlanMotion(grid, plan.cells, rest(at(grid, 0, 1), N))).toBeNull();
    expect(plan.cells[plan.cells.length - 1]).toBe(at(grid, 5, 1));
    expect(plan.cells.some((c) => grid.blocked[c])).toBe(false);
  });

  it('lets two robots cross a corridor head-on without a conflict', () => {
    const { grid, table, planner } = setup([
      '.#########.',
      '...........',
      '.####.####.',
      '.#########.',
    ]);
    const sa = rest(at(grid, 0, 0), S);
    const sb = rest(at(grid, 10, 0), S);
    // Every robot always holds the cell it stands on.
    table.hold(sa.cell, 0, 0);
    table.hold(sb.cell, 0, 1);
    const a = planner.plan(0, sa, { cell: at(grid, 10, 3) })!;
    planner.commit(0, a);
    const b = planner.plan(1, sb, { cell: at(grid, 0, 3) })!;
    planner.commit(1, b);
    assertRobust([a, b]);
    expect(validatePlanMotion(grid, a.cells, sa)).toBeNull();
    expect(validatePlanMotion(grid, b.cells, sb)).toBeNull();
    expect(b.cells[b.cells.length - 1]).toBe(at(grid, 0, 3));
  });

  it('keeps two cells of distance when following another robot', () => {
    const { grid, table, planner } = setup(['............']);
    // B starts right behind A: it has to wait until A is two cells ahead.
    table.hold(at(grid, 2, 0), 0, 0);
    table.hold(at(grid, 1, 0), 0, 1);
    const a = planner.plan(0, rest(at(grid, 2, 0), E), { cell: at(grid, 11, 0) })!;
    planner.commit(0, a);
    const b = planner.plan(1, rest(at(grid, 1, 0), E), { cell: at(grid, 9, 0) })!;
    expect(b.cells[1]).toBe(at(grid, 1, 0));
    planner.commit(1, b);
    assertRobust([a, b]);
    for (let s = 1; s < 12; s++) {
      const xa = grid.x(a.cells[Math.min(s, a.cells.length - 1)] as number);
      const xb = grid.x(b.cells[Math.min(s, b.cells.length - 1)] as number);
      expect(xa - xb).toBeGreaterThanOrEqual(2);
    }
  });

  it('only accepts a goal it can keep forever', () => {
    const { grid, table, planner } = setup(['..........']);
    const goal = at(grid, 5, 0);
    table.reserve(goal, 40, 3); // someone passes through the goal at step 40
    const plan = planner.plan(0, rest(at(grid, 0, 0), E), { cell: goal })!;
    expect(plan.startStep + plan.cells.length - 1).toBeGreaterThanOrEqual(42);
  });

  it('fails cleanly when the goal is unreachable or held by someone else', () => {
    const { grid, table, planner } = setup(['....#....']);
    expect(planner.plan(0, rest(at(grid, 0, 0), E), { cell: at(grid, 8, 0) })).toBeNull();
    table.hold(at(grid, 3, 0), 0, 2);
    expect(planner.plan(0, rest(at(grid, 0, 0), E), { cell: at(grid, 3, 0) })).toBeNull();
    expect(planner.stats.failures).toBe(2);
  });

  it('can evade to the nearest holdable cell that is not avoided', () => {
    const { grid, planner } = setup(['.....h...h']);
    const avoid = new Set([at(grid, 5, 0)]);
    const plan = planner.plan(0, rest(at(grid, 0, 0), E), { cell: -1, avoid })!;
    expect(plan.cells[plan.cells.length - 1]).toBe(at(grid, 9, 0));
  });

  it('is deterministic', () => {
    const run = () => {
      const { grid, planner } = setup(['.....', '.#.#.', '.....', '.#.#.', '.....']);
      const out: number[][] = [];
      [
        [0, 0, 4, 4],
        [4, 0, 0, 4],
        [0, 4, 4, 0],
      ].forEach(([x0, z0, x1, z1], r) => {
        const p = planner.plan(r, rest(at(grid, x0!, z0!), E), { cell: at(grid, x1!, z1!) })!;
        planner.commit(r, p);
        out.push(p.cells);
      });
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('keeps many sequentially planned robots 1-robust and within the motion rules', () => {
    const art = [
      '..............',
      '.##.##..##.##.',
      '..............',
      '.##.##..##.##.',
      '..............',
      '.##.##..##.##.',
      '..............',
    ];
    const rng = new Rng(17);
    for (let trial = 0; trial < 20; trial++) {
      const { grid, table, planner } = setup(art, 8);
      const free = [...Array(grid.cellCount).keys()].filter((c) => !grid.blocked[c]);
      const pick = () => free.splice(rng.int(free.length), 1)[0] as number;
      const starts = Array.from({ length: 8 }, () => rest(pick(), rng.int(4)));
      const goals = Array.from({ length: 8 }, () => pick());
      starts.forEach((st, r) => table.hold(st.cell, 0, r));
      const plans: Plan[] = [];
      for (let r = 0; r < 8; r++) {
        const start = starts[r] as PlanStart;
        const goal = goals[r] as number;
        const plan = planner.plan(r, start, { cell: goal });
        if (!plan) {
          // Robots that cannot move keep standing (holding) on their start cell.
          plans.push({ cells: [start.cell], startStep: 0, expansions: 0 });
          continue;
        }
        expect(validatePlanMotion(grid, plan.cells, start)).toBeNull();
        expect(plan.cells[0]).toBe(start.cell);
        expect(plan.cells[plan.cells.length - 1]).toBe(goal);
        planner.commit(r, plan);
        plans.push(plan);
      }
      expect(plans.filter((p) => p.cells.length > 1).length).toBeGreaterThan(4);
      assertRobust(plans);
    }
  });
});
