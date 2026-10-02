/**
 * Space-time reservation table for cooperative path planning.
 *
 * Time is counted in planner steps (one step = one cell move). A robot that
 * plans a path reserves (cell, step) for every step of it, and at the end of
 * the path it *holds* its last cell from the arrival step on, with no end:
 * the cell stays its own until the robot plans again. That rule is what makes
 * a stopped robot safe — nobody can plan through it.
 *
 * Reservations are "1-robust": a robot may only use a cell at step t if no
 * other robot uses it at t-1, t or t+1. This forbids head-on swaps and
 * following too close, and it absorbs the timing error of real motion
 * (acceleration, braking, turning) as long as robots run less than one step
 * behind their plan.
 *
 * Storage is a ring buffer of `horizon` steps × cells, so lookups are O(1) and
 * nothing is allocated while planning.
 */
export class ReservationTable {
  private readonly occ: Int16Array;
  private readonly holdBy: Int16Array;
  private readonly holdFrom: Int32Array;
  private readonly holdCell: Int32Array;
  /** Per robot: keys (step * cellCount + cell) it has reserved, for fast release. */
  private readonly owned: number[][];
  /** Oldest step still stored. */
  private base = 0;

  constructor(
    readonly cellCount: number,
    readonly robotCount: number,
    readonly horizon = 512,
  ) {
    if (robotCount >= 32767) throw new Error('too many robots');
    this.occ = new Int16Array(horizon * cellCount);
    this.holdBy = new Int16Array(cellCount);
    this.holdFrom = new Int32Array(cellCount);
    this.holdCell = new Int32Array(robotCount).fill(-1);
    this.owned = Array.from({ length: robotCount }, () => []);
  }

  /** Last step that can be reserved. */
  get lastStep(): number {
    return this.base + this.horizon - 1;
  }

  get firstStep(): number {
    return this.base;
  }

  /** Moves the window so `step - 1` is the oldest stored step; older slots are wiped for reuse. */
  advanceTo(step: number): void {
    const newBase = step - 1;
    if (newBase <= this.base) return;
    const wipeUntil = Math.min(newBase, this.base + this.horizon);
    for (let s = this.base; s < wipeUntil; s++) {
      const off = (s % this.horizon) * this.cellCount;
      this.occ.fill(0, off, off + this.cellCount);
    }
    this.base = newBase;
  }

  private slot(cell: number, step: number): number {
    return (step % this.horizon) * this.cellCount + cell;
  }

  private inWindow(step: number): boolean {
    return step >= this.base && step <= this.lastStep;
  }

  /** Robot using `cell` at `step` (reservation or hold), or -1. */
  occupant(cell: number, step: number): number {
    const h = this.holdBy[cell] as number;
    if (h !== 0 && step >= (this.holdFrom[cell] as number)) return h - 1;
    if (!this.inWindow(step)) return -1;
    return (this.occ[this.slot(cell, step)] as number) - 1;
  }

  /** True when no robot other than `robot` uses `cell` at `step`. */
  isFree(cell: number, step: number, robot: number): boolean {
    const o = this.occupant(cell, step);
    return o < 0 || o === robot;
  }

  /** 1-robust check: `cell` is free for `robot` at step-1, step and step+1. */
  canOccupy(cell: number, step: number, robot: number): boolean {
    if (step + 1 > this.lastStep) return false;
    return (
      this.isFree(cell, step - 1, robot) &&
      this.isFree(cell, step, robot) &&
      this.isFree(cell, step + 1, robot)
    );
  }

  /** `robot` could stay on `cell` from `step` on, forever (no later reservation or hold by others). */
  canHoldFrom(cell: number, step: number, robot: number): boolean {
    const h = this.holdBy[cell] as number;
    if (h !== 0 && h !== robot + 1) return false;
    const from = Math.max(this.base, step - 1);
    for (let s = from; s <= this.lastStep; s++) {
      const o = this.occ[this.slot(cell, s)] as number;
      if (o !== 0 && o !== robot + 1) return false;
    }
    return true;
  }

  reserve(cell: number, step: number, robot: number): void {
    if (!this.inWindow(step)) throw new Error(`step ${step} outside the reservation window`);
    const i = this.slot(cell, step);
    const o = this.occ[i] as number;
    if (o === robot + 1) return;
    if (o !== 0) throw new Error(`cell ${cell} at step ${step} already reserved by robot ${o - 1}`);
    this.occ[i] = robot + 1;
    (this.owned[robot] as number[]).push(step * this.cellCount + cell);
  }

  /** `robot` keeps `cell` from `fromStep` on until it releases it. Replaces its previous hold. */
  hold(cell: number, fromStep: number, robot: number): void {
    const h = this.holdBy[cell] as number;
    if (h !== 0 && h !== robot + 1) throw new Error(`cell ${cell} already held by robot ${h - 1}`);
    this.dropHold(robot);
    this.holdBy[cell] = robot + 1;
    this.holdFrom[cell] = fromStep;
    this.holdCell[robot] = cell;
  }

  holdOf(robot: number): { cell: number; from: number } | null {
    const cell = this.holdCell[robot] as number;
    return cell < 0 ? null : { cell, from: this.holdFrom[cell] as number };
  }

  /** Removes every reservation of `robot` after `afterStep`, and its hold. */
  release(robot: number, afterStep: number): void {
    this.dropHold(robot);
    const keys = this.owned[robot] as number[];
    const kept: number[] = [];
    for (const key of keys) {
      const step = Math.floor(key / this.cellCount);
      if (step < this.base) continue; // already wiped
      const cell = key - step * this.cellCount;
      if (step <= afterStep) {
        kept.push(key);
        continue;
      }
      const i = this.slot(cell, step);
      if (this.occ[i] === robot + 1) this.occ[i] = 0;
    }
    this.owned[robot] = kept;
  }

  /**
   * Robots other than `robot` whose reservations make it impossible for
   * `robot` to hold `cell` from `fromStep` (they would have to replan).
   */
  conflictsWithHold(cell: number, fromStep: number, robot: number): number[] {
    const out = new Set<number>();
    const from = Math.max(this.base, fromStep - 1);
    for (let s = from; s <= this.lastStep; s++) {
      const o = (this.occ[this.slot(cell, s)] as number) - 1;
      if (o >= 0 && o !== robot) out.add(o);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Robot holding `cell` (forever), or -1. */
  holder(cell: number): number {
    return (this.holdBy[cell] as number) - 1;
  }

  private dropHold(robot: number): void {
    const cell = this.holdCell[robot] as number;
    if (cell < 0) return;
    if (this.holdBy[cell] === robot + 1) this.holdBy[cell] = 0;
    this.holdCell[robot] = -1;
  }
}
