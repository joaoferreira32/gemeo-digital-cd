import { Graph, type Vec2 } from './graph';

/**
 * Default distribution center floor plan (meters, floor plane x/z).
 *
 *   inbound wall (x=-36)                                         dock wall (x=32)
 *                                               D1 ◄─ Q1
 *                                                     │
 *                                               D2 ◄─ Q2
 *                                                     │
 *   IN1 ─► A1 ─► A2 ─► A3 ─► A4 ─► S1 ──────────► D3
 *           │     ▲     │     ▲
 *           ▼     │     ▼     │
 *   IN2 ─► B1 ─► B2 ─► B3 ─► B4 ─► S2 ──────────► D4
 *                                                     │
 *                                               D5 ◄─ R5
 *                                                     │
 *                                               D6 ◄─ R6
 *
 * Two parallel main lines with alternating crossovers give most conveyors an
 * alternative route — the redundancy the optimizer exploits when one fails.
 * A4→S1, B3→B4 and B4→S2 have no conveyor alternative (pinned by a test);
 * B3→B4 also carries the crossover traffic and is the busiest belt by design.
 */
export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** A row of pallet racking, 1 m deep, centered on `z`, from `x0` to `x1`. */
export interface RackRow {
  readonly x0: number;
  readonly x1: number;
  readonly z: number;
}

export interface WarehouseLayout {
  readonly graph: Graph;
  readonly inboundNodes: readonly number[];
  readonly dockNodes: readonly number[];
  readonly bounds: Rect;
  readonly racks: readonly RackRow[];
  /** Floor area of each inbound backlog pile (same order as inboundNodes). */
  readonly inboundAreas: readonly Rect[];
  /** Floor area of each dock staging pile (same order as dockNodes). */
  readonly stagingAreas: readonly Rect[];
  /**
   * Cells where robots may pass under a conveyor (the belt is raised over a
   * marked passage). Everywhere else a conveyor is a wall for the robots.
   */
  readonly gates: readonly Vec2[];
}

export function createDefaultLayout(): WarehouseLayout {
  const g = new Graph();
  const LINE_A_Z = -3;
  const LINE_B_Z = 3;
  const SORTER_X = 12;
  const DOCK_X = 24;

  const in1 = g.addNode('Entrada 1', 'inbound', -28, LINE_A_Z);
  const in2 = g.addNode('Entrada 2', 'inbound', -28, LINE_B_Z);
  const columns = [-20, -10, 0, 6];
  const a = columns.map((x, i) => g.addNode(`A${i + 1}`, 'junction', x, LINE_A_Z));
  const b = columns.map((x, i) => g.addNode(`B${i + 1}`, 'junction', x, LINE_B_Z));
  const s1 = g.addNode('S1', 'junction', SORTER_X, LINE_A_Z);
  const s2 = g.addNode('S2', 'junction', SORTER_X, LINE_B_Z);
  const q2 = g.addNode('Q2', 'junction', SORTER_X, -9);
  const q1 = g.addNode('Q1', 'junction', SORTER_X, -15);
  const r5 = g.addNode('R5', 'junction', SORTER_X, 9);
  const r6 = g.addNode('R6', 'junction', SORTER_X, 15);
  const dockZ = [-15, -9, -3, 3, 9, 15];
  const docks = dockZ.map((z, i) => g.addNode(`Doca ${i + 1}`, 'dock', DOCK_X, z));

  let n = 0;
  const conveyor = (from: number, to: number) => g.addEdge(from, to, `Esteira ${++n}`);
  const chain = (nodes: readonly number[]) => {
    for (let i = 1; i < nodes.length; i++) conveyor(nodes[i - 1] as number, nodes[i] as number);
  };

  chain([in1, ...a, s1]);
  chain([in2, ...b, s2]);
  // Alternating crossovers: A→B at columns 1 and 3, B→A at columns 2 and 4.
  conveyor(a[0] as number, b[0] as number);
  conveyor(b[1] as number, a[1] as number);
  conveyor(a[2] as number, b[2] as number);
  conveyor(b[3] as number, a[3] as number);
  // Sorter spines and dock feeders.
  chain([s1, q2, q1]);
  chain([s2, r5, r6]);
  conveyor(q1, docks[0] as number);
  conveyor(q2, docks[1] as number);
  conveyor(s1, docks[2] as number);
  conveyor(s2, docks[3] as number);
  conveyor(r5, docks[4] as number);
  conveyor(r6, docks[5] as number);

  // Racks are aligned to the 1 m robot grid: back-to-back pairs on rows 9/10
  // and 13/14, a single row on 17 (mirrored north/south); aisles in between.
  const racks: RackRow[] = [];
  for (const sign of [-1, 1]) {
    for (const z of [9, 10, 13, 14, 17]) racks.push({ x0: -26, x1: 2, z: sign * z });
  }

  // Pile footprints: 0.56 m slots, see render/floorplan.ts.
  const SLOT = 0.56;
  const inboundAreas = [in1, in2].map((id) => {
    const z = g.node(id).pos.z;
    const near = z + Math.sign(z) * 1.1;
    const far = near + Math.sign(z) * 10 * SLOT;
    return {
      minX: -35.4,
      maxX: -35.4 + 12 * SLOT,
      minZ: Math.min(near, far),
      maxZ: Math.max(near, far),
    };
  });
  const stagingAreas = dockZ.map((z) => ({
    minX: DOCK_X + 1.4,
    maxX: DOCK_X + 1.4 + 10 * SLOT,
    minZ: z - 4 * SLOT,
    maxZ: z + 4 * SLOT,
  }));

  // Passages under the conveyors: two through each main line near the sorter
  // (into the middle corridor) and one through each sorter spine segment
  // (into the dock strips).
  const gates: Vec2[] = [
    { x: 8, z: LINE_A_Z },
    { x: 10, z: LINE_A_Z },
    { x: 8, z: LINE_B_Z },
    { x: 10, z: LINE_B_Z },
    { x: SORTER_X, z: -6 },
    { x: SORTER_X, z: -12 },
    { x: SORTER_X, z: 6 },
    { x: SORTER_X, z: 12 },
  ];

  return {
    graph: g,
    inboundNodes: [in1, in2],
    dockNodes: docks,
    bounds: { minX: -36, maxX: 32, minZ: -20, maxZ: 20 },
    racks,
    inboundAreas,
    stagingAreas,
    gates,
  };
}
