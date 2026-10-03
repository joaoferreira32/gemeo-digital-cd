import type { Vec2 } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';

export interface RobotPositions {
  readonly count: number;
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
}

/**
 * What a click on the floor at (x, z) points at, from the layout's own
 * geometry (not the meshes): the nearest robot within 0.9 m, else the
 * nearest conveyor within 0.7 m of its center line, else a dock's staging
 * area (1 m of margin). Returns an entity key ("robot:3", "conveyor:7",
 * "dock:2") or null.
 */
export function pickEntity(
  layout: WarehouseLayout,
  robots: RobotPositions,
  x: number,
  z: number,
): string | null {
  let best = -1;
  let bestD = 0.9;
  for (let i = 0; i < robots.count; i++) {
    const d = Math.hypot((robots.x[i] as number) - x, (robots.z[i] as number) - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return `robot:${best}`;

  let edge = -1;
  let edgeD = 0.7;
  for (const e of layout.graph.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const d = segmentDistance(e.points[i - 1] as Vec2, e.points[i] as Vec2, x, z);
      if (d < edgeD) {
        edgeD = d;
        edge = e.id;
      }
    }
  }
  if (edge >= 0) return `conveyor:${edge}`;

  const dock = layout.stagingAreas.findIndex(
    (a) => x >= a.minX - 1 && x <= a.maxX + 1 && z >= a.minZ - 1 && z <= a.maxZ + 1,
  );
  return dock >= 0 ? `dock:${dock}` : null;
}

function segmentDistance(a: Vec2, b: Vec2, x: number, z: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}
