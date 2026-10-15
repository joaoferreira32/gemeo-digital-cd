import { change, int, seconds as secondsText } from './card';
import type { CinemaSide } from './cinema-run';
import { DEMO_EXPLICADA, type DemoSide } from './run';

/**
 * The cinema demo (docs/roteiro.md, 2026-10-11, and the visual rounds of
 * 2026-10-12): the explained demo's run told for a video feed, silent, the
 * story in big words. A belt breaks; the same warehouse with and without the
 * AI, side by side; what the AI sees (an X-ray); the motor it saves; the
 * numbers. Two formats: the feed cut (4:5, 60 s, the split screen top and
 * bottom) and the full version (16:9, about 100 s, side by side, with the
 * time travel and "como funciona").
 *
 * Everything on screen is data here: each segment's simulated span and speed,
 * its camera, the look of the scene, and every text with when it shows.
 * Speeds are whole numbers, so every video frame (1/60 s) lands on a tick of
 * the simulation (1/60 s too) and a recording shows each moment exactly. The
 * reading rule (on screen at least 1 s for every 3 words, counting every
 * word, number and badge) and the order of the story are checked on these
 * data, and what each text says on the run (tests/cinema.test.ts).
 *
 * Colors keep one meaning: a stopped belt is grey with ⚠, the queue is red,
 * the AI is cyan, "sem IA" is orange, a worn motor's warning is yellow.
 */

export type CinemaFormatId = 'feed' | 'completa' | 'galpao' | 'galpao-completa';

export type SegmentId =
  | 'teaser'
  | 'rebobinada'
  | 'tour'
  | 'gancho'
  | 'frase'
  | 'volta'
  | 'como-esteiras'
  | 'como-robos'
  | 'quebra'
  | 'dividida'
  | 'raiox'
  | 'previsao'
  | 'numeros'
  | 'endereco';

/** A point of the scene: from the layout, or from the run being shown (live). */
export type Anchor =
  | { readonly kind: 'point'; readonly x: number; readonly y: number; readonly z: number }
  /** `at` of the way along a belt (0 … 1). */
  | { readonly kind: 'belt'; readonly id: number; readonly at: number; readonly y: number }
  | { readonly kind: 'node'; readonly name: string; readonly y: number }
  /** A belt's drive motor, moved `dx`, `dz` meters (room for a panel beside or below it). */
  | {
      readonly kind: 'motor';
      readonly id: number;
      readonly y: number;
      readonly dx?: number;
      readonly dz?: number;
    }
  | { readonly kind: 'center' }
  /** The robot the camera follows (a working one, picked when the shot starts). */
  | { readonly kind: 'robot' }
  /** The first stopped packet of the queue on line B that is in sight. */
  | { readonly kind: 'queue-head' }
  /** A robot in sight with a long reserved route. */
  | { readonly kind: 'route' }
  /** The belt the detector points out. */
  | { readonly kind: 'bottleneck' }
  /**
   * The tour's packet (PROTAGONIST): on its belt; in its dock's pile once it
   * got there; at its entrance before it went in.
   */
  | { readonly kind: 'protagonist'; readonly y: number }
  /** A robot of the fleet, by its number (the tour's robot at a shelf). */
  | { readonly kind: 'fleet'; readonly robot: number };

/**
 * A pose of a camera path (src/demo/cinema-player.ts goes through them on a
 * smooth curve, one continuous shot): at `at` seconds into the segment.
 */
export interface CameraKey {
  readonly at: number;
  readonly target: Anchor;
  readonly radius: number;
  readonly phi: number;
  readonly theta: number;
  /** Where the depth of field is sharp (the shot's `focus` gives how strong). */
  readonly focus?: Anchor;
}

export interface Shot {
  readonly target: Anchor;
  /** Distance to the target (m; screens narrower than 16:10 pull back), angles (rad). */
  readonly radius: number;
  readonly phi: number;
  readonly theta: number;
  /** Radians the camera turns around its target over the segment (a slow travelling). */
  readonly turn: number;
  /** Depth of field on a point, and how strong. */
  readonly focus?: { readonly at: Anchor; readonly aperture: number; readonly maxblur: number };
  /** The camera glides from the shot before at this rate (1/s); without it the segment opens on a cut. */
  readonly glide?: number;
  /** A continuous camera move through these poses (it replaces target, radius, angles and turn). */
  readonly path?: readonly CameraKey[];
}

export interface Look {
  readonly heat: 'off' | 'espera';
  /** How bright the racks are (1: as built): what is not the subject recedes. */
  readonly racks: number;
  /** The AI's flow arrows on the AI side, and how bright (0: hidden). */
  readonly arrows: number;
  /** The detector's ring on the bottleneck (the AI side). */
  readonly ring: boolean;
  /** The look of the past (the time travel), 0 … 1. */
  readonly past: number;
}

/**
 * Simulated seconds played at a whole speed (simulated seconds per video
 * second); with speed 0, `from` held still for `hold` seconds; with a negative
 * speed, played backward (the rewind: moments of the run shown in reverse
 * order). A span that does not start where the one before ended is a jump in time.
 */
export interface Span {
  readonly from: number;
  readonly to: number;
  readonly speed: number;
  readonly hold?: number;
}

export type Tone = 'red' | 'cyan' | 'ink' | 'grey';

export type ItemBody =
  /** Big words at the top, on a dark band. */
  | { readonly kind: 'headline'; readonly text: string }
  /** The sentence in the middle of the screen (`big`: larger, the cover's). */
  | { readonly kind: 'phrase'; readonly text: string; readonly big?: true }
  /** At the bottom of a pane (or of the screen); "|" breaks a line. */
  | {
      readonly kind: 'caption';
      readonly text: string;
      readonly pane?: CinemaSide;
      /** Kept to the left (a panel stands to the right). */
      readonly narrow?: boolean;
    }
  /** COUNTER_LABEL ("FILA · ESTEIRA 8") and the packets queuing for that belt now. */
  | { readonly kind: 'counter'; readonly pane?: CinemaSide }
  /** "SEM IA" (orange) or "COM IA" (cyan). */
  | { readonly kind: 'tag'; readonly pane: CinemaSide }
  /** The speed, when it is not real time. */
  | { readonly kind: 'badge' }
  /** ⚠ on a stopped belt, with its name. */
  | {
      readonly kind: 'pin';
      readonly at: Anchor;
      readonly label?: string;
      readonly pane?: CinemaSide;
    }
  /**
   * A label fixed to a point; "{share}" is the share of B2's packets going by
   * line A, "{rate}" the packets delivered in the minute before the moment shown.
   */
  | {
      readonly kind: 'balloon';
      readonly at: Anchor;
      readonly text: string;
      readonly tone: Tone;
      readonly dx: number;
      readonly dy: number;
      readonly pane?: CinemaSide;
      /** Hidden while its point is out of the picture (a moving camera leaves it behind). */
      readonly inSight?: true;
    }
  /** The X-ray's title, on a band dark enough to hide what passes under it. */
  | { readonly kind: 'title'; readonly text: string }
  /** Every robot's reserved route, glowing (the X-ray). */
  | { readonly kind: 'routes' }
  /**
   * The detector's card (its live words), a line to the ring and the belt's
   * name there; without the line where the ring is not in the picture.
   */
  | { readonly kind: 'bottleneck'; readonly link?: false }
  /**
   * The AI's log (src/demo/cinema-run.ts writes it from the engine): its last
   * lines, and LOG_STATUS while the router decides every second. `first`: the
   * kinds of line that first show up in this segment (the reading rule counts
   * the first line of each kind; the next ones of a kind need not be read).
   */
  | {
      readonly kind: 'log';
      readonly pane: CinemaSide;
      readonly first: readonly (LogKind | 'status')[];
      /** Its last lines shown, and where: at the bottom of the pane or at its top. */
      readonly lines: number;
      readonly place: 'bottom' | 'top';
    }
  /** The router's two ways at a junction, with the time it expects on each; the one it takes lit. */
  | { readonly kind: 'compare'; readonly node: string; readonly dx: number; readonly dy: number }
  /** A ring at each junction where the router splits the flow, every time it decides. */
  | { readonly kind: 'pulses'; readonly pane: CinemaSide }
  /** The 24 motors' alarm sums, read every second, the highest one named. */
  | { readonly kind: 'monitor'; readonly pane: CinemaSide }
  /** Rings going out from a point (the breakdown). */
  | { readonly kind: 'wave'; readonly at: Anchor }
  /** The worn motor's readings: vibration, temperature and the alarm sum against its limit. */
  | { readonly kind: 'forecast'; readonly pane: CinemaSide; readonly motor: number }
  /** Darkens what is not the subject (around these points). */
  | {
      readonly kind: 'spotlight';
      readonly around: readonly Anchor[];
      readonly pad: readonly [number, number];
      readonly alpha: number;
      readonly pane?: CinemaSide;
    }
  /** Darkens the whole screen. */
  | { readonly kind: 'shade'; readonly alpha: number }
  /** The numbers of both runs, counting up as the runs go to their end. */
  | { readonly kind: 'card'; readonly rows: readonly CardRowId[] }
  /** Where the code is, on a dark band. */
  | { readonly kind: 'address'; readonly cta?: string }
  /** The time travel: a bar going back between two simulated moments (s). */
  | { readonly kind: 'timeline'; readonly sim: readonly [number, number] }
  /** A short white flash (the breakdown), fading out. */
  | { readonly kind: 'flash' };

/** An item on screen from `from` to `to` (seconds into its segment). */
export type Item = ItemBody & { readonly from: number; readonly to: number };

export type CardRowId = 'entregas' | 'ciclo' | 'espera' | 'quebras' | 'evitadas';

export interface Segment {
  readonly id: SegmentId;
  readonly layout: 'single' | 'split';
  /** Video seconds: the spans play, then the last moment holds. */
  readonly seconds: number;
  readonly spans: readonly Span[];
  readonly shot: Shot;
  readonly look: Look;
  /** The look changing from a second of the segment on (the X-ray, one layer at a time). */
  readonly steps?: readonly { readonly from: number; readonly look: Partial<Look> }[];
  /**
   * Where the reading rule splits the segment (the X-ray's layers): the words
   * of each item count in the window where it shows up.
   */
  readonly windows?: readonly number[];
  readonly items: readonly Item[];
}

export interface CinemaFormat {
  readonly id: CinemaFormatId;
  readonly width: number;
  readonly height: number;
  /** How the two runs share the screen: one above the other (4:5) or side by side (16:9). */
  readonly split: 'stack' | 'side';
  readonly segments: readonly Segment[];
  /**
   * Where words may go (shares of the frame): none in the bottom `bottom`
   * (a feed's buttons and caption cover it on a phone), none closer than
   * `side` to the left and right edges or `top` to the top one.
   */
  readonly safe?: { readonly side: number; readonly top: number; readonly bottom: number };
  /** The video's bitrate (bits per second); a high one survives a site's re-encoding better. */
  readonly bitrate?: number;
  /**
   * Simulated seconds drawn, unseen, before the first frame: what builds up on
   * screen over time (the heat) is there from the first frame.
   */
  readonly preroll?: number;
  /** A still for the post's thumbnail: a segment held at a moment of it (seconds into it). */
  readonly cover?: { readonly segment: Segment; readonly local: number };
}

export const CINEMA_FPS = 60;

const S = DEMO_EXPLICADA;
/** The belt that breaks (Esteira 8, B2→B3) and the one whose motor wears (Esteira 16). */
const BROKEN = S.failure.target;
const WORN = S.wear.target;

export const PHRASE = 'Eu programei uma IA para decidir o que fazer.';

// ---------------------------------------------------------------- the AI's log

/**
 * The kinds of line of the AI's log, all from the engine: the AI taking over
 * (the script's input), a way of a routing choice cut by a stopped belt (its
 * cost goes infinite) and back, and a maintenance scheduled on a motor's alarm.
 */
export type LogKind = 'assume' | 'corte' | 'retorno' | 'manutencao';

export interface CinemaLogLine {
  /** Simulated seconds. */
  readonly at: number;
  readonly kind: LogKind;
  readonly text: string;
}

/** The fixed line under the log while the router decides every second. */
export const LOG_STATUS = 'reavaliando a divisão a cada segundo';

const stamp = (t: number) => `${Math.round(t)} s`;
/** The texts of the log's lines (worker and tests write them the same way). */
export const LOG_TEXT = {
  assume: (t: number) => `${stamp(t)} · IA assume roteamento e manutenção`,
  /** At `node`, the way through `belt` (stopped) is cut: the flow goes by `way`. */
  corte: (t: number, node: string, belt: string, state: string, way: string) =>
    `${stamp(t)} · ${node}: ${belt} ${state} → ${way}`,
  retorno: (t: number, node: string, belt: string) => `${stamp(t)} · ${node}: ${belt} de volta`,
  manutencao: (t: number, belt: string) =>
    `${stamp(t)} · ${belt}: motor fora do padrão → manutenção agendada`,
} as const;

/** A line of each kind as this run writes it (the reading rule counts its words). */
export const LOG_EXAMPLE: Record<LogKind, string> = {
  assume: LOG_TEXT.assume(128),
  corte: LOG_TEXT.corte(129, 'B2', 'Esteira 8', 'parada', 'linha A'),
  retorno: LOG_TEXT.retorno(190, 'B2', 'Esteira 8'),
  manutencao: LOG_TEXT.manutencao(218, 'Esteira 16'),
};

/** The router's costs at a junction: what they are. */
export const COMPARE_TITLE = 'tempo previsto (viagem + fila)';
/** The 24 motors' panel. */
export const MONITOR_TITLE = 'Monitoramento: 24 motores';
/**
 * The counter's label, in the hook and in both panes of the split screen: the
 * queue it counts is the broken belt's (src/demo/cinema-run.ts), not the
 * warehouse's, so the label names the belt.
 */
export const COUNTER_LABEL = `FILA · ESTEIRA ${BROKEN + 1}`;
/** Where the hook ends: 7 s of the breakdown at 2×; the phrase holds this moment still. */
const HOOK_END = S.failure.at + 7;
export const ADDRESS_LEAD = 'Código e detalhes';
export const ADDRESS = 'github.com/joaoferreira32/gemeo-digital-cd';
/** The end card's call: the demo runs in the browser, at the address. */
export const ADDRESS_CTA = 'Roda no seu navegador: teste você mesmo';
/** The card's note: the scenario was picked to show each step. */
export const CARD_NOTE = 'Cenário escolhido para mostrar cada etapa;|não representa a média.';
/** The moment the AI half's caption claims, and what it says then. */
export const AVOIDED = 'Falha evitada';
export const BROKE = 'A esteira quebrou';

const point = (x: number, y: number, z: number): Anchor => ({ kind: 'point', x, y, z });
const belt = (id: number, at = 0.5, y = 0.9): Anchor => ({ kind: 'belt', id, at, y });
const motor = (id: number, y = 0.9, dx = 0, dz = 0): Anchor => ({
  kind: 'motor',
  id,
  y,
  dx,
  dz,
});
const always = (seconds: number) => ({ from: 0, to: seconds });

/** The queue of line B: Esteira 7 before B2 and the stopped Esteira 8 after it. */
const LINE_B = [belt(BROKEN - 1, 0.1, 0.5), belt(BROKEN, 0.3, 0.5)];
const SPLIT_SPOT = [
  belt(BROKEN - 1, 0.2, 0.5),
  belt(BROKEN, 1, 0.5),
  point(-10, 0.5, -3),
  point(0, 0.5, -3),
];

/** Seconds into a segment at which its run shows the simulated moment `time` (played forward). */
export function localAt(spans: readonly Span[], time: number): number {
  let local = 0;
  for (const s of spans) {
    if (s.speed === 0) {
      local += s.hold ?? 0;
      continue;
    }
    if (s.speed > 0 && time <= s.to) return local + Math.max(0, time - s.from) / s.speed;
    local += Math.abs(s.to - s.from) / Math.abs(s.speed);
  }
  return local;
}

/** Video seconds a span lasts. */
const spanSeconds = (s: Span): number =>
  s.speed === 0 ? (s.hold ?? 0) : Math.abs(s.to - s.from) / Math.abs(s.speed);

/** The look of a segment that a scene shows (before any step). */
const look = (l: Partial<Look>): Look => ({
  heat: 'off',
  racks: 1,
  arrows: 0,
  ring: false,
  past: 0,
  ...l,
});

/** The hook: the broken belt and its queue, low and close; nothing of the AI yet. */
function gancho(shot: Shot): Segment {
  const seconds = 3.5;
  return {
    id: 'gancho',
    layout: 'single',
    seconds,
    spans: [{ from: S.failure.at, to: HOOK_END, speed: 2 }],
    shot,
    look: look({ racks: 0.45 }),
    items: [
      { kind: 'spotlight', around: LINE_B, pad: [200, 220], alpha: 0.6, ...always(seconds) },
      { kind: 'headline', text: 'Uma esteira quebrou.', ...always(seconds) },
      { kind: 'counter', ...always(seconds) },
      { kind: 'badge', ...always(seconds) },
      { kind: 'pin', at: { kind: 'queue-head' }, label: 'Esteira 8', ...always(seconds) },
    ],
  };
}

/** "Eu programei uma IA…", the run held still while the camera pulls back over the floor. */
function frase(shot: Shot): Segment {
  const seconds = 3;
  return {
    id: 'frase',
    layout: 'single',
    seconds,
    spans: [{ from: HOOK_END, to: HOOK_END, speed: 0, hold: seconds }],
    shot,
    look: look({ racks: 0.6 }),
    items: [{ kind: 'phrase', text: PHRASE, from: 0, to: seconds }],
  };
}

/** What the tour's version adds to a segment: its own spans, more items. */
interface SegmentOptions {
  readonly spans?: readonly Span[];
  /** Items over the scene (the AI's log, its costs, its pulses), placed on the segment's spans. */
  readonly extra?: (spans: readonly Span[]) => Item[];
}

/** The same warehouse with and without the AI, from the same moment. */
function dividida(
  from: number,
  speed: number,
  seconds: number,
  shot: Shot,
  intro: string,
  captionPane: CinemaSide | undefined,
  opts: SegmentOptions & {
    readonly detourAt?: number;
    /** The tour's version: the intro until this moment (s), then no balloon nor closing caption. */
    readonly introUntil?: number;
  } = {},
): Segment {
  const spans = opts.spans ?? [{ from, to: 176, speed }];
  // The balloon shows once the AI has taken over and its arrows are up.
  const detour = localAt(spans, opts.detourAt ?? S.aiAt + 7);
  const told = opts.introUntil !== undefined;
  const where = captionPane ? { pane: captionPane } : {};
  return {
    id: 'dividida',
    layout: 'split',
    seconds,
    spans,
    shot,
    look: look({ heat: 'espera', racks: 0.5, arrows: 2 }),
    items: [
      ...(['no-ai', 'ai'] as const).flatMap((pane): Item[] => [
        {
          kind: 'spotlight',
          around: SPLIT_SPOT,
          pad: [110, 90],
          alpha: 0.5,
          pane,
          ...always(seconds),
        },
        { kind: 'tag', pane, ...always(seconds) },
        { kind: 'counter', pane, ...always(seconds) },
        { kind: 'pin', at: belt(BROKEN, 0.3), pane, ...always(seconds) },
      ]),
      { kind: 'badge', ...always(seconds) },
      {
        kind: 'caption',
        text: intro,
        ...where,
        from: 0,
        to: told ? localAt(spans, opts.introUntil as number) : detour - 0.3,
      },
      // The tour's version leaves these to the AI's log and costs.
      ...(told
        ? []
        : [
            {
              kind: 'balloon' as const,
              at: belt(11, 0.5, 0.7),
              text: 'desvio pela linha A',
              tone: 'cyan' as const,
              dx: -60,
              dy: -90,
              pane: 'ai' as const,
              from: detour,
              to: seconds,
            },
            {
              kind: 'caption' as const,
              text: 'A IA desvia o fluxo, e a fila para de crescer.',
              ...where,
              from: detour + 1.2,
              to: seconds,
            },
          ]),
      ...(opts.extra?.(spans) ?? []),
    ],
  };
}

/**
 * What the AI sees, one layer at a time: the waiting, the routes, the detour,
 * the new bottleneck. The tour's version leaves the robots' routes out: they
 * are planned by the robots' own system, which no part of the AI reads.
 */
function raiox(shot: Shot, robots = true, extra: readonly Item[] = []): Segment {
  const seconds = robots ? 14 : 12;
  const layers = robots ? [0, 3, 5, 7] : [0, 3, 5];
  const share = layers[layers.length - 2] as number;
  const card = layers[layers.length - 1] as number;
  return {
    id: 'raiox',
    layout: 'single',
    seconds,
    spans: [{ from: 176, to: 176 + seconds, speed: 1 }],
    shot,
    look: look({ heat: 'espera', racks: 0.28 }),
    steps: [
      { from: share, look: { arrows: 2.6 } },
      { from: card, look: { arrows: 2.6, ring: true } },
    ],
    windows: layers,
    items: [
      { kind: 'spotlight', around: LINE_B, pad: [140, 150], alpha: 0.35, from: 0, to: 3 },
      ...(robots ? [{ kind: 'routes' as const, from: 3, to: seconds }] : []),
      { kind: 'title', text: 'O que a IA vê', ...always(seconds) },
      { kind: 'pin', at: belt(BROKEN, 0.3), ...always(seconds) },
      {
        kind: 'balloon',
        at: point(-2.5, 0.5, 3.6),
        text: 'espera (mapa de calor)',
        tone: 'red',
        dx: -40,
        dy: 190,
        from: 0,
        to: 3,
      },
      ...(robots
        ? [
            {
              kind: 'balloon' as const,
              at: { kind: 'route' as const },
              text: 'rotas reservadas dos robôs',
              tone: 'cyan' as const,
              dx: -60,
              dy: -120,
              from: 3,
              to: 5,
            },
          ]
        : []),
      {
        kind: 'balloon',
        at: { kind: 'node', name: 'B2', y: 0.7 },
        text: 'B2: {share}% pela linha A',
        tone: 'cyan',
        dx: 60,
        dy: 150,
        from: share,
        to: card,
      },
      { kind: 'bottleneck', from: card, to: seconds },
      ...extra,
    ],
  };
}

/**
 * The worn motor: the AI reads it and stops the belt in time; without it, the
 * belt breaks. The tour's version opens on all 24 motors (`chartsAt`: the
 * simulated moment the worn motor's charts take their place).
 */
function previsao(
  slow: number,
  seconds: number,
  shot: Shot,
  panelBelow: boolean,
  opts: SegmentOptions & {
    readonly chartsAt?: number;
    /** Without the AI side's caption (the tour's version: its log and panels tell it). */
    readonly quiet?: boolean;
  } = {},
): Segment {
  const spans = opts.spans ?? [
    { from: 190, to: 215, speed: 5 },
    { from: 215, to: slow, speed: 1 },
  ];
  const fast = localAt(spans, 215);
  const charts = opts.chartsAt === undefined ? 0 : localAt(spans, opts.chartsAt);
  return {
    id: 'previsao',
    layout: 'split',
    seconds,
    spans,
    shot,
    look: look({ racks: 0.5 }),
    items: [
      ...(['no-ai', 'ai'] as const).flatMap((pane): Item[] => [
        {
          kind: 'spotlight',
          around: [motor(WORN)],
          pad: [260, 200],
          alpha: 0.5,
          pane,
          ...always(seconds),
        },
        { kind: 'tag', pane, ...always(seconds) },
      ]),
      { kind: 'badge', from: 0, to: fast },
      {
        kind: 'balloon',
        at: motor(WORN),
        text: 'Esteira 16',
        tone: 'ink',
        dx: 90,
        dy: -110,
        pane: 'no-ai',
        from: 0,
        to: localAt(spans, 222.75),
      },
      ...(charts > 0
        ? [{ kind: 'monitor' as const, pane: 'ai' as const, from: 0, to: charts }]
        : []),
      { kind: 'forecast', pane: 'ai', motor: WORN, from: charts, to: seconds },
      {
        kind: 'caption',
        text: 'Sem IA, ninguém agenda a manutenção.',
        pane: 'no-ai',
        ...always(seconds),
      },
      ...(opts.quiet
        ? []
        : [
            {
              kind: 'caption' as const,
              text: 'A IA prevê a quebra|pelos sensores do motor.',
              pane: 'ai' as const,
              narrow: !panelBelow,
              ...always(seconds),
            },
          ]),
      {
        kind: 'balloon',
        at: motor(WORN),
        text: AVOIDED,
        tone: 'cyan',
        dx: -70,
        dy: -120,
        pane: 'ai',
        from: localAt(spans, 219),
        to: seconds,
      },
      {
        kind: 'pin',
        at: motor(WORN),
        label: BROKE,
        pane: 'no-ai',
        from: localAt(spans, 222.75),
        to: seconds,
      },
      ...(opts.extra?.(spans) ?? []),
    ],
  };
}

/** The numbers of both runs, counting up while the runs go to their end behind the card. */
function numeros(
  from: number,
  speed: number,
  seconds: number,
  rows: readonly CardRowId[],
  address: boolean,
): Segment {
  return {
    id: 'numeros',
    layout: 'single',
    seconds,
    spans: [{ from, to: S.end, speed }],
    shot: { target: { kind: 'center' }, radius: 80, phi: 0.6, theta: 1.2, turn: 0.05 },
    look: look({}),
    items: [
      { kind: 'shade', alpha: 0.55, ...always(seconds) },
      { kind: 'card', rows, ...always(seconds) },
      ...(address ? [{ kind: 'address' as const, from: seconds - 3, to: seconds }] : []),
    ],
  };
}

const HOOK_SHOT: Shot = {
  target: point(-13, 0.5, 3),
  radius: 6.5,
  phi: 1.32,
  theta: 1.5,
  turn: 0.04,
  focus: { at: point(-13, 0.5, 3), aperture: 0.005, maxblur: 0.014 },
};
const SPLIT_FOCUS = { at: point(-7, 0.5, 0), aperture: 0.0025, maxblur: 0.01 };
const MOTOR_FOCUS = { at: motor(WORN, 0.6), aperture: 0.004, maxblur: 0.012 };
const XRAY_SHOT: Shot = {
  target: point(-6, 0.5, -1.5),
  radius: 30,
  phi: 0.42,
  theta: 0.3,
  turn: 0.05,
};
/** The feed's split screen (and the tour's teaser, the same shot). */
const FEED_SPLIT_SHOT: Shot = {
  target: point(-6, 0.5, 0.5),
  radius: 30,
  phi: 0.6,
  theta: 0.42,
  turn: 0.06,
  focus: SPLIT_FOCUS,
};
const FEED_PREVISAO_SHOT: Shot = {
  target: motor(WORN, 0.6, 2.5),
  radius: 10.5,
  phi: 0.6,
  theta: 5.8,
  turn: 0.04,
  focus: MOTOR_FOCUS,
};
const COMPLETA_SPLIT_SHOT: Shot = {
  target: point(-6, 0.5, 0.5),
  radius: 24,
  phi: 0.6,
  theta: 0.42,
  turn: 0.06,
  focus: SPLIT_FOCUS,
};
const COMPLETA_PREVISAO_SHOT: Shot = {
  target: motor(WORN, 0.6, -1.2, 2.4),
  radius: 9,
  phi: 0.62,
  theta: 5.8,
  turn: 0.04,
  focus: MOTOR_FOCUS,
};
const FEED_FRASE_SHOT: Shot = {
  target: point(-6, 0.5, 0.5),
  radius: 30,
  phi: 0.62,
  theta: 0.42,
  turn: 0,
  glide: 1.4,
};

/** The feed cut: 4:5, 60 s, the split screen one run above the other. */
export const FEED: CinemaFormat = {
  id: 'feed',
  width: 1080,
  height: 1350,
  split: 'stack',
  segments: [
    gancho(HOOK_SHOT),
    frase(FEED_FRASE_SHOT),
    dividida(
      HOOK_END,
      5,
      13,
      FEED_SPLIT_SHOT,
      'Mesmo galpão, mesmas falhas. Em cima, sem IA; embaixo, com IA.',
      'ai',
    ),
    raiox(XRAY_SHOT),
    previsao(224, 14, FEED_PREVISAO_SHOT, false),
    numeros(224, 48, 12.5, ['entregas', 'ciclo', 'quebras'], true),
  ],
};

/** The full version: 16:9, about 100 s, side by side, with the time travel and how it works. */
export const COMPLETA: CinemaFormat = {
  id: 'completa',
  width: 1920,
  height: 1080,
  split: 'side',
  segments: [
    gancho({ ...HOOK_SHOT, radius: 8.5, theta: 1.25 }),
    frase({ target: point(-6, 0.5, 0.5), radius: 40, phi: 0.62, theta: 0.42, turn: 0, glide: 1.4 }),
    {
      id: 'volta',
      layout: 'single',
      seconds: 6,
      spans: [
        { from: HOOK_END, to: HOOK_END, speed: 0, hold: 3 },
        { from: S.failure.at - 20, to: S.failure.at - 17, speed: 1 },
      ],
      shot: { target: point(-6, 0.5, 0.5), radius: 40, phi: 0.62, theta: 0.42, turn: 0.05 },
      look: look({ past: 1 }),
      steps: [{ from: 3, look: { past: 0 } }],
      items: [
        { kind: 'timeline', sim: [HOOK_END, S.failure.at - 20], from: 0, to: 3 },
        { kind: 'caption', text: 'Volta no tempo: 20 s antes da quebra.', from: 0.2, to: 6 },
      ],
    },
    {
      id: 'como-esteiras',
      layout: 'single',
      seconds: 10,
      spans: [{ from: S.failure.at - 17, to: S.failure.at - 7, speed: 1 }],
      shot: { target: belt(1, 0.5, 0.5), radius: 16, phi: 0.95, theta: 0.6, turn: 0.5 },
      look: look({}),
      items: [
        {
          kind: 'caption',
          text: 'Pacotes chegam pelas entradas, andam pelas esteiras e saem pelas docas.',
          from: 0.3,
          to: 10,
        },
      ],
    },
    {
      id: 'como-robos',
      layout: 'single',
      seconds: 7,
      spans: [{ from: S.failure.at - 7, to: S.failure.at, speed: 1 }],
      shot: {
        target: { kind: 'robot' },
        radius: 11,
        phi: 1.0,
        theta: 0,
        turn: 0.5,
        focus: { at: { kind: 'robot' }, aperture: 0.003, maxblur: 0.01 },
      },
      look: look({ racks: 0.7 }),
      items: [
        {
          kind: 'caption',
          text: '40 robôs buscam pacotes nas prateleiras|e combinam o caminho entre si para não bater.',
          from: 0.2,
          to: 7,
        },
      ],
    },
    {
      id: 'quebra',
      layout: 'single',
      seconds: 5,
      spans: [{ from: S.failure.at, to: S.failure.at + 5, speed: 1 }],
      shot: {
        target: belt(BROKEN, 0.5, 0.5),
        radius: 18,
        phi: 0.62,
        theta: 0.5,
        turn: 0.1,
        focus: { at: belt(BROKEN, 0.5, 0.5), aperture: 0.003, maxblur: 0.01 },
      },
      look: look({ racks: 0.5 }),
      items: [
        { kind: 'pin', at: belt(BROKEN, 0.3), label: 'Esteira 8', from: 0, to: 5 },
        {
          kind: 'caption',
          text: 'De novo, a quebra. Agora, sem IA e com IA, lado a lado.',
          from: 0.2,
          to: 5,
        },
      ],
    },
    dividida(
      S.failure.at + 5,
      4,
      16.75,
      COMPLETA_SPLIT_SHOT,
      'Mesmo galpão, mesmas falhas. À esquerda, sem IA; à direita, com IA.',
      undefined,
    ),
    raiox({ ...XRAY_SHOT, radius: 32 }),
    previsao(226, 16, COMPLETA_PREVISAO_SHOT, true),
    numeros(226, 47, 15, ['entregas', 'ciclo', 'espera', 'quebras', 'evitadas'], false),
    {
      id: 'endereco',
      layout: 'single',
      seconds: 4,
      spans: [{ from: S.end, to: S.end, speed: 0, hold: 4 }],
      shot: { target: { kind: 'center' }, radius: 90, phi: 0.5, theta: 1.5, turn: 0.05 },
      look: look({}),
      items: [
        { kind: 'shade', alpha: 0.9, from: 0, to: 4 },
        { kind: 'address', from: 0, to: 4 },
      ],
    },
  ],
};

// ---------------------------------------------------------------- the warehouse tour

/**
 * The tour's version of the feed (?demo=cinema-galpao, 2026-10-13): it opens
 * on the split screen's climax, rewinds the run two minutes, follows one
 * packet through the working warehouse in one continuous shot (to its dock,
 * across Esteira 8 before it breaks), and ends that shot on Esteira 8 as it
 * breaks; from there on, the feed's story. It closes on the aerial shot it
 * opened the tour with.
 */

/** The teaser's moment: the split screen's climax (the split shows it again later, the same numbers). */
export const TEASER_AT = 170;
/** Where the rewind lands and the tour starts. */
export const TOUR_FROM = 50;
/**
 * The tour's packet: the last to go onto Esteira 6 (Entrada 2) before 65 s;
 * it crosses Esteira 8 between 74 and 79 s and reaches Doca 4 at 91 s, over a
 * robot passing under Esteira 10 (tests/cinema.test.ts checks all of it on the run).
 */
export const PROTAGONIST = { id: 279, entrance: 'Entrada 2' } as const;
/**
 * The robot taking boxes off a shelf near Entrada 2 as the packet goes in
 * (63–66 s, beside line B): the tour's "40 robôs" points at it.
 */
export const SHELF_ROBOT = 7;
/** The robot passing under Esteira 10 as the packet goes over it (83–85.5 s): the tour's 0,97 m. */
export const GATE_ROBOT = 28;
export const TEASER_TEXT = 'Mesma quebra. Duas decisões.';
/** The scale of the warehouse, each fixed to its place in the tour (checked on the engine). */
export const SCALE = {
  belts: '24 esteiras',
  robots: '40 robôs',
  distance: 'robôs a no mínimo 0,97 m uns dos outros',
  rate: '{rate} entregas por minuto',
} as const;

/** "⏪ 2 minutos antes": how far back the rewind goes (simulated seconds). */
export function rewindText(seconds: number): string {
  if (seconds % 60 !== 0) return `⏪ ${seconds} s antes`;
  const minutes = seconds / 60;
  return `⏪ ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} antes`;
}

/** A shot that moves through these poses (its fixed fields are the first pose's). */
function pathShot(
  keys: readonly CameraKey[],
  strength: { aperture: number; maxblur: number },
): Shot {
  const first = keys[0] as CameraKey;
  return {
    target: first.target,
    radius: first.radius,
    phi: first.phi,
    theta: first.theta,
    turn: 0,
    focus: { at: first.focus ?? first.target, ...strength },
    path: keys,
  };
}

const TOUR_PACKET: Anchor = { kind: 'protagonist', y: 0.9 };
/**
 * The whole warehouse from above, seen from behind the entrances (the long
 * side runs into the picture, which suits 4:5): where the tour starts and
 * the video ends.
 */
const AERIAL: Omit<CameraKey, 'at'> = {
  target: point(-2, 0, 0),
  radius: 60,
  phi: 0.62,
  theta: -1.35,
};

const secondsOf = (spans: readonly Span[]) => spans.reduce((t, s) => t + spanSeconds(s), 0);

/** What the tour's two versions (4:5 for the feed, 16:9 at about two minutes) do differently. */
interface TourSpec {
  readonly id: CinemaFormatId;
  readonly width: number;
  readonly height: number;
  readonly split: 'stack' | 'side';
  /** The tour: the aerial, the packet's way (slow), the return to Esteira 8. */
  readonly tour: readonly Span[];
  /** "Pacotes chegam pelas entradas…" while the camera goes with the packet (the long version). */
  readonly how: boolean;
  readonly splitShot: Shot;
  /** The split screen: 4×, at 2× while the AI takes over and decides. */
  readonly splitSpans: readonly Span[];
  readonly intro: string;
  readonly xray: Shot;
  readonly forecastShot: Shot;
  readonly forecastSpans: readonly Span[];
  readonly panelBelow: boolean;
  readonly numbers: {
    readonly speed: number;
    readonly seconds: number;
    readonly rows: readonly CardRowId[];
  };
  readonly cover: boolean;
}

/** The climax of the split screen, before anything is told: the same moment the split shows later. */
function teaser(seconds: number, split: Shot, splitSpans: readonly Span[]): Segment {
  // The split's own pose at TEASER_AT (its camera turns over the whole split).
  const at = split.theta + split.turn * (localAt(splitSpans, TEASER_AT) / secondsOf(splitSpans));
  const shot = { ...split, theta: at - 0.02, turn: 0.02 };
  return {
    id: 'teaser',
    layout: 'split',
    seconds,
    spans: [{ from: TEASER_AT - seconds, to: TEASER_AT, speed: 1 }],
    shot,
    look: look({ heat: 'espera', racks: 0.5, arrows: 2 }),
    items: [
      ...splitFrame(seconds),
      { kind: 'pulses', pane: 'ai', ...always(seconds) },
      { kind: 'phrase', text: TEASER_TEXT, ...always(seconds) },
    ],
  };
}

/** Both panes of a split screen: the subject lit, each side's tag, its counter, ⚠ on Esteira 8. */
function splitFrame(seconds: number): Item[] {
  return (['no-ai', 'ai'] as const).flatMap((pane): Item[] => [
    { kind: 'spotlight', around: SPLIT_SPOT, pad: [110, 90], alpha: 0.5, pane, ...always(seconds) },
    { kind: 'tag', pane, ...always(seconds) },
    { kind: 'counter', pane, ...always(seconds) },
    { kind: 'pin', at: belt(BROKEN, 0.3), pane, ...always(seconds) },
  ]);
}

/**
 * The thumbnail of the post: the split screen at the teaser's moment
 * (146 × 10), still, with the teaser's sentence large across the line
 * between the runs.
 */
function capa(split: Shot, splitSpans: readonly Span[]): Segment {
  const t = teaser(1, split, splitSpans);
  return {
    ...t,
    spans: [{ from: TEASER_AT, to: TEASER_AT, speed: 0, hold: 1 }],
    shot: { ...t.shot, turn: 0 },
    items: [...splitFrame(1), { kind: 'phrase', text: TEASER_TEXT, big: true, ...always(1) }],
  };
}

/** The time travel of the app, for real: the run's own moments, backward, to where the tour starts. */
function rebobinada(seconds: number, split: Shot): Segment {
  const back = TEASER_AT - TOUR_FROM;
  return {
    id: 'rebobinada',
    layout: 'single',
    seconds,
    spans: [{ from: TEASER_AT, to: TOUR_FROM, speed: -back / seconds }],
    shot: pathShot(
      [
        { at: 0, target: split.target, radius: split.radius, phi: split.phi, theta: 0.47 },
        { at: seconds, ...AERIAL },
      ],
      { aperture: 0.001, maxblur: 0.004 },
    ),
    look: look({ racks: 0.6, past: 1 }),
    items: [
      { kind: 'headline', text: rewindText(back), ...always(seconds) },
      { kind: 'timeline', sim: [TEASER_AT, TOUR_FROM], ...always(seconds) },
    ],
  };
}

/** The long version's words on how the floor works, while the camera goes with the packet. */
export const TOUR_HOW = 'Pacotes chegam pelas entradas, andam pelas esteiras e saem pelas docas.';

/**
 * The warehouse working, one continuous shot: the camera comes down from the
 * whole floor, picks up the packet at its entrance and travels with it slowly
 * (a slow orbit to the racks' side, low over the robots passing under Esteira
 * 10, up to its dock), then rises and turns back to Esteira 8 for the moment
 * it breaks. The scale of the place, one fact at a time, fixed to where it is.
 * Poses and labels are placed by the simulated moment they show.
 */
function tour(spans: readonly Span[], how: boolean): Segment {
  const seconds = secondsOf(spans);
  const t = (sim: number) => localAt(spans, sim);
  const keys: CameraKey[] = [
    { at: 0, ...AERIAL },
    // Down toward Entrada 2 (a crane shot): a robot at a shelf beside it, the packet going in.
    { at: t(60.2), target: point(-24, 0.5, 4), radius: 26, phi: 0.85, theta: -1.4 },
    { at: t(64.7), target: TOUR_PACKET, radius: 12, phi: 1.0, theta: -1.55 },
    // With the packet along line B, turning slowly to the far side (the racks behind it).
    { at: t(69.5), target: TOUR_PACKET, radius: 10, phi: 1.05, theta: -1.9 },
    { at: t(74.6), target: TOUR_PACKET, radius: 10.5, phi: 1.0, theta: -2.5 },
    { at: t(79.4), target: TOUR_PACKET, radius: 9.5, phi: 1.08, theta: -2.8 },
    // Low between the lines, where robots pass under Esteira 10.
    { at: t(83.9), target: TOUR_PACKET, radius: 7, phi: 1.2, theta: -2.75 },
    // To its dock, the truck beyond it.
    { at: t(87.8), target: TOUR_PACKET, radius: 10, phi: 1.02, theta: -2.6 },
    { at: t(91.4), target: TOUR_PACKET, radius: 12, phi: 0.92, theta: -2.75 },
    // Up and around, back to Esteira 8 for the moment it breaks (the focus goes with it);
    // the turn spread over the whole way back, the most of it from high up.
    {
      at: t(96),
      target: point(9, 0.5, 2.5),
      radius: 26,
      phi: 0.62,
      theta: -3.55,
      focus: belt(BROKEN, 0.5, 0.5),
    },
    {
      at: t(100.6),
      target: point(-6, 0.5, 3),
      radius: 15,
      phi: 0.98,
      theta: -4.35,
      focus: belt(BROKEN, 0.5, 0.5),
    },
    {
      at: seconds,
      target: HOOK_SHOT.target,
      radius: HOOK_SHOT.radius,
      phi: HOOK_SHOT.phi,
      // The hook's angle, reached turning on the same way round.
      theta: HOOK_SHOT.theta - 2 * Math.PI,
      focus: HOOK_SHOT.target,
    },
  ];
  // Each fact in a window of its own (the reading rule): the robot at the shelf from 63.4 s,
  // the one under Esteira 10 from 82.4 s, the deliveries from 89.4 s.
  const windows = [0, t(63.4) - 0.05, t(82.4) - 0.05, t(89.4) - 0.05];
  const sharpUntil = t(96);
  return {
    id: 'tour',
    layout: 'single',
    seconds,
    spans,
    shot: pathShot(
      // Sharp on the packet while the camera goes with it.
      keys.map((k) =>
        k.at > 0 && k.at < sharpUntil && !k.focus ? { ...k, focus: TOUR_PACKET } : k,
      ),
      { aperture: 0.003, maxblur: 0.01 },
    ),
    look: look({}),
    windows,
    items: [
      { kind: 'badge', ...always(seconds) },
      {
        kind: 'balloon',
        at: belt(11, 0.5, 0.9),
        text: SCALE.belts,
        tone: 'ink',
        inSight: true,
        dx: 60,
        dy: -130,
        from: 0.4,
        to: t(63.4) - 0.2,
      },
      {
        kind: 'balloon',
        at: { kind: 'fleet', robot: SHELF_ROBOT },
        text: SCALE.robots,
        tone: 'ink',
        inSight: true,
        dx: -60,
        dy: -120,
        from: t(63.4),
        to: t(70),
      },
      ...(how ? [{ kind: 'caption' as const, text: TOUR_HOW, from: t(70.5), to: t(79) }] : []),
      {
        kind: 'balloon',
        at: { kind: 'fleet', robot: GATE_ROBOT },
        text: SCALE.distance,
        tone: 'ink',
        inSight: true,
        dx: -40,
        dy: -170,
        from: t(82.4),
        to: t(89),
      },
      {
        kind: 'balloon',
        at: { kind: 'node', name: 'Doca 4', y: 1.2 },
        text: SCALE.rate,
        tone: 'ink',
        inSight: true,
        dx: -60,
        dy: -150,
        from: t(89.4),
        to: t(96),
      },
    ],
  };
}

/**
 * The breakdown, where the tour's shot ends: a short flash, rings going out
 * from the belt, and the bottleneck detector's card as it names the belt on
 * its own (105 s, a second later), in real time; the AI does not route yet
 * (it takes over at 128 s, in the split screen).
 */
function quebra(): Segment {
  const spans = [{ from: S.failure.at, to: HOOK_END, speed: 1 }];
  const seconds = secondsOf(spans);
  return {
    id: 'quebra',
    layout: 'single',
    seconds,
    spans,
    shot: HOOK_SHOT,
    look: look({ racks: 0.45 }),
    items: [
      { kind: 'flash', from: 0, to: 0.35 },
      { kind: 'wave', at: belt(BROKEN, 0.1, 0.9), from: 0, to: 1.6 },
      { kind: 'spotlight', around: LINE_B, pad: [200, 220], alpha: 0.6, ...always(seconds) },
      { kind: 'headline', text: 'Uma esteira quebrou.', ...always(seconds) },
      { kind: 'counter', ...always(seconds) },
      { kind: 'pin', at: { kind: 'queue-head' }, label: 'Esteira 8', ...always(seconds) },
      {
        kind: 'bottleneck',
        link: false,
        from: localAt(spans, S.failure.at + 1),
        to: seconds,
      },
    ],
  };
}

/**
 * The end: the camera goes back up to the aerial shot the tour opened on,
 * with the address and the call to try it, then the card holds still for
 * `hold` seconds (time to read the address).
 */
function fim(seconds: number, hold: number): Segment {
  return {
    id: 'endereco',
    layout: 'single',
    seconds: seconds + hold,
    spans: [
      { from: S.end, to: S.end + seconds, speed: 1 },
      { from: S.end + seconds, to: S.end + seconds, speed: 0, hold },
    ],
    shot: pathShot(
      [
        { at: 0, target: { kind: 'center' }, radius: 80, phi: 0.6, theta: 1.25 },
        { at: seconds, ...AERIAL },
      ],
      { aperture: 0.001, maxblur: 0.004 },
    ),
    look: look({}),
    items: [{ kind: 'address', cta: ADDRESS_CTA, ...always(seconds + hold) }],
  };
}

/** The router's first decision once the AI takes over (it decides on every whole second). */
const FIRST_DECISION = S.aiAt + 1;
/** Seconds the router's costs stay up from its first decision (the reading rule: 10 words). */
const COSTS_SHOWN = 3.75;

/**
 * The tour's version and the AI at work: on the AI's side, from 128 s, its
 * log (from the engine), the router's pulses at every decision, its costs at
 * B2 when it first decides, the 24 motors before the worn one's charts.
 */
function galpao(spec: TourSpec): CinemaFormat {
  return {
    id: spec.id,
    width: spec.width,
    height: spec.height,
    split: spec.split,
    // A feed's buttons and caption cover the bottom of the video on a phone.
    safe: { side: 0.05, top: 0.03, bottom: 0.08 },
    bitrate: 25_000_000,
    preroll: 12,
    ...(spec.cover ? { cover: { segment: capa(spec.splitShot, spec.splitSpans), local: 0 } } : {}),
    segments: [
      teaser(5.5, spec.splitShot, spec.splitSpans),
      rebobinada(2, spec.splitShot),
      tour(spec.tour, spec.how),
      quebra(),
      frase(FEED_FRASE_SHOT),
      dividida(HOOK_END, 4, secondsOf(spec.splitSpans), spec.splitShot, spec.intro, 'ai', {
        spans: spec.splitSpans,
        introUntil: S.aiAt - 0.5,
        extra: (spans) => {
          const seconds = secondsOf(spans);
          const costs = localAt(spans, FIRST_DECISION);
          return [
            { kind: 'pulses', pane: 'ai', ...always(seconds) },
            {
              kind: 'log',
              pane: 'ai',
              first: ['assume', 'corte', 'status'],
              lines: 2,
              place: 'bottom',
              ...always(seconds),
            },
            {
              kind: 'compare',
              node: 'B2',
              dx: -40,
              dy: -150,
              from: costs,
              to: costs + COSTS_SHOWN,
            },
          ];
        },
      }),
      raiox(spec.xray, false, [{ kind: 'pulses', pane: 'ai', from: 0, to: 12 }]),
      previsao(
        (spec.forecastSpans.at(-1) as Span).to,
        secondsOf(spec.forecastSpans),
        spec.forecastShot,
        spec.panelBelow,
        {
          spans: spec.forecastSpans,
          chartsAt: 205,
          quiet: true,
          extra: (spans) => {
            const seconds = secondsOf(spans);
            return [
              { kind: 'pulses', pane: 'ai', ...always(seconds) },
              {
                kind: 'log',
                pane: 'ai',
                first: ['retorno', 'manutencao'],
                lines: 1,
                place: 'top',
                ...always(seconds),
              },
            ];
          },
        },
      ),
      numeros(
        (spec.forecastSpans.at(-1) as Span).to,
        spec.numbers.speed,
        spec.numbers.seconds,
        spec.numbers.rows,
        false,
      ),
      fim(3, 1.5),
    ],
  };
}

/** The feed with the warehouse tour: 4:5, the split screen top and bottom. */
export const GALPAO: CinemaFormat = galpao({
  id: 'galpao',
  width: 1080,
  height: 1350,
  split: 'stack',
  tour: [
    { from: TOUR_FROM, to: 62, speed: 4 },
    { from: 62, to: 92, speed: 2 },
    { from: 92, to: S.failure.at, speed: 3 },
  ],
  how: false,
  splitShot: FEED_SPLIT_SHOT,
  splitSpans: [
    { from: HOOK_END, to: 123, speed: 4 },
    { from: 123, to: 141, speed: 2 },
    { from: 141, to: 176, speed: 4 },
  ],
  intro: 'Mesmo galpão, mesmas falhas. Em cima, sem IA; embaixo, com IA.',
  xray: XRAY_SHOT,
  forecastShot: FEED_PREVISAO_SHOT,
  forecastSpans: [
    { from: 188, to: 215, speed: 3 },
    { from: 215, to: 224, speed: 1 },
  ],
  panelBelow: false,
  numbers: { speed: 48, seconds: 11, rows: ['entregas', 'ciclo', 'quebras'] },
  cover: true,
});

/** The long version with the tour: 16:9, about two minutes, side by side, the tour at real time. */
export const GALPAO_COMPLETA: CinemaFormat = galpao({
  id: 'galpao-completa',
  width: 1920,
  height: 1080,
  split: 'side',
  tour: [
    { from: TOUR_FROM, to: 62, speed: 3 },
    { from: 62, to: 80, speed: 1 },
    { from: 80, to: 92, speed: 2 },
    { from: 92, to: S.failure.at, speed: 3 },
  ],
  how: true,
  splitShot: COMPLETA_SPLIT_SHOT,
  splitSpans: [
    { from: HOOK_END, to: 123, speed: 4 },
    { from: 123, to: 147, speed: 2 },
    { from: 147, to: 176, speed: 4 },
  ],
  intro: 'Mesmo galpão, mesmas falhas. À esquerda, sem IA; à direita, com IA.',
  xray: { ...XRAY_SHOT, radius: 32 },
  forecastShot: COMPLETA_PREVISAO_SHOT,
  forecastSpans: [
    { from: 188, to: 215, speed: 3 },
    { from: 215, to: 226, speed: 1 },
  ],
  panelBelow: true,
  numbers: {
    speed: 47,
    seconds: 15.5,
    rows: ['entregas', 'ciclo', 'espera', 'quebras', 'evitadas'],
  },
  cover: false,
});

export const CINEMA_FORMATS: Record<CinemaFormatId, CinemaFormat> = {
  feed: FEED,
  completa: COMPLETA,
  galpao: GALPAO,
  'galpao-completa': GALPAO_COMPLETA,
};

/**
 * The cinema demo the page plays: ?demo=cinema (the feed cut),
 * ?demo=cinema-completa, ?demo=cinema-galpao (the feed with the warehouse
 * tour), ?demo=cinema-galpao-completa (its 16:9 version), or none.
 */
export function cinemaFormatFrom(search: string): CinemaFormatId | null {
  const demo = new URLSearchParams(search).get('demo');
  const ids: Record<string, CinemaFormatId> = {
    cinema: 'feed',
    'cinema-completa': 'completa',
    'cinema-galpao': 'galpao',
    'cinema-galpao-completa': 'galpao-completa',
  };
  return demo !== null && Object.hasOwn(ids, demo) ? (ids[demo] as CinemaFormatId) : null;
}

/**
 * The moments the rewinds of a format show (s, ascending): a run keeps a
 * snapshot of each as it passes them going forward, and the rewind plays them back.
 */
export function rewindMoments(f: CinemaFormat): number[] {
  const out = new Set<number>();
  const frames = formatFrames(f);
  for (let k = 0; k < frames; k++) {
    const m = momentAt(f, k);
    if (m.speed < 0) out.add(m.time);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- reading the script

/** Video seconds a format lasts. */
export function formatSeconds(f: CinemaFormat): number {
  return f.segments.reduce((t, s) => t + s.seconds, 0);
}

/** Video frames a format has (60 per second, exactly). */
export function formatFrames(f: CinemaFormat): number {
  return Math.round(formatSeconds(f) * CINEMA_FPS);
}

export interface Moment {
  readonly segment: Segment;
  readonly index: number;
  /** Video seconds at which the segment starts, and into it. */
  readonly start: number;
  readonly local: number;
  /** The simulated moment shown (s) and its speed (0 while it holds still). */
  readonly time: number;
  readonly speed: number;
}

/**
 * What a video frame shows: its segment and the simulated moment. `frame`
 * may be fractional (playing live, by the clock); a whole frame at a whole
 * speed lands on a tick.
 */
export function momentAt(f: CinemaFormat, frame: number): Moment {
  let start = 0;
  const last = f.segments.length - 1;
  for (let i = 0; i <= last; i++) {
    const segment = f.segments[i] as Segment;
    const frames = Math.round(segment.seconds * CINEMA_FPS);
    const from = Math.round(start * CINEMA_FPS);
    if (frame < from + frames || i === last) {
      const localFrames = Math.min(Math.max(0, frame - from), frames);
      const { time, speed } = simAt(segment, localFrames);
      return { segment, index: i, start, local: localFrames / CINEMA_FPS, time, speed };
    }
    start += segment.seconds;
  }
  throw new Error('a format without segments');
}

/** The simulated moment `frames` frames into a segment, and its speed. */
function simAt(segment: Segment, frames: number): { time: number; speed: number } {
  let left = frames;
  for (const s of segment.spans) {
    const length = spanSeconds(s) * CINEMA_FPS;
    if (left < length - 1e-6) {
      // In ticks (1/60 s), so a whole frame at a whole speed is a whole tick.
      const ticks = Math.round(s.from * CINEMA_FPS) + s.speed * left;
      return { time: ticks / CINEMA_FPS, speed: s.speed };
    }
    left -= length;
  }
  const end = segment.spans.at(-1) as Span;
  return { time: end.to, speed: 0 };
}

/** The look of a segment `local` seconds into it (its layers, step by step). */
export function lookAt(segment: Segment, local: number): Look {
  let l = segment.look;
  for (const s of segment.steps ?? []) if (local >= s.from) l = { ...l, ...s.look };
  return l;
}

/** Seconds an item takes to fade in and out (at the edges of its segment it cuts with the scene). */
export const FADE = 0.3;

/** The items on screen `local` seconds into a segment, with how visible each is (0 … 1). */
export function itemsAt(segment: Segment, local: number): { item: Item; alpha: number }[] {
  const out: { item: Item; alpha: number }[] = [];
  for (const item of segment.items) {
    if (local < item.from || local >= item.to) continue;
    const fadeIn = item.from > 0 ? Math.min(1, (local - item.from) / FADE) : 1;
    const fadeOut = item.to < segment.seconds ? Math.min(1, (item.to - local) / FADE) : 1;
    out.push({ item, alpha: Math.max(0, Math.min(fadeIn, fadeOut)) });
  }
  return out;
}

/** "5×" when the run plays faster than real time; nothing at 1× or held still. */
export function badgeText(speed: number): string {
  return speed > 1 ? `${speed}×` : '';
}

/** A pane of the screen and the run it shows. */
export interface Pane {
  readonly side: CinemaSide;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The panes of a layout: one, or the run without AI first (top or left) and the one with AI. */
export function panesOf(f: CinemaFormat, layout: Segment['layout']): Pane[] {
  const { width: w, height: h } = f;
  if (layout === 'single') return [{ side: 'ai', x: 0, y: 0, w, h }];
  if (f.split === 'stack') {
    return [
      { side: 'no-ai', x: 0, y: 0, w, h: h / 2 },
      { side: 'ai', x: 0, y: h / 2, w, h: h / 2 },
    ];
  }
  return [
    { side: 'no-ai', x: 0, y: 0, w: w / 2, h },
    { side: 'ai', x: w / 2, y: 0, w: w / 2, h },
  ];
}

// ---------------------------------------------------------------- live texts

/** "Esteira 3 (A2→A3)" without what is in parentheses: "Esteira 3". */
export function shortLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)/g, '').trim();
}

/** The detector's card in the X-ray: the belt, its use, the cause (its live words). */
export function bottleneckText(b: {
  readonly label: string;
  readonly use: number;
  readonly cause: { readonly certain: boolean; readonly text: string };
}): string {
  const cause = shortLabel(b.cause.text);
  const article = /^(Esteira|Doca)\b/.test(cause) ? 'a ' : '';
  const why = b.cause.certain ? 'Causa' : 'Causa provável';
  return `${b.label}, ${Math.round(b.use * 100)}% de uso. ${why}: ${article}${cause}.`;
}

export const BOTTLENECK_TITLE = 'GARGALO AGORA';

export interface CinemaCardRow {
  /** The change with AI, big ("+49%"); empty for a plain row. */
  readonly headline: string;
  readonly label: string;
  readonly noAi: string;
  readonly ai: string;
}

/** The card's rows from both runs' measures (from the breakdown to the moment shown). */
export function cinemaCardRows(
  rows: readonly CardRowId[],
  ai: DemoSide,
  noAi: DemoSide,
): CinemaCardRow[] {
  return rows.map((id): CinemaCardRow => {
    switch (id) {
      case 'entregas':
        return {
          headline: change(ai.delivered, noAi.delivered),
          label: CARD_LABELS.entregas,
          noAi: int(noAi.delivered),
          ai: int(ai.delivered),
        };
      case 'ciclo':
        return {
          headline: change(ai.cycleP95, noAi.cycleP95),
          label: CARD_LABELS.ciclo,
          noAi: secondsText(noAi.cycleP95),
          ai: secondsText(ai.cycleP95),
        };
      case 'espera':
        return {
          headline: change(ai.waitP95, noAi.waitP95),
          label: CARD_LABELS.espera,
          noAi: secondsText(noAi.waitP95),
          ai: secondsText(ai.waitP95),
        };
      case 'quebras':
        return {
          headline: '',
          label: CARD_LABELS.quebras,
          noAi: int(noAi.breakdowns),
          ai: int(ai.breakdowns),
        };
      case 'evitadas':
        return {
          headline: '',
          label: CARD_LABELS.evitadas,
          noAi: int(noAi.avoided),
          ai: int(ai.avoided),
        };
    }
  });
}

export const CARD_TITLE = 'Nesta execução';
const CARD_LABELS: Record<CardRowId, string> = {
  entregas: 'entregas',
  ciclo: 'p95 do ciclo',
  espera: 'p95 de espera',
  quebras: 'quebras de esteira',
  evitadas: 'quebras evitadas',
};

// ---------------------------------------------------------------- the reading rule

/**
 * Words of a text, as the reading rule counts them: numbers included; a
 * separator such as "·" (or the rewind's "⏪") is not read, and "|" only
 * breaks a line.
 */
export const words = (text: string): number =>
  text
    .replace(/\|/g, ' ')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** What an item puts on screen, in words (a live value counts as one; "158 s" as two). */
export function itemWords(item: Item, live: { readonly bottleneck: string }): number {
  switch (item.kind) {
    case 'headline':
    case 'phrase':
    case 'caption':
    case 'title':
    case 'balloon':
      return words(item.text);
    case 'counter':
      return words(COUNTER_LABEL) + 1;
    case 'tag':
      return words('SEM IA');
    case 'badge':
      return 1;
    case 'pin':
      return words(item.label ?? '');
    case 'bottleneck':
      // Its title, its live words and the belt's name at the ring ("Esteira 3"), when drawn.
      return words(BOTTLENECK_TITLE) + words(live.bottleneck) + (item.link === false ? 0 : 2);
    case 'log':
      // The first line of each kind that shows up here (the next ones need not be read).
      return item.first.reduce(
        (n, k) => n + words(k === 'status' ? LOG_STATUS : LOG_EXAMPLE[k]),
        0,
      );
    case 'compare':
      // The title and a row per way: "Esteira 8 ∞", "linha A 11 s".
      return words(COMPARE_TITLE) + words('Esteira 8 ∞') + words('linha A 11 s');
    case 'monitor':
      // The title and the motor it names ("Esteira 16").
      return words(MONITOR_TITLE) + 2;
    case 'forecast':
      // vibração 3,2 mm/s · temperatura 40,1 °C · CUSUM 42,3 · limite do alarme
      return 1 + 2 + 1 + 2 + 1 + 1 + words('limite do alarme');
    case 'card': {
      const values: Record<CardRowId, number> = {
        entregas: 2,
        ciclo: 4,
        espera: 4,
        quebras: 2,
        evitadas: 2,
      };
      const rows = item.rows.reduce(
        (n, id) =>
          n + (id === 'quebras' || id === 'evitadas' ? 0 : 1) + words(CARD_LABELS[id]) + values[id],
        0,
      );
      return words(CARD_TITLE) + words('SEM IA COM IA') + rows + words(CARD_NOTE);
    }
    case 'address':
      return words(ADDRESS_LEAD) + words(ADDRESS) + words(item.cta ?? '');
    case 'timeline':
      // The moment it is at: "84 s".
      return 2;
    case 'routes':
    case 'spotlight':
    case 'shade':
    case 'flash':
    case 'pulses':
    case 'wave':
      return 0;
  }
}

export interface ReadingWindow {
  readonly segment: SegmentId;
  /** Seconds into the segment. */
  readonly from: number;
  readonly to: number;
  readonly words: number;
}

/**
 * The stretches the reading rule checks: each segment, or each of its
 * layers; an item's words count in the stretch where it shows up.
 */
export function readingWindows(
  f: CinemaFormat,
  live: {
    readonly bottleneck: string;
    /** The detector's words where a segment shows another finding (the tour's breakdown). */
    readonly bottleneckIn?: Partial<Record<SegmentId, string>>;
  },
): ReadingWindow[] {
  const out: ReadingWindow[] = [];
  for (const segment of f.segments) {
    const bounds = segment.windows ?? [0];
    const here = { bottleneck: live.bottleneckIn?.[segment.id] ?? live.bottleneck };
    bounds.forEach((from, i) => {
      const to = bounds[i + 1] ?? segment.seconds;
      const n = segment.items
        .filter((item) => item.from >= from && item.from < to)
        .reduce((sum, item) => sum + itemWords(item, here), 0);
      out.push({ segment: segment.id, from, to, words: n });
    });
  }
  return out;
}
