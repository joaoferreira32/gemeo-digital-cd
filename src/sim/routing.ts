import { shortestPathTree, type Graph } from './graph';
import type { Packet } from './packet';
import type { Router } from './router';
import type { StateReader, StateWriter } from './state';

/**
 * A routing choice the operations layer controls: at junction `node`, packets
 * bound to the docks behind sorter `side` may take `primary` (the static
 * shortest path) or `alternative` (the other belt that still reaches them).
 */
export interface RouteDecision {
  readonly id: number;
  readonly node: number;
  readonly side: number;
  readonly primary: number;
  readonly alternative: number;
  readonly docks: readonly number[];
  /** "A1 → S1": junction and sorter, for panels and logs. */
  readonly label: string;
}

/**
 * Router with adjustable splits. Every decision has a share (0 … 1) of
 * packets sent the alternative way; packets are spread by error diffusion
 * (a share of 0.3 sends exactly 3 of every 10, no randomness), so a run stays
 * deterministic. With every share at 0 it routes exactly like the static
 * shortest-path router.
 *
 * `nextEdge` is called once per packet at a decision junction (the world
 * keeps the answer on the packet until it moves), since every call there
 * advances the split.
 */
export class SplitRouter implements Router {
  readonly decisions: RouteDecision[] = [];
  /** Share of packets sent the alternative way, per decision. */
  readonly share: Float64Array;
  private readonly carry: Float64Array;
  private readonly tables = new Map<number, Int32Array>();
  /** Decision index at (node, dock), or absent. */
  private readonly byNodeDock = new Map<number, number>();
  private readonly nodeCount: number;

  constructor(graph: Graph, docks: readonly number[]) {
    this.nodeCount = graph.nodes.length;
    for (const dock of docks) {
      this.tables.set(dock, shortestPathTree(graph, dock, (e) => e.length).next);
    }
    const reaches = (from: number, dock: number) =>
      from === dock ||
      Number.isFinite(shortestPathTree(graph, dock, (e) => e.length).dist[from] as number);
    // A dock's side: the last merge (a node with two or more inputs) on its
    // static path. Docks behind the same merge share every belt after it, so
    // one split serves them all.
    const sideOf = (dock: number) => {
      let side = -1;
      let n = graph.edge(graph.node(dock).inEdges[0] as number).from;
      // Walk up from the dock while the way in is unique; the first merge found is the last one.
      for (let guard = 0; guard < graph.nodes.length; guard++) {
        const ins = graph.node(n).inEdges;
        if (ins.length !== 1) {
          side = n;
          break;
        }
        n = graph.edge(ins[0] as number).from;
      }
      return side;
    };
    const dockNo = (dock: number) => docks.indexOf(dock) + 1;
    for (const node of graph.nodes) {
      if (node.outEdges.length < 2) continue;
      const groups = new Map<number, number[]>();
      for (const dock of docks) {
        const options = node.outEdges.filter((e) => reaches(graph.edge(e).to, dock));
        if (options.length < 2) continue;
        const side = sideOf(dock);
        const list = groups.get(side) ?? [];
        list.push(dock);
        groups.set(side, list);
      }
      for (const [side, group] of groups) {
        const primary = (this.tables.get(group[0] as number) as Int32Array)[node.id] as number;
        const alternative = node.outEdges.find(
          (e) => e !== primary && group.every((d) => reaches(graph.edge(e).to, d)),
        );
        if (alternative === undefined) continue;
        const id = this.decisions.length;
        const nos = group.map(dockNo);
        this.decisions.push({
          id,
          node: node.id,
          side,
          primary,
          alternative,
          docks: group,
          label: `${node.name} → Docas ${Math.min(...nos)}–${Math.max(...nos)}`,
        });
        for (const d of group) this.byNodeDock.set(d * this.nodeCount + node.id, id);
      }
    }
    const n = this.decisions.length;
    this.share = new Float64Array(n);
    this.carry = new Float64Array(n);
  }

  /** Decision taken at `node` for packets bound to `dock`, or -1. */
  decisionAt(node: number, dock: number): number {
    return this.byNodeDock.get(dock * this.nodeCount + node) ?? -1;
  }

  /** The static choice (what a share of 0 does). */
  staticEdge(node: number, dock: number): number {
    return this.tables.get(dock)?.[node] ?? -1;
  }

  nextEdge(nodeId: number, packet: Packet): number {
    const d = this.decisionAt(nodeId, packet.destination);
    if (d < 0) return this.staticEdge(nodeId, packet.destination);
    const decision = this.decisions[d] as RouteDecision;
    const carry = (this.carry[d] as number) + (this.share[d] as number);
    if (carry >= 1 - 1e-9) {
      this.carry[d] = carry - 1;
      return decision.alternative;
    }
    this.carry[d] = carry;
    return decision.primary;
  }

  save(w: StateWriter): void {
    w.floats64(this.share);
    w.floats64(this.carry);
  }

  load(r: StateReader): void {
    this.share.set(r.floats64());
    this.carry.set(r.floats64());
  }
}
