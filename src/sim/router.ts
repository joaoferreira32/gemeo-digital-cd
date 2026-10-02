import { shortestPathTree, type Graph, type GraphEdge } from './graph';
import type { Packet } from './packet';

/**
 * Decides which outgoing conveyor a packet takes at a node. The world only
 * talks to this interface, so a dynamic-cost router (phase 3 optimizer) can
 * replace the static one without touching the engine.
 */
export interface Router {
  /** Edge id to take from `nodeId` toward the packet's destination, or -1 if there is no route. */
  nextEdge(nodeId: number, packet: Packet): number;
}

/** Static shortest path by conveyor length, precomputed once per destination dock. */
export class ShortestPathRouter implements Router {
  private readonly tables = new Map<number, Int32Array>();

  constructor(
    graph: Graph,
    destinations: readonly number[],
    weight: (edge: GraphEdge) => number = (e) => e.length,
  ) {
    for (const dock of destinations) {
      this.tables.set(dock, shortestPathTree(graph, dock, weight).next);
    }
  }

  nextEdge(nodeId: number, packet: Packet): number {
    return this.tables.get(packet.destination)?.[nodeId] ?? -1;
  }
}
