import { describe, expect, it } from 'vitest';
import { SURGE_FACTOR } from '../src/sim/failures';
import { World } from '../src/sim/world';

const MINUTE = 60 * 60;

describe('FailureInjector', () => {
  it('breaks a conveyor and repairs it when the failure ends', () => {
    const w = new World({ seed: 3 });
    const f = w.failures.inject('conveyor', w.time, 3)!;
    expect(w.isConveyorBroken(3)).toBe(true);
    expect(w.events.at(-1)!.text).toBe('Esteira 4 (A3→A4) quebrou');
    w.stepMany(Math.ceil((f.endsAt - w.time) * 60) + 2);
    expect(w.isConveyorBroken(3)).toBe(false);
    expect(w.events.at(-1)!.text).toBe('Esteira 4 (A3→A4) voltou a operar');
    expect(w.failures.active).toHaveLength(0);
  });

  it('multiplies the order rate during a surge and restores it afterwards', () => {
    const w = new World({ seed: 3 });
    const base = w.currentArrivalRate;
    const f = w.failures.inject('surge', w.time)!;
    expect(w.currentArrivalRate).toBeCloseTo(base * SURGE_FACTOR, 9);
    expect(w.fleet!.rackOrderRate).toBeCloseTo(w.config.rackOrderRate * 2, 9);
    // Only one surge at a time.
    expect(w.failures.inject('surge', w.time)).toBeNull();
    w.stepMany(Math.ceil((f.endsAt - w.time) * 60) + 2);
    expect(w.currentArrivalRate).toBeCloseTo(base, 9);
  });

  it('stops a robot and repairs it', () => {
    const w = new World({ seed: 3 });
    w.stepMany(20 * 60);
    const f = w.failures.inject('robot', w.time, 7)!;
    w.stepMany(2 * 60);
    expect(w.fleet!.robots[7]!.stage).toBe('defect');
    w.stepMany(Math.ceil((f.endsAt - w.time) * 60) + 2 * 60);
    expect(w.fleet!.robots[7]!.stage).not.toBe('defect');
    expect(w.events.some((e) => e.text === 'Robô 8 consertado')).toBe(true);
  });

  it('blocks a dock: nothing is sorted into it until it is released', () => {
    const w = new World({ seed: 3, robots: 0 });
    w.stepMany(2 * MINUTE);
    const dock = w.docks[1]!;
    const f = w.failures.inject('dock', w.time, 1)!;
    const staged = dock.staged.length;
    const shippedBefore = w.metrics.shipped;
    w.stepMany(Math.floor((f.endsAt - w.time) * 60) - 10);
    // While blocked, the staging pile only shrinks (trucks may still load).
    expect(dock.staged.length).toBeLessThanOrEqual(staged);
    expect(w.metrics.shipped).toBeGreaterThanOrEqual(shippedBefore);
    w.stepMany(MINUTE);
    expect(w.events.some((e) => e.text === 'Doca 2 liberada')).toBe(true);
  });

  it('runs the automatic mode deterministically, never with more than two failures at once', () => {
    const run = () => {
      const w = new World({ seed: 99 });
      w.failures.setAuto(true, 0);
      let maxActive = 0;
      for (let i = 0; i < 6 * MINUTE; i++) {
        w.step();
        maxActive = Math.max(maxActive, w.failures.active.length);
      }
      return { events: w.events.map((e) => `${e.time.toFixed(3)} ${e.text}`), maxActive };
    };
    const a = run();
    const b = run();
    expect(a.events).toEqual(b.events);
    expect(a.events.length).toBeGreaterThan(4);
    expect(a.maxActive).toBeLessThanOrEqual(2);
  }, 60_000);

  it('does not inject the same failure twice on the same target', () => {
    const w = new World({ seed: 3 });
    expect(w.failures.inject('conveyor', 0, 2)).not.toBeNull();
    expect(w.failures.inject('conveyor', 0, 2)).toBeNull();
  });
});

describe('Robot bypass benefit (same seed, with and without robots bridging)', () => {
  it('reduces the queue behind a broken A4→S1', () => {
    const measure = (robotBypass: boolean) => {
      const w = new World({ seed: 2026, robotBypass });
      w.stepMany(MINUTE);
      const lane = w.lanes[0]!;
      w.setConveyorStatus(lane.edgeId, 'broken');
      let peak = 0;
      for (let i = 0; i < 3 * MINUTE; i++) {
        w.step();
        peak = Math.max(peak, w.stats.waiting);
      }
      w.setConveyorStatus(lane.edgeId, 'ok');
      w.stepMany(2 * MINUTE);
      return { peak, delivered: w.metrics.delivered, carried: lane.carried };
    };
    const off = measure(false);
    const on = measure(true);
    expect(off.carried).toBe(0);
    expect(on.carried).toBeGreaterThan(0);
    expect(on.peak).toBeLessThan(off.peak);
    expect(on.delivered).toBeGreaterThan(off.delivered);
  }, 120_000);
});
