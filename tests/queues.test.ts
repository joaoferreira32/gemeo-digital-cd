import { describe, expect, it } from 'vitest';
import { waitingFor } from '../src/sim/queues';
import { World } from '../src/sim/world';

const SECOND = 60;
/** Esteira 15 (S1→Q2) feeds Esteira 16 (Q2→Q1), the only way to Doca 1: short belts, 11 packets each. */
const E15 = 14;
const E16 = 15;

function queues(w: World) {
  const conveyors = new Int32Array(w.conveyors.length);
  const docks = new Int32Array(w.docks.length);
  waitingFor(w, conveyors, docks);
  return { conveyors, docks };
}

const total = (q: { conveyors: Int32Array; docks: Int32Array }) =>
  q.conveyors.reduce((a, b) => a + b, 0) + q.docks.reduce((a, b) => a + b, 0);

describe('who each waiting packet waits for', () => {
  for (const [seed, arrivalRate] of [
    [77, 3.6],
    [79, 6],
    [80, 40],
  ] as const) {
    it(`counts every waiting packet once (seed ${seed}, ${arrivalRate} orders/s, automatic failures, schedule on)`, () => {
      const w = new World({ seed, arrivalRate, scheduleMaintenance: true });
      w.setPolicy('heuristic');
      w.failures.setAuto(true, 0);
      for (let s = 0; s < 600; s++) {
        w.stepMany(SECOND);
        expect(total(queues(w)), `at ${s + 1} s`).toBe(w.stats.waiting);
      }
    }, 60_000);
  }

  it('a stopped belt is the root of the whole chain held behind it', () => {
    const w = new World({ seed: 20_001 });
    w.setPolicy('heuristic');
    w.stepMany(150 * SECOND);
    w.failures.inject('conveyor', w.time, E16);
    w.stepMany(60 * SECOND);
    const q = queues(w);
    // Far more than the 11 packets the belt in front of it can hold: the piles behind count too.
    expect(q.conveyors[E16]).toBeGreaterThan(100);
    expect(q.conveyors[E16]).toBeGreaterThanOrEqual(0.9 * w.stats.waiting);
    // The full belt in front of it is a victim: nothing waits for it.
    expect(w.conveyors[E15]!.packets.length).toBeGreaterThan(0);
    expect(q.conveyors[E15]).toBe(0);
  }, 30_000);

  it('packets held at the end of a dock feeder wait for the dock', () => {
    const w = new World({ seed: 3, robots: 0 });
    w.stepMany(120 * SECOND);
    w.failures.inject('dock', w.time, 1);
    w.stepMany(20 * SECOND);
    const q = queues(w);
    const feeder = w.layout.graph.node(w.docks[1]!.nodeId).inEdges[0]!;
    const held = w.conveyors[feeder]!.packets.filter((p) => p.blocked).length;
    expect(held).toBeGreaterThan(0);
    expect(q.docks[1]).toBeGreaterThanOrEqual(held);
  });

  it('the pile at an inbound waits for the root of its first belt', () => {
    // Far more orders than the first belt can take: the pile waits for that belt, full and moving.
    const w = new World({ seed: 4, robots: 0, arrivalRate: 40 });
    w.stepMany(60 * SECOND);
    const q = queues(w);
    const first = w.layout.graph.node(w.inbounds[0]!.nodeId).outEdges[0]!;
    expect(w.inbounds[0]!.backlog.length).toBeGreaterThan(100);
    expect(q.conveyors[first]).toBeGreaterThanOrEqual(w.inbounds[0]!.backlog.length);
  });
});
