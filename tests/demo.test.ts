import { beforeAll, describe, expect, it } from 'vitest';
import { BottleneckDetector, topologyOf } from '../src/ai/bottleneck';
import { beatAt, demoBeats, wallSeconds, type Beat } from '../src/demo/beats';
import { cardRows } from '../src/demo/card';
import { DEMO, DemoRunner, runDemo, type DemoResult } from '../src/demo/run';
import type { Recorder } from '../src/sim/recorder';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

const beats = demoBeats();
const beat = (id: Beat['id']) => beats.find((b) => b.id === id) as Beat;
let full: ReturnType<typeof runDemo>;
/** The run with AI to its end (the full run above drops it when it goes back in time). */
let ai: Recorder;

beforeAll(() => {
  full = runDemo();
  const runner = new DemoRunner();
  while (runner.step());
  ai = runner.rec;
}, 120_000);

const inBeat = (b: Beat, time: number) => time >= b.from && time <= b.to;

describe('the demo script', () => {
  it('is the same run, bit for bit, every time', () => {
    const again = runDemo();
    expect(again.result).toEqual(full.result);
    expect(again.aiPrint).toBe(full.aiPrint);
    expect(again.noAiPrint).toBe(full.noAiPrint);
    expect(again.aiPrint).not.toBe(again.noAiPrint);
  }, 60_000);

  it('the breakdown, the detour of the robots and of the routing', () => {
    const f = beat('falha');
    const start = ai.events.find(
      (e) => e.kind === 'failure-start' && e.target === DEMO.failure.target,
    );
    expect(start && inBeat(f, start.time)).toBe(true);
    expect(ai.events.some((e) => e.kind === 'bypass-start' && inBeat(f, e.time))).toBe(true);
    // During "desvio": nothing leaves the broken belt, the A line carries the traffic.
    const d = beat('desvio');
    const s = ai.series;
    const exits = (belt: number) =>
      s.conveyorExits.get(d.to * s.conveyors + belt) -
      s.conveyorExits.get(d.from * s.conveyors + belt);
    expect(exits(DEMO.failure.target)).toBe(0);
    for (const belt of [11, 2, 3]) expect(exits(belt)).toBeGreaterThan(0);
  });

  it('the queue grows, and the detector names the broken belt with its own failure', () => {
    const q = beat('fila');
    expect(ai.series.waiting.get(q.to)).toBeGreaterThan(ai.series.waiting.get(q.from) + 50);
    const g = beat('gargalo');
    const detector = new BottleneckDetector(topologyOf(ai.live));
    let named = 0;
    let total = 0;
    for (let t = g.from; t < g.to; t++) {
      const b = detector.detect(ai.series, t);
      total++;
      if (
        b?.index === DEMO.failure.target &&
        b.cause.kind === 'conveyor' &&
        b.cause.target === DEMO.failure.target
      ) {
        named++;
      }
    }
    expect(named / total).toBeGreaterThan(0.9);
  });

  it('maintenance catches the worn motor; without AI it breaks', () => {
    const m = beat('manutencao');
    const w = DEMO.wear.target;
    expect(
      ai.events.some((e) => e.kind === 'maintenance' && e.target === w && inBeat(m, e.time)),
    ).toBe(true);
    expect(
      ai.events.some((e) => e.kind === 'failure-avoided' && e.target === w && inBeat(m, e.time)),
    ).toBe(true);
    expect(ai.events.some((e) => e.kind === 'failure-start' && e.target === w)).toBe(false);
    const noAi = full.runner.rec;
    const n = beat('sem-ia');
    expect(
      noAi.events.some((e) => e.kind === 'failure-start' && e.target === w && inBeat(n, e.time)),
    ).toBe(true);
    // The same breakdown of the script came again, at its tick.
    expect(
      noAi.events.some(
        (e) =>
          e.kind === 'failure-start' &&
          e.target === DEMO.failure.target &&
          e.time === DEMO.failure.at,
      ),
    ).toBe(true);
    expect(noAi.live.policy).toBe('static');
    expect(noAi.live.schedule.enabled).toBe(false);
  });

  it('the card shows the numbers of the two runs, as computed', () => {
    const r: DemoResult = full.result;
    const rows = cardRows(r);
    const byLabel = (label: string) => rows.find((x) => x.label === label)!;
    const s = (v: number) => `${Math.round(v).toLocaleString('pt-BR')} s`;
    expect(byLabel('p95 do ciclo')).toMatchObject({
      ai: s(r.ai.cycleP95),
      noAi: s(r.noAi.cycleP95),
    });
    expect(byLabel('p95 de espera')).toMatchObject({
      ai: s(r.ai.waitP95),
      noAi: s(r.noAi.waitP95),
    });
    expect(byLabel('Entregas').ai).toBe(r.ai.delivered.toLocaleString('pt-BR'));
    const pct = Math.round(((r.ai.cycleP95 - r.noAi.cycleP95) / r.noAi.cycleP95) * 100);
    expect(byLabel('p95 do ciclo').change).toBe(`${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`);
    expect(byLabel('Quebras de esteira')).toMatchObject({ ai: '1, e 1 evitada', noAi: '2' });
    // In this run the AI delivers more, with shorter cycles and waits.
    expect(r.ai.delivered).toBeGreaterThan(r.noAi.delivered);
    expect(r.ai.cycleP95).toBeLessThan(r.noAi.cycleP95);
    expect(r.ai.waitP95).toBeLessThan(r.noAi.waitP95);
  });

  it('the beats follow each other without gaps and last about a minute', () => {
    for (const side of ['ai', 'no-ai'] as const) {
      const of = beats.filter((b) => b.side === side);
      for (let i = 1; i < of.length; i++) expect(of[i]!.from).toBe(of[i - 1]!.to);
      expect(of.at(-1)!.to).toBe(DEMO.end);
    }
    expect(beats[0]!.from).toBe(DEMO.warmup);
    expect(beat('sem-ia').from).toBe(DEMO.branchAt);
    const total = wallSeconds(beats);
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThan(65);
    expect(beatAt(beats, 'ai', DEMO.failure.at).id).toBe('falha');
    expect(beatAt(beats, 'ai', 10_000).id).toBe('segue');
  });
});

describe('the demo through the worker host (what the page shows)', () => {
  it('runs both sides at the script ticks and posts the same result', () => {
    let now = 0;
    const posted: SimMessage[] = [];
    const host = new SimHost(
      (m) => posted.push(m),
      () => now,
    );
    host.handle({ type: 'init', config: {} });
    host.handle({ type: 'demo', action: 'start' });
    host.handle({ type: 'speed', speed: 64 });
    const demo = () =>
      posted.filter((m) => m.type === 'demo').at(-1) as Extract<SimMessage, { type: 'demo' }>;
    for (let i = 0; i < 20_000 && demo().phase === 'ai'; i++) {
      now += 50;
      host.pump();
    }
    expect(demo().phase).toBe('ai-done');
    // The page shows the moment before the breakdown, then asks to go on without AI.
    host.handle({ type: 'seek', time: DEMO.branchAt });
    now += 16;
    host.pump();
    host.handle({ type: 'demo', action: 'compare' });
    expect(demo().phase).toBe('no-ai');
    for (let i = 0; i < 20_000 && demo().phase === 'no-ai'; i++) {
      now += 50;
      host.pump();
    }
    expect(demo().phase).toBe('done');
    expect(demo().result).toEqual(full.result);
  }, 120_000);
});
