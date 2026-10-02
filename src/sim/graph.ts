/**
 * Directed graph of the warehouse floor. Nodes are transfer points (inbound
 * induction, junctions, docks); edges are conveyors laid out as polylines on
 * the floor plane (x, z), in meters.
 */

export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

export type NodeKind = 'inbound' | 'junction' | 'dock';

export interface GraphNode {
  readonly id: number;
  readonly name: string;
  readonly kind: NodeKind;
  readonly pos: Vec2;
  readonly outEdges: number[];
  readonly inEdges: number[];
}

export interface GraphEdge {
  readonly id: number;
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** Polyline from the `from` node to the `to` node, inclusive. */
  readonly points: readonly Vec2[];
  /** Arc length at the start of each segment; `segmentStarts[i]` belongs to points[i]. */
  readonly segmentStarts: readonly number[];
  readonly length: number;
}

export class Graph {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];

  addNode(name: string, kind: NodeKind, x: number, z: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, name, kind, pos: { x, z }, outEdges: [], inEdges: [] });
    return id;
  }

  /** Adds a conveyor from `from` to `to`, optionally bending through `via` points. */
  addEdge(from: number, to: number, name: string, via: readonly Vec2[] = []): number {
    const a = this.node(from);
    const b = this.node(to);
    const points = [a.pos, ...via, b.pos];
    const segmentStarts: number[] = [0];
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1] as Vec2;
      const q = points[i] as Vec2;
      length += Math.hypot(q.x - p.x, q.z - p.z);
      segmentStarts.push(length);
    }
    if (length <= 0) throw new Error(`Edge ${name} has zero length`);
    const id = this.edges.length;
    this.edges.push({ id, name, from, to, points, segmentStarts, length });
    a.outEdges.push(id);
    b.inEdges.push(id);
    return id;
  }

  node(id: number): GraphNode {
    const n = this.nodes[id];
    if (!n) throw new Error(`Unknown node ${id}`);
    return n;
  }

  edge(id: number): GraphEdge {
    const e = this.edges[id];
    if (!e) throw new Error(`Unknown edge ${id}`);
    return e;
  }
}

export interface EdgePoint {
  x: number;
  z: number;
  /** Direction of travel, radians, measured from +x toward +z. */
  heading: number;
}

/** Position at arc length `s` along the edge (clamped), written into `out` to avoid allocation. */
export function pointOnEdge(edge: GraphEdge, s: number, out: EdgePoint): EdgePoint {
  const pts = edge.points;
  const starts = edge.segmentStarts;
  const clamped = s <= 0 ? 0 : s >= edge.length ? edge.length : s;
  let i = 1;
  while (i < pts.length - 1 && (starts[i] as number) < clamped) i++;
  const p = pts[i - 1] as Vec2;
  const q = pts[i] as Vec2;
  const segStart = starts[i - 1] as number;
  const segLen = (starts[i] as number) - segStart;
  const t = segLen > 0 ? (clamped - segStart) / segLen : 0;
  out.x = p.x + (q.x - p.x) * t;
  out.z = p.z + (q.z - p.z) * t;
  out.heading = Math.atan2(q.z - p.z, q.x - p.x);
  return out;
}

export interface PathTree {
  /** Cost from each node to the target (Infinity when unreachable). */
  readonly dist: Float64Array;
  /** Edge to take from each node toward the target (-1 when none). */
  readonly next: Int32Array;
}

/**
 * Shortest-path tree toward `target` (reverse Dijkstra). `weight` returns the
 * cost of an edge; Infinity marks it unusable. Ties are broken by the lowest
 * node id, so the result is deterministic.
 */
export function shortestPathTree(
  graph: Graph,
  target: number,
  weight: (edge: GraphEdge) => number,
): PathTree {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const next = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[target] = 0;
  // The graph has a few dozen nodes: an O(n^2) scan beats a heap here.
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && (dist[i] as number) < best) {
        best = dist[i] as number;
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = 1;
    for (const eid of graph.node(u).inEdges) {
      const e = graph.edge(eid);
      const w = weight(e);
      if (!Number.isFinite(w)) continue;
      const nd = best + w;
      if (nd < (dist[e.from] as number)) {
        dist[e.from] = nd;
        next[e.from] = eid;
      }
    }
  }
  return { dist, next };
}
