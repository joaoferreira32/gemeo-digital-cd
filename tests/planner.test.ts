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

  it('proves that a robot shut in by a stopped robot has no path, without searching', () => {
    const { grid, table, planner } = setup(['....#....', '.........', '....#....']);
    table.hold(at(grid, 4, 1), 0, 1); // the only opening in the wall
    const before = planner.stats.expansions;
    expect(planner.plan(0, rest(at(grid, 0, 1), E), { cell: at(grid, 8, 1) })).toBeNull();
    expect(planner.stats.provedUnreachable).toBe(1);
    expect(planner.stats.expansions).toBe(before);
    // Getting out of the way: the only holdable cells it reaches are avoided.
    grid.holdable[at(grid, 1, 1)] = 1;
    grid.holdable[at(grid, 7, 1)] = 1;
    const avoid = new Set([at(grid, 1, 1)]);
    expect(planner.plan(0, rest(at(grid, 0, 1), E), { cell: -1, avoid })).toBeNull();
    expect(planner.stats.provedUnreachable).toBe(2);
    expect(planner.stats.expansions).toBe(before);
    // A hold that only starts later does not close the opening yet.
    table.hold(at(grid, 4, 1), 30, 1);
    expect(planner.plan(0, rest(at(grid, 0, 1), E), { cell: at(grid, 8, 1) })).not.toBeNull();
  });

  it('never rejects a path the space-time search would find (proof on vs off)', () => {
    // Two rooms joined by three one-cell openings: random stopped robots shut
    // them often, so both answers (path / no path) come up many times.
    const art = [
      '.........#.........',
      '.hhh.....#.....hhh.',
      '.hhh...........hhh.',
      '.........#.........',
      '.hhh...........hhh.',
      '.hhh.....#.....hhh.',
      '.........#.........',
      '...............hhh.',
      '.........#.........',
    ];
    const rng = new Rng(99);
    let found = 0;
    let none = 0;
    // The same budget for both (smaller than the fleet's, to keep the test
    // fast): the answers must match for any budget.
    const limits = { maxExpansions: 8_000, maxSteps: 320 };
    for (let trial = 0; trial < 400; trial++) {
      const grid = gridFrom(art);
      const table = new ReservationTable(grid.cellCount, 8, 256);
      const withProof = new CooperativePlanner(grid, table, limits);
      const without = new CooperativePlanner(grid, table, { ...limits, precheck: false });
      const openings = [at(grid, 9, 2), at(grid, 9, 4), at(grid, 9, 7)];
      const free = [...Array(grid.cellCount).keys()].filter(
        (c) => !grid.blocked[c] && !openings.includes(c),
      );
      const take = (side: (x: number) => boolean) => {
        const options = free.filter((c) => side(grid.x(c)));
        const c = options[rng.int(options.length)] as number;
        free.splice(free.indexOf(c), 1);
        return c;
      };
      const anywhere = () => take(() => true);
      // Robots 1..3 often stop in an opening, from now or only from a later step.
      openings.forEach((cell, i) => {
        if (rng.next() < 0.8) table.hold(cell, rng.next() < 0.8 ? 0 : 1 + rng.int(6), i + 1);
      });
      // Robots 4..7 stand still somewhere or pass by.
      for (let r = 4; r < 8; r++) {
        if (rng.next() < 0.6) table.hold(anywhere(), rng.next() < 0.7 ? 0 : 1 + rng.int(6), r);
        else {
          const a = anywhere();
          const p = without.plan(r, rest(a, rng.int(4)), { cell: anywhere() });
          if (p) without.commit(r, p);
          else table.hold(a, 0, r);
        }
      }
      const start = rest(
        take((x) => x < 9),
        rng.int(4),
      );
      const right = Array.from({ length: 12 }, () => take((x) => x > 9));
      const goal =
        rng.next() < 0.75
          ? { cell: right[0] as number }
          : { cell: -1, avoid: new Set(free.filter((c) => grid.x(c) < 9)) };
      const a = withProof.plan(0, start, goal);
      const b = without.plan(0, start, goal);
      expect(a?.cells ?? null, `trial ${trial}`).toEqual(b?.cells ?? null);
      if (a) found++;
      else none++;
    }
    console.info(
      `prova ligada x desligada: ${found} com caminho, ${none} sem caminho, 0 diferenças`,
    );
    expect(found).toBeGreaterThan(50);
    expect(none).toBeGreaterThan(50);
  }, 60_000);

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
  }, 20_000);
});
