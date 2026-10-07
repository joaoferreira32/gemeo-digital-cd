import type { World } from './world';

/**
 * Who every waiting packet is waiting for, right now: the resource at the
 * root of what holds it back. This is the queue in front of each belt and
 * dock, the raw material of the bottleneck detector (src/ai/bottleneck.ts).
 *
 * A held packet waits for what the first packet of its belt waits to enter:
 * the next belt it chose, or the dock at the end of the belt. When that next
 * belt is itself held (its own first packet waits further on), the wait goes
 * on along the chain, until a resource that is stopped (broken, in
 * maintenance), a dock, or a belt that is full but still moving: that one is
 * the root, and the whole chain behind it counts in its queue. (Counting only
 * the step in front made the queue of a short stopped belt stop at what the
 * belt before it holds, 11 packets, while hundreds waited behind: found by
 * the controlled trials of phase 4b.)
 *
 *  - Packets held on a stopped belt, and in the robot bypass of a belt, wait for it.
 *  - The pile at an inbound waits for the root of its first belt.
 *
 * Every waiting packet of the world's stats (`stats.waiting`) is counted
 * exactly once. `conveyors` and `docks` are overwritten (one entry per belt
 * and per dock).
 */
export function waitingFor(world: World, conveyors: Int32Array, docks: Int32Array): void {
  conveyors.fill(0);
  docks.fill(0);
  const { graph, dockNodes } = world.layout;
  const belts = world.conveyors;
  const n = belts.length;
  // What the held packets of each running belt wait for directly: a belt id,
  // a dock as −(index + 1), or NONE; and how many are held.
  const NONE = n;
  const held = new Int32Array(n);
  const next = new Int32Array(n).fill(NONE);
  for (const c of belts) {
    if (c.status !== 'ok') continue;
    let h = 0;
    for (const p of c.packets) if (p.blocked) h++;
    if (h === 0) continue;
    held[c.edgeId] = h;
    const end = graph.edge(c.edgeId).to;
    const dock = dockNodes.indexOf(end);
    if (dock >= 0) {
      next[c.edgeId] = -(dock + 1);
      continue;
    }
    // The first packet has chosen where it goes once it reached the end. One that has
    // not (the one before it left in this very step) would take the static way there.
    const head = c.packets[0];
    const chosen = head
      ? head.next >= 0
        ? head.next
        : world.routing.staticEdge(end, head.destination)
      : -1;
    next[c.edgeId] = chosen >= 0 ? chosen : NONE;
  }
  /** The root of what a packet waiting to enter `belt` waits for (a belt id, or a dock as −(index + 1)). */
  const root = (belt: number): number => {
    let at = belt;
    for (let guard = 0; guard < n; guard++) {
      if ((belts[at] as { status: string }).status !== 'ok') return at;
      const to = next[at] as number;
      if (held[at] === 0 || to === NONE) return at;
      if (to < 0) return to;
      at = to;
    }
    return at;
  };
  const add = (target: number, count: number) => {
    if (target < 0) docks[-target - 1]! += count;
    else conveyors[target]! += count;
  };
  for (const inbound of world.inbounds) {
    const first = graph.node(inbound.nodeId).outEdges[0];
    if (first !== undefined && inbound.backlog.length) add(root(first), inbound.backlog.length);
  }
  for (const c of belts) {
    if (c.status !== 'ok') {
      // Every packet of a stopped belt is held from its next step on; one stopped at the
      // end of this step (a maintenance starts there) still has this step's marks, and
      // they are what the world's stats count too.
      let h = 0;
      for (const p of c.packets) if (p.blocked) h++;
      if (h) add(c.edgeId, h);
      continue;
    }
    const h = held[c.edgeId] as number;
    if (h === 0) continue;
    const to = next[c.edgeId] as number;
    if (to === NONE) continue;
    add(to < 0 ? to : root(to), h);
  }
  for (const lane of world.lanes) {
    if (lane.pickup.length) add(lane.edgeId, lane.pickup.length);
  }
}
