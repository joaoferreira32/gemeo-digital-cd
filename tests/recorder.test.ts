import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/sim/fingerprint';
import { ROBOT_STAGES } from '../src/sim/fleet';
import { Recorder, quantile, type RunReport, type SimInput } from '../src/sim/recorder';
import { Rng } from '../src/sim/rng';
import { SnapshotWriter } from '../src/sim/snapshot';
import type { World } from '../src/sim/world';

const SECOND = 60;

function snapshotBytes(w: World): Uint8Array {
  return new Uint8Array(new SnapshotWriter(w).write({ speed: 1, stress: false }));
}

/** Inputs a viewer could give, at fixed seconds. */
const SCRIPT: [number, SimInput][] = [
  [20, { type: 'inject', kind: 'conveyor', target: 3 }],
  [45, { type: 'auto', on: true }],
  [70, { type: 'stress', on: true }],
  // Exactly on a checkpoint tick: the checkpoint is taken before the input. The
  // target is drawn, so applying it twice would break another conveyor.
  [90, { type: 'inject', kind: 'conveyor' }],
  [95, { type: 'inject', kind: 'robot', target: 7 }],
  [130, { type: 'stress', on: false }],
  [160, { type: 'inject', kind: 'dock', target: 2 }],
  [200, { type: 'auto', on: false }],
];

/** Records `seconds` of a run driven by SCRIPT; `each` runs at every tick, after that tick's inputs. */
function record(seconds: number, each?: (rec: Recorder) => void, checkpointSeconds = 30) {
  const rec = new Recorder({ seed: 11, rackOrderRate: 0.5 }, { checkpointSeconds });
  for (let tick = 0; tick <= seconds * SECOND; tick++) {
    for (const [s, input] of SCRIPT) if (s * SECOND === tick) rec.input(input);
    each?.(rec);
    if (tick < seconds * SECOND) rec.step();
  }
  return rec;
}

describe('Recorder', () => {
  it('shows any past moment exactly as it was live', () => {
    const rng = new Rng(4);
    const moments = new Set<number>([0, 1, 20 * SECOND, 30 * SECOND, 30 * SECOND + 1]);
    while (moments.size < 30) moments.add(rng.int(240 * SECOND));
    const expected = new Map<number, { print: string; bytes: Uint8Array }>();
    const rec = record(240, (r) => {
      const t = r.headTick;
      if (moments.has(t))
        expected.set(t, { print: fingerprint(r.live), bytes: snapshotBytes(r.live) });
    });
    // Out of order, forward and backward, so restores and continued replays both happen.
    const order = [...moments].sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
    for (const t of order) {
      const shown = rec.seek(t);
      expect(rec.viewing).toBe(true);
      expect(shown.tick).toBe(t);
      expect(fingerprint(shown), `tick ${t}`).toBe(expected.get(t)!.print);
      expect(snapshotBytes(shown), `tick ${t}`).toEqual(expected.get(t)!.bytes);
    }
  }, 60_000);

  it('leaves the live world untouched: back to live, it goes on like a run that never looked back', () => {
    const plain = record(150);
    const looked = record(150);
    looked.seek(40 * SECOND);
    looked.seek(130 * SECOND);
    looked.seek(5 * SECOND);
    looked.backToLive();
    expect(looked.shown).toBe(looked.live);
    plain.stepMany(60 * SECOND);
    looked.stepMany(60 * SECOND);
    expect(fingerprint(looked.live)).toBe(fingerprint(plain.live));
  }, 60_000);

  it('continuing from the past is a new branch: the same as running again with the new input', () => {
    const rec = record(240);
    const headEvents = rec.events.length;
    // 95 s: an input of the recording was given at that very tick; it stays.
    rec.seek(95 * SECOND);
    const extra: SimInput = { type: 'inject', kind: 'conveyor', target: 9 };
    rec.input(extra); // an input in the past continues the run from there
    expect(rec.viewing).toBe(false);
    // The world's own feed has only the new input's event; the replay's are already logged.
    expect(rec.live.events).toEqual([rec.events.at(-1)]);
    expect(rec.headTick).toBe(95 * SECOND);
    expect(rec.branches).toEqual([95 * SECOND]);
    expect(rec.inputs.every((i) => i.tick <= 95 * SECOND)).toBe(true);
    expect(rec.inputs.filter((i) => i.tick === 95 * SECOND)).toHaveLength(2);
    expect(rec.checkpoints.at(-1)!.tick).toBeLessThanOrEqual(95 * SECOND);
    expect(rec.events.every((e) => e.time <= 95)).toBe(true);
    expect(rec.events.length).toBeLessThan(headEvents);
    expect(rec.series.seconds).toBe(96);
    rec.stepMany(80 * SECOND);

    // Reference: a fresh run with the script up to 95 s, then the new input.
    const ref = record(95);
    ref.input(extra);
    ref.stepMany(80 * SECOND);
    expect(fingerprint(rec.live)).toBe(fingerprint(ref.live));
    expect(snapshotBytes(rec.live)).toEqual(snapshotBytes(ref.live));
    expect(rec.events.map((e) => [e.id, e.time, e.text])).toEqual(
      ref.events.map((e) => [e.id, e.time, e.text]),
    );
    expect(rec.journal.length).toBe(ref.journal.length);
    expect(rec.kpis(170)).toEqual(ref.kpis(170));
  }, 60_000);

  it('writes a report that runs the recording again to the same end', () => {
    const rec = record(150);
    rec.seek(90 * SECOND);
    rec.input({ type: 'inject', kind: 'surge' });
    rec.stepMany(30 * SECOND);
    const report = JSON.parse(JSON.stringify(rec.report())) as RunReport;
    expect(report.endTick).toBe(120 * SECOND);
    const again = Recorder.replay(report);
    expect(fingerprint(again.live)).toBe(report.fingerprint);
    expect(() => Recorder.replay({ ...report, format: 'x' } as unknown as RunReport)).toThrow();
  }, 60_000);

  it('logs every robot stage change of the live run', () => {
    const rec = record(60);
    const robots = rec.live.fleet!.robots;
    // The last logged stage of each robot is its stage now.
    const last = new Map<number, number>();
    for (let i = 0; i < rec.journal.length; i++) {
      last.set(rec.journal.robots.get(i), rec.journal.stages.get(i));
    }
    expect(rec.journal.length).toBeGreaterThan(40);
    for (const [robot, stage] of last) {
      expect(robots[robot]!.stage).toBe(ROBOT_STAGES[stage]);
    }
  });
});

describe('KPIs', () => {
  it('p95 by quickselect equals the nearest rank of the sorted values', () => {
    const rng = new Rng(8);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + rng.int(trial < 50 ? 10 : 3000);
      // Coarse values give many ties, like real cycle times.
      const values = Array.from({ length: n }, () => Math.round(rng.next() * 40) / 2);
      const sorted = [...values].sort((a, b) => a - b);
      for (const p of [0.5, 0.95, 0.99, 1]) {
        const rank = Math.max(1, Math.ceil(p * n));
        expect(quantile(values, p), `n=${n} p=${p}`).toBe(sorted[rank - 1]);
      }
    }
    expect(quantile([], 0.95)).toBeNaN();
  });

  it('cycle time and utilizations over the window match a count made by hand', () => {
    const rec = record(200);
    const k = rec.kpis(200, 120);
    const w = rec.live;
    // Every delivery of the last 120 s, straight from the samples.
    const s = rec.series;
    const cycles = Array.from(s.cycles.data.subarray(s.cycleEnd.get(80), s.cycleEnd.get(200)));
    expect(k.deliveries).toBe(cycles.length);
    expect(k.cycleMean).toBeCloseTo(cycles.reduce((a, b) => a + b, 0) / cycles.length, 9);
    expect(k.cycleP95).toBe([...cycles].sort((a, b) => a - b)[Math.ceil(0.95 * cycles.length) - 1]);
    expect(k.throughput).toBeCloseTo(s.delivered.get(200) - s.delivered.get(140), 9);
    for (const u of [...k.conveyorUse, ...k.dockUse, ...k.robotUse]) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1.000001);
    }
    // At least one belt really carried something, and the busiest robot worked.
    expect(Math.max(...k.conveyorUse)).toBeGreaterThan(0.1);
    expect(Math.max(...k.robotUse)).toBeGreaterThan(0.1);
    expect(k.chart.waiting.at(-1)).toBe(w.stats.waiting);
    expect(k.chart.throughput.length).toBe(120);
  });
});
