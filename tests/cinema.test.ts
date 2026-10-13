import { beforeAll, describe, expect, it } from 'vitest';
import {
  AVOIDED,
  BROKE,
  COMPLETA,
  FEED,
  PHRASE,
  bottleneckText,
  cinemaCardRows,
  cinemaFormatFrom,
  formatFrames,
  formatSeconds,
  itemWords,
  localAt,
  lookAt,
  momentAt,
  readingWindows,
  words,
  type CinemaFormat,
  type Item,
  type Segment,
  type SegmentId,
} from '../src/demo/cinema';
import { CinemaRun } from '../src/demo/cinema-run';
import { DEMO_EXPLICADA, runDemo } from '../src/demo/run';
import { fingerprint } from '../src/sim/fingerprint';
import { DEFAULT_DETECTOR } from '../src/sim/health';
import { SplitRouter } from '../src/sim/routing';
import { createDefaultLayout } from '../src/sim/layout';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

/**
 * The cinema demo (src/demo/cinema.ts): the data of both formats (every
 * frame on a tick, the order of the story, the reading rule counting every
 * word, number and badge on screen) and, for every text, the fact it states,
 * measured on the run each side of the split screen plays (src/demo/cinema-run.ts).
 */

const E = DEMO_EXPLICADA;
const BROKEN = E.failure.target;
const WORN = E.wear.target;
const segment = (f: CinemaFormat, id: SegmentId) => f.segments.find((s) => s.id === id) as Segment;
const item = (s: Segment, pick: (i: Item) => boolean) => s.items.find(pick) as Item;

interface Played {
  readonly ai: CinemaRun;
  readonly noAi: CinemaRun;
  /** The counter of each side at every frame, by simulated tick (the last frame on that tick). */
  readonly counter: { readonly ai: Map<number, number>; readonly noAi: Map<number, number> };
}

/** Both sides played frame by frame through a format, as the page asks for them. */
function play(f: CinemaFormat): Played {
  const ai = new CinemaRun('ai');
  const noAi = new CinemaRun('no-ai');
  const counter = { ai: new Map<number, number>(), noAi: new Map<number, number>() };
  for (let frame = 0; frame < formatFrames(f); frame++) {
    const { time } = momentAt(f, frame);
    ai.to(time);
    noAi.to(time);
    counter.ai.set(ai.tick(time), ai.queue());
    counter.noAi.set(noAi.tick(time), noAi.queue());
  }
  return { ai, noAi, counter };
}

let demo: ReturnType<typeof runDemo>;
let feed: Played;
/** What the counter showed at a simulated moment (s) of the feed. */
const queue = (r: CinemaRun, t: number) => {
  const shown = (r === feed.ai ? feed.counter.ai : feed.counter.noAi).get(r.tick(t));
  if (shown === undefined) throw new Error(`no frame at ${t} s`);
  return shown;
};
/** The counter at every frame of the feed between two simulated moments. */
const counterBetween = (r: CinemaRun, from: number, to: number) =>
  [...(r === feed.ai ? feed.counter.ai : feed.counter.noAi)]
    .filter(([tick]) => tick >= r.tick(from) && tick <= r.tick(to))
    .map(([, q]) => q);

beforeAll(() => {
  demo = runDemo(E);
  feed = play(FEED);
}, 180_000);

describe('the cinema demo: the script', () => {
  it('the feed is 60 s at 4:5 and the full version about 100 s at 16:9, 60 frames a second', () => {
    expect([FEED.width, FEED.height, FEED.split]).toEqual([1080, 1350, 'stack']);
    expect([COMPLETA.width, COMPLETA.height, COMPLETA.split]).toEqual([1920, 1080, 'side']);
    expect(formatSeconds(FEED)).toBe(60);
    expect(formatFrames(FEED)).toBe(3600);
    expect(formatSeconds(COMPLETA)).toBeGreaterThan(95);
    expect(formatSeconds(COMPLETA)).toBeLessThan(105);
    for (const f of [FEED, COMPLETA]) {
      for (const s of f.segments) expect(Number.isInteger(s.seconds * 60)).toBe(true);
    }
  });

  it('every frame shows a whole tick, and time only goes forward but for the time travel', () => {
    for (const f of [FEED, COMPLETA]) {
      let before = -Infinity;
      const jumps: number[][] = [];
      for (let frame = 0; frame < formatFrames(f); frame++) {
        const { time, speed } = momentAt(f, frame);
        expect(Math.abs(time * 60 - Math.round(time * 60))).toBeLessThan(1e-6);
        expect(Number.isInteger(speed)).toBe(true);
        if (time < before) jumps.push([before, time]);
        before = time;
      }
      // Only the full version goes back: from where the hook ended to 20 s before the breakdown.
      expect(jumps).toEqual(f === COMPLETA ? [[E.failure.at + 9.5, E.failure.at - 20]] : []);
      expect(momentAt(f, 0).time).toBe(E.failure.at);
      expect(momentAt(f, formatFrames(f) - 1).time).toBe(E.end);
    }
  });

  it('the story in order: the break, the AI taking over side by side, the X-ray, the motor, the numbers', () => {
    expect(FEED.segments.map((s) => s.id)).toEqual([
      'gancho',
      'frase',
      'dividida',
      'raiox',
      'previsao',
      'numeros',
    ]);
    expect(COMPLETA.segments.map((s) => s.id)).toEqual([
      'gancho',
      'frase',
      'volta',
      'como-esteiras',
      'como-robos',
      'quebra',
      'dividida',
      'raiox',
      'previsao',
      'numeros',
      'endereco',
    ]);
    expect(item(segment(FEED, 'frase'), (i) => i.kind === 'phrase')).toMatchObject({
      text: PHRASE,
    });
    for (const f of [FEED, COMPLETA]) {
      // The breakdown opens the hook, and the AI takes over once both runs are on screen.
      expect(segment(f, 'gancho').spans[0]?.from).toBe(E.failure.at);
      const split = segment(f, 'dividida');
      const takeover = localAt(split.spans, E.aiAt);
      expect(takeover).toBeGreaterThan(2);
      expect(takeover).toBeLessThan(split.seconds / 2);
      // What the AI does shows after it took over.
      const detour = item(split, (i) => i.kind === 'balloon');
      expect(detour.from).toBeGreaterThan(takeover);
      const solved = split.items.filter((i) => i.kind === 'caption').at(-1) as Item;
      expect(solved.from).toBeGreaterThan(detour.from);
      // The X-ray, one layer at a time: the waiting, the routes, the detour, the new bottleneck.
      const x = segment(f, 'raiox');
      const at = (kind: Item['kind'], text?: string) =>
        (
          x.items.find(
            (i) => i.kind === kind && (!text || ('text' in i && i.text === text)),
          ) as Item
        ).from;
      expect(at('balloon', 'espera (mapa de calor)')).toBe(0);
      expect(at('routes')).toBe(3);
      expect(at('balloon', 'rotas reservadas dos robôs')).toBe(3);
      expect(at('balloon', 'B2: {share}% pela linha A')).toBe(5);
      expect(at('bottleneck')).toBe(7);
      expect(lookAt(x, 4.9)).toMatchObject({ arrows: 0, ring: false });
      expect(lookAt(x, 5)).toMatchObject({ arrows: 2.6, ring: false });
      expect(lookAt(x, 7)).toMatchObject({ ring: true });
      // Each layer's label leaves when the next comes; the title stays.
      for (const label of ['espera (mapa de calor)', 'rotas reservadas dos robôs']) {
        const b = x.items.find((i) => i.kind === 'balloon' && i.text === label) as Item;
        expect(
          x.items.some((i) => i !== b && i.kind === 'balloon' && i.from < b.to && i.to > b.from),
        ).toBe(false);
      }
      // The motor: the failure avoided with AI, then the belt breaking without it.
      const p = segment(f, 'previsao');
      const avoided = item(p, (i) => i.kind === 'balloon' && i.text === AVOIDED);
      const broke = item(p, (i) => i.kind === 'pin' && i.label === BROKE);
      expect(avoided.from).toBeCloseTo(localAt(p.spans, 219), 9);
      expect(broke.from).toBeCloseTo(localAt(p.spans, 222.75), 9);
      expect(avoided.from).toBeLessThan(broke.from);
      // The counters stay off the forecast (the reading rule), and the numbers close the video.
      expect(p.items.some((i) => i.kind === 'counter')).toBe(false);
      const order = f.segments.map((s) => s.id);
      expect(order.indexOf('numeros')).toBeGreaterThan(order.indexOf('previsao'));
    }
  });

  it('every text stays on screen at least 1 s for every 3 words (every word, number and badge)', () => {
    feed.ai.rec.seek(feed.ai.tick(183));
    const card = feed.ai.bottleneck();
    feed.ai.rec.backToLive();
    expect(card).not.toBeNull();
    const live = { bottleneck: bottleneckText(card!) };
    for (const f of [FEED, COMPLETA]) {
      for (const w of readingWindows(f, live)) {
        expect(
          w.to - w.from,
          `${f.id} ${w.segment} ${w.from}–${w.to}: ${w.words} palavras`,
        ).toBeGreaterThanOrEqual(w.words / 3);
      }
      for (const s of f.segments) {
        for (const i of s.items) {
          expect(i.to - i.from, `${f.id} ${s.id} ${i.kind}`).toBeGreaterThanOrEqual(
            itemWords(i, live) / 3,
          );
          expect(i.from).toBeGreaterThanOrEqual(0);
          expect(i.to).toBeLessThanOrEqual(s.seconds + 1e-9);
        }
      }
    }
    // The counts the README gives, for the feed.
    expect(readingWindows(FEED, live).map((w) => w.words)).toEqual([9, 9, 37, 9, 4, 5, 21, 38, 37]);
    expect(words('A IA prevê a quebra|pelos sensores do motor.')).toBe(9);
  });
});

describe('the cinema demo: what each text says, on the run', () => {
  it('the hook: Esteira 8 breaks as it opens, and its queue grows', () => {
    for (const r of [feed.ai, feed.noAi]) {
      const start = r.rec.events.find((e) => e.kind === 'failure-start' && e.target === BROKEN);
      expect(start?.time).toBe(E.failure.at);
      expect(r.rec.live.conveyorLabel(BROKEN)).toBe('Esteira 8 (B2→B3)');
      expect(queue(r, 110)).toBeGreaterThan(queue(r, 104) + 30);
    }
  });

  it('until the AI takes over, the two sides are the same run, bit for bit', () => {
    const upTo = (r: CinemaRun, to: number) => {
      const s = r.rec.series;
      return Array.from({ length: to + 1 }, (_, t) => [
        s.waiting.get(t),
        s.cycleEnd.get(t),
        ...Array.from({ length: s.conveyors }, (_, c) => s.conveyorExits.get(t * s.conveyors + c)),
        ...Array.from({ length: s.conveyors }, (_, c) => s.conveyorQueue.get(t * s.conveyors + c)),
      ]);
    };
    expect(upTo(feed.ai, E.aiAt)).toEqual(upTo(feed.noAi, E.aiAt));
    expect(upTo(feed.ai, E.end)).not.toEqual(upTo(feed.noAi, E.end));
    expect(feed.ai.rec.live.policy).toBe('heuristic');
    expect(feed.noAi.rec.live.policy).toBe('static');
  });

  it('side by side: the AI sends line B by line A, and the queue of the broken belt stops growing', () => {
    for (const f of [FEED, COMPLETA]) {
      const split = segment(f, 'dividida');
      const solved = split.items.filter((i) => i.kind === 'caption').at(-1) as Item;
      const from = splitTime(f, solved.from);
      const to = split.spans.at(-1)!.to;
      // The detour: Esteira 12 (B2→A2) carries line B's packets only with AI.
      const crossing = 11;
      expect(feed.ai.rec.live.conveyorLabel(crossing)).toMatch(/B2→A2/);
      const exits = (r: CinemaRun) =>
        r.rec.series.conveyorExits.get(to * r.rec.series.conveyors + crossing) -
        r.rec.series.conveyorExits.get(E.aiAt * r.rec.series.conveyors + crossing);
      expect(exits(feed.ai)).toBeGreaterThan(30);
      expect(exits(feed.noAi)).toBe(0);
      // While the caption says so, frame by frame: with AI the counter holds still, without AI it grows.
      const withAi = counterBetween(feed.ai, from, to);
      expect(withAi.length).toBeGreaterThan(100);
      expect(Math.max(...withAi)).toBeLessThanOrEqual(queue(feed.ai, from));
      expect(queue(feed.ai, from)).toBeLessThan(queue(feed.ai, E.aiAt));
      expect(queue(feed.noAi, to)).toBeGreaterThan(queue(feed.noAi, from) + 30);
    }
    // With AI, from the detour on until the belt is repaired: the 10 packets stopped on it, every frame.
    expect(new Set(counterBetween(feed.ai, 130, 189))).toEqual(new Set([10]));
  });

  it('the X-ray: B2 sends all by line A, and the detector names Esteira 3, overloaded by the detour', () => {
    const x = segment(FEED, 'raiox');
    const r = feed.ai;
    const b2 = new SplitRouter(
      r.rec.live.layout.graph,
      r.rec.live.layout.dockNodes,
    ).decisions.findIndex((d) => d.primary === BROKEN);
    const share = (t: number) => r.rec.seek(r.tick(t)).routing.share[b2] as number;
    const detourFrom = 176 + item(x, (i) => i.kind === 'balloon' && i.text.startsWith('B2')).from;
    for (let t = detourFrom; t <= detourFrom + 2; t++) expect(Math.round(share(t) * 100)).toBe(100);
    r.rec.backToLive();
    const cardFrom = 176 + item(x, (i) => i.kind === 'bottleneck').from;
    for (let t = cardFrom; t <= 190; t++) {
      r.rec.seek(r.tick(t));
      const b = r.bottleneck();
      expect(b?.kind).toBe('conveyor');
      expect(b?.index).toBe(2);
      expect(b?.cause).toMatchObject({ kind: 'conveyor', target: BROKEN, certain: false });
    }
    r.rec.seek(r.tick(cardFrom));
    expect(bottleneckText(r.bottleneck()!)).toBe(
      'Esteira 3 (A2→A3), 87% de uso. Causa provável: a Esteira 8 quebrada desvia o fluxo para cá.',
    );
    r.rec.backToLive();
  });

  it('the motor: with AI, the alarm and the failure avoided; without it, no maintenance, and the belt breaks', () => {
    const ai = feed.ai.rec.events;
    const no = feed.noAi.rec.events;
    const at = (events: typeof ai, kind: string) =>
      events
        .filter((e) => e.kind === kind && e.target === WORN)
        .map((e) => Math.round(e.time * 100) / 100);
    expect(at(ai, 'maintenance')).toEqual([218]);
    expect(at(ai, 'service-planned')).toEqual([218]);
    expect(at(ai, 'failure-avoided')).toEqual([219]);
    expect(at(ai, 'failure-start')).toEqual([]);
    expect(at(no, 'service-planned')).toEqual([]);
    expect(no.some((e) => e.kind === 'service-planned' || e.kind === 'service-start')).toBe(false);
    expect(at(no, 'failure-start')).toEqual([222.75]);
    // The chart's dashed line is the alarm's limit, and the sum rises toward it.
    expect(DEFAULT_DETECTOR.threshold).toBe(48);
    const sum = (t: number) => feed.ai.rec.seek(feed.ai.tick(t)).health.sum[WORN] as number;
    expect(sum(190)).toBeLessThan(10);
    expect(sum(214)).toBeGreaterThan(40);
    expect(sum(214)).toBeLessThan(48);
    feed.ai.rec.backToLive();
  });

  it('the card: both runs from the breakdown to the end, the numbers of the explained demo', () => {
    expect(feed.ai.measures()).toEqual(demo.result.ai);
    expect(feed.noAi.measures()).toEqual(demo.result.noAi);
    const rows = cinemaCardRows(
      ['entregas', 'ciclo', 'espera', 'quebras', 'evitadas'],
      demo.result.ai,
      demo.result.noAi,
    );
    expect(rows).toEqual([
      { headline: '+49%', label: 'entregas', noAi: '622', ai: '928' },
      { headline: '−43%', label: 'p95 do ciclo', noAi: '158 s', ai: '91 s' },
      { headline: '−66%', label: 'p95 de espera', noAi: '128 s', ai: '44 s' },
      { headline: '', label: 'quebras de esteira', noAi: '2', ai: '1' },
      { headline: '', label: 'quebras evitadas', noAi: '0', ai: '1' },
    ]);
  });

  it('the same runs as the explained demo, and the time travel lands on the same world', () => {
    expect(fingerprint(feed.ai.rec.live)).toBe(demo.aiPrint);
    expect(fingerprint(feed.noAi.rec.live)).toBe(demo.noAiPrint);
    const full = play(COMPLETA);
    expect(full.ai.jumps).toBe(1);
    expect(fingerprint(full.ai.rec.live)).toBe(demo.aiPrint);
    expect(fingerprint(full.noAi.rec.live)).toBe(demo.noAiPrint);
  }, 180_000);
});

describe('the cinema demo on the page', () => {
  it('plays at ?demo=cinema (the feed) or ?demo=cinema-completa; V and ⇧V play the others otherwise', () => {
    expect(cinemaFormatFrom('?demo=cinema')).toBe('feed');
    expect(cinemaFormatFrom('?demo=cinema-completa')).toBe('completa');
    expect(cinemaFormatFrom('?demo=curta')).toBeNull();
    expect(cinemaFormatFrom('')).toBeNull();
  });

  it('the routing tells where the next packet goes without spending its share', () => {
    const layout = createDefaultLayout();
    const router = new SplitRouter(layout.graph, layout.dockNodes);
    const d = router.decisions.findIndex((x) => x.primary === BROKEN);
    const decision = router.decisions[d]!;
    const node = layout.graph.edge(BROKEN).from;
    const dock = decision.docks[0]!;
    const packet = { destination: dock } as Parameters<SplitRouter['nextEdge']>[1];
    expect(router.decisionAt(node, dock)).toBe(d);
    router.share[d] = 0.5;
    const taken: number[] = [];
    for (let i = 0; i < 6; i++) {
      const peeked = router.peekEdge(node, dock);
      expect(router.peekEdge(node, dock)).toBe(peeked);
      expect(router.nextEdge(node, packet)).toBe(peeked);
      taken.push(peeked);
    }
    // Half by each way: the peek follows the alternation.
    expect(new Set(taken)).toEqual(new Set([decision.primary, decision.alternative]));
  });
});

describe('the cinema demo through the worker host', () => {
  it('answers each frame with its snapshot, the queue, the detector and, when asked, the measures', () => {
    const posted: SimMessage[] = [];
    const host = new SimHost(
      (m) => posted.push(m),
      () => 0,
    );
    host.handle({ type: 'init', config: {} });
    host.handle({ type: 'cinema', action: 'start', side: 'ai' });
    posted.length = 0;
    host.pump();
    expect(posted).toEqual([]);
    host.handle({ type: 'cinema', action: 'to', time: 110, frame: 7, measure: false });
    const first = posted.at(-1) as Extract<SimMessage, { type: 'cinema' }>;
    expect(first.type).toBe('cinema');
    expect(first.frame).toBe(7);
    expect(first.buffer.byteLength).toBeGreaterThan(0);
    expect(first.measure).toBeNull();
    expect(first.queue).toBe(queue(feed.ai, 110));
    expect(first.events.some((e) => e.kind === 'failure-start' && e.target === BROKEN)).toBe(true);
    host.handle({ type: 'cinema', action: 'to', time: E.end, frame: 8, measure: true });
    const last = posted.at(-1) as Extract<SimMessage, { type: 'cinema' }>;
    expect(last.measure).toEqual(demo.result.ai);
    // Back to the ordinary app: an init, and the regular snapshots again.
    posted.length = 0;
    host.handle({ type: 'init', config: {} });
    expect(posted.some((m) => m.type === 'snapshot')).toBe(true);
  }, 120_000);
});

/** The simulated second at which a split caption starts, rounded up to a whole second. */
function splitTime(f: CinemaFormat, local: number): number {
  const s = segment(f, 'dividida');
  const span = s.spans[0]!;
  return Math.ceil(span.from + span.speed * local);
}
