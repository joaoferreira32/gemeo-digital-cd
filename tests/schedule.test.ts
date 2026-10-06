import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/sim/fingerprint';
import type { ServiceOutcome } from '../src/sim/schedule';
import { SnapshotWriter } from '../src/sim/snapshot';
import { World, type Checkpoint, type SimConfig } from '../src/sim/world';

const SECOND = 60;
/** Esteira 3 (A2→A3): on four routing choices, so the heuristic can empty it. */
const ON_A_WAY = 2;
/** Esteira 20 (Q2→Doca 2): a dock feeder, its traffic has no other way. */
const NO_OTHER_WAY = 19;

/**
 * A world with the schedule on and the heuristic routing. The motor alarm is
 * raised by hand (`schedule.alarm`), so its threshold is out of reach here:
 * a natural alarm would add plans these tests do not expect.
 */
function world(config: Partial<SimConfig> = {}): World {
  const w = new World({
    seed: 11,
    scheduleMaintenance: true,
    detector: { threshold: 1e9 },
    ...config,
  });
  w.setPolicy('heuristic');
  return w;
}

function runUntil(w: World, time: number): void {
  w.stepMany(Math.max(0, Math.round(time * SECOND) - w.tick));
}

/** Runs second by second until the belt is stopped for maintenance; returns the time. */
function untilStarted(w: World, edge: number, limit = 60): number {
  for (let i = 0; i < limit; i++) {
    if (w.conveyors[edge]!.status === 'maintenance') return w.time;
    w.stepMany(SECOND);
  }
  throw new Error('the maintenance never started');
}

describe('maintenance schedule', () => {
  it('does nothing unless the configuration turns it on', () => {
    const w = new World({ seed: 11 });
    w.schedule.alarm(ON_A_WAY, w.time);
    expect(w.schedule.plans).toHaveLength(0);
    expect(w.schedule.closing[ON_A_WAY]).toBe(0);
  });

  it('a worn belt is emptied, serviced and never breaks', () => {
    const w = world();
    runUntil(w, 60);
    const wear = w.failures.degrade(w.time, ON_A_WAY)!;
    runUntil(w, wear.onset + 20);
    w.schedule.alarm(ON_A_WAY, w.time);
    const alarmAt = w.time;
    expect(w.schedule.closing[ON_A_WAY]).toBe(1);
    expect(w.events.at(-1)!.kind).toBe('service-planned');

    const started = untilStarted(w, ON_A_WAY);
    expect(started - alarmAt).toBeLessThanOrEqual(w.schedule.params.window + 1e-6);
    expect(w.failures.degrading.some((d) => d.target === ON_A_WAY)).toBe(false);
    expect(w.schedule.avoided).toBe(1);
    expect(w.schedule.closing[ON_A_WAY]).toBe(0);
    const avoided = w.events.find((e) => e.kind === 'failure-avoided')!;
    expect(avoided.text).toMatch(/^Falha evitada: Esteira 3 \(A2→A3\) parou para manutenção/);
    expect(avoided.about).toEqual([`conveyor:${ON_A_WAY}`]);

    runUntil(w, wear.breaksAt + 5);
    expect(w.events.some((e) => e.kind === 'failure-start' && e.target === ON_A_WAY)).toBe(false);
    runUntil(w, started + w.schedule.params.duration + 1);
    expect(w.conveyors[ON_A_WAY]!.status).toBe('ok');
    expect(w.events.some((e) => e.kind === 'service-end')).toBe(true);
  });

  it('while a belt is emptied, the heuristic sends its traffic the other way', () => {
    const w = world();
    runUntil(w, 60);
    w.schedule.alarm(ON_A_WAY, w.time);
    runUntil(w, w.time + 2);
    // Esteira 3 is on the main way of the two choices at A1 and on the
    // alternative of the two at B2 (see policy.ts: ways).
    expect([...w.routing.share]).toEqual([1, 1, expect.any(Number), 0, 0]);
  });

  it('a false alarm stops the belt for nothing, and says so', () => {
    const w = world();
    runUntil(w, 60);
    w.schedule.alarm(ON_A_WAY, w.time);
    untilStarted(w, ON_A_WAY);
    expect(w.schedule.unneeded).toBe(1);
    expect(w.schedule.avoided).toBe(0);
    expect(w.events.find((e) => e.kind === 'service-start')!.text).toBe(
      'Esteira 3 (A2→A3): manutenção sem desgaste encontrado (alarme falso)',
    );
  });

  it('waits for the belt to empty, at most until the deadline', () => {
    const w = world();
    runUntil(w, 60);
    expect(w.conveyors[ON_A_WAY]!.packets.length).toBeGreaterThan(0);
    w.schedule.alarm(ON_A_WAY, w.time);
    const alarmAt = w.time;
    const started = untilStarted(w, ON_A_WAY);
    expect(started - alarmAt).toBeGreaterThan(1);
    const empty = w.conveyors[ON_A_WAY]!.packets.length === 0;
    const atDeadline = Math.abs(started - (alarmAt + w.schedule.params.window)) < 1e-6;
    expect(empty || atDeadline).toBe(true);
  });

  it('a belt whose traffic has no other way stops a second after the alarm', () => {
    const w = world();
    runUntil(w, 60);
    w.schedule.alarm(NO_OTHER_WAY, w.time);
    const alarmAt = w.time;
    expect(untilStarted(w, NO_OTHER_WAY) - alarmAt).toBeCloseTo(1, 6);
    expect(w.events.find((e) => e.kind === 'service-planned')!.text).toMatch(
      /sem outro caminho para o fluxo/,
    );
  });

  it('with another routing than the heuristic, nothing empties the belt: it stops at once', () => {
    const w = world();
    w.setPolicy('static');
    runUntil(w, 60);
    w.schedule.alarm(ON_A_WAY, w.time);
    const alarmAt = w.time;
    expect(untilStarted(w, ON_A_WAY) - alarmAt).toBeCloseTo(1, 6);
  });

  it('waits for a surge that ends before the deadline', () => {
    const w = world();
    runUntil(w, 60);
    const surge = w.failures.inject('surge', w.time)!;
    runUntil(w, surge.endsAt - 5);
    w.schedule.alarm(NO_OTHER_WAY, w.time);
    const started = untilStarted(w, NO_OTHER_WAY);
    expect(started).toBeGreaterThanOrEqual(surge.endsAt - 1e-6);
    expect(
      w.events.some((e) =>
        /manutenção adiada \d+ s, para quando a demanda prevista cair 60%/.test(e.text),
      ),
    ).toBe(true);
  });

  it('does not wait for a surge that outlasts the deadline', () => {
    const w = world();
    runUntil(w, 60);
    const surge = w.failures.inject('surge', w.time)!;
    runUntil(w, w.time + 1);
    w.schedule.alarm(NO_OTHER_WAY, w.time);
    const alarmAt = w.time;
    expect(untilStarted(w, NO_OTHER_WAY) - alarmAt).toBeCloseTo(1, 6);
    expect(surge.endsAt - alarmAt).toBeGreaterThan(w.schedule.params.window);
  });

  it('starts at the deadline at the latest, even with the belt not empty yet', () => {
    // Emptying Esteira 3 takes about 10 s; the deadline comes first.
    const w = world({ schedule: { window: 3 } });
    runUntil(w, 60);
    w.schedule.alarm(ON_A_WAY, w.time);
    const alarmAt = w.time;
    expect(untilStarted(w, ON_A_WAY) - alarmAt).toBeCloseTo(3, 6);
    expect(w.conveyors[ON_A_WAY]!.packets.length).toBeGreaterThan(0);
  });

  it('a belt that breaks before its maintenance starts is a plan lost, and the routing returns', () => {
    const w = world();
    runUntil(w, 60);
    const wear = w.failures.degrade(w.time, ON_A_WAY)!;
    const outcomes: ServiceOutcome[] = [];
    w.schedule.onOutcome = (o) => outcomes.push(o);
    // The alarm comes half a second before the breakdown: too late to do anything.
    runUntil(w, wear.breaksAt - 0.5);
    w.schedule.alarm(ON_A_WAY, w.time);
    runUntil(w, wear.breaksAt + 2);
    expect(w.isConveyorBroken(ON_A_WAY)).toBe(true);
    expect(w.schedule.lost).toBe(1);
    expect(w.schedule.plans).toHaveLength(0);
    expect(w.schedule.closing[ON_A_WAY]).toBe(0);
    expect(outcomes.map((o) => o.kind)).toEqual(['lost']);
    expect(w.events.some((e) => e.kind === 'service-lost')).toBe(true);
  });

  it('a belt stopped for maintenance cannot break down on top of it', () => {
    const w = world();
    runUntil(w, 60);
    w.schedule.alarm(NO_OTHER_WAY, w.time);
    untilStarted(w, NO_OTHER_WAY);
    expect(w.failures.inject('conveyor', w.time, NO_OTHER_WAY)).toBeNull();
    expect(w.conveyors[NO_OTHER_WAY]!.status).toBe('maintenance');
    // And the automatic failures do not pick it.
    expect(w.isConveyorBroken(NO_OTHER_WAY)).toBe(true);
  });

  it('restored in the middle of a plan or of a maintenance, it continues bit for bit', () => {
    const bytes = (w: World) =>
      new Uint8Array(new SnapshotWriter(w).write({ speed: 1, stress: false }));
    const live = world();
    runUntil(live, 60);
    const wear = live.failures.degrade(live.time, ON_A_WAY)!;
    runUntil(live, wear.onset + 10);
    live.schedule.alarm(ON_A_WAY, live.time);
    // Every 3 s through the plan, the maintenance and its end: save, run 3 s, note what came.
    const moments: { cp: Checkpoint; print: string; bytes: Uint8Array; state: number }[] = [];
    for (let s = 0; s < 51; s += 3) {
      const cp = live.saveState();
      const state = live.schedule.stateOf(ON_A_WAY);
      live.stepMany(3 * SECOND);
      moments.push({ cp, print: fingerprint(live), bytes: bytes(live), state });
    }
    // The run went through all three states of the belt.
    expect(new Set(moments.map((m) => m.state))).toEqual(new Set([0, 1, 2]));
    expect(live.schedule.avoided).toBe(1);
    const restored = world();
    for (const m of moments) {
      restored.loadState(m.cp);
      restored.stepMany(3 * SECOND);
      const t = m.cp.tick / SECOND;
      expect(fingerprint(restored), `checkpoint at ${t} s`).toBe(m.print);
      expect(bytes(restored), `checkpoint at ${t} s`).toEqual(m.bytes);
    }
  }, 60_000);

  it('on a chaotic run, the motor alarms put worn belts into maintenance before they break', () => {
    // A seed outside the training, validation and test sets.
    const w = new World({ seed: 77, scheduleMaintenance: true });
    w.setPolicy('heuristic');
    w.failures.setAuto(true, 0);
    const outcomes: ServiceOutcome[] = [];
    w.schedule.onOutcome = (o) => outcomes.push(o);
    const broke: { time: number; target: number }[] = [];
    let last = 0;
    for (let s = 0; s < 1200; s++) {
      w.stepMany(SECOND);
      for (const e of w.events) {
        if (e.id <= last) continue;
        last = e.id;
        if (e.kind === 'failure-start' && e.failure === 'conveyor') {
          broke.push({ time: e.time, target: e.target! });
        }
      }
    }
    const avoided = outcomes.filter((o) => o.kind === 'avoided');
    expect(avoided.length).toBeGreaterThan(0);
    // Each failure avoided really was: that belt did not break when its wear would have
    // (a worn belt breaks on the first step at or after `breaksAt`).
    for (const o of avoided) {
      expect(o.breaksAt).toBeGreaterThan(o.time);
      const atItsTime = (b: { time: number; target: number }) =>
        b.target === o.target && b.time >= o.breaksAt - 1e-9 && b.time < o.breaksAt + 1 / 60;
      expect(broke.some(atItsTime)).toBe(false);
    }
    expect(w.schedule.avoided + w.schedule.unneeded + w.schedule.lost).toBe(outcomes.length);
  }, 60_000);
});
