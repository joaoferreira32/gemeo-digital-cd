import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/sim/fingerprint';
import { faceToFace } from '../src/sim/scenarios';
import { SnapshotWriter } from '../src/sim/snapshot';
import { World, type Checkpoint, type SimConfig } from '../src/sim/world';

const SECOND = 60;

/** Snapshot bytes of a world, from a fresh writer (no history from earlier frames). */
function snapshotBytes(w: World): Uint8Array {
  return new Uint8Array(new SnapshotWriter(w).write({ speed: 1, stress: false }));
}

/** A busy, chaotic run: automatic failures, a broken single point of failure, a heavier load. */
function chaotic(seed: number, config: Partial<SimConfig> = {}): World {
  const w = new World({ seed, rackOrderRate: 0.6, arrivalRate: 4.5, ...config });
  w.failures.setAuto(true, 0);
  return w;
}

function sameState(a: Checkpoint, b: Checkpoint): boolean {
  const eq = (x: ArrayLike<number>, y: ArrayLike<number>) =>
    x.length === y.length && Array.from(x).every((v, i) => Object.is(v, y[i]));
  return a.tick === b.tick && eq(a.state.ints, b.state.ints) && eq(a.state.floats, b.state.floats);
}

describe('World checkpoints', () => {
  it('round-trips: loading a checkpoint and saving again gives the same bytes', () => {
    const a = chaotic(3);
    a.stepMany(90 * SECOND);
    const cp = a.saveState();
    const b = new World(a.config);
    b.loadState(cp);
    expect(sameState(b.saveState(), cp)).toBe(true);
    expect(fingerprint(b)).toBe(fingerprint(a));
    expect(snapshotBytes(b)).toEqual(snapshotBytes(a));
  });

  /**
   * Checkpoints every 10 s of a chaotic 4-minute run; each one is loaded into
   * the same reused world (in place) and continued for 5 s, then compared with
   * the original at that moment. Many moments, so the rare states (a truck
   * loading, a robot pausing after stepping aside, a failure about to start)
   * are caught somewhere.
   */
  for (const seed of [1, 2]) {
    it(`seed ${seed}: restored at any moment, a world continues bit for bit like the original`, () => {
      // Smaller trucks, so some are loading at some checkpoint in every run.
      const live = chaotic(seed, { truckCapacity: 40 });
      const checkpoints: Checkpoint[] = [];
      const expected = new Map<
        number,
        { print: string; bytes: Uint8Array; stats: Record<string, number> }
      >();
      for (let t = 10; t <= 240; t += 10) {
        live.stepMany(t * SECOND - live.tick);
        if (t === 100) live.fleet!.setDefect(4, live.time + 30);
        checkpoints.push(live.saveState());
        live.stepMany(5 * SECOND);
        expected.set(t, {
          print: fingerprint(live),
          bytes: snapshotBytes(live),
          stats: { ...live.fleet!.stats },
        });
      }
      const restored = new World(live.config);
      for (const cp of checkpoints) {
        restored.loadState(cp);
        restored.stepMany(5 * SECOND);
        const t = cp.tick / SECOND;
        expect(fingerprint(restored), `checkpoint at ${t} s`).toBe(expected.get(t)!.print);
        expect(snapshotBytes(restored), `checkpoint at ${t} s`).toEqual(expected.get(t)!.bytes);
        expect(restored.fleet!.stats, `checkpoint at ${t} s`).toEqual(expected.get(t)!.stats);
      }
      expect(live.metrics.shipped).toBeGreaterThan(0); // trucks did load and leave
    }, 60_000);
  }

  for (const stepAside of [true, false]) {
    const how = stepAside ? 'a step-aside' : 'the watchdog';
    it(`restored in the middle of a wait solved by ${how}, it continues identically`, () => {
      // Two robots face to face across a gate: failing plans, then a back-off and a pause.
      const build = () => {
        const w = new World({ robots: 4, rackOrderRate: 0, fleet: { stepAside } });
        faceToFace(w.fleet!, -6);
        return w;
      };
      const live = build();
      const restored = build();
      for (let t = 1; t <= 24; t++) {
        live.stepMany(t * SECOND - live.tick);
        const cp = live.saveState();
        restored.loadState(cp);
        restored.stepMany(8 * SECOND);
        const ref = build();
        ref.stepMany(cp.tick + 8 * SECOND);
        expect(snapshotBytes(restored), `checkpoint at ${t} s`).toEqual(snapshotBytes(ref));
        expect(restored.fleet!.stats, `checkpoint at ${t} s`).toEqual(ref.fleet!.stats);
      }
    }, 60_000);
  }

  it('also restores into a world that already ran somewhere else (in place, no leftovers)', () => {
    const a = chaotic(5);
    a.stepMany(60 * SECOND);
    const cp = a.saveState();
    const b = chaotic(5);
    b.stepMany(140 * SECOND); // a different moment of the same run
    b.loadState(cp);
    a.stepMany(40 * SECOND);
    b.stepMany(40 * SECOND);
    expect(fingerprint(b)).toBe(fingerprint(a));
    expect(snapshotBytes(b)).toEqual(snapshotBytes(a));
  }, 60_000);

  it('counts the aggregates again after a load, even into a world at the same tick', () => {
    // The aggregates are counted on the first read of a tick; a seek reuses a
    // world, which may have counted them at that very tick in another state.
    const a = chaotic(6);
    a.stepMany(60 * SECOND);
    const cp = a.saveState();
    const b = chaotic(6);
    b.setArrivalRate(20); // a much heavier load: another state at the same tick
    b.stepMany(60 * SECOND);
    expect(b.tick).toBe(a.tick);
    expect(b.stats.backlog).not.toBe(a.stats.backlog);
    b.loadState(cp);
    expect({ ...b.stats }).toEqual({ ...a.stats });
  }, 60_000);

  it('refuses a checkpoint from a world with another fleet size', () => {
    const cp = new World({ robots: 10 }).saveState();
    expect(() => new World({ robots: 12 }).loadState(cp)).toThrow(/another fleet/);
  });

  it('is compact', () => {
    const w = chaotic(7);
    w.stepMany(120 * SECOND);
    const cp = w.saveState();
    const bytes = cp.state.ints.byteLength + cp.state.floats.byteLength;
    console.info(
      `checkpoint aos 120 s (caos ligado): ${(bytes / 1024).toFixed(1)} KB ` +
        `(${cp.state.ints.length} inteiros, ${cp.state.floats.length} reais)`,
    );
    expect(bytes).toBeLessThan(256 * 1024);
  });
});
