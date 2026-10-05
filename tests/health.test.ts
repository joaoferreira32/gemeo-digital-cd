import { describe, expect, it } from 'vitest';
import {
  cusumAlarms,
  pool,
  recordMaintenance,
  replayAlarms,
  scoreRun,
} from '../src/ai/maintenance';
import { WEAR_LEAD } from '../src/sim/failures';
import { fingerprint } from '../src/sim/fingerprint';
import { World } from '../src/sim/world';

const SECOND = 60;
const MINUTE = 60 * SECOND;

/** What moves packets, robots and failures (everything but the monitoring). */
function flow(w: World): string {
  return JSON.stringify({
    metrics: [w.metrics.created, w.metrics.delivered, w.metrics.shipped],
    belts: w.conveyors.map((c) => [c.status, c.packets.map((p) => [p.id, p.s])]),
    robots: w.fleet?.robots.map((r) => [r.motion.x, r.motion.z, r.load.length]),
    failures: w.failures.active,
    wearing: w.failures.degrading,
  });
}

describe('Motor monitoring (predictive maintenance, simulated signals)', () => {
  it('never changes the flow: a far more sensitive alarm leaves packets and robots identical', () => {
    const run = (detector?: { allowance: number; threshold: number }) => {
      const w = new World({ seed: 10_011, ...(detector ? { detector } : {}) });
      w.failures.setAuto(true, 0);
      w.stepMany(4 * MINUTE);
      return w;
    };
    const calibrated = run();
    const jumpy = run({ allowance: 0.5, threshold: 4 });
    const alarms = (w: World) => w.events.filter((e) => e.kind === 'maintenance').length;
    expect(alarms(jumpy)).toBeGreaterThan(alarms(calibrated));
    expect(flow(jumpy)).toBe(flow(calibrated));
  }, 60_000);

  it('automatic conveyor breakdowns: most come after one to three minutes of wear, some are sudden', () => {
    const run = recordMaintenance(10_021, 1800);
    const worn = run.breakdowns.filter((b) => b.worn);
    const sudden = run.breakdowns.filter((b) => !b.worn);
    expect(worn.length).toBeGreaterThan(sudden.length);
    expect(sudden.length).toBeGreaterThan(0);
    for (const b of worn) {
      const d = run.degradations.find((x) => x.id === b.id)!;
      expect(b.motor).toBe(d.target);
      // It breaks on the first tick at or after the scheduled moment.
      expect(b.time).toBeGreaterThanOrEqual(d.breaksAt);
      expect(b.time).toBeLessThan(d.breaksAt + 1 / 60 + 1e-9);
      expect(d.breaksAt - d.onset).toBeGreaterThanOrEqual(WEAR_LEAD[0]);
      expect(d.breaksAt - d.onset).toBeLessThanOrEqual(WEAR_LEAD[1]);
    }
  }, 60_000);

  it('a belt wearing out raises the alarm before it breaks, and the alarm says why', () => {
    // A seed whose wear shows clearly. Faint or short wear can go unnoticed
    // (about one in four on the validation seeds); the precision and recall
    // test below and npm run bench:manutencao measure that.
    const w = new World({ seed: 10_037 });
    w.stepMany(3 * MINUTE);
    const wear = w.failures.degrade(w.time, 2)!;
    expect(wear).not.toBeNull();
    // Hidden: wear makes no event and does not stop the belt.
    const eventsBefore = w.events.length;
    w.stepMany(SECOND);
    expect(w.events.length).toBe(eventsBefore);
    expect(w.conveyors[2]!.status).toBe('ok');
    while (w.time < wear.breaksAt + 1) w.step();
    const alarm = w.events.find(
      (e) => e.kind === 'maintenance' && e.target === 2 && e.time >= wear.onset,
    );
    expect(alarm).toBeDefined();
    expect(wear.breaksAt - alarm!.time).toBeGreaterThanOrEqual(10);
    expect(alarm!.text).toMatch(
      /^Esteira 3 \(A2→A3\): motor fora do padrão \(vibração .+ mm\/s, .+ °C\)/,
    );
    expect(alarm!.about).toEqual(['conveyor:2']);
    expect(w.conveyors[2]!.status).toBe('broken');
  }, 60_000);

  it('a motor back from repairing the breakdown it wore into reads like a healthy one', () => {
    // It comes back still warm (thermal memory) and the filter must not have
    // learned the wear: either mistake shifts the scores after the restart
    // (measured: about +2.7 and −4.1 on average over 30 s, against −0.8).
    const w = new World({ seed: 10_037 });
    w.stepMany(3 * MINUTE);
    w.failures.degrade(w.time, 2);
    const running = () => w.conveyors[2]!.status === 'ok';
    while (running()) w.step();
    while (!running()) w.step();
    const scores: number[] = [];
    w.health.onScore = (motor, z) => {
      if (motor === 2) scores.push(z);
    };
    w.stepMany(30 * SECOND);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(scores.length).toBe(30);
    expect(mean).toBeGreaterThan(-2);
    expect(mean).toBeLessThan(1.5);
  }, 60_000);

  it('raises exactly the alarms that replaying the CUSUM over its scores gives', () => {
    const sensitive = { allowance: 1, threshold: 16 };
    const run = recordMaintenance(10_041, 900, sensitive);
    const key = (alarms: readonly { time: number; motor: number }[]) =>
      alarms.map((a) => `${a.time}:${a.motor}`).sort();
    expect(run.alarms.length).toBeGreaterThan(3);
    expect(key(run.alarms)).toEqual(key(replayAlarms(run, sensitive)));
  }, 60_000);

  it('restored in the middle of a wear, continues bit for bit (readings, filter, alarm)', () => {
    const a = new World({ seed: 10_051 });
    a.failures.setAuto(true, 0);
    // Bounded: a wear starts within minutes of automatic failures (a test must fail, not hang).
    while (!a.failures.degrading.length && a.time < 600) a.stepMany(SECOND);
    expect(a.failures.degrading.length).toBeGreaterThan(0);
    a.stepMany(20 * SECOND);
    const cp = a.saveState();
    const savedAt = a.time;
    const b = new World(a.config);
    b.loadState(cp);
    a.stepMany(2 * MINUTE);
    b.stepMany(2 * MINUTE);
    expect(fingerprint(b)).toBe(fingerprint(a));
    for (const k of ['vibration', 'temperature', 'score', 'sum', 'alarm'] as const) {
      expect(Array.from(b.health[k])).toEqual(Array.from(a.health[k]));
    }
    const texts = (w: World) => w.events.filter((e) => e.time > savedAt).map((e) => e.text);
    expect(texts(b)).toEqual(texts(a));
  }, 60_000);

  it('detector precision and recall on two training seeds (30 minutes of automatic failures each)', () => {
    const score = pool([10_061, 10_062].map((seed) => scoreRun(recordMaintenance(seed, 1800))));
    expect(score.breakdowns).toBeGreaterThan(8);
    expect(score.precision).toBeGreaterThanOrEqual(0.8);
    expect(score.recall).toBeGreaterThanOrEqual(0.6);
    expect(score.leads[Math.floor(score.leads.length / 2)]).toBeGreaterThanOrEqual(15);
    expect(score.falsePerMotorHour).toBeLessThan(0.2);
  }, 120_000);
});

describe('CUSUM rule', () => {
  it('a burst shorter than the threshold allows is ignored; a sustained one raises the alarm', () => {
    // z = 4.5 with k = 3 adds 1.5 a second: 32 s to reach h = 48.
    expect(cusumAlarms(new Array(30).fill(4.5), 3, 48)).toEqual([]);
    expect(cusumAlarms(new Array(40).fill(4.5), 3, 48)).toEqual([32]);
  });

  it('a stopped motor starts from zero, and the alarm goes down only when the sum is back to 0', () => {
    expect(
      cusumAlarms([...new Array(20).fill(4.5), null, ...new Array(20).fill(4.5)], 3, 48),
    ).toEqual([]);
    // Up at 32; stays up while the sum drains; down at 0, then up again.
    const series = [
      ...new Array(32).fill(4.5),
      ...new Array(20).fill(0),
      ...new Array(40).fill(4.5),
    ];
    expect(cusumAlarms(series, 3, 48)).toEqual([32, 84]);
  });
});
