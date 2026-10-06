import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/sim/failures';
import { HEADER, readSnapshot } from '../src/sim/snapshot';
import type { RunReport } from '../src/sim/recorder';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';
import type { AgentLoader } from '../src/worker/routing';
import { markers } from '../src/worker/views';

function makeHost(agentLoader?: AgentLoader) {
  let now = 0;
  const posted: SimMessage[] = [];
  const host = new SimHost(
    (msg) => posted.push(msg),
    () => now,
    agentLoader,
  );
  const pump = (ms: number, times = 1) => {
    for (let i = 0; i < times; i++) {
      now += ms;
      host.pump();
    }
  };
  /** The newest snapshot's header. */
  const header = () => {
    const snap = posted.filter((m) => m.type === 'snapshot').at(-1);
    if (snap?.type !== 'snapshot') throw new Error('no snapshot');
    return readSnapshot(snap.buffer).header;
  };
  return { host, posted, pump, header, advanceClock: (ms: number) => (now += ms) };
}

describe('SimHost time travel', () => {
  it('shows a past moment with a cut, replaying within the frame budget, then goes back to live', () => {
    const { host, posted, pump, header } = makeHost();
    host.handle({ type: 'init', config: { seed: 5 } });
    host.handle({ type: 'advance', seconds: 120 });
    host.handle({ type: 'seek', time: 50 });
    const h = header();
    expect(h[HEADER.mode]).toBe(1);
    expect(h[HEADER.cut]).toBe(1);
    expect(h[HEADER.head]).toBeCloseTo(120, 6);
    expect(h[HEADER.speed]).toBe(0);
    // Restored at the 30 s checkpoint; the replay to 50 s runs in later pumps.
    pump(16, 200);
    expect(host.currentWorld.time).toBeCloseTo(50, 6);
    expect(header()[HEADER.cut]).toBe(0);
    // The live run waited at the head the whole time.
    expect(host.currentRecorder.headTick).toBe(120 * 60);
    host.handle({ type: 'live' });
    expect(header()[HEADER.mode]).toBe(0);
    expect(header()[HEADER.cut]).toBe(1);
    expect(host.currentWorld.time).toBeCloseTo(120, 6);
    const statuses = posted.filter((m) => m.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
  });

  it('an input given in the past continues the run from there', () => {
    const { host, header } = makeHost();
    host.handle({ type: 'init', config: { seed: 5 } });
    host.handle({ type: 'advance', seconds: 90 });
    host.handle({ type: 'seek', time: 60 });
    host.handle({ type: 'inject', kind: 'dock', target: 1 });
    expect(header()[HEADER.mode]).toBe(0);
    expect(host.currentRecorder.headTick).toBe(60 * 60);
    expect(host.currentRecorder.branches).toEqual([60 * 60]);
    expect(host.currentWorld.docks[1]!.blockedUntil).toBeGreaterThan(60);
  });

  it('exports the event log and a report that loads back to the same end', () => {
    const { host, posted, pump } = makeHost();
    host.handle({ type: 'init', config: { seed: 9 } });
    host.handle({ type: 'inject', kind: 'conveyor', target: 2 });
    host.handle({ type: 'advance', seconds: 40 });
    host.handle({ type: 'export', what: 'csv' });
    host.handle({ type: 'export', what: 'report' });
    const files = posted.filter((m) => m.type === 'export');
    expect(files.map((f) => f.type === 'export' && f.filename)).toEqual([
      'gemeo-cd-seed9-40s-eventos.csv',
      'gemeo-cd-seed9-40s-relatorio.json',
    ]);
    const csv = files[0]!.type === 'export' ? files[0]!.text : '';
    expect(csv).toContain('Falha;Esteira 3');
    const report = JSON.parse(files[1]!.type === 'export' ? files[1]!.text : '') as RunReport;

    host.handle({ type: 'init', config: { seed: 1 } });
    host.handle({ type: 'load-report', report });
    for (let i = 0; i < 400 && !posted.some((m) => m.type === 'replay' && m.done); i++) pump(16);
    const done = posted.find((m) => m.type === 'replay' && m.done);
    expect(done?.type === 'replay' && done.ok).toBe(true);
    expect(host.currentWorld.tick).toBe(report.endTick);
    expect(host.currentWorld.config.seed).toBe(9);
  });

  it('refuses a file that is not a report', () => {
    const { host, posted } = makeHost();
    host.handle({ type: 'load-report', report: { format: 'x' } as unknown as RunReport });
    expect(posted).toContainEqual({
      type: 'error',
      message: 'Este arquivo não é um relatório do simulador.',
    });
  });

  it('answers the history of a robot, a conveyor and a dock', () => {
    const { host, posted } = makeHost();
    host.handle({ type: 'init', config: { seed: 3 } });
    host.handle({ type: 'inject', kind: 'robot', target: 4 });
    host.handle({ type: 'advance', seconds: 90 });
    for (const entity of ['robot:4', 'conveyor:3', 'dock:2']) {
      host.handle({ type: 'history', entity });
      const m = posted.at(-1);
      if (m?.type !== 'history') throw new Error(`no history for ${entity}`);
      expect(m.history.entity).toBe(entity);
      expect(m.history.series).toHaveLength(300);
      expect(m.history.use).toBeGreaterThanOrEqual(0);
      expect(m.history.use).toBeLessThanOrEqual(1);
    }
    host.handle({ type: 'history', entity: 'robot:4' });
    const robot = posted.at(-1);
    // Newest first: the repair (40 to 60 s after the failure), then the failure.
    expect(robot?.type === 'history' && robot.history.events.map((e) => e.text)).toEqual([
      'Robô 5 consertado',
      'Robô 5 com defeito',
    ]);
    host.handle({ type: 'history', entity: 'robot:999' });
    expect(posted.at(-1)?.type).toBe('error');
  });
});

describe('SimHost routing (key P)', () => {
  const routingOf = (posted: SimMessage[]) => {
    const s = posted.filter((m) => m.type === 'status').at(-1);
    if (s?.type !== 'status') throw new Error('no status');
    return s.routing;
  };
  /** Lets the promises of the agent settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('starts with the heuristic (the official policy), compared live with a static copy from tick 0', () => {
    const { host, posted, pump, header } = makeHost();
    host.handle({ type: 'init', config: { seed: 5 } });
    host.handle({ type: 'advance', seconds: 30 });
    pump(600);
    expect(header()[HEADER.policy]).toBe(1);
    const r = routingOf(posted);
    expect(r.shown).toBe('heuristic');
    expect(r.compare?.since).toBe(0);
    // A recorded input at tick 0, so the past and the reports have it too.
    expect(host.currentRecorder.inputs[0]).toEqual({
      tick: 0,
      input: { type: 'policy', policy: 'heuristic' },
    });
    // And again after a restart.
    host.handle({ type: 'restart' });
    pump(600);
    expect(header()[HEADER.policy]).toBe(1);
  });

  it('switches who routes; the past keeps its own; a static copy runs from the switch', () => {
    const { host, posted, pump, header } = makeHost();
    host.handle({ type: 'init', config: { seed: 5 } });
    host.handle({ type: 'policy', policy: 'static' });
    host.handle({ type: 'advance', seconds: 30 });
    pump(600);
    expect(header()[HEADER.policy]).toBe(0);
    expect(routingOf(posted).compare).toBeNull();
    const switchedAt = host.currentWorld.time;
    host.handle({ type: 'policy', policy: 'heuristic' });
    host.handle({ type: 'advance', seconds: 60 });
    pump(600);
    expect(header()[HEADER.policy]).toBe(1);
    let r = routingOf(posted);
    expect(r.shown).toBe('heuristic');
    expect(r.compare?.since).toBeCloseTo(switchedAt, 6);
    // The copy took the same 60 s with the static routing.
    expect(r.compare!.live.delivered).toBeGreaterThan(100);
    expect(r.compare!.shadow.delivered).toBeGreaterThan(100);
    // Before the switch, the static routing: no comparison in the past.
    host.handle({ type: 'seek', time: 20 });
    pump(16, 100);
    pump(600);
    expect(header()[HEADER.policy]).toBe(0);
    r = routingOf(posted);
    expect(r.shown).toBe('static');
    expect(r.compare).toBeNull();
    host.handle({ type: 'live' });
    pump(600);
    expect(routingOf(posted).compare).not.toBeNull();
    host.handle({ type: 'policy', policy: 'static' });
    pump(600);
    expect(routingOf(posted).compare).toBeNull();
  });

  it('the agent decides at every simulated second; its shares are inputs that a report replays', async () => {
    let calls = 0;
    const { host, posted, pump, header, advanceClock } = makeHost(async () => async () => {
      calls++;
      return [4, 0, 2, 1, 3];
    });
    host.handle({ type: 'init', config: { seed: 7 } });
    host.handle({ type: 'policy', policy: 'rl', model: 'x' });
    advanceClock(600);
    host.pump();
    // Asked for while the network loads: still the heuristic until it is ready.
    expect(routingOf(posted).wanted).toBe('rl');
    expect(routingOf(posted).agent).toBe('loading');
    expect(header()[HEADER.policy]).toBe(1);
    await settle();
    host.handle({ type: 'speed', speed: 16 });
    // Each pump runs until the next second, which waits for the agent's answer.
    for (let i = 0; i < 200; i++) {
      advanceClock(40);
      host.pump();
      await settle();
    }
    const rec = host.currentRecorder;
    const shares = rec.inputs.filter((i) => i.input.type === 'shares');
    expect(calls).toBeGreaterThan(10);
    expect(shares.length).toBe(calls);
    for (const s of shares) expect(s.tick % 60).toBe(0);
    expect(Array.from(host.currentWorld.routing.share)).toEqual([1, 0, 0.5, 0.25, 0.75]);
    expect(header()[HEADER.policy]).toBe(2);
    // The report runs again without the network and ends in the same state.
    host.handle({ type: 'export', what: 'report' });
    const file = posted.filter((m) => m.type === 'export').at(-1);
    const report = JSON.parse(file?.type === 'export' ? file.text : '') as RunReport;
    host.handle({ type: 'load-report', report });
    for (let i = 0; i < 400 && !posted.some((m) => m.type === 'replay' && m.done); i++) pump(16);
    const done = posted.find((m) => m.type === 'replay' && m.done);
    expect(done?.type === 'replay' && done.ok).toBe(true);
  });
});

describe('Timeline markers', () => {
  const ev = (id: number, time: number, extra: Partial<SimEvent>): SimEvent => ({
    id,
    time,
    kind: 'failure-start',
    text: `e${id}`,
    ...extra,
  });

  it('pairs each failure and each stuck robot with its own end', () => {
    const m = markers([
      ev(1, 10, { failure: 'conveyor', target: 2 }),
      ev(2, 12, { failure: 'conveyor', target: 5 }),
      ev(3, 20, { kind: 'failure-end', failure: 'conveyor', target: 5 }),
      ev(4, 25, { kind: 'robot-stuck', about: ['robot:7'] }),
      ev(5, 30, { kind: 'watchdog', about: ['robot:7'] }),
      ev(6, 40, { kind: 'robot-moving', about: ['robot:7'] }),
      ev(7, 50, { kind: 'failure-end', failure: 'conveyor', target: 2 }),
      ev(8, 55, { failure: 'surge', target: -1 }),
    ]);
    expect(m.map((x) => [x.kind, x.start, x.end])).toEqual([
      ['conveyor', 10, 50],
      ['conveyor', 12, 20],
      ['stuck', 25, 40],
      ['watchdog', 30, 30],
      ['surge', 55, null],
    ]);
  });
});
