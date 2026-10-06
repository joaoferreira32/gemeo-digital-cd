import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/ai/evaluate';
import { paired, tQuantile975 } from '../src/ai/stats';
import { fingerprint } from '../src/sim/fingerprint';
import { Recorder } from '../src/sim/recorder';
import { World } from '../src/sim/world';

const SECOND = 60;

describe('Congestion heuristic', () => {
  it('sends the traffic around a broken belt within a second, and only where it helps', () => {
    const w = new World({ seed: 20_001 });
    w.setPolicy('heuristic');
    w.stepMany(30 * SECOND);
    w.setConveyorStatus(2, 'broken'); // Esteira 3, A2→A3: no robot bypass for it
    w.stepMany(2 * SECOND);
    const share = Array.from(w.routing.share);
    const label = w.routing.decisions.map((d) => d.label);
    // A1: everything bound to either side must avoid A2→A3, so it crosses to line B.
    expect(share[label.indexOf('A1 → Docas 1–3')]).toBe(1);
    expect(share[label.indexOf('A1 → Docas 4–6')]).toBe(1);
    // B2: the crossover back to A2 now leads into the broken belt.
    expect(share[label.indexOf('B2 → Docas 1–3')]).toBeLessThan(0.05);
    expect(share[label.indexOf('B2 → Docas 4–6')]).toBeLessThan(0.05);
    expect(w.heuristic.cost[label.indexOf('A1 → Docas 1–3')]!.primary).toBe(Infinity);
  });

  it('is deterministic and survives a checkpoint like the rest of the world', () => {
    const run = () => {
      const w = new World({ seed: 20_002 });
      w.setPolicy('heuristic');
      w.failures.setAuto(true, 0);
      w.stepMany(150 * SECOND);
      return w;
    };
    const a = run();
    const b = run();
    expect(fingerprint(a)).toBe(fingerprint(b));
    const cp = a.saveState();
    const c = new World(a.config);
    c.loadState(cp);
    expect(c.policy).toBe('heuristic');
    a.stepMany(60 * SECOND);
    c.stepMany(60 * SECOND);
    expect(fingerprint(c)).toBe(fingerprint(a));
    expect(Array.from(c.routing.share)).toEqual(Array.from(a.routing.share));
  }, 60_000);

  it('policy and shares are recorded inputs: the past is shown exactly', () => {
    const rec = new Recorder({ seed: 20_003 });
    rec.stepMany(20 * SECOND);
    rec.input({ type: 'policy', policy: 'external' });
    rec.input({ type: 'shares', shares: [0.5, 0, 0.25, 1, 0] });
    rec.stepMany(30 * SECOND);
    rec.input({ type: 'policy', policy: 'heuristic' });
    rec.stepMany(40 * SECOND);
    const live = fingerprint(rec.live);
    rec.seek(45 * SECOND);
    expect(Array.from(rec.shown.routing.share)).toEqual([0.5, 0, 0.25, 1, 0]);
    expect(rec.shown.policy).toBe('external');
    rec.seek(rec.headTick - 1);
    rec.backToLive();
    expect(fingerprint(rec.live)).toBe(live);
  }, 60_000);

  it('static zeroes the shares; outside shares only count for the external policy', () => {
    const w = new World({ seed: 1 });
    w.setShares([1, 1, 1, 1, 1]);
    expect(Array.from(w.routing.share)).toEqual([0, 0, 0, 0, 0]);
    w.setPolicy('external');
    w.setShares([1, 2, -1, 0.5, 0.25]);
    expect(Array.from(w.routing.share)).toEqual([1, 1, 0, 0.5, 0.25]);
    w.setPolicy('static');
    expect(Array.from(w.routing.share)).toEqual([0, 0, 0, 0, 0]);
  });

  it('beats the static routing when a belt with an alternative breaks (one validation seed)', () => {
    const base = evaluate(20_004, 'esteira', 'static', { seconds: 300 });
    const heur = evaluate(20_004, 'esteira', 'heuristic', { seconds: 300 });
    expect(heur.cycleP95).toBeLessThan(base.cycleP95);
    expect(heur.oldestMax).toBeLessThanOrEqual(base.oldestMax);
  }, 60_000);
});

describe('Paired comparison', () => {
  it('computes the mean gain, its 95% interval and the wins', () => {
    // Gains 10%, 20%, 30% (lower is better).
    const p = paired([100, 100, 100], [90, 80, 70], true);
    expect(p.mean).toBeCloseTo(0.2, 12);
    expect(p.wins).toBe(3);
    // sd = 0.1, n = 3: half width = 4.303 × 0.1 / √3.
    expect(p.high - p.mean).toBeCloseTo((4.303 * 0.1) / Math.sqrt(3), 9);
    const t = paired([10, 10], [11, 9], false);
    expect(t.mean).toBeCloseTo(0, 12);
    expect(t.wins).toBe(1);
    expect(tQuantile975(9)).toBe(2.262);
    expect(() => paired([1], [1, 2], true)).toThrow();
  });
});
