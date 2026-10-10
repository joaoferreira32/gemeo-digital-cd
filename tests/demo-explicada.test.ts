import { beforeAll, describe, expect, it } from 'vitest';
import { BottleneckDetector, topologyOf } from '../src/ai/bottleneck';
import { beatSeconds, wallSeconds, type Beat } from '../src/demo/beats';
import { CARD_SCENARIO, cardRows, EXPLAINED_CARD } from '../src/demo/card';
import { CHAPTERS, END_TEXT, explainedBeats } from '../src/demo/explicada';
import { DEMO_KINDS, demoKindFrom } from '../src/demo/kinds';
import { DEMO_EXPLICADA, DemoRunner, runDemo } from '../src/demo/run';
import type { Recorder } from '../src/sim/recorder';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

/**
 * The explained demo (src/demo/explicada.ts): the same checks as the short
 * one (order, determinism, the numbers of the card) and, for every caption,
 * the fact it states, measured on the run; plus the reading rule (on screen
 * at least 1 s for every 3 words), computed on the beats' data.
 */

const E = DEMO_EXPLICADA;
const beats = explainedBeats();
const beat = (id: Beat['id']) => beats.find((b) => b.id === id) as Beat;
const inBeat = (b: Beat, time: number) => time >= b.from && time <= b.to;
/** The beats as they play: the run with AI, the jump back, without AI, the card, the end. */
const playOrder = (['ai', 'rewind', 'no-ai', 'card', 'end'] as const).flatMap((side) =>
  beats.filter((b) => b.side === side),
);

let full: ReturnType<typeof runDemo>;
/** The run with AI to its end, and the run without AI (the branch of the full run). */
let ai: Recorder;
let noAi: Recorder;

beforeAll(() => {
  full = runDemo(E);
  noAi = full.runner.rec;
  const runner = new DemoRunner(E);
  while (runner.step());
  ai = runner.rec;
}, 120_000);

describe('the explained demo', () => {
  it('is the default of V; the short one is at ?demo=curta', () => {
    expect(demoKindFrom('')).toBe('explicada');
    expect(demoKindFrom('?demo=curta')).toBe('curta');
    expect(demoKindFrom('?demo=outra')).toBe('explicada');
    expect(DEMO_KINDS.explicada.script).toBe(E);
    expect(DEMO_KINDS.curta.explained).toBe(false);
  });

  it('is the same run, bit for bit, every time', () => {
    const again = runDemo(E);
    expect(again.result).toEqual(full.result);
    expect(again.aiPrint).toBe(full.aiPrint);
    expect(again.noAiPrint).toBe(full.noAiPrint);
    expect(again.aiPrint).not.toBe(again.noAiPrint);
  }, 60_000);

  it('nine chapters, in the order of the roadmap, each with its name on screen', () => {
    expect(CHAPTERS).toEqual([
      'Abertura',
      'Como funciona',
      'O problema',
      'A fila cresce',
      'Diagnóstico',
      'A IA assume',
      'Manutenção preditiva',
      'Volta no tempo',
      'Resultado',
    ]);
    const chapters = playOrder.map((b) => b.chapter);
    expect(chapters.every((c) => c !== undefined)).toBe(true);
    for (let i = 1; i < chapters.length; i++) {
      expect(chapters[i]!).toBeGreaterThanOrEqual(chapters[i - 1]!);
    }
    expect(new Set(chapters)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    // The AI takes over after the queue and the diagnosis, not before.
    expect(beat('diagnostico').to).toBe(E.aiAt);
    expect(beat('ia').from).toBe(E.aiAt);
  });

  it('the beats follow each other without gaps, about 100 s in all', () => {
    for (const side of ['ai', 'no-ai'] as const) {
      const of = beats.filter((b) => b.side === side);
      for (let i = 1; i < of.length; i++) expect(of[i]!.from).toBe(of[i - 1]!.to);
      expect(of.at(-1)!.to).toBe(E.end);
    }
    expect(beats[0]!.from).toBe(E.warmup);
    expect(beat('sem-ia').from).toBe(E.branchAt);
    const total = wallSeconds(beats);
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(110);
  });

  it('every caption stays on screen at least 1 s for every 3 words', () => {
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    // What the detector's card says during the diagnosis (its live text, read in the pause).
    const detector = new BottleneckDetector(topologyOf(ai.live));
    const card = detector.detect(ai.series, beat('diagnostico').from);
    expect(card).not.toBeNull();
    const cardWords =
      words(EXPLAINED_CARD.title) +
      words(EXPLAINED_CARD.subtitle) +
      cardRows(full.result, EXPLAINED_CARD.avoided).reduce((n, r) => n + words(r.label), 0) +
      EXPLAINED_CARD.notes.reduce((n, t) => n + words(t), 0);
    // Beats in a row with the same words on screen add up their time.
    const runs: { ids: string[]; words: number; seconds: number }[] = [];
    let key = '';
    for (const b of playOrder) {
      const text =
        b.side === 'card'
          ? `card:${cardWords}`
          : `${b.title} ${b.text}${b.bottleneck ? ` ${card!.text}` : ''}`;
      const own = b.side === 'card' ? cardWords : words(text);
      if (b.alert) expect(beatSeconds(b)).toBeGreaterThanOrEqual(words(b.alert) / 3);
      const last = runs.at(-1);
      if (last && text === key) {
        last.ids.push(b.id);
        last.seconds += beatSeconds(b);
        last.words += b.alert ? words(b.alert) : 0;
      } else {
        runs.push({
          ids: [b.id],
          words: own + (b.alert ? words(b.alert) : 0),
          seconds: beatSeconds(b),
        });
        key = text;
      }
    }
    for (const r of runs) {
      expect(r.seconds, `${r.ids.join(' + ')}: ${r.words} palavras`).toBeGreaterThanOrEqual(
        r.words / 3,
      );
    }
    expect(beat('fim').text).toBe(END_TEXT);
  });

  it('the problem: Esteira 8 breaks at its beat, which opens with a pause', () => {
    const q = beat('quebra');
    const start = ai.events.find(
      (e) => e.kind === 'failure-start' && e.target === E.failure.target,
    );
    expect(start?.time).toBe(q.from);
    expect(q.pause).toBeGreaterThanOrEqual(2);
    expect(q.alert).toBe(`${ai.live.conveyorLabel(E.failure.target)} quebrou`);
  });

  it('the queue grows under the fixed routing, and the detector names the broken belt', () => {
    const f = beat('fila');
    expect(ai.series.waiting.get(f.to)).toBeGreaterThan(ai.series.waiting.get(f.from) + 15);
    const g = beat('diagnostico');
    const detector = new BottleneckDetector(topologyOf(ai.live));
    const b = detector.detect(ai.series, g.from);
    expect(b?.index).toBe(E.failure.target);
    expect(b?.cause).toMatchObject({ kind: 'conveyor', target: E.failure.target });
  });

  it('until the AI takes over, the run with AI is the run without it', () => {
    const upTo = (r: Recorder, to: number) =>
      Array.from({ length: to + 1 }, (_, t) => [r.series.waiting.get(t), r.series.cycleEnd.get(t)]);
    expect(upTo(ai, E.aiAt)).toEqual(upTo(noAi, E.aiAt));
    expect(upTo(ai, E.end)).not.toEqual(upTo(noAi, E.end));
    expect(ai.live.policy).toBe('heuristic');
    expect(noAi.live.policy).toBe('static');
  });

  it('the AI takes over: part of line B goes around by line A, and the queue stops growing', () => {
    const d = beat('ia');
    const crossing = 11;
    expect(ai.live.conveyorLabel(crossing)).toMatch(/B2→A2/);
    const exits = (r: Recorder) =>
      r.series.conveyorExits.get(d.to * r.series.conveyors + crossing) -
      r.series.conveyorExits.get(d.from * r.series.conveyors + crossing);
    expect(exits(ai)).toBeGreaterThan(30);
    expect(exits(noAi)).toBe(0);
    const q = (r: Recorder, t: number) => r.series.waiting.get(t);
    expect(q(ai, d.to)).toBeLessThan(q(ai, d.from));
    expect(q(noAi, d.to)).toBeGreaterThan(q(noAi, d.from));
  });

  it('maintenance: the halo turns amber, the alarm comes in its pause, the failure is avoided', () => {
    const w = E.wear.target;
    const risk = (t: number) => ai.seek(Math.round(t * 60)).health.risk(w);
    expect(risk(185)).toBeLessThan(0.25);
    expect(risk(205)).toBeGreaterThan(0.4);
    ai.backToLive();
    const alarm = ai.events.find((e) => e.kind === 'maintenance' && e.target === w);
    expect(alarm?.time).toBe(beat('alarme').from);
    expect(beat('alarme').pause).toBeGreaterThan(0);
    const avoided = ai.events.find((e) => e.kind === 'failure-avoided' && e.target === w);
    expect(avoided && inBeat(beat('evitada'), avoided.time)).toBe(true);
    expect(ai.events.some((e) => e.kind === 'failure-start' && e.target === w)).toBe(false);
  });

  it('without AI, Esteira 16 breaks when the alert says so', () => {
    const b = beat('sem-ia-quebra');
    const broke = noAi.events.find((e) => e.kind === 'failure-start' && e.target === E.wear.target);
    expect(broke).toBeDefined();
    expect(broke!.time).toBeGreaterThanOrEqual(b.from);
    expect(broke!.time).toBeLessThan(b.from + 0.5);
    expect(b.alert).toBe('Esteira 16 quebrou');
  });

  it('the card: the numbers of both runs, this run only, the scenario chosen to show each step', () => {
    const r = full.result;
    const rows = cardRows(r, EXPLAINED_CARD.avoided);
    expect(rows.at(-1)!.label).toBe('Quebras evitadas');
    expect(rows.find((x) => x.label === 'Quebras de esteira')).toMatchObject({
      ai: '1',
      noAi: '2',
    });
    expect(rows.at(-1)).toMatchObject({ ai: '1', noAi: '0' });
    expect(r.ai.delivered).toBeGreaterThan(r.noAi.delivered);
    expect(r.ai.cycleP95).toBeLessThan(r.noAi.cycleP95);
    expect(r.ai.waitP95).toBeLessThan(r.noAi.waitP95);
    expect(EXPLAINED_CARD.title).toBe('Resultado nesta execução');
    expect(EXPLAINED_CARD.subtitle).toMatch(/roteamento fixo/);
    expect(EXPLAINED_CARD.notes).toContain(CARD_SCENARIO);
    expect(EXPLAINED_CARD.notes.join(' ')).toMatch(/IC de 95%.*README/);
  });
});

describe('the explained demo through the worker host (what the page shows)', () => {
  it('runs both sides at the script ticks and posts the same result', () => {
    let now = 0;
    const posted: SimMessage[] = [];
    const host = new SimHost(
      (m) => posted.push(m),
      () => now,
    );
    host.handle({ type: 'init', config: {} });
    host.handle({ type: 'demo', action: 'start', script: 'explicada' });
    host.handle({ type: 'speed', speed: 64 });
    const demo = () =>
      posted.filter((m) => m.type === 'demo').at(-1) as Extract<SimMessage, { type: 'demo' }>;
    for (let i = 0; i < 20_000 && demo().phase === 'ai'; i++) {
      now += 50;
      host.pump();
    }
    expect(demo().phase).toBe('ai-done');
    host.handle({ type: 'seek', time: E.branchAt });
    now += 16;
    host.pump();
    host.handle({ type: 'demo', action: 'compare' });
    for (let i = 0; i < 20_000 && demo().phase === 'no-ai'; i++) {
      now += 50;
      host.pump();
    }
    expect(demo().phase).toBe('done');
    expect(demo().result).toEqual(full.result);
  }, 120_000);
});
