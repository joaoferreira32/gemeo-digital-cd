import { describe, expect, it } from 'vitest';
import { createFloorGrid, DX, DZ, UNREACHABLE, type FloorGrid } from '../src/sim/floor';
import { createDefaultLayout } from '../src/sim/layout';

const layout = createDefaultLayout();
const grid = createFloorGrid(layout);

/** Cells reachable from `start`, optionally treating gates as walls. */
function reachable(g: FloorGrid, start: number, withGates = true): Uint8Array {
  const seen = new Uint8Array(g.cellCount);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const cell = stack.pop() as number;
    for (let d = 0; d < 4; d++) {
      const n = g.neighbor(cell, d);
      if (n < 0 || seen[n] || g.blocked[n] || (!withGates && g.gate[n])) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

describe('FloorGrid', () => {
  it('covers the building interior with 1 m cells centered on integers', () => {
    expect(grid.cols).toBe(67);
    expect(grid.rows).toBe(39);
    expect(grid.x(grid.cellOf(-35, -19))).toBe(-35);
    expect(grid.z(grid.cellOf(31, 19))).toBe(19);
    expect(grid.cellOf(32, 0)).toBe(-1);
  });

  it('turns conveyors into walls except at the gates', () => {
    expect(grid.passable(grid.cellOf(-15, -3))).toBe(false); // line A
    expect(grid.passable(grid.cellOf(12, -10))).toBe(false); // spine
    expect(grid.passable(grid.cellOf(18, 9))).toBe(false); // dock 5 feeder
    for (const g of layout.gates) {
      const cell = grid.cellOf(g.x, g.z);
      expect(grid.passable(cell)).toBe(true);
      expect(grid.gate[cell]).toBe(1);
      expect(grid.holdable[cell]).toBe(0);
    }
  });

  it('blocks racks and piles but leaves the aisles free', () => {
    expect(grid.passable(grid.cellOf(-10, 9))).toBe(false);
    expect(grid.passable(grid.cellOf(-10, 11))).toBe(true);
    expect(grid.passable(grid.cellOf(-10, 12))).toBe(true);
    expect(grid.passable(grid.cellOf(-30, -6))).toBe(false); // inbound pile
    expect(grid.passable(grid.cellOf(28, 9))).toBe(false); // staging
  });

  it('creates every station on free floor', () => {
    const count = (kind: string) => grid.stations.filter((s) => s.kind === kind).length;
    expect(count('rack')).toBe(50);
    expect(count('dock')).toBe(12);
    expect(count('bypass')).toBe(5);
    expect(count('charger')).toBe(8);
    expect(count('parking')).toBe(64);
    for (const s of grid.stations) {
      expect(grid.passable(s.cell)).toBe(true);
      expect(grid.gate[s.cell]).toBe(0);
      const target = grid.cellOf(s.x + (DX[s.face] as number), s.z + (DZ[s.face] as number));
      if (s.kind === 'parking') {
        // Parked robots face the aisle they leave through: free floor, not another slot.
        expect(grid.passable(target)).toBe(true);
        expect(grid.stationAt[target]).toBe(-1);
      } else {
        // Everything else faces what it serves: rack, pile, conveyor node or wall.
        expect(target < 0 || !grid.passable(target)).toBe(true);
      }
    }
  });

  it('connects every station to every other through the gates', () => {
    const fromDepot = reachable(
      grid,
      (grid.stations.find((s) => s.kind === 'parking') ?? grid.stations[0]!).cell,
    );
    for (const s of grid.stations) expect(fromDepot[s.cell], s.label).toBe(1);
  });

  it('needs the gates: without them most docks are cut off from the depot', () => {
    const depot = grid.stations.find((s) => s.kind === 'parking')!.cell;
    const noGates = reachable(grid, depot, false);
    const docksCut = grid.stations.filter((s) => s.kind === 'dock' && !noGates[s.cell]);
    expect(docksCut.length).toBeGreaterThanOrEqual(8);
  });

  it('marks only wide open floor as holdable', () => {
    let holdable = 0;
    for (let cell = 0; cell < grid.cellCount; cell++) {
      if (!grid.holdable[cell]) continue;
      holdable++;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          expect(grid.passable(grid.cellOf(grid.x(cell) + dx, grid.z(cell) + dz))).toBe(true);
        }
      }
    }
    expect(holdable).toBeGreaterThan(200);
    // The 2-wide rack aisles are never holdable.
    expect(grid.holdable[grid.cellOf(-10, 11)]).toBe(0);
  });

  it('computes BFS distances that respect walls and gates', () => {
    const goal = grid.stations.find((s) => s.label === 'Desvio S1')!.cell;
    const dist = grid.distanceMap(goal);
    expect(dist[goal]).toBe(0);
    // From the A4 bypass station the robot must go through a line gate: > straight-line distance.
    const a4 = grid.stations.find((s) => s.label === 'Desvio A4')!.cell;
    expect(dist[a4]).toBeGreaterThan(6);
    expect(dist[a4]).toBeLessThan(UNREACHABLE);
    expect(grid.distanceMap(goal)).toBe(dist); // cached
  });
});
