import { describe, expect, it } from 'vitest';
import { deriveSeed, Rng } from '../src/sim/rng';

describe('Rng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const same = Array.from({ length: 100 }, () => a.next() === b.next()).filter(Boolean);
    expect(same.length).toBeLessThan(3);
  });

  it('stays in [0, 1) and is roughly uniform', () => {
    const rng = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n / 100);
  });

  it('draws exponential intervals with the requested mean', () => {
    const rng = new Rng(3);
    let sum = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) sum += rng.exponential(4);
    expect(sum / n).toBeCloseTo(0.25, 2);
  });

  it('draws weighted indices in proportion to the weights', () => {
    const rng = new Rng(11);
    const counts = [0, 0, 0];
    const n = 60_000;
    for (let i = 0; i < n; i++) counts[rng.weightedIndex([1, 2, 3])]!++;
    expect(counts[0]! / n).toBeCloseTo(1 / 6, 1);
    expect(counts[2]! / n).toBeCloseTo(3 / 6, 1);
  });

  it('derives distinct, stable seeds per stream', () => {
    expect(deriveSeed(5, 'orders')).toBe(deriveSeed(5, 'orders'));
    expect(deriveSeed(5, 'orders')).not.toBe(deriveSeed(5, 'failures'));
    expect(deriveSeed(5, 'orders')).not.toBe(deriveSeed(6, 'orders'));
  });
});
