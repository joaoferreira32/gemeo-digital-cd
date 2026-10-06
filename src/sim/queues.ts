import type { World } from './world';

/**
 * Who every waiting packet is waiting for, right now: the belt it has to
 * enter (or the robots bridging that belt), or the dock that has to take it.
 * This is the queue in front of each resource, the raw material of the
 * bottleneck detector (src/ai/bottleneck.ts).
 *
 *  - Packets on a stopped belt (broken, or stopped for maintenance) wait for
 *    that belt; so do packets in the robot bypass of a belt.
 *  - Packets held on a running belt wait for whatever its first packet waits
 *    to enter: the next belt it chose, or the dock at the end of the belt.
 *  - The pile at an inbound waits for the first belt of that inbound.
 *
 * `conveyors` and `docks` are overwritten (one entry per belt and per dock).
 */
export function waitingFor(world: World, conveyors: Int32Array, docks: Int32Array): void {
  conveyors.fill(0);
  docks.fill(0);
  const { graph, dockNodes } = world.layout;
  for (const inbound of world.inbounds) {
    const first = graph.node(inbound.nodeId).outEdges[0];
    if (first !== undefined) conveyors[first]! += inbound.backlog.length;
  }
  for (const c of world.conveyors) {
    if (c.status !== 'ok') {
      conveyors[c.edgeId]! += c.packets.length;
      continue;
    }
    let held = 0;
    for (const p of c.packets) if (p.blocked) held++;
    if (held === 0) continue;
    const dock = dockNodes.indexOf(graph.edge(c.edgeId).to);
    if (dock >= 0) {
      docks[dock]! += held;
      continue;
    }
    const next = c.packets[0]?.next ?? -1;
    if (next >= 0) conveyors[next]! += held;
  }
  for (const lane of world.lanes) conveyors[lane.edgeId]! += lane.pickup.length;
}
