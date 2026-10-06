import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/sim/fingerprint';
import { createDefaultLayout } from '../src/sim/layout';
import { createPacket } from '../src/sim/packet';
import { ShortestPathRouter } from '../src/sim/router';
import { SplitRouter } from '../src/sim/routing';
import { SnapshotWriter } from '../src/sim/snapshot';
import { World } from '../src/sim/world';

const SECOND = 60;

describe('SplitRouter', () => {
  const layout = createDefaultLayout();
  const { graph, dockNodes } = layout;
  const node = (name: string) => graph.nodes.find((n) => n.name === name)!.id;

  it('finds the five routing choices of the default floor', () => {
    const r = new SplitRouter(graph, dockNodes);
    expect(r.decisions.map((d) => d.label)).toEqual([
      'A1 → Docas 1–3',
      'A1 → Docas 4–6',
      'A3 → Docas 1–3',
      'B2 → Docas 1–3',
      'B2 → Docas 4–6',
    ]);
    // B2's static choice for docks 1–3 goes through B3→B4 (the busiest belt); the
    // alternative is the crossover back to line A.
    const b2 = r.decisions[3]!;
    expect(graph.edge(b2.primary).name).toBe('Esteira 8');
    expect(graph.edge(b2.alternative).name).toBe('Esteira 12');
    // B4 has no choice: each of its exits reaches one side only.
    expect(r.decisions.some((d) => d.node === node('B4'))).toBe(false);
  });

  it('splits exactly by the share, without randomness', () => {
    const r = new SplitRouter(graph, dockNodes);
    const d = r.decisions[3]!;
    const p = createPacket(1, node('Entrada 2'), dockNodes[0]!, 0);
    const count = (share: number, n: number) => {
      r.share[3] = share;
      let alt = 0;
      for (let i = 0; i < n; i++) if (r.nextEdge(d.node, p) === d.alternative) alt++;
      return alt;
    };
    expect(count(0, 100)).toBe(0);
    expect(count(0.3, 10)).toBe(3);
    expect(count(0.3, 1000)).toBe(300);
    expect(count(1, 50)).toBe(50);
    // Where there is no choice it answers like the static tables.
    const stat = new ShortestPathRouter(graph, dockNodes);
    for (const dock of dockNodes) {
      for (const n of graph.nodes) {
        if (r.decisionAt(n.id, dock) >= 0) continue;
        const q = createPacket(2, n.id, dock, 0);
        expect(r.nextEdge(n.id, q)).toBe(stat.nextEdge(n.id, q));
      }
    }
  });

  it('with every share at 0 the world runs bit for bit like with the static router', () => {
    const run = (staticRouter: boolean) => {
      const w = new World({ seed: 4, rackOrderRate: 0.5 });
      if (staticRouter) w.setRouter(new ShortestPathRouter(w.layout.graph, w.layout.dockNodes));
      w.failures.setAuto(true, 0);
      w.stepMany(240 * SECOND);
      return w;
    };
    const a = run(false);
    const b = run(true);
    expect(fingerprint(a)).toBe(fingerprint(b));
    const bytes = (w: World) =>
      new Uint8Array(new SnapshotWriter(w).write({ speed: 1, stress: false }));
    expect(bytes(a)).toEqual(bytes(b));
    expect(a.failures.active.length + a.metrics.delivered).toBeGreaterThan(0);
  }, 60_000);
});
