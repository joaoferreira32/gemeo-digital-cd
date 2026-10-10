import { describe, expect, it } from 'vitest';
import { chooseFormat, WEBM_WARNING } from '../src/demo/capture';
import { CARD_SCENARIO, cardRows, EXPLAINED_CARD } from '../src/demo/card';
import { captionText, Director, speedBadge, type DirectorStage } from '../src/demo/director';
import { CHAPTERS, END_TEXT } from '../src/demo/explicada';
import { DEMO, DEMO_EXPLICADA, type DemoResult } from '../src/demo/run';
import type { SimEvent } from '../src/sim/failures';
import { pointOnEdge } from '../src/sim/graph';
import { createDefaultLayout } from '../src/sim/layout';
import type { SimCommand } from '../src/worker/protocol';

const layout = createDefaultLayout();

/** A stage that only writes down what the director asks for. */
function setup(reduced = false) {
  const sent: SimCommand[] = [];
  const aims: { x: number; z: number; radius: number; theta: number; rate: number | undefined }[] =
    [];
  const focus: boolean[] = [];
  const heat: string[] = [];
  const arrows: boolean[] = [];
  const queue = { value: 0 };
  const stage: DirectorStage = {
    aim: (t, radius, _phi, theta, rate) => aims.push({ x: t.x, z: t.z, radius, theta, rate }),
    focus: (on) => focus.push(on),
    heat: (layer) => heat.push(layer),
    robot: () => ({ x: 1, z: 2 }),
    motor: () => ({ x: 5, z: 6 }),
    arrows: (on) => arrows.push(on),
    queue: () => queue.value,
    send: (cmd) => sent.push(cmd),
  };
  const director = new Director(stage, layout, () => reduced);
  const speeds = () =>
    sent.filter((c) => c.type === 'speed').map((c) => (c as { speed: number }).speed);
  return { director, sent, aims, focus, heat, speeds, arrows, queue };
}

const result: DemoResult = {
  ai: {
    delivered: 783,
    cycleP95: 133.8,
    waitP95: 86.1,
    waitingMax: 357,
    breakdowns: 1,
    avoided: 1,
  },
  noAi: {
    delivered: 493,
    cycleP95: 184.1,
    waitP95: 136.9,
    waitingMax: 546,
    breakdowns: 2,
    avoided: 0,
  },
};

const event = (kind: SimEvent['kind'], text: string): SimEvent => ({ id: 1, time: 0, kind, text });

describe('the demo director', () => {
  it('prepares, then follows the beats by the simulated time being drawn', () => {
    const { director, sent, aims, focus, speeds } = setup();
    director.start('curta');
    expect(sent[0]).toEqual({ type: 'demo', action: 'start', script: 'curta' });
    expect(director.frame(0.1, 0)?.status).toBe('Preparando a demo…');
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    expect(director.frame(0.1, DEMO.warmup + 1)?.title).toMatch(/centro de distribuição/);
    expect(director.current?.id).toBe('aberto');
    director.frame(0.1, DEMO.failure.at + 1);
    expect(director.current?.id).toBe('falha');
    expect(speeds()).toEqual([1, 2]);
    // The shot of the breakdown: the middle of the broken belt, with the depth of field.
    const mid = pointOnEdge(
      layout.graph.edge(DEMO.failure.target),
      layout.graph.edge(DEMO.failure.target).length / 2,
      {
        x: 0,
        z: 0,
        heading: 0,
      },
    );
    expect(aims.at(-1)).toMatchObject({ x: mid.x, z: mid.z, radius: 15 });
    expect(focus.at(-1)).toBe(true);
  });

  it('goes back in time when the run with AI ends, and on without AI after the hold', () => {
    const { director, sent, speeds } = setup();
    director.start('curta');
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    director.frame(0.1, DEMO.end);
    director.onDemo({ type: 'demo', phase: 'ai-done', result: null });
    expect(sent.at(-1)).toEqual({ type: 'seek', time: DEMO.branchAt });
    for (let i = 0; i < 40; i++) director.frame(0.1, DEMO.branchAt);
    expect(director.current?.id).toBe('volta');
    expect(sent.filter((c) => c.type === 'demo' && c.action === 'compare')).toHaveLength(1);
    director.onDemo({ type: 'demo', phase: 'no-ai', result: null });
    director.frame(0.1, DEMO.branchAt + 5);
    expect(director.current?.id).toBe('sem-ia');
    expect(speeds().at(-1)).toBe(32);
  });

  it('ends on the card with the numbers of both runs, the simulation paused', () => {
    const { director, speeds } = setup();
    director.start('curta');
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    director.onDemo({ type: 'demo', phase: 'ai-done', result: null });
    director.onDemo({ type: 'demo', phase: 'no-ai', result: null });
    director.onDemo({ type: 'demo', phase: 'done', result });
    expect(speeds().at(-1)).toBe(0);
    const state = director.frame(0.5, DEMO.end)!;
    expect(state.card?.rows).toEqual(cardRows(result));
    expect(state.card?.title).toBe('Resultado nesta execução');
    expect(state.card?.notes.join(' ')).toMatch(/tabela de benchmarks do README/);
    expect(state.card?.notes[0]).toBe(CARD_SCENARIO);
    expect(state.title).toBe('');
    expect(director.cardSeconds).toBeCloseTo(0.5, 9);
  });

  it('the captions follow the detector and the events the beat names', () => {
    const { director } = setup();
    director.start('curta');
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    director.frame(0.1, 140);
    expect(director.current?.id).toBe('gargalo');
    director.onBottleneck({
      text: 'Gargalo: Esteira 9 parada. Causa: quebra desta esteira.',
    } as never);
    expect(director.frame(0.1, 141)?.text).toBe(
      'Gargalo: Esteira 9 parada. Causa: quebra desta esteira.',
    );
    director.frame(0.1, 195);
    expect(director.current?.id).toBe('manutencao');
    // Before the first event, what the beat says while waiting; another kind of event is not its own.
    expect(director.frame(0.1, 196)?.text).toMatch(/começou a se desgastar/);
    director.onEvents([event('failure-start', 'Esteira 3 quebrou')]);
    expect(director.frame(0.1, 197)?.text).toMatch(/começou a se desgastar/);
    director.onEvents([
      event('failure-avoided', 'Falha evitada: Esteira 16 parou para manutenção'),
    ]);
    expect(director.frame(0.1, 217)?.text).toBe('Falha evitada: Esteira 16 parou para manutenção');
  });

  it('with reduced motion: no slow turn, no depth of field, the captions at once', () => {
    const { director, aims, focus } = setup(true);
    director.start('curta');
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    const state = director.frame(0.01, DEMO.warmup + 4)!;
    expect(state.alpha).toBe(1);
    expect(aims.at(-1)!.theta).toBe(director.beats[0]!.shot.theta);
    director.frame(0.01, DEMO.failure.at + 3);
    expect(focus.at(-1)).toBe(false);
  });

  it('stopping hands the worker back to the ordinary app', () => {
    const { director, sent } = setup();
    director.start('curta');
    director.stop();
    expect(sent.at(-1)).toEqual({ type: 'demo', action: 'stop' });
    expect(director.active).toBe(false);
    expect(director.frame(0.1, 100)).toBeNull();
  });

  it('a caption without its live part still reads', () => {
    const { director } = setup();
    director.start('curta');
    const beat = director.beats.find((b) => b.id === 'sem-ia')!;
    expect(captionText(beat, '', '')).toBe('roteamento estático e sem manutenção preditiva.');
    expect(captionText(beat, '', 'Esteira 16 (Q2→Q1) quebrou')).toBe(
      'roteamento estático e sem manutenção preditiva. Esteira 16 (Q2→Q1) quebrou',
    );
  });
});

describe('the explained demo on the page', () => {
  const E = DEMO_EXPLICADA;
  const ai = { type: 'demo', phase: 'ai', result: null } as const;

  it('is the default, with the chapter and the speed on screen', () => {
    const { director, sent } = setup();
    director.start();
    expect(sent[0]).toEqual({ type: 'demo', action: 'start', script: 'explicada' });
    director.onDemo(ai);
    const open = director.frame(0.1, E.warmup + 1)!;
    expect(open.large).toBe(true);
    expect(open.step).toEqual({ index: 1, count: 9, name: 'Abertura' });
    expect(open.badge).toBe('');
    const queue = director.frame(0.1, E.failure.at + 8)!;
    expect(queue.step).toEqual({ index: 4, count: 9, name: 'A fila cresce' });
    expect(queue.badge).toBe('2,5×');
    expect(queue.counter).not.toBeNull();
    expect(CHAPTERS).toHaveLength(9);
  });

  it('a pause holds the simulation still, says so, then plays the beat at its speed', () => {
    const { director, speeds } = setup();
    director.start();
    director.onDemo(ai);
    director.frame(0.1, E.failure.at - 1);
    expect(speeds().at(-1)).toBe(2);
    const pause = director.frame(0.1, E.failure.at)!;
    expect(director.current?.id).toBe('quebra');
    expect(speeds().at(-1)).toBe(0);
    expect(pause.badge).toBe('pausado');
    expect(pause.alert).toBe('Esteira 8 (B2→B3) quebrou');
    for (let i = 0; i < 18; i++) director.frame(0.1, E.failure.at);
    expect(speeds().at(-1)).toBe(0);
    expect(director.pausing).toBe(true);
    director.frame(0.2, E.failure.at);
    expect(speeds().at(-1)).toBe(2);
    expect(director.frame(0.1, E.failure.at + 1)!.badge).toBe('2×');
  });

  it("the diagnosis shows the detector's card, big, and the arrows light up with the AI only", () => {
    const { director, arrows } = setup();
    director.start();
    director.onDemo(ai);
    director.onBottleneck({
      text: 'Gargalo: Esteira 8 parada. Causa: quebra desta esteira.',
    } as never);
    const read = director.frame(0.1, E.aiAt - 1)!;
    expect(director.current?.id).toBe('diagnostico');
    expect(read.bottleneck).toBe('Gargalo: Esteira 8 parada. Causa: quebra desta esteira.');
    expect(read.text).toBe('O detector aponta o gargalo e explica a causa:');
    expect(arrows.at(-1)).toBe(false);
    director.frame(0.1, E.aiAt + 1);
    expect(director.current?.id).toBe('ia');
    expect(arrows.at(-1)).toBe(true);
    director.frame(0.1, 200);
    expect(arrows.at(-1)).toBe(false);
  });

  it('the queue counter keeps one sample per simulated second', () => {
    const { director, queue } = setup();
    director.start();
    director.onDemo(ai);
    for (const [t, v] of [
      [110, 40],
      [110.5, 41],
      [111, 45],
      [112.2, 50],
    ] as const) {
      queue.value = v;
      director.frame(0.05, t);
    }
    const s = director.frame(0.05, 112.6)!;
    expect(s.counter).toEqual({ value: 50, history: [40, 45, 50] });
  });

  it('back in time on a timeline, then the card, the last screen, and the end', () => {
    const { director } = setup();
    director.start();
    director.onDemo(ai);
    director.frame(0.1, E.end);
    director.onDemo({ type: 'demo', phase: 'ai-done', result: null });
    const first = director.frame(0.01, E.branchAt)!;
    expect(first.timeline?.at).toBeCloseTo(E.end, 0);
    for (let i = 0; i < 40; i++) director.frame(0.1, E.branchAt);
    expect(director.frame(0.01, E.branchAt)!.timeline?.at).toBeCloseTo(E.branchAt, 6);
    director.onDemo({ type: 'demo', phase: 'no-ai', result: null });
    const noAi = director.frame(0.1, 250)!;
    expect(noAi.title).toBe('A mesma situação, sem IA');
    expect(noAi.alert).toBe('Esteira 16 quebrou');
    expect(noAi.badge).toBe('30×');
    director.onDemo({ type: 'demo', phase: 'done', result });
    const card = director.frame(0.5, E.end)!;
    expect(card.card?.rows).toEqual(cardRows(result, EXPLAINED_CARD.avoided));
    expect(card.card?.notes).toEqual(EXPLAINED_CARD.notes);
    expect(card.card?.notes[0]).toBe(CARD_SCENARIO);
    expect(card.badge).toBe('');
    for (let i = 0; i < 186; i++) director.frame(0.1, E.end);
    expect(director.finished).toBe(false);
    const end = director.frame(0.1, E.end)!;
    expect(end.end).toBe(END_TEXT);
    expect(end.card).toBeNull();
    for (let i = 0; i < 30; i++) director.frame(0.1, E.end);
    expect(director.finished).toBe(true);
  });

  it('slower glides between shots; with reduced motion, a short veil instead of a cut', () => {
    const smooth = setup();
    smooth.director.start();
    smooth.director.onDemo(ai);
    smooth.director.frame(0.1, E.warmup + 1);
    expect(smooth.aims.at(-1)?.rate).toBeLessThan(7);
    const still = setup(true);
    still.director.start();
    still.director.onDemo(ai);
    expect(still.director.frame(0.1, E.warmup + 1)!.veil).toBe(0);
    const cut = still.director.frame(0.1, E.warmup + 6)!;
    expect(cut.veil).toBeGreaterThan(0.7);
    for (let i = 0; i < 10; i++) still.director.frame(0.1, E.warmup + 6);
    expect(still.director.frame(0.1, E.warmup + 6)!.veil).toBe(0);
  });

  it('the speed badge reads like Portuguese', () => {
    expect(speedBadge(1)).toBe('');
    expect(speedBadge(2.5)).toBe('2,5×');
    expect(speedBadge(48)).toBe('48×');
    expect(speedBadge(0)).toBe('');
  });
});

describe('the video format', () => {
  it('MP4 with H.264 when the browser records it', () => {
    const f = chooseFormat((m) => m.startsWith('video/mp4') || m.startsWith('video/webm'));
    expect(f).toMatchObject({ ext: 'mp4', label: 'MP4 (H.264)', warning: null });
    expect(f!.mime).toContain('avc1');
  });

  it('WebM only when it is all there is, with the warning about posting it', () => {
    const f = chooseFormat((m) => m === 'video/webm;codecs=vp9');
    expect(f).toMatchObject({ ext: 'webm', label: 'WebM (VP9)', warning: WEBM_WARNING });
    expect(WEBM_WARNING).toMatch(/LinkedIn/);
    expect(chooseFormat(() => false)).toBeNull();
  });
});
