import { describe, expect, it } from 'vitest';
import { Graph, pointOnEdge, shortestPathTree } from '../src/sim/graph';
import { createDefaultLayout } from '../src/sim/layout';

describe('Graph geometry', () => {
  it('measures polyline length and interpolates along bends', () => {
    const g = new Graph();
    const a = g.addNode('a', 'junction', 0, 0);
    const b = g.addNode('b', 'junction', 3, 4);
    const e = g.edge(g.addEdge(a, b, 'e', [{ x: 3, z: 0 }]));
    expect(e.length).toBe(7);
    const p = pointOnEdge(e, 1.5, { x: 0, z: 0, heading: 0 });
    expect(p).toEqual({ x: 1.5, z: 0, heading: 0 });
    pointOnEdge(e, 5, p);
    expect(p.x).toBe(3);
    expect(p.z).toBe(2);
    expect(p.heading).toBeCloseTo(Math.PI / 2);
    // Clamped outside [0, length].
    expect(pointOnEdge(e, 99, p)).toMatchObject({ x: 3, z: 4 });
    expect(pointOnEdge(e, -1, p)).toMatchObject({ x: 0, z: 0 });
  });

  it('rejects zero-length edges', () => {
    const g = new Graph();
    const a = g.addNode('a', 'junction', 1, 1);
    const b = g.addNode('b', 'junction', 1, 1);
    expect(() => g.addEdge(a, b, 'e')).toThrow();
  });
});

describe('shortestPathTree', () => {
  // a → b → d is shorter than a → c → d.
  function diamond() {
    const g = new Graph();
    const a = g.addNode('a', 'junction', 0, 0);
    const b = g.addNode('b', 'junction', 1, 0);
    const c = g.addNode('c', 'junction', 0, 5);
    const d = g.addNode('d', 'dock', 2, 0);
    const ab = g.addEdge(a, b, 'ab');
    const ac = g.addEdge(a, c, 'ac');
    const bd = g.addEdge(b, d, 'bd');
    const cd = g.addEdge(c, d, 'cd');
    return { g, a, b, c, d, ab, ac, bd, cd };
  }

  it('picks the cheapest next hop toward the target', () => {
    const { g, a, b, c, d, ab, bd, cd } = diamond();
    const tree = shortestPathTree(g, d, (e) => e.length);
    expect(tree.next[a]).toBe(ab);
    expect(tree.next[b]).toBe(bd);
    expect(tree.next[c]).toBe(cd);
    expect(tree.next[d]).toBe(-1);
    expect(tree.dist[a]).toBe(2);
  });

  it('routes around an edge with infinite weight', () => {
    const { g, a, d, ac, bd } = diamond();
    const tree = shortestPathTree(g, d, (e) => (e.id === bd ? Infinity : e.length));
    expect(tree.next[a]).toBe(ac);
  });

  it('marks unreachable nodes', () => {
    const { g, a, d } = diamond();
    const tree = shortestPathTree(g, d, () => Infinity);
    expect(tree.next[a]).toBe(-1);
    expect(tree.dist[a]).toBe(Infinity);
  });
});

describe('default layout', () => {
  const layout = createDefaultLayout();
  const { graph } = layout;

  it('reaches every dock from every inbound', () => {
    for (const dock of layout.dockNodes) {
      const tree = shortestPathTree(graph, dock, (e) => e.length);
      for (const inbound of layout.inboundNodes) expect(tree.dist[inbound]).toBeLessThan(Infinity);
    }
  });

  // Main line = conveyors on z = ±3 between an inbound/junction and the next junction.
  const mainLine = graph.edges.filter((e) => {
    const from = graph.node(e.from);
    const to = graph.node(e.to);
    return from.pos.z === to.pos.z && Math.abs(from.pos.z) === 3 && to.kind === 'junction';
  });
  const docksReachableWithout = (brokenId: number) =>
    layout.dockNodes.filter((dock) => {
      const tree = shortestPathTree(graph, dock, (e) => (e.id === brokenId ? Infinity : e.length));
      return layout.inboundNodes.some((n) => (tree.dist[n] as number) < Infinity);
    }).length;

  it('keeps every dock reachable when most main-line conveyors fail', () => {
    expect(mainLine.length).toBe(10);
    const spof = mainLine.filter((e) => docksReachableWithout(e.id) < layout.dockNodes.length);
    // Known single points of failure (no conveyor alternative): the two sorter
    // feeds and B3→B4, the only way into B4. Phase 2 AGVs are the bypass for them.
    expect(spof.map((e) => `${graph.node(e.from).name}→${graph.node(e.to).name}`)).toEqual([
      'A4→S1',
      'B3→B4',
      'B4→S2',
    ]);
    for (const e of spof) expect(docksReachableWithout(e.id)).toBe(layout.dockNodes.length - 3);
  });

  it('gives every conveyor a unique display name', () => {
    const names = new Set(graph.edges.map((e) => e.name));
    expect(names.size).toBe(graph.edges.length);
  });

  it('keeps every node inside the building', () => {
    const { minX, maxX, minZ, maxZ } = layout.bounds;
    for (const n of graph.nodes) {
      expect(n.pos.x).toBeGreaterThan(minX);
      expect(n.pos.x).toBeLessThan(maxX);
      expect(n.pos.z).toBeGreaterThan(minZ);
      expect(n.pos.z).toBeLessThan(maxZ);
    }
  });
});
