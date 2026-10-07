import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/sim/metrics';

describe('Metrics', () => {
  it('averages cycle time over all deliveries and over the window', () => {
    const m = new Metrics(10);
    m.recordDelivery(1, 4, 1);
    m.recordDelivery(2, 6, 2);
    m.evict(2);
    expect(m.meanCycleTime).toBe(5);
    expect(m.windowMeanCycleTime).toBe(5);
    m.recordDelivery(15, 20, 12);
    m.evict(15);
    // The first two left the 10 s window; the overall mean keeps them.
    expect(m.windowDeliveries).toBe(1);
    expect(m.windowMeanCycleTime).toBe(20);
    expect(m.meanCycleTime).toBe(10);
    expect(m.lastWaits(5)).toEqual([12]);
  });

  it('reports NaN, not zero, before the first delivery', () => {
    const m = new Metrics(60);
    expect(m.meanCycleTime).toBeNaN();
    expect(m.windowMeanCycleTime).toBeNaN();
    expect(m.throughputPerMinute(0)).toBe(0);
  });

  it('computes throughput per minute, using elapsed time early in the run', () => {
    const m = new Metrics(60);
    for (let t = 1; t <= 30; t++) m.recordDelivery(t, 1, 0);
    m.evict(30);
    expect(m.throughputPerMinute(30)).toBe(60);
  });

  it('stays exact after many evictions and compactions, the waits beside the cycles', () => {
    const m = new Metrics(5);
    for (let i = 0; i < 20_000; i++) {
      const t = i * 0.01;
      m.recordDelivery(t, (i % 7) + 1, (i % 7) / 2);
      m.evict(t);
    }
    // Recompute the window mean by brute force.
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 20_000; i++) {
      if (i * 0.01 >= 199.99 - 5) {
        sum += (i % 7) + 1;
        n++;
      }
    }
    expect(m.windowDeliveries).toBe(n);
    expect(m.windowMeanCycleTime).toBeCloseTo(sum / n, 9);
    // Each wait still belongs to its own delivery after the compactions.
    expect(m.lastWaits(50)).toEqual(m.lastCycles(50).map((c) => (c - 1) / 2));
  });
});
