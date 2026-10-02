import { describe, expect, it } from 'vitest';
import { ReservationTable } from '../src/sim/reservations';

const CELLS = 100;

describe('ReservationTable', () => {
  it('reports who uses a cell at a step', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.reserve(5, 10, 2);
    expect(t.occupant(5, 10)).toBe(2);
    expect(t.occupant(5, 11)).toBe(-1);
    expect(t.isFree(5, 10, 2)).toBe(true);
    expect(t.isFree(5, 10, 1)).toBe(false);
  });

  it('is 1-robust: another robot may not use the cell one step before or after', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.reserve(7, 10, 0);
    expect(t.canOccupy(7, 9, 1)).toBe(false);
    expect(t.canOccupy(7, 10, 1)).toBe(false);
    expect(t.canOccupy(7, 11, 1)).toBe(false);
    expect(t.canOccupy(7, 8, 1)).toBe(true);
    expect(t.canOccupy(7, 12, 1)).toBe(true);
    // The owner itself is never blocked by its own reservation.
    expect(t.canOccupy(7, 10, 0)).toBe(true);
  });

  it('holds a cell forever from a step on', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.hold(3, 20, 0);
    expect(t.canOccupy(3, 18, 1)).toBe(true);
    expect(t.canOccupy(3, 19, 1)).toBe(false); // robust: one step before the hold
    expect(t.canOccupy(3, 1000, 1)).toBe(false);
    expect(t.canHoldFrom(3, 5, 1)).toBe(false);
    expect(t.holder(3)).toBe(0);
    expect(t.holdOf(0)).toEqual({ cell: 3, from: 20 });
    // A new hold replaces the old one.
    t.hold(4, 25, 0);
    expect(t.holder(3)).toBe(-1);
    expect(t.holdOf(0)).toEqual({ cell: 4, from: 25 });
  });

  it('only lets a robot hold a cell nobody needs later', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.reserve(9, 40, 1);
    expect(t.canHoldFrom(9, 10, 0)).toBe(false);
    expect(t.conflictsWithHold(9, 10, 0)).toEqual([1]);
    expect(t.canHoldFrom(9, 42, 0)).toBe(true); // the other robot is gone by then
    t.release(1, 0);
    expect(t.canHoldFrom(9, 10, 0)).toBe(true);
    expect(t.conflictsWithHold(9, 10, 0)).toEqual([]);
  });

  it('releases only the reservations after the given step', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    for (let s = 10; s <= 20; s++) t.reserve(s, s, 0);
    t.hold(21, 21, 0);
    t.release(0, 14);
    expect(t.occupant(14, 14)).toBe(0);
    expect(t.occupant(15, 15)).toBe(-1);
    expect(t.holder(21)).toBe(-1);
  });

  it('refuses to double-book a cell', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.reserve(1, 5, 0);
    expect(() => t.reserve(1, 5, 1)).toThrow();
    t.hold(2, 5, 0);
    expect(() => t.hold(2, 9, 1)).toThrow();
  });

  it('forgets past steps and reuses the ring slots without ghosts', () => {
    const t = new ReservationTable(CELLS, 4, 64);
    t.reserve(8, 5, 0);
    t.advanceTo(100);
    expect(t.firstStep).toBe(99);
    // Step 5 + 64k maps to the same slot; it must read as free now.
    expect(t.occupant(8, 5 + 64)).toBe(-1);
    expect(t.canOccupy(8, 133, 1)).toBe(true);
    // Stale keys are dropped on release instead of clearing someone else's slot.
    t.reserve(8, 133, 1);
    t.release(0, -1);
    expect(t.occupant(8, 133)).toBe(1);
  });

  it('never reserves beyond the horizon', () => {
    const t = new ReservationTable(CELLS, 2, 16);
    expect(t.lastStep).toBe(15);
    expect(t.canOccupy(1, 15, 0)).toBe(false); // needs step + 1 inside the window
    expect(() => t.reserve(1, 16, 0)).toThrow();
  });
});
