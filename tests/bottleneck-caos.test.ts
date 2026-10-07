import { describe, expect, it } from 'vitest';
import { causesWithin, replay, rightAbout, runCaos } from '../src/ai/bottleneck-caos';
import { FailureInjector } from '../src/sim/failures';
import { fingerprint } from '../src/sim/fingerprint';
import { Recorder } from '../src/sim/recorder';
import { World } from '../src/sim/world';

const SECOND = 60;

function chaos(seed: number, seconds: number, suppressFailures?: number[]): World {
  const w = new World({ seed, ...(suppressFailures ? { suppressFailures } : {}) });
  w.setPolicy('heuristic');
  w.failures.setAuto(true, w.time);
  w.stepMany(seconds * SECOND);
  return w;
}

describe('suppressed failures (counterfactual runs)', () => {
  it('changes nothing when the suppressed failure never happens', () => {
    expect(fingerprint(chaos(7, 120, [9999]))).toBe(fingerprint(chaos(7, 120)));
  });

  it('draws a suppressed failure but never applies it', () => {
    const ids = (suppressFailures?: number[]) => {
      const w = new World({ seed: 7, ...(suppressFailures ? { suppressFailures } : {}) });
      w.setPolicy('heuristic');
      w.failures.setAuto(true, w.time);
      const seen = new Map<number, number>();
      for (let i = 0; i < 120 * SECOND; i++) {
        w.step();
        for (const f of w.failures.active) if (!seen.has(f.id)) seen.set(f.id, f.startedAt);
      }
      return seen;
    };
    const original = ids();
    const [first, startedAt] = [...original][0]!;
    const without = ids([first]);
    expect(without.has(first)).toBe(false);
    // Up to it, both runs are the same: no failure of the counterfactual starts earlier.
    expect(Math.min(...without.values())).toBeGreaterThanOrEqual(startedAt);
  });

  it('keeps the place of a suppressed failure in the limit until it would have ended', () => {
    const host = new World({ seed: 3 });
    const injector = new FailureInjector(host, 3, 0.01, 1, new Set([1]));
    const f = injector.inject('dock', 0, 2)!;
    expect(f.id).toBe(1);
    expect(injector.active).toHaveLength(0);
    expect(host.docks[2]!.blockedUntil).toBeLessThanOrEqual(0);
    injector.setAuto(true, 0);
    // Draws come every hundredth of a second, but the limit (1) is held.
    for (let t = 0.1; t < f.endsAt; t += 0.1) {
      injector.update(t);
      expect(injector.active).toHaveLength(0);
    }
    injector.update(f.endsAt + 0.1);
    injector.update(f.endsAt + 0.2);
    expect(injector.active.length + injector.degrading.length).toBe(1);
  });
});

describe('replay', () => {
  it('reproduces the recording from any checkpoint when nothing is suppressed', () => {
    const rec = new Recorder({ seed: 20004 });
    rec.input({ type: 'policy', policy: 'heuristic' });
    rec.input({ type: 'auto', on: true });
    rec.stepMany(100 * SECOND);
    const live = fingerprint(rec.live);
    expect(fingerprint(replay(rec, rec.checkpoints[0]!, [], rec.live.tick))).toBe(live);
    expect(fingerprint(replay(rec, rec.checkpoints[2]!, [], rec.live.tick))).toBe(live);
  });
});

describe('the causes under the automatic failures', () => {
  it('names a cause right only when it is one of the true causes', () => {
    const belt = { kind: 'conveyor' as const, target: 4 };
    const dock = { kind: 'dock' as const, target: 2 };
    expect(rightAbout('layout', -1, [])).toBe(true);
    expect(rightAbout('surge', -1, [])).toBe(false);
    expect(rightAbout('conveyor', 4, [belt])).toBe(true);
    expect(rightAbout('conveyor', 5, [belt])).toBe(false);
    expect(rightAbout('dock', 2, [belt, dock])).toBe(true);
    expect(rightAbout('layout', -1, [belt])).toBe(false);
    expect(rightAbout('surge', -1, [{ kind: 'surge', target: -1 }])).toBe(true);
    expect(rightAbout('conveyor', 0, [{ kind: 'robot', target: 0 }])).toBe(false);
  });

  it('a cause takes at least half of the queue away, within the window', () => {
    const f = (id: number, endsAt: number, shrink: number) => ({
      id,
      kind: 'conveyor' as const,
      target: id,
      startedAt: 0,
      endsAt,
      shrink,
    });
    const j = { second: 300, queue: 40, candidates: [f(1, 250, 30), f(2, 50, 35), f(3, 290, 10)] };
    // 2 ended 250 s before; 3 takes 10 of 40 packets away.
    expect(causesWithin(j, 180).map((c) => c.id)).toEqual([1]);
    expect(causesWithin(j, 300).map((c) => c.id)).toEqual([1, 2]);
    // A short queue: at least MIN_SHRINK (6) packets, not half of it.
    expect(causesWithin({ ...j, queue: 8, candidates: [f(4, 299, 5), f(5, 299, 6)] }, 180)).toEqual(
      [{ id: 5, kind: 'conveyor', target: 5, startedAt: 0, endsAt: 299 }],
    );
  });

  it('judges every explanation against counterfactual runs', { timeout: 60_000 }, () => {
    const r = runCaos(20004, 300);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.explanations.length).toBeGreaterThan(0);
    for (const e of r.explanations) {
      const j = e.judged;
      expect(j.second).toBeGreaterThanOrEqual(e.from);
      expect(j.second).toBeLessThanOrEqual(e.to);
      // The causes are candidates that took at least half of the queue away.
      for (const c of j.causes) {
        const cand = j.candidates.find((x) => x.id === c.id)!;
        expect(cand.shrink).toBeGreaterThanOrEqual(Math.max(6, j.queue / 2));
      }
      expect(j.correct).toBe(rightAbout(e.cause.kind, e.cause.target, j.causes));
    }
    for (let k = 0; k < 3; k++) {
      expect(r.rightSeconds[k]).toBeLessThanOrEqual(r.judgedSeconds[k]!);
    }
  });
});
