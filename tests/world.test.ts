import { describe, expect, it } from 'vitest';
import { conveyorCapacity } from '../src/sim/conveyor';
import { fingerprint } from '../src/sim/fingerprint';
import { shortestPathTree } from '../src/sim/graph';
import { World } from '../src/sim/world';

const MINUTE = 60 * 60; // steps at the default 60 Hz
/** The phase-1 flow tests are about conveyors: they run without the robot fleet. */
const CONVEYORS_ONLY = { robots: 0 } as const;

function conservationHolds(w: World): boolean {
  const s = w.stats;
  const accounted =
    s.backlog +
    s.onConveyors +
    s.staged +
    w.metrics.shipped +
    s.inBypass +
    s.onRobots +
    s.rackPending;
  return w.metrics.created === accounted;
}

describe('World determinism', () => {
  it('reproduces the exact same state for the same seed', () => {
    const a = new World({ seed: 123 });
    const b = new World({ seed: 123 });
    for (let i = 0; i < 5; i++) {
      a.stepMany(MINUTE);
      b.stepMany(MINUTE);
      expect(fingerprint(a)).toBe(fingerprint(b));
    }
  }, 20_000);

  it('diverges for a different seed', () => {
    const a = new World({ seed: 1 });
    const b = new World({ seed: 2 });
    a.stepMany(MINUTE);
    b.stepMany(MINUTE);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('keeps the order stream independent of conveyor parameters', () => {
    // Same seed, different belt speed: the generated orders must be identical,
    // so scenario A/B comparisons see the same demand.
    const a = new World({ seed: 9, conveyorSpeed: 2.0 });
    const b = new World({ seed: 9, conveyorSpeed: 2.4 });
    a.stepMany(MINUTE);
    b.stepMany(MINUTE);
    expect(a.metrics.created).toBe(b.metrics.created);
    expect(a.inbounds.map((i) => i.nextArrivalAt)).toEqual(b.inbounds.map((i) => i.nextArrivalAt));
  });
});

describe('World flow', () => {
  it('conserves packets at every step, robots included', () => {
    const w = new World({ seed: 5, arrivalRate: 6 });
    for (let i = 0; i < 10 * MINUTE; i++) {
      w.step();
      if (i % 97 === 0) expect(conservationHolds(w)).toBe(true);
    }
    expect(conservationHolds(w)).toBe(true);
    expect(w.metrics.deliveredByRobots).toBeGreaterThan(0);
  }, 60_000);

  it('delivers every packet to its own dock', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 8 });
    w.stepMany(10 * MINUTE);
    expect(w.metrics.delivered).toBeGreaterThan(1000);
    expect(w.metrics.misrouted).toBe(0);
    for (const dock of w.docks) {
      for (const p of dock.staged) expect(p.destination).toBe(dock.nodeId);
    }
  });

  it('keeps up with the default demand (stable backlog)', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 21 });
    w.stepMany(15 * MINUTE);
    // Arrival rate is below every bottleneck's capacity, so nothing piles up.
    expect(w.stats.backlog).toBeLessThan(10);
    const minutes = w.time / 60;
    const createdPerMinute = w.metrics.created / minutes;
    expect(w.metrics.throughputPerMinute(w.time)).toBeGreaterThan(createdPerMinute * 0.9);
  });

  it('never delivers faster than the shortest path allows', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 4 });
    const { graph, inboundNodes, dockNodes } = w.layout;
    let minTravel = Infinity;
    for (const dock of dockNodes) {
      const tree = shortestPathTree(graph, dock, (e) => e.length);
      for (const inbound of inboundNodes) {
        minTravel = Math.min(minTravel, (tree.dist[inbound] as number) / w.config.conveyorSpeed);
      }
    }
    w.stepMany(5 * MINUTE);
    expect(w.metrics.delivered).toBeGreaterThan(0);
    expect(w.metrics.meanCycleTime).toBeGreaterThan(minTravel);
  });

  it('builds a queue behind a broken conveyor and drains it after the repair', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 33 });
    w.stepMany(2 * MINUTE);
    const feeder = w.conveyors.find(
      (c) => w.layout.graph.edge(c.edgeId).to === w.layout.dockNodes[2],
    )!;
    const waitingBefore = w.stats.waiting;
    w.setConveyorStatus(feeder.edgeId, 'broken');
    w.stepMany(2 * MINUTE);
    const peak = w.stats.waiting;
    expect(peak).toBeGreaterThan(waitingBefore + 100);
    expect(feeder.packets.every((p) => p.blocked)).toBe(true);
    expect(conservationHolds(w)).toBe(true);
    w.setConveyorStatus(feeder.edgeId, 'ok');
    // Recovery is limited by the spare capacity of the busiest belt, so it
    // takes minutes, not seconds; it must still clearly drain.
    w.stepMany(8 * MINUTE);
    expect(w.stats.waiting).toBeLessThan(peak / 2);
  });

  it('never exceeds lane or staging capacity under overload', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 77, arrivalRate: 30 });
    for (let i = 0; i < 5 * MINUTE; i++) {
      w.step();
      if (i % 113 !== 0) continue;
      for (const c of w.conveyors)
        expect(c.packets.length).toBeLessThanOrEqual(conveyorCapacity(c));
      for (const d of w.docks)
        expect(d.staged.length).toBeLessThanOrEqual(w.config.stagingCapacity);
    }
    // Demand far above capacity ends up in the inbound backlog.
    expect(w.stats.backlog).toBeGreaterThan(1000);
    expect(conservationHolds(w)).toBe(true);
  });

  it('ships full truckloads and brings the truck back', () => {
    const w = new World({ ...CONVEYORS_ONLY, seed: 12, truckCapacity: 20, truckAwayTime: 10 });
    const dock = w.docks[0]!;
    const seen: string[] = [];
    for (let i = 0; i < 10 * MINUTE; i++) {
      w.step();
      const state = dock.truck.state;
      if (seen[seen.length - 1] !== state) seen.push(state);
      // A truck only leaves completely full.
      if (state === 'away') expect(dock.truck.load).toBe(20);
    }
    expect(seen.join('>')).toMatch(/^docked>loading>away>docked/);
    expect(w.metrics.shipped).toBeGreaterThanOrEqual(20);
  });

  it('rejects inconsistent configurations', () => {
    expect(() => new World({ truckCapacity: 500, stagingCapacity: 100 })).toThrow();
    expect(() => new World({ arrivalRate: 0 })).toThrow();
    expect(() => new World({ destinationWeights: [1, 2] })).toThrow();
  });
});
