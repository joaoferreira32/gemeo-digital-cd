import type { WarehouseLayout } from '../sim/layout';

/**
 * Render-side placement of things the simulation only counts: where the
 * inbound backlog and the dock staging piles are drawn. The simulation knows
 * how many packets are in each pile; this file decides where each slot sits.
 */

/** Height of the belt surface above the floor, in meters. */
export const BELT_TOP = 0.78;
export const WALL_HEIGHT = 1.1;
export const ROOF_Y = 10.5;

export interface PileArea {
  /** Corner of slot (0, 0, 0) — slot centers start half a cell inside. */
  readonly x0: number;
  readonly z0: number;
  /** Direction the rows grow along z (+1 or -1). */
  readonly zDir: 1 | -1;
  readonly cols: number;
  readonly rows: number;
  readonly layers: number;
  readonly cell: number;
  readonly layerHeight: number;
  /** Floor height of the first layer (pallets raise it). */
  readonly baseY: number;
}

export function pileCapacity(a: PileArea): number {
  return a.cols * a.rows * a.layers;
}

/**
 * Center of slot `i`. Slots fill a whole layer before stacking the next one,
 * starting at the corner closest to the conveyor, so a pile grows outward and
 * then upward as the count rises.
 */
export function pileSlot(a: PileArea, i: number, out: { x: number; y: number; z: number }) {
  const perLayer = a.cols * a.rows;
  const layer = Math.floor(i / perLayer);
  const r = i - layer * perLayer;
  const row = Math.floor(r / a.cols);
  const col = r - row * a.cols;
  out.x = a.x0 + (col + 0.5) * a.cell;
  out.z = a.z0 + a.zDir * (row + 0.5) * a.cell;
  out.y = a.baseY + layer * a.layerHeight;
  return out;
}

const CELL = 0.56;

/** Backlog pile beside each inbound induction point, on the outer side of the line. */
export function inboundPile(layout: WarehouseLayout, inboundIndex: number): PileArea {
  const node = layout.graph.node(layout.inboundNodes[inboundIndex] as number);
  const zDir = node.pos.z < 0 ? -1 : 1;
  return {
    x0: layout.bounds.minX + 0.6,
    z0: node.pos.z + zDir * 1.1,
    zDir,
    cols: 12,
    rows: 10,
    layers: 7,
    cell: CELL,
    layerHeight: 0.44,
    baseY: 0.14,
  };
}

/** Staging area between the end of a dock conveyor and the dock door. */
export function stagingPile(layout: WarehouseLayout, dockIndex: number): PileArea {
  const node = layout.graph.node(layout.dockNodes[dockIndex] as number);
  return {
    x0: node.pos.x + 1.4,
    z0: node.pos.z - 2.24,
    zDir: 1,
    cols: 10,
    rows: 8,
    layers: 4,
    cell: CELL,
    layerHeight: 0.44,
    baseY: 0.14,
  };
}
