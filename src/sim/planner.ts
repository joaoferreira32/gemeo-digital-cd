import { opposite, type FloorGrid } from './floor';
import type { ReservationTable } from './reservations';

/**
 * Cooperative A* (Silver, 2005): robots plan one at a time in space-time,
 * each one treating the paths already reserved by the others as moving
 * obstacles. The search state is (cell, step, motion mode):
 *
 *  - moving with heading h: the robot passes through the cell without
 *    stopping; it may go straight or turn 90° (on an arc), never reverse;
 *  - stopped with heading h after w full wait steps: turning 90° needs one
 *    wait (time to rotate in place), reversing needs two.
 *
 * Every action takes one step. A goal is accepted only if the robot can stay
 * there forever (no later reservation by anyone else), because it will hold
 * that cell until it plans again.
 */

export interface PlanStart {
  cell: number;
  step: number;
  heading: number;
  /** True when the robot arrives at `cell` in motion and may continue without stopping. */
  moving: boolean;
  /** Full wait steps already spent standing on `cell` (only when not moving). */
  waited: number;
}

export interface PlanGoal {
  /** Target cell, or -1 for "any holdable cell" (used to get out of the way). */
  cell: number;
  /** Cells an evasion must not end on. */
  avoid?: ReadonlySet<number>;
}

export interface PlannerLimits {
  maxExpansions: number;
  maxSteps: number;
}

export interface Plan {
  /** cells[i] is the robot's cell at step startStep + i; it holds the last one afterwards. */
  readonly cells: number[];
  readonly startStep: number;
  readonly expansions: number;
}

export const DEFAULT_LIMITS: PlannerLimits = { maxExpansions: 60_000, maxSteps: 320 };

const MODES = 16;

/** mode 0..3 = moving with heading; 4 + h*3 + w = stopped with heading h after w waits (w ≤ 2). */
export function moveAllowed(mode: number, dir: number): boolean {
  if (mode < 4) return dir !== opposite(mode);
  const h = Math.floor((mode - 4) / 3);
  const w = (mode - 4) % 3;
  if (dir === h) return true;
  if (dir === opposite(h)) return w >= 2;
  return w >= 1;
}

export function waitMode(mode: number): number {
  if (mode < 4) return 4 + mode * 3 + 1;
  const h = Math.floor((mode - 4) / 3);
  const w = (mode - 4) % 3;
  return 4 + h * 3 + Math.min(w + 1, 2);
}

export function startMode(start: PlanStart): number {
  return start.moving
    ? start.heading
    : 4 + start.heading * 3 + Math.min(Math.max(start.waited, 0), 2);
}

/** Min-heap of search states ordered by f, then by depth (deeper first), then by id (determinism). */
class OpenList {
  private ids: number[] = [];
  private fs: number[] = [];
  private gs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.ids.length = 0;
    this.fs.length = 0;
    this.gs.length = 0;
  }

  private less(i: number, j: number): boolean {
    const fi = this.fs[i] as number;
    const fj = this.fs[j] as number;
    if (fi !== fj) return fi < fj;
    const gi = this.gs[i] as number;
    const gj = this.gs[j] as number;
    if (gi !== gj) return gi > gj;
    return (this.ids[i] as number) < (this.ids[j] as number);
  }

  private swap(i: number, j: number): void {
    const { ids, fs, gs } = this;
    [ids[i], ids[j]] = [ids[j] as number, ids[i] as number];
    [fs[i], fs[j]] = [fs[j] as number, fs[i] as number];
    [gs[i], gs[j]] = [gs[j] as number, gs[i] as number];
  }

  push(id: number, f: number, g: number): void {
    this.ids.push(id);
    this.fs.push(f);
    this.gs.push(g);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0] as number;
    const last = this.ids.length - 1;
    this.swap(0, last);
    this.ids.pop();
    this.fs.pop();
    this.gs.pop();
    let i = 0;
    const n = this.ids.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

export class CooperativePlanner {
  private readonly open = new OpenList();
  private readonly parent = new Map<number, number>();
  /** Statistics for the HUD and the benchmarks. */
  readonly stats = { plans: 0, failures: 0, expansions: 0 };

  constructor(
    private readonly grid: FloorGrid,
    private readonly table: ReservationTable,
    private readonly limits: PlannerLimits = DEFAULT_LIMITS,
  ) {}

  /** Finds a path for `robot`; returns null when none exists within the limits. */
  plan(robot: number, start: PlanStart, goal: PlanGoal): Plan | null {
    const { grid, table } = this;
    const cells = grid.cellCount;
    const h = goal.cell >= 0 ? grid.distanceMap(goal.cell) : null;
    if (h && (h[start.cell] as number) >= 1 << 29) return this.fail();
    const open = this.open;
    const parent = this.parent;
    open.clear();
    parent.clear();

    const encode = (dt: number, cell: number, mode: number) => (dt * cells + cell) * MODES + mode;
    const rootId = encode(0, start.cell, startMode(start));
    parent.set(rootId, -1);
    open.push(rootId, h ? (h[start.cell] as number) : 0, 0);
    let expansions = 0;
    const maxDt = Math.min(this.limits.maxSteps, table.lastStep - 1 - start.step);

    while (open.size > 0) {
      const id = open.pop();
      expansions++;
      const mode = id % MODES;
      const rest = (id - mode) / MODES;
      const cell = rest % cells;
      const dt = (rest - cell) / cells;
      const step = start.step + dt;

      if (this.isGoal(robot, cell, step, goal)) {
        this.stats.plans++;
        this.stats.expansions += expansions;
        return { cells: this.reconstruct(id, dt, cells), startStep: start.step, expansions };
      }
      if (expansions >= this.limits.maxExpansions) break;
      if (dt >= maxDt) continue;

      const next = step + 1;
      // Wait in place.
      if (table.canOccupy(cell, next, robot)) {
        const nid = encode(dt + 1, cell, waitMode(mode));
        if (!parent.has(nid)) {
          parent.set(nid, id);
          open.push(nid, dt + 1 + (h ? (h[cell] as number) : 0), dt + 1);
        }
      }
      // Move to a neighbor.
      for (let d = 0; d < 4; d++) {
        if (!moveAllowed(mode, d)) continue;
        const n = grid.neighbor(cell, d);
        if (n < 0 || grid.blocked[n]) continue;
        const hn = h ? (h[n] as number) : 0;
        if (hn >= 1 << 29) continue;
        if (!table.canOccupy(n, next, robot)) continue;
        const nid = encode(dt + 1, n, d);
        if (parent.has(nid)) continue;
        parent.set(nid, id);
        open.push(nid, dt + 1 + hn, dt + 1);
      }
    }
    this.stats.expansions += expansions;
    return this.fail();
  }

  /** Writes `plan` into the table: reservations for every step and a hold on the last cell. */
  commit(robot: number, plan: Plan): void {
    this.table.release(robot, plan.startStep);
    plan.cells.forEach((cell, i) => this.table.reserve(cell, plan.startStep + i, robot));
    this.table.hold(
      plan.cells[plan.cells.length - 1] as number,
      plan.startStep + plan.cells.length - 1,
      robot,
    );
  }

  private isGoal(robot: number, cell: number, step: number, goal: PlanGoal): boolean {
    if (goal.cell >= 0) {
      if (cell !== goal.cell) return false;
    } else if (!this.grid.holdable[cell] || goal.avoid?.has(cell)) {
      return false;
    }
    return this.table.canHoldFrom(cell, step, robot);
  }

  private reconstruct(id: number, dt: number, cells: number): number[] {
    const out = new Array<number>(dt + 1);
    let cur = id;
    for (let i = dt; i >= 0; i--) {
      const rest = (cur - (cur % MODES)) / MODES;
      out[i] = rest % cells;
      cur = this.parent.get(cur) as number;
    }
    return out;
  }

  private fail(): null {
    this.stats.failures++;
    return null;
  }
}

/**
 * Checks that a cell sequence respects the motion rules (adjacent moves only,
 * no reversal in motion, waits before turning from a stop). Used by tests.
 */
export function validatePlanMotion(
  grid: FloorGrid,
  cells: readonly number[],
  start: PlanStart,
): string | null {
  let mode = startMode(start);
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1] as number;
    const b = cells[i] as number;
    if (a === b) {
      mode = waitMode(mode);
      continue;
    }
    let dir = -1;
    for (let d = 0; d < 4; d++) if (grid.neighbor(a, d) === b) dir = d;
    if (dir < 0) return `step ${i}: cells ${a} and ${b} are not adjacent`;
    if (grid.blocked[b]) return `step ${i}: cell ${b} is blocked`;
    if (!moveAllowed(mode, dir)) return `step ${i}: move ${dir} not allowed from mode ${mode}`;
    mode = dir;
  }
  return null;
}
