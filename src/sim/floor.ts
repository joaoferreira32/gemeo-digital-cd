import type { Vec2 } from './graph';
import type { Rect, WarehouseLayout } from './layout';

/**
 * The robots' floor: a 1 m grid whose cell centers sit on integer
 * coordinates, so conveyor center lines (also on integers) cover exactly one
 * row or column of cells. Conveyors, racks and piles are walls; robots cross a
 * conveyor only through a gate (a raised passage).
 */

/** Directions: 0 = +x (east), 1 = +z (south), 2 = -x (west), 3 = -z (north). */
export const DX = [1, 0, -1, 0] as const;
export const DZ = [0, 1, 0, -1] as const;
export const opposite = (d: number) => (d + 2) & 3;

export type StationKind = 'rack' | 'dock' | 'bypass' | 'charger' | 'parking';

export interface Station {
  readonly id: number;
  readonly kind: StationKind;
  readonly cell: number;
  readonly x: number;
  readonly z: number;
  /** Direction from the station cell toward what it serves (rack, staging, conveyor node, wall). */
  readonly face: number;
  /** Dock index for 'dock', graph node id for 'bypass', -1 otherwise. */
  readonly ref: number;
  readonly label: string;
}

/** Conveyor frames are 1 m wide; the transfer turntables have this radius. */
const NODE_RADIUS = 0.48;
const EPS = 0.02;

export class FloorGrid {
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellCount: number;
  /** 1 = static obstacle. */
  readonly blocked: Uint8Array;
  /** 1 = passage under a conveyor. */
  readonly gate: Uint8Array;
  /**
   * 1 = a robot may stand still here without risking to cut a corridor: every
   * one of its 8 neighbors is free floor and it is not a depot aisle.
   */
  readonly holdable: Uint8Array;
  readonly stations: Station[] = [];
  /** Station id at each cell, or -1. */
  readonly stationAt: Int32Array;
  private readonly distanceCache = new Map<number, Int32Array>();

  constructor(bounds: Rect) {
    // Interior cells only: the walls sit on the bounds.
    this.minX = Math.ceil(bounds.minX + 0.5);
    this.minZ = Math.ceil(bounds.minZ + 0.5);
    this.cols = Math.floor(bounds.maxX - 0.5) - this.minX + 1;
    this.rows = Math.floor(bounds.maxZ - 0.5) - this.minZ + 1;
    this.cellCount = this.cols * this.rows;
    this.blocked = new Uint8Array(this.cellCount);
    this.gate = new Uint8Array(this.cellCount);
    this.holdable = new Uint8Array(this.cellCount);
    this.stationAt = new Int32Array(this.cellCount).fill(-1);
  }

  cellOf(x: number, z: number): number {
    const c = Math.round(x) - this.minX;
    const r = Math.round(z) - this.minZ;
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  x(cell: number): number {
    return (cell % this.cols) + this.minX;
  }

  z(cell: number): number {
    return Math.floor(cell / this.cols) + this.minZ;
  }

  /** Neighbor cell in direction `d`, or -1 outside the grid. */
  neighbor(cell: number, d: number): number {
    const c = (cell % this.cols) + (DX[d] as number);
    const r = Math.floor(cell / this.cols) + (DZ[d] as number);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  passable(cell: number): boolean {
    return cell >= 0 && this.blocked[cell] === 0;
  }

  /** Marks every cell whose square overlaps the rectangle (touching edges do not count). */
  blockRect(minX: number, maxX: number, minZ: number, maxZ: number): void {
    for (let r = 0; r < this.rows; r++) {
      const z = r + this.minZ;
      if (z + 0.5 <= minZ + EPS || z - 0.5 >= maxZ - EPS) continue;
      for (let c = 0; c < this.cols; c++) {
        const x = c + this.minX;
        if (x + 0.5 <= minX + EPS || x - 0.5 >= maxX - EPS) continue;
        this.blocked[r * this.cols + c] = 1;
      }
    }
  }

  /**
   * Shortest number of moves from every cell to `goal` on the static grid
   * (breadth-first search). Used as the A* heuristic; cached per goal.
   */
  distanceMap(goal: number): Int32Array {
    const cached = this.distanceCache.get(goal);
    if (cached) return cached;
    const dist = new Int32Array(this.cellCount).fill(UNREACHABLE);
    const queue = new Int32Array(this.cellCount);
    let head = 0;
    let tail = 0;
    dist[goal] = 0;
    queue[tail++] = goal;
    while (head < tail) {
      const cell = queue[head++] as number;
      const d = (dist[cell] as number) + 1;
      for (let k = 0; k < 4; k++) {
        const n = this.neighbor(cell, k);
        if (n < 0 || this.blocked[n] || (dist[n] as number) <= d) continue;
        dist[n] = d;
        queue[tail++] = n;
      }
    }
    this.distanceCache.set(goal, dist);
    return dist;
  }

  addStation(
    kind: StationKind,
    x: number,
    z: number,
    face: number,
    ref: number,
    label: string,
  ): Station {
    const cell = this.cellOf(x, z);
    if (cell < 0 || this.blocked[cell]) throw new Error(`Station ${label} on a blocked cell`);
    if ((this.stationAt[cell] as number) >= 0) throw new Error(`Two stations on cell (${x}, ${z})`);
    const station: Station = { id: this.stations.length, kind, cell, x, z, face, ref, label };
    this.stations.push(station);
    this.stationAt[cell] = station.id;
    return station;
  }
}

export const UNREACHABLE = 1 << 29;

/** Depot pockets (parking and chargers) at the west end of the rack zones. */
const DEPOT = { minX: -35, maxX: -27, nearZ: 11, farZ: 19 };

export function createFloorGrid(layout: WarehouseLayout): FloorGrid {
  const grid = new FloorGrid(layout.bounds);
  const { graph } = layout;

  // Conveyors: every segment is a 1 m wide wall; turntables at the nodes.
  for (const e of graph.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1] as Vec2;
      const b = e.points[i] as Vec2;
      grid.blockRect(
        Math.min(a.x, b.x) - 0.5,
        Math.max(a.x, b.x) + 0.5,
        Math.min(a.z, b.z) - 0.5,
        Math.max(a.z, b.z) + 0.5,
      );
    }
  }
  for (const n of graph.nodes) {
    grid.blockRect(
      n.pos.x - NODE_RADIUS,
      n.pos.x + NODE_RADIUS,
      n.pos.z - NODE_RADIUS,
      n.pos.z + NODE_RADIUS,
    );
  }
  for (const r of layout.racks) grid.blockRect(r.x0 - 0.1, r.x1 + 0.1, r.z - 0.5, r.z + 0.5);
  // Piles include the painted outline (0.15 m) around the slots.
  for (const a of [...layout.inboundAreas, ...layout.stagingAreas]) {
    grid.blockRect(a.minX - 0.15, a.maxX + 0.15, a.minZ - 0.15, a.maxZ + 0.15);
  }
  for (const g of layout.gates) {
    const cell = grid.cellOf(g.x, g.z);
    if (cell < 0) throw new Error(`Gate (${g.x}, ${g.z}) outside the floor`);
    grid.blocked[cell] = 0;
    grid.gate[cell] = 1;
  }

  addStations(grid, layout);
  computeHoldable(grid);
  return grid;
}

function addStations(grid: FloorGrid, layout: WarehouseLayout): void {
  const { graph } = layout;
  const N = 3;
  const S = 1;
  const E = 0;

  // Rack faces: aisle cells next to a rack row, staggered so that two robots
  // picking at the same time never close a 2-wide aisle at the same x.
  const faceRows: { z: number; xs: number[]; toward: number }[] = [
    { z: 8, xs: [-24, -18, -12, -6, 0], toward: 9 },
    { z: 11, xs: [-25, -19, -13, -7, -1], toward: 10 },
    { z: 12, xs: [-22, -16, -10, -4, 2], toward: 13 },
    { z: 15, xs: [-25, -19, -13, -7, -1], toward: 14 },
    { z: 16, xs: [-22, -16, -10, -4, 2], toward: 17 },
  ];
  let rackNo = 0;
  for (const sign of [-1, 1]) {
    for (const row of faceRows) {
      const z = sign * row.z;
      const face = sign * row.toward > z ? S : N;
      for (const x of row.xs) grid.addStation('rack', x, z, face, -1, `Rack ${++rackNo}`);
    }
  }

  // Dock drops: the cells beside each staging pile, one on each side of the feeder.
  layout.dockNodes.forEach((nodeId, i) => {
    const { x, z } = graph.node(nodeId).pos;
    grid.addStation('dock', x, z - 1, E, i, `Doca ${i + 1}`);
    grid.addStation('dock', x, z + 1, E, i, `Doca ${i + 1}`);
  });

  // Bypass stations next to the nodes at both ends of the single points of failure.
  for (const name of ['A4', 'S1', 'B3', 'B4', 'S2']) {
    const node = graph.nodes.find((n) => n.name === name);
    if (!node) throw new Error(`Node ${name} missing`);
    const cell = grid.cellOf(node.pos.x, node.pos.z);
    let placed = false;
    for (let d = 0; d < 4 && !placed; d++) {
      const n = grid.neighbor(cell, d);
      if (!grid.passable(n) || grid.gate[n]) continue;
      grid.addStation('bypass', grid.x(n), grid.z(n), opposite(d), node.id, `Desvio ${name}`);
      placed = true;
    }
    if (!placed) throw new Error(`No free cell next to ${name}`);
  }

  // Depots (one per rack zone): chargers on the outer row, parking rows
  // reached from aisles at z = 11, 14, 17 and 18 and the column x = -27.
  let chargerNo = 0;
  let slotNo = 0;
  for (const sign of [-1, 1]) {
    for (const x of [-34, -32, -30, -28]) {
      grid.addStation(
        'charger',
        x,
        sign * DEPOT.farZ,
        sign > 0 ? S : N,
        -1,
        `Carregador ${++chargerNo}`,
      );
    }
    for (const row of [12, 13, 15, 16]) {
      // Face the aisle the slot is reached from, so a robot leaves straight ahead.
      const aisle = row === 12 || row === 15 ? row - 1 : row + 1;
      const face = sign * aisle > sign * row ? S : N;
      for (let x = DEPOT.minX; x < DEPOT.maxX; x++) {
        grid.addStation('parking', x, sign * row, face, -1, `Vaga ${++slotNo}`);
      }
    }
  }
}

function computeHoldable(grid: FloorGrid): void {
  for (let cell = 0; cell < grid.cellCount; cell++) {
    if (grid.blocked[cell] || grid.gate[cell]) continue;
    const x = grid.x(cell);
    const z = grid.z(cell);
    const inDepot =
      x >= DEPOT.minX && x <= DEPOT.maxX && Math.abs(z) >= DEPOT.nearZ && Math.abs(z) <= DEPOT.farZ;
    if (inDepot) continue;
    let open = true;
    for (let dz = -1; dz <= 1 && open; dz++) {
      for (let dx = -1; dx <= 1 && open; dx++) {
        const n = grid.cellOf(x + dx, z + dz);
        if (n < 0 || grid.blocked[n] || grid.gate[n]) open = false;
      }
    }
    if (open) grid.holdable[cell] = 1;
  }
}
