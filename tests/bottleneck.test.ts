import { describe, expect, it } from 'vitest';
import {
  BottleneckDetector,
  topologyOf,
  type BottleneckTopology,
  type QueueSeries,
} from '../src/ai/bottleneck';
import { Recorder, type SimInput } from '../src/sim/recorder';

/**
 * A recording made by hand: per second and belt (or dock), the packets
 * waiting for it, its state, its flow; and whether a surge is on.
 */
function series(o: {
  seconds: number;
  queue?: (t: number, c: number) => number;
  state?: (t: number, c: number) => number;
  /** Packets per second that leave each belt. */
  flow?: (c: number) => number;
  dockQueue?: (t: number, d: number) => number;
  blocked?: (t: number, d: number) => number;
  dockFlow?: (d: number) => number;
  surge?: (t: number) => number;
}): QueueSeries {
  const conveyors = 2;
  const docks = 1;
  const col = (n: number, f: (t: number, i: number) => number) => ({
    get: (i: number) => f(Math.floor(i / n), i % n),
  });
  return {
    seconds: o.seconds,
    conveyors,
    docks,
    conveyorQueue: col(conveyors, o.queue ?? (() => 0)),
    dockQueue: col(docks, o.dockQueue ?? (() => 0)),
    conveyorState: col(conveyors, o.state ?? (() => 0)),
    dockBlocked: col(docks, o.blocked ?? (() => 0)),
    surge: { get: (t: number) => o.surge?.(t) ?? 0 },
    conveyorExits: col(conveyors, (t, c) => Math.round(t * (o.flow?.(c) ?? 0))),
    dockDeliveries: col(docks, (t, d) => Math.round(t * (o.dockFlow?.(d) ?? 0))),
  };
}

/** Two belts on the two ways of one routing choice, the second one bridged by robots; one dock. */
const topology: BottleneckTopology = {
  conveyorLabels: ['Esteira 1 (A→B)', 'Esteira 2 (A→C)'],
  dockLabels: ['Doca 1'],
  conveyorCapacity: 2,
  dockCapacity: 1,
  ways: [{ primary: [0], alternative: [1] }],
  bypassEdges: [1],
};
const detector = new BottleneckDetector(topology);
/** A queue that grows by one packet a second from second `from` on. */
const rising = (from: number) => (t: number) => Math.max(0, t - from);

describe('bottleneck detector', () => {
  it('points out a busy belt whose queue keeps growing, and says why', () => {
    const s = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? rising(70)(t) : 0),
      flow: () => 1.8,
    });
    const b = detector.detect(s, 100)!;
    expect(b).toMatchObject({
      kind: 'conveyor',
      index: 0,
      stopped: false,
      queue: 30,
      growingFor: 30,
    });
    expect(b.use).toBeCloseTo(0.9, 2);
    expect(b.perMinute).toBeCloseTo(60, 6);
    expect(b.cause).toMatchObject({ kind: 'layout', certain: false });
    expect(b.text).toBe(
      'Gargalo: Esteira 1 (A→B) com 90% de uso no último minuto; fila de 30 pacotes crescendo há 30 s (+60 por minuto). Causa provável: a demanda passa da capacidade desta esteira.',
    );
  });

  it('does not blame a belt that moves little: its exit is held further on', () => {
    const s = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? rising(70)(t) : 0),
      flow: () => 0.6,
    });
    expect(detector.detect(s, 100)).toBeNull();
  });

  it('ignores a queue that only comes and goes', () => {
    const s = series({
      seconds: 301,
      queue: (t) => 6 + Math.round(5 * Math.sin(t / 3)),
      flow: () => 1.9,
    });
    for (let t = 60; t <= 300; t += 10) expect(detector.detect(s, t), `at ${t} s`).toBeNull();
  });

  it('a queue that has grown for less than a few seconds is not a bottleneck yet', () => {
    const s = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? Math.max(0, 15 * (t - 97)) : 0),
      flow: () => 1.8,
    });
    expect(detector.detect(s, 100)).toBeNull();
  });

  it('a stopped belt with packets waiting is the bottleneck, growing or not; the cause is certain', () => {
    const broken = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? 20 : 0),
      state: (t, c) => (c === 0 && t >= 50 ? 1 : 0),
    });
    const b = detector.detect(broken, 100)!;
    expect(b).toMatchObject({ kind: 'conveyor', index: 0, stopped: true, queue: 20 });
    expect(b.cause).toEqual({
      kind: 'conveyor',
      target: 0,
      certain: true,
      text: 'quebra desta esteira',
    });
    expect(b.text).toBe(
      'Gargalo: Esteira 1 (A→B) parada; fila de 20 pacotes. Causa: quebra desta esteira.',
    );

    const serviced = series({
      seconds: 101,
      queue: (t, c) => (c === 1 ? 20 : 0),
      state: (t, c) => (c === 1 ? 2 : 0),
    });
    expect(detector.detect(serviced, 100)!.cause).toMatchObject({
      kind: 'service',
      target: 1,
      certain: true,
      text: 'manutenção programada desta esteira, e robôs fazem o desvio',
    });
  });

  it('a blocked dock with a queue is the bottleneck', () => {
    const s = series({ seconds: 101, dockQueue: () => 14, blocked: (t) => (t >= 80 ? 1 : 0) });
    const b = detector.detect(s, 100)!;
    expect(b).toMatchObject({ kind: 'dock', index: 0, stopped: true });
    expect(b.text).toBe('Gargalo: Doca 1 bloqueada; fila de 14 pacotes. Causa: doca bloqueada.');
  });

  it('traffic diverted from a belt stopped on the other way of a routing choice is the likely cause', () => {
    // Esteira 2 is down with few packets waiting for it; Esteira 1, the other way, fills up.
    const s = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? rising(70)(t) : 3),
      state: (t, c) => (c === 1 && t >= 60 ? 1 : 0),
      flow: (c) => (c === 0 ? 1.9 : 0),
    });
    const b = detector.detect(s, 100)!;
    expect(b.index).toBe(0);
    expect(b.cause).toEqual({
      kind: 'conveyor',
      target: 1,
      certain: false,
      text: 'Esteira 2 (A→C) quebrada desvia o fluxo para cá',
    });
  });

  it('an order surge while the queue grew, or in the minute before, is the likely cause', () => {
    const queue = (t: number, c: number) => (c === 0 ? rising(70)(t) : 0);
    const during = series({
      seconds: 101,
      queue,
      flow: () => 1.8,
      surge: (t) => (t >= 60 && t < 105 ? 1 : 0),
    });
    expect(detector.detect(during, 100)!.cause.kind).toBe('surge');
    // Over 40 s before the queue started, and 60 s is the window: its wave is still crossing.
    const before = series({
      seconds: 101,
      queue,
      flow: () => 1.8,
      surge: (t) => (t >= 20 && t < 30 ? 1 : 0),
    });
    expect(detector.detect(before, 100)!.cause.kind).toBe('surge');
    // Long before: not this queue.
    const long = series({ seconds: 101, queue, flow: () => 1.8, surge: (t) => (t < 5 ? 1 : 0) });
    expect(detector.detect(long, 100)!.cause.kind).toBe('layout');
  });

  it('the worst point wins: the resource holding the most packets', () => {
    const s = series({
      seconds: 101,
      queue: (t, c) => (c === 0 ? rising(70)(t) : 2 * rising(80)(t)),
      flow: () => 1.9,
    });
    // Esteira 2 started later but holds more: 40 packets against 30.
    expect(detector.detect(s, 100)!.index).toBe(1);
    expect(detector.detect(s, 100)!.queue).toBe(40);
  });

  it('a finding stays up a few seconds after its last confirmation, then goes', () => {
    const s = series({
      seconds: 121,
      queue: (t, c) => (c === 0 ? (t <= 100 ? rising(70)(t) : 0) : 0),
      flow: () => 1.8,
    });
    expect(detector.detect(s, 100)!.second).toBe(100);
    expect(detector.detect(s, 104)!.second).toBe(100);
    expect(detector.detect(s, 106)).toBeNull();
  });
});

describe('bottleneck detector on the simulation', () => {
  function run(input: SimInput | null, seconds: number) {
    const rec = new Recorder({ seed: 5 });
    rec.input({ type: 'policy', policy: 'heuristic' });
    const detector = new BottleneckDetector(topologyOf(rec.live));
    for (let s = 1; s <= seconds; s++) {
      if (s === 120 && input) rec.input(input);
      rec.stepMany(60);
    }
    return { rec, detector };
  }

  it('a broken belt the robots bridge is pointed out with its own breakdown', () => {
    const { rec, detector } = run({ type: 'inject', kind: 'conveyor', target: 8 }, 140);
    const b = detector.detect(rec.series, 140)!;
    expect(b.label).toBe('Esteira 9 (B3→B4)');
    expect(b.cause).toMatchObject({ kind: 'conveyor', target: 8, certain: true });
    expect(b.text).toMatch(
      /^Gargalo: Esteira 9 \(B3→B4\) parada; fila de \d+ pacotes.*Causa: quebra desta esteira, e robôs fazem o desvio\.$/,
    );
  }, 30_000);

  it('a blocked dock is pointed out with its own failure', () => {
    const { rec, detector } = run({ type: 'inject', kind: 'dock', target: 2 }, 145);
    expect(detector.detect(rec.series, 145)).toMatchObject({
      kind: 'dock',
      index: 2,
      cause: { kind: 'dock' },
    });
  }, 30_000);

  it('reads only the recording: a past moment gives what it gave then', () => {
    const { rec, detector } = run({ type: 'inject', kind: 'conveyor', target: 8 }, 300);
    const then = detector.detect(rec.series, 140);
    expect(then?.label).toBe('Esteira 9 (B3→B4)');
    rec.stepMany(60 * 60);
    expect(detector.detect(rec.series, 140)).toEqual(then);
  }, 30_000);

  it('a calm run points out nothing', () => {
    const { rec, detector } = run(null, 300);
    for (let t = 60; t <= 300; t++) expect(detector.detect(rec.series, t), `at ${t} s`).toBeNull();
  }, 30_000);
});
