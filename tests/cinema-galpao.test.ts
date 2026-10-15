import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESS_CTA,
  BROKE,
  COMPARE_TITLE,
  GALPAO,
  GALPAO_COMPLETA,
  GATE_ROBOT,
  LOG_EXAMPLE,
  LOG_STATUS,
  LOG_TEXT,
  MONITOR_TITLE,
  PROTAGONIST,
  SCALE,
  SHELF_ROBOT,
  TEASER_AT,
  TEASER_TEXT,
  TOUR_FROM,
  bottleneckText,
  cinemaCardRows,
  cinemaFormatFrom,
  formatFrames,
  formatSeconds,
  itemsAt,
  localAt,
  momentAt,
  panesOf,
  readingWindows,
  rewindMoments,
  rewindText,
  words,
  type CinemaFormat,
  type CinemaLogLine,
  type Item,
  type LogKind,
  type Segment,
  type SegmentId,
} from '../src/demo/cinema';
import { drawCinema, type OverlayScene } from '../src/demo/cinema-overlay';
import { CinemaRun } from '../src/demo/cinema-run';
import { DEMO_EXPLICADA, runDemo } from '../src/demo/run';
import { decodeFrame } from '../src/link/frames';
import { fingerprint } from '../src/sim/fingerprint';
import { HEADER } from '../src/sim/snapshot';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

/**
 * The cinema demo with the warehouse tour and the AI at work (src/demo/cinema.ts,
 * GALPAO and GALPAO_COMPLETA): the script (every frame on a tick, time going
 * back only in the rewind, the order of the story, the reading rule, the
 * first frame and the end card), every fact it puts on screen measured on the
 * runs (the tour's packet and robots, the scale, the AI's log and costs, the
 * detector, the motors), the rewind through the worker, and where words may go
 * (none in the bottom 8% of the frame, none on its edges).
 */

const E = DEMO_EXPLICADA;
const BROKEN = E.failure.target;
const WORN = E.wear.target;
const FORMATS = [GALPAO, GALPAO_COMPLETA] as const;
const segment = (f: CinemaFormat, id: SegmentId) => f.segments.find((s) => s.id === id) as Segment;
const itemsOf = (s: Segment, kind: Item['kind']) => s.items.filter((i) => i.kind === kind);

/** Video seconds at which a segment starts. */
function startOf(f: CinemaFormat, id: SegmentId): number {
  let t = 0;
  for (const s of f.segments) {
    if (s.id === id) return t;
    t += s.seconds;
  }
  throw new Error(id);
}

interface Played {
  readonly ai: CinemaRun;
  readonly noAi: CinemaRun;
  /** Each side's counter at a simulated tick (the last frame on it). */
  readonly counter: { readonly ai: Map<number, number>; readonly noAi: Map<number, number> };
  /** The worlds at the end of the script (before the end card plays on). */
  readonly prints: { ai: string; noAi: string };
}

/**
 * Both sides through a format as the page asks for them: from where the
 * rewind lands; a rewind's frames come from what the run kept (the run does
 * not move), and the next frame goes back for real.
 */
function play(f: CinemaFormat): Played {
  const ai = new CinemaRun('ai', undefined, TOUR_FROM);
  const noAi = new CinemaRun('no-ai', undefined, TOUR_FROM);
  const counter = { ai: new Map<number, number>(), noAi: new Map<number, number>() };
  const prints = { ai: '', noAi: '' };
  for (let frame = 0; frame < formatFrames(f); frame++) {
    const { time, speed } = momentAt(f, frame);
    if (speed < 0) continue;
    ai.to(time);
    noAi.to(time);
    counter.ai.set(ai.tick(time), ai.queue());
    counter.noAi.set(noAi.tick(time), noAi.queue());
    if (time === E.end && !prints.ai) {
      prints.ai = fingerprint(ai.rec.live);
      prints.noAi = fingerprint(noAi.rec.live);
    }
  }
  return { ai, noAi, counter, prints };
}

let demo: ReturnType<typeof runDemo>;
let feed: Played;
/** A run of the AI side, for the detector's words where its cards show. */
let ai: CinemaRun;

beforeAll(() => {
  demo = runDemo(E);
  feed = play(GALPAO);
  ai = new CinemaRun('ai', undefined, 0);
}, 240_000);

describe('the tour: the script', () => {
  it('the feed (4:5) and the long version (16:9, about two minutes), 60 frames a second, made for a feed', () => {
    expect([GALPAO.width, GALPAO.height, GALPAO.split]).toEqual([1080, 1350, 'stack']);
    expect([GALPAO_COMPLETA.width, GALPAO_COMPLETA.height, GALPAO_COMPLETA.split]).toEqual([
      1920,
      1080,
      'side',
    ]);
    expect(formatSeconds(GALPAO)).toBe(105.75);
    expect(formatFrames(GALPAO)).toBe(6345);
    expect(formatSeconds(GALPAO_COMPLETA)).toBeGreaterThan(110);
    expect(formatSeconds(GALPAO_COMPLETA)).toBeLessThan(130);
    for (const f of FORMATS) {
      for (const s of f.segments) expect(Number.isInteger(s.seconds * 60)).toBe(true);
      // A high bitrate (a site re-encodes the video), no words in the bottom 8% nor on the edges,
      // and a warm-up before the first frame.
      expect(f.bitrate).toBeGreaterThanOrEqual(20e6);
      expect(f.bitrate).toBeLessThanOrEqual(30e6);
      expect(f.safe).toEqual({ side: 0.05, top: 0.03, bottom: 0.08 });
      expect(f.preroll).toBeGreaterThan(0);
    }
    expect(GALPAO.cover?.segment.layout).toBe('split');
  });

  it('every frame shows a whole tick; time goes back only in the rewind, two minutes', () => {
    expect(rewindText(TEASER_AT - TOUR_FROM)).toBe('⏪ 2 minutos antes');
    for (const f of FORMATS) {
      let before = -Infinity;
      const back: number[] = [];
      for (let frame = 0; frame < formatFrames(f); frame++) {
        const m = momentAt(f, frame);
        expect(Math.abs(m.time * 60 - Math.round(m.time * 60))).toBeLessThan(1e-6);
        expect(Number.isInteger(m.speed)).toBe(true);
        if (m.time < before) {
          expect(['rebobinada', 'tour']).toContain(m.segment.id);
          back.push(m.time);
        }
        before = m.time;
      }
      // Backward a second of the run per frame, from the teaser's moment to where the tour starts.
      expect(back[0]).toBe(TEASER_AT - 1);
      expect(back.at(-1)).toBe(TOUR_FROM);
      expect(rewindMoments(f)).toEqual(Array.from({ length: 120 }, (_, i) => 51 + i));
      // The first frame is the teaser's (its words up already: no fade in); the last holds
      // the end card still for 1.5 s.
      const first = momentAt(f, 0);
      expect(first.segment.id).toBe('teaser');
      expect(first.time).toBe(TEASER_AT - first.segment.seconds);
      for (const i of first.segment.items) expect(i.from).toBe(0);
      for (const k of [1, 45, 89]) {
        expect(momentAt(f, formatFrames(f) - k)).toMatchObject({ speed: 0, time: E.end + 3 });
      }
      expect(momentAt(f, formatFrames(f) - 91).speed).toBe(1);
    }
  });

  it('the story in order: teaser, rewind, tour, breakdown, the AI at work side by side, X-ray, motors, numbers, address', () => {
    for (const f of FORMATS) {
      expect(f.segments.map((s) => s.id)).toEqual([
        'teaser',
        'rebobinada',
        'tour',
        'quebra',
        'frase',
        'dividida',
        'raiox',
        'previsao',
        'numeros',
        'endereco',
      ]);
      const texts = f.segments.flatMap((s) => s.items).filter((i) => 'text' in i);
      const said = texts.map((i) => (i as { text: string }).text);
      expect(said).toContain(TEASER_TEXT);
      expect(said).toContain('⏪ 2 minutos antes');
      expect(said).toEqual(expect.arrayContaining(Object.values(SCALE)));
      // What the AI's log and costs tell now, gone: the detour's balloon and the two captions.
      expect(said).not.toContain('desvio pela linha A');
      expect(said).not.toContain('A IA desvia o fluxo, e a fila para de crescer.');
      expect(said.some((t) => t.startsWith('A IA prevê a quebra'))).toBe(false);
      // The robots' routes are not what the AI sees: no layer of them.
      expect(itemsOf(segment(f, 'raiox'), 'routes')).toEqual([]);
      // The split: its words until the AI takes over; the costs from the router's first
      // decision (129 s); the log and the pulses on the AI's side.
      const split = segment(f, 'dividida');
      const intro = itemsOf(split, 'caption')[0] as Item;
      expect(intro.to).toBeCloseTo(localAt(split.spans, E.aiAt - 0.5), 6);
      const costs = itemsOf(split, 'compare')[0] as Item;
      expect(costs.from).toBeCloseTo(localAt(split.spans, E.aiAt + 1), 6);
      expect(costs.to - costs.from).toBeGreaterThanOrEqual(words(COMPARE_TITLE) / 3 + 2);
      expect(itemsOf(split, 'log')).toHaveLength(1);
      expect(itemsOf(split, 'pulses')).toHaveLength(1);
      // The AI takes over slowed to 2×.
      expect(
        momentAt(f, Math.round((startOf(f, 'dividida') + localAt(split.spans, 128)) * 60)).speed,
      ).toBe(2);
      // The motors: all 24 first, then the worn one's charts (from 205 s).
      const forecast = segment(f, 'previsao');
      const monitor = itemsOf(forecast, 'monitor')[0] as Item;
      const charts = itemsOf(forecast, 'forecast')[0] as Item;
      expect(monitor.from).toBe(0);
      expect(monitor.to).toBeCloseTo(localAt(forecast.spans, 205), 6);
      expect(charts.from).toBe(monitor.to);
      expect(itemsOf(forecast, 'pin')[0]).toMatchObject({ label: BROKE, pane: 'no-ai' });
      // The breakdown: the detector's card a second in (105 s), without a line to a ring.
      const quebra = segment(f, 'quebra');
      expect(itemsOf(quebra, 'bottleneck')[0]).toMatchObject({ link: false, from: 1 });
      expect(itemsOf(quebra, 'wave')[0]).toMatchObject({ from: 0 });
      // The end card: the call to try it.
      expect(itemsOf(segment(f, 'endereco'), 'address')[0]).toMatchObject({ cta: ADDRESS_CTA });
    }
  });

  it('every text stays on screen at least 1 s for every 3 words; the first log line of each kind too', () => {
    const live = {
      bottleneck: '',
      bottleneckIn: {} as Partial<Record<SegmentId, string>>,
    };
    for (const f of FORMATS) {
      // The detector's live words where its card shows: the breakdown's, and the X-ray's.
      const quebra = segment(f, 'quebra');
      const raiox = segment(f, 'raiox');
      const card = itemsOf(raiox, 'bottleneck')[0] as Item;
      ai.to(quebra.spans[0]!.from + 1);
      live.bottleneckIn.quebra = bottleneckText(ai.bottleneck() as never);
      ai.to(raiox.spans[0]!.from + card.from);
      live.bottleneck = bottleneckText(ai.bottleneck() as never);
      for (const w of readingWindows(f, live)) {
        expect(w.words / 3, `${f.id} ${w.segment} ${w.from}–${w.to}`).toBeLessThanOrEqual(
          w.to - w.from + 1e-9,
        );
      }
      // The log: each kind declared first in a segment does show up first there, says as many
      // words as the rule counted, and stays among the lines shown long enough to be read.
      const log = feed.ai.log;
      const firsts = new Map<LogKind, CinemaLogLine>();
      for (const l of log) if (!firsts.has(l.kind)) firsts.set(l.kind, l);
      // Every kind whose first line shows in a segment with the log is counted there.
      for (const [kind, line] of firsts) {
        const s = f.segments.find(
          (x) =>
            itemsOf(x, 'log').length > 0 &&
            line.at >= x.spans[0]!.from &&
            line.at <= x.spans.at(-1)!.to,
        );
        const it = s && (itemsOf(s, 'log')[0] as Item);
        expect(it && it.kind === 'log' ? it.first : [], kind).toContain(kind);
      }
      for (const s of f.segments) {
        for (const it of itemsOf(s, 'log')) {
          if (it.kind !== 'log') continue;
          for (const kind of it.first) {
            if (kind === 'status') continue;
            const line = firsts.get(kind) as CinemaLogLine;
            expect(line, kind).toBeDefined();
            const at = localAt(s.spans, line.at);
            expect(line.at).toBeGreaterThanOrEqual(s.spans[0]!.from);
            expect(at).toBeLessThan(s.seconds);
            expect(words(line.text)).toBe(words(LOG_EXAMPLE[kind]));
            // It leaves the panel when `lines` newer lines have come, or with the segment.
            const newer = log.filter((l) => l.at > line.at).slice(it.lines - 1);
            const gone = newer[0] ? Math.min(localAt(s.spans, newer[0].at), s.seconds) : s.seconds;
            expect(gone - at, kind).toBeGreaterThanOrEqual(words(line.text) / 3);
          }
        }
      }
    }
    // The status line and the titles count as they are.
    expect(words(LOG_STATUS)).toBe(6);
    expect(words(MONITOR_TITLE)).toBe(3);
  });
});

describe('the tour: what it shows, on the run', () => {
  it('the teaser is the split screen at 170 s, 146 × 10, the same moment the split shows later', () => {
    expect(feed.counter.noAi.get(feed.ai.tick(TEASER_AT))).toBe(146);
    expect(feed.counter.ai.get(feed.ai.tick(TEASER_AT))).toBe(10);
    for (const f of FORMATS) {
      const split = segment(f, 'dividida');
      expect(localAt(split.spans, TEASER_AT)).toBeLessThan(split.seconds);
    }
  });

  it('the scale: 24 belts, 40 robots, never closer than 0,97 m in either run', () => {
    const w = ai.rec.live;
    expect(SCALE.belts).toBe(`${w.layout.graph.edges.length} esteiras`);
    expect(SCALE.robots).toBe(`${w.fleet?.robots.length} robôs`);
    let closest = Infinity;
    for (const run of [new CinemaRun('ai', undefined, 0), new CinemaRun('no-ai', undefined, 0)]) {
      for (let tick = 0; tick <= run.tick(E.end); tick++) {
        run.to(tick / 60);
        const robots = run.rec.live.fleet?.robots ?? [];
        for (let a = 0; a < robots.length; a++) {
          for (let b = a + 1; b < robots.length; b++) {
            const ma = robots[a]!.motion;
            const mb = robots[b]!.motion;
            closest = Math.min(closest, Math.hypot(ma.x - mb.x, ma.z - mb.z));
          }
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(0.97);
    expect(SCALE.distance).toContain('0,97 m');
  }, 120_000);

  it("the tour's packet goes onto Esteira 6 just before 65 s, crosses Esteira 8 before it breaks, reaches Doca 4", () => {
    const edges: { edge: number; at: number }[] = [];
    let dockedAt = -1;
    const run = new CinemaRun('ai', undefined, 60);
    for (let tick = run.tick(60); tick <= run.tick(E.failure.at); tick++) {
      run.to(tick / 60);
      const w = run.rec.live;
      const on = w.conveyors.find((c) => c.packets.some((p) => p.id === PROTAGONIST.id));
      if (on && edges.at(-1)?.edge !== on.edgeId) edges.push({ edge: on.edgeId, at: tick / 60 });
      const dock = w.docks.findIndex((d) => d.staged.some((p) => p.id === PROTAGONIST.id));
      if (dock >= 0 && dockedAt < 0) dockedAt = tick / 60;
      if (tick === run.tick(65)) {
        // The newest packet on the entrance belt of Entrada 2 then: the one the camera picks up.
        const entrance = w.conveyors[5]!;
        const newest = [...entrance.packets].sort((a, b) => a.s - b.s)[0];
        expect(newest?.id).toBe(PROTAGONIST.id);
        expect(w.layout.graph.node(w.layout.graph.edge(5).from).name).toBe(PROTAGONIST.entrance);
      }
    }
    expect(edges[0]).toEqual({ edge: 5, at: expect.closeTo(64.95, 1) });
    const e8 = edges.find((e) => e.edge === BROKEN);
    expect(e8?.at).toBeGreaterThan(70);
    expect(e8?.at).toBeLessThan(E.failure.at - 20);
    // Doca 4, at about 91 s: before the tour's camera leaves it (92 s) and before the breakdown.
    expect(edges.at(-1)?.edge).toBe(
      run.rec.live.layout.graph.edges.findIndex((x) => x.to === run.rec.live.layout.dockNodes[3]),
    );
    expect(dockedAt).toBeCloseTo(91.05, 1);
  }, 60_000);

  it('the robots the labels point at: one taking boxes off a shelf, one passing under Esteira 10', () => {
    const run = new CinemaRun('ai', undefined, 60);
    run.to(63.4);
    const shelf = run.rec.live.fleet!.robots[SHELF_ROBOT]!;
    expect(shelf.stage).toBe('loading');
    expect(shelf.job?.kind).toBe('rack');
    run.to(83.5);
    const gate = run.rec.live.fleet!.robots[GATE_ROBOT]!;
    const passage = run.rec.live.layout.gates.find((g) => g.x === 10 && g.z === 3)!;
    expect(Math.hypot(gate.motion.x - passage.x, gate.motion.z - passage.z)).toBeLessThan(1.2);
  });

  it('the deliveries per minute: those of the minute before the label shows (89.4 s)', () => {
    const run = new CinemaRun('ai', undefined, 0);
    const delivered: number[] = [];
    for (let s = 0; s <= 90; s++) {
      run.to(s);
      delivered[s] = run.rec.live.metrics.delivered;
    }
    run.to(89.4);
    expect(run.deliveredLastMinute()).toBe((delivered[89] as number) - (delivered[29] as number));
    expect(run.deliveredLastMinute()).toBeGreaterThan(150);
  });

  it('the breakdown: the detector names Esteira 8 on its own a second later, in both runs', () => {
    for (const side of ['ai', 'no-ai'] as const) {
      const run = new CinemaRun(side, undefined, 100);
      run.to(E.failure.at);
      expect(run.bottleneck()).toBeNull();
      run.to(E.failure.at + 1);
      const b = run.bottleneck();
      expect(b?.kind).toBe('conveyor');
      expect(b?.index).toBe(BROKEN);
      expect(b?.cause.certain).toBe(true);
      expect(bottleneckText(b as never)).toMatch(
        /^Esteira 8 \(B2→B3\), \d+% de uso\. Causa: quebra desta esteira\.$/,
      );
    }
  });

  it("the AI's log, from the engine: it takes over, B2 leaves Esteira 8, Esteira 8 back, the maintenance", () => {
    const log = feed.ai.log;
    expect(log.map((l) => [l.at, l.kind, l.text])).toEqual([
      [128, 'assume', LOG_TEXT.assume(128)],
      [129, 'corte', LOG_TEXT.corte(129, 'B2', 'Esteira 8', 'parada', 'linha A')],
      [190, 'retorno', LOG_TEXT.retorno(190, 'B2', 'Esteira 8')],
      [218, 'manutencao', LOG_TEXT.manutencao(218, 'Esteira 16')],
    ]);
    expect(feed.noAi.log).toEqual([]);
    // Each line is what the engine did then: B2's way through Esteira 8 cut (infinite) and all
    // its packets sent by line A at the router's first decision; A1's way by line B cut too, but
    // no packet took it, so nothing changed there and nothing is written.
    const run = new CinemaRun('ai', undefined, 120);
    const w = () => run.rec.live;
    const b2 = w().routing.decisions.flatMap((d, i) =>
      w().layout.graph.node(d.node).name === 'B2' ? [i] : [],
    );
    const a1 = w().routing.decisions.flatMap((d, i) =>
      w().layout.graph.node(d.node).name === 'A1' ? [i] : [],
    );
    run.to(128.5);
    expect(run.routing().decidedAt).toBe(-1);
    for (const i of a1) expect(w().routing.share[i]).toBe(0);
    run.to(129);
    expect(run.routing().decidedAt).toBe(129);
    for (const i of b2) {
      expect(w().heuristic.cost[i]!.primary).toBe(Infinity);
      expect(w().routing.share[i]).toBe(1);
    }
    for (const i of a1) {
      expect(w().heuristic.cost[i]!.alternative).toBe(Infinity);
      expect(w().routing.share[i]).toBe(0);
    }
    // Until Esteira 8 is back, both choices at B2 cost the same (one panel shows them).
    for (let t = 129; t < 190; t++) {
      run.to(t);
      expect(run.routing().decidedAt).toBe(t);
      const [x, y] = b2.map((i) => w().heuristic.cost[i]!);
      expect(x).toEqual(y);
    }
    run.to(190);
    for (const i of b2) expect(Number.isFinite(w().heuristic.cost[i]!.primary)).toBe(true);
    run.to(218);
    const events = run.rec.events.filter((e) => e.time === 218 && e.target === WORN);
    expect(events.map((e) => e.kind)).toEqual(['maintenance', 'service-planned']);
  });

  it('back in time and on again, the log is written the same: from the teaser back to the tour, or into a cut', () => {
    const run = new CinemaRun('ai', undefined, TOUR_FROM);
    run.to(TEASER_AT - 5.5);
    run.to(TEASER_AT);
    run.to(TOUR_FROM);
    expect(run.log).toEqual([]);
    expect(run.routing().decidedAt).toBe(-1);
    run.to(230);
    expect(run.log).toEqual(feed.ai.log.filter((l) => l.at <= 230));
    run.to(150);
    expect(run.routing().decidedAt).toBe(150);
    run.to(230);
    expect(run.log).toEqual(feed.ai.log.filter((l) => l.at <= 230));
  });

  it('the motors: Esteira 16 the highest of the 24 from 195 s, named from 200 s, its alarm at 218 s', () => {
    const run = new CinemaRun('ai', undefined, 190);
    for (const t of [195, 200, 210, 217]) {
      run.to(t);
      const sums = [...run.rec.live.health.sum];
      const top = sums.indexOf(Math.max(...sums));
      expect(top).toBe(WORN);
    }
    run.to(200);
    expect((run.rec.live.health.sum[WORN] as number) / 48).toBeGreaterThan(0.25);
    run.to(217);
    expect(run.rec.live.health.alarm[WORN]).toBe(0);
    run.to(218);
    expect(run.rec.live.health.alarm[WORN]).toBe(1);
  });

  it('the same runs as the explained demo, the rewind included', () => {
    expect(feed.prints.ai).toBe(demo.aiPrint);
    expect(feed.prints.noAi).toBe(demo.noAiPrint);
    expect(feed.ai.jumps).toBe(1);
    expect(feed.noAi.jumps).toBe(1);
  });
});

describe('the tour on the page', () => {
  it('plays at ?demo=cinema-galpao and ?demo=cinema-galpao-completa', () => {
    expect(cinemaFormatFrom('?demo=cinema-galpao')).toBe('galpao');
    expect(cinemaFormatFrom('?demo=cinema-galpao-completa')).toBe('galpao-completa');
    expect(cinemaFormatFrom('?demo=toString')).toBeNull();
  });

  it('no words in the bottom 8% of the frame, nor touching its edges, in any frame', () => {
    const card = cinemaCardRows(
      ['entregas', 'ciclo', 'espera', 'quebras', 'evitadas'],
      demo.result.ai,
      demo.result.noAi,
    );
    for (const f of FORMATS) {
      const safe = {
        left: f.width * 0.05,
        right: f.width * 0.95,
        top: f.height * 0.03,
        bottom: f.height * 0.92,
      };
      for (let frame = 0; frame < formatFrames(f); frame += 15) {
        const m = momentAt(f, frame);
        const panes = panesOf(f, m.segment.layout);
        // Every point of the scene at its pane's middle, and again low and to the left in it.
        for (const corner of [false, true]) {
          const texts: Text[] = [];
          const ctx = recorder(texts);
          drawCinema(ctx, sceneAt(f, m, panes, safe, corner, card));
          for (const t of texts) {
            const where = `${f.id} ${m.segment.id} quadro ${frame} "${t.text}"`;
            expect(t.y + t.size * 0.25, where).toBeLessThanOrEqual(safe.bottom + 0.5);
            // The top of the letters: about 0.75 of the size above the baseline.
            expect(t.y - t.size * 0.75, where).toBeGreaterThanOrEqual(safe.top - 0.5);
            if (t.align === 'left' || t.align === 'start')
              expect(t.x, where).toBeGreaterThanOrEqual(safe.left - 0.5);
            if (t.align === 'right') expect(t.x, where).toBeLessThanOrEqual(safe.right + 0.5);
          }
        }
      }
    }
  }, 60_000);
});

describe('the tour through the worker host', () => {
  it('keeps the moments a rewind shows and plays them back; then goes back for real', () => {
    const posted: SimMessage[] = [];
    const host = new SimHost(
      (m) => posted.push(m),
      () => 0,
    );
    host.handle({ type: 'init', config: {} });
    host.handle({ type: 'cinema', action: 'start', side: 'ai', warmup: 50, keep: [55, 56, 57] });
    const frame = (time: number, k: number) => {
      host.handle({ type: 'cinema', action: 'to', time, frame: k, measure: false });
      return posted.at(-1) as Extract<SimMessage, { type: 'cinema' }>;
    };
    expect(decodeFrame(frame(58, 1).buffer, []).s.header[HEADER.time]).toBe(58);
    const kept = frame(57, 2);
    expect(kept.frame).toBe(2);
    expect(decodeFrame(kept.buffer, []).s.header[HEADER.time]).toBe(57);
    expect(kept.queue).toBe(feed.counter.ai.get(57 * 60) ?? kept.queue);
    // Played back from what the run kept going forward (nothing of the router then), not replayed.
    expect(kept.log).toEqual([]);
    expect(kept.routing.cost).toEqual([]);
    // Not kept: the run goes back to it and on from there.
    const back = frame(54, 3);
    expect(decodeFrame(back.buffer, []).s.header[HEADER.time]).toBe(54);
    // The AI at work in a frame: its log and its router.
    const at = frame(130, 4);
    expect(at.log.map((l) => l.kind)).toEqual(['assume', 'corte']);
    expect(at.routing.active).toBe(true);
    expect(at.routing.decidedAt).toBe(130);
    expect(at.routing.cost.length).toBe(10);
  }, 120_000);
});

// ---------------------------------------------------------------- drawing without a browser

interface Text {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly align: string;
}

/** A 2D context that only remembers where each word was written (and how large). */
function recorder(texts: Text[]): CanvasRenderingContext2D {
  const state = { font: '10px sans-serif', textAlign: 'start' as CanvasTextAlign };
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 10);
  const noop = () => undefined;
  const ctx = {
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: CanvasTextAlign) {
      state.textAlign = v;
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineJoin: 'miter',
    textBaseline: 'alphabetic',
    // Condensed letters: about 0.4 of the size each.
    measureText: (t: string) => ({ width: t.length * size() * 0.4 }),
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y, size: size(), align: state.textAlign });
    },
    createRadialGradient: () => ({ addColorStop: noop }),
  } as Record<string, unknown>;
  for (const name of [
    'save',
    'restore',
    'translate',
    'scale',
    'rect',
    'clip',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'arcTo',
    'fill',
    'stroke',
    'fillRect',
    'setLineDash',
  ]) {
    ctx[name] = noop;
  }
  return ctx as unknown as CanvasRenderingContext2D;
}

/** What the overlay draws at a moment, with the run's log and made-up live readings. */
function sceneAt(
  f: CinemaFormat,
  m: ReturnType<typeof momentAt>,
  panes: ReturnType<typeof panesOf>,
  safe: OverlayScene['safe'],
  corner: boolean,
  card: ReturnType<typeof cinemaCardRows>,
): OverlayScene {
  const point = (_: unknown, side: 'ai' | 'no-ai') => {
    const p = panes.find((x) => x.side === side) ?? panes[0]!;
    return corner
      ? ([p.x + p.w * 0.12, p.y + p.h * 0.8] as const)
      : ([p.x + p.w / 2, p.y + p.h / 2] as const);
  };
  const series = Array.from({ length: 40 }, (_, i) => i);
  return {
    width: f.width,
    height: f.height,
    safe,
    split: f.split,
    layout: m.segment.layout,
    panes,
    items: itemsAt(m.segment, m.local),
    speed: m.speed,
    point,
    routes: () => [],
    queue: { ai: 10, 'no-ai': 146 },
    share: 1,
    rate: 207,
    time: m.time,
    local: m.local,
    log: feed.ai.log.filter((l) => l.at <= m.time),
    decidedAt: m.time >= 129 ? Math.floor(m.time) : -1,
    junctions: ['A1', 'A3', 'B2'],
    compare: () => ({
      primary: { name: 'Esteira 8', cost: Infinity },
      alternative: { name: 'linha A', cost: 12.65 },
      chosen: 'alternative',
    }),
    motors: Array.from({ length: 24 }, (_, i) => (i === WORN ? 0.8 : 0.02)),
    bottleneck: {
      text: 'Esteira 3 (A2→A3), 87% de uso. Causa provável: a Esteira 8 quebrada desvia o fluxo para cá.',
      label: 'Esteira 3',
    },
    forecast: { vibration: series, temperature: series, sum: series, limit: 48 },
    card: m.segment.items.some((i) => i.kind === 'card')
      ? card.slice(0, f === GALPAO ? 3 : 5)
      : null,
    timeline: { at: m.time, from: TEASER_AT, to: TOUR_FROM, breakAt: E.failure.at },
  };
}
