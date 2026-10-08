import { describe, expect, it } from 'vitest';
import { chooseFormat, WEBM_WARNING } from '../src/demo/capture';
import { cardRows } from '../src/demo/card';
import { captionText, Director, type DirectorStage } from '../src/demo/director';
import { DEMO, type DemoResult } from '../src/demo/run';
import type { SimEvent } from '../src/sim/failures';
import { pointOnEdge } from '../src/sim/graph';
import { createDefaultLayout } from '../src/sim/layout';
import type { SimCommand } from '../src/worker/protocol';

const layout = createDefaultLayout();

/** A stage that only writes down what the director asks for. */
function setup(reduced = false) {
  const sent: SimCommand[] = [];
  const aims: { x: number; z: number; radius: number; theta: number }[] = [];
  const focus: boolean[] = [];
  const heat: string[] = [];
  const stage: DirectorStage = {
    aim: (t, radius, _phi, theta) => aims.push({ x: t.x, z: t.z, radius, theta }),
    focus: (on) => focus.push(on),
    heat: (layer) => heat.push(layer),
    robot: () => ({ x: 1, z: 2 }),
    send: (cmd) => sent.push(cmd),
  };
  const director = new Director(stage, layout, () => reduced);
  const speeds = () =>
    sent.filter((c) => c.type === 'speed').map((c) => (c as { speed: number }).speed);
  return { director, sent, aims, focus, heat, speeds };
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
    director.start();
    expect(sent[0]).toEqual({ type: 'demo', action: 'start' });
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
    director.start();
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
    director.start();
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    director.onDemo({ type: 'demo', phase: 'ai-done', result: null });
    director.onDemo({ type: 'demo', phase: 'no-ai', result: null });
    director.onDemo({ type: 'demo', phase: 'done', result });
    expect(speeds().at(-1)).toBe(0);
    const state = director.frame(0.5, DEMO.end)!;
    expect(state.card?.rows).toEqual(cardRows(result));
    expect(state.card?.title).toBe('Resultado nesta execução');
    expect(state.card?.note).toMatch(/tabela de benchmarks do README/);
    expect(state.title).toBe('');
    expect(director.cardSeconds).toBeCloseTo(0.5, 9);
  });

  it('the captions follow the detector and the events the beat names', () => {
    const { director } = setup();
    director.start();
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    director.frame(0.1, 150);
    expect(director.current?.id).toBe('gargalo');
    director.onBottleneck({
      text: 'Gargalo: Esteira 9 parada. Causa: quebra desta esteira.',
    } as never);
    expect(director.frame(0.1, 151)?.text).toBe(
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
    director.start();
    director.onDemo({ type: 'demo', phase: 'ai', result: null });
    const state = director.frame(0.01, DEMO.warmup + 4)!;
    expect(state.alpha).toBe(1);
    expect(aims.at(-1)!.theta).toBe(director.beats[0]!.shot.theta);
    director.frame(0.01, DEMO.failure.at + 3);
    expect(focus.at(-1)).toBe(false);
  });

  it('stopping hands the worker back to the ordinary app', () => {
    const { director, sent } = setup();
    director.start();
    director.stop();
    expect(sent.at(-1)).toEqual({ type: 'demo', action: 'stop' });
    expect(director.active).toBe(false);
    expect(director.frame(0.1, 100)).toBeNull();
  });

  it('a caption without its live part still reads', () => {
    const beat = setup().director.beats.find((b) => b.id === 'sem-ia')!;
    expect(captionText(beat, '', '')).toBe('roteamento estático e sem manutenção preditiva.');
    expect(captionText(beat, '', 'Esteira 16 (Q2→Q1) quebrou')).toBe(
      'roteamento estático e sem manutenção preditiva. Esteira 16 (Q2→Q1) quebrou',
    );
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
