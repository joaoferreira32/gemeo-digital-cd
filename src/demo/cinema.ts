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

export type CinemaFormatId = 'feed' | 'completa';

export type SegmentId =
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
  | { readonly kind: 'bottleneck' };

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
 * second); with speed 0, `from` held still for `hold` seconds. A span that
 * does not start where the one before ended is a jump in time.
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
  /** The sentence in the middle of the screen. */
  | { readonly kind: 'phrase'; readonly text: string }
  /** At the bottom of a pane (or of the screen); "|" breaks a line. */
  | {
      readonly kind: 'caption';
      readonly text: string;
      readonly pane?: CinemaSide;
      /** Kept to the left (a panel stands to the right). */
      readonly narrow?: boolean;
    }
  /** "NA FILA" and the packets queuing now. */
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
  /** A label fixed to a point; "{share}" is the share of B2's packets going by line A. */
  | {
      readonly kind: 'balloon';
      readonly at: Anchor;
      readonly text: string;
      readonly tone: Tone;
      readonly dx: number;
      readonly dy: number;
      readonly pane?: CinemaSide;
    }
  /** The X-ray's title, on a band dark enough to hide what passes under it. */
  | { readonly kind: 'title'; readonly text: string }
  /** Every robot's reserved route, glowing (the X-ray). */
  | { readonly kind: 'routes' }
  /** The detector's card (its live words), a line to the ring and the belt's name there. */
  | { readonly kind: 'bottleneck' }
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
  | { readonly kind: 'address' }
  /** The time travel: a bar going back between two simulated moments (s). */
  | { readonly kind: 'timeline'; readonly sim: readonly [number, number] };

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
}

export const CINEMA_FPS = 60;

const S = DEMO_EXPLICADA;
/** The belt that breaks (Esteira 8, B2→B3) and the one whose motor wears (Esteira 16). */
const BROKEN = S.failure.target;
const WORN = S.wear.target;

export const PHRASE = 'Eu programei uma IA para decidir o que fazer.';
export const ADDRESS_LEAD = 'Código e detalhes';
export const ADDRESS = 'github.com/joaoferreira32/gemeo-digital-cd';
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

/** Seconds into a segment at which its run shows the simulated moment `time`. */
export function localAt(spans: readonly Span[], time: number): number {
  let local = 0;
  for (const s of spans) {
    if (s.speed === 0) {
      local += s.hold ?? 0;
      continue;
    }
    if (time <= s.to) return local + Math.max(0, time - s.from) / s.speed;
    local += (s.to - s.from) / s.speed;
  }
  return local;
}

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
  const seconds = 3;
  return {
    id: 'gancho',
    layout: 'single',
    seconds,
    spans: [{ from: S.failure.at, to: S.failure.at + 6, speed: 2 }],
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

/** "Eu programei uma IA…", while the camera pulls back over the floor. */
function frase(shot: Shot): Segment {
  const seconds = 3.5;
  return {
    id: 'frase',
    layout: 'single',
    seconds,
    spans: [{ from: S.failure.at + 6, to: S.failure.at + 9.5, speed: 1 }],
    shot,
    look: look({ racks: 0.6 }),
    items: [{ kind: 'phrase', text: PHRASE, from: 0.2, to: seconds }],
  };
}

/** The same warehouse with and without the AI, from the same moment. */
function dividida(
  from: number,
  speed: number,
  seconds: number,
  shot: Shot,
  intro: string,
  captionPane: CinemaSide | undefined,
): Segment {
  const spans = [{ from, to: 176, speed }];
  // The balloon shows once the AI has taken over and its arrows are up.
  const detour = localAt(spans, S.aiAt + 7);
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
      { kind: 'caption', text: intro, ...where, from: 0, to: detour - 0.3 },
      {
        kind: 'balloon',
        at: belt(11, 0.5, 0.7),
        text: 'desvio pela linha A',
        tone: 'cyan',
        dx: -60,
        dy: -90,
        pane: 'ai',
        from: detour,
        to: seconds,
      },
      {
        kind: 'caption',
        text: 'A IA desvia o fluxo, e a fila para de crescer.',
        ...where,
        from: detour + 1.2,
        to: seconds,
      },
    ],
  };
}

/** What the AI sees, one layer at a time: the waiting, the routes, the detour, the new bottleneck. */
function raiox(shot: Shot): Segment {
  const seconds = 14;
  const layers = [0, 3, 5, 7];
  return {
    id: 'raiox',
    layout: 'single',
    seconds,
    spans: [{ from: 176, to: 190, speed: 1 }],
    shot,
    look: look({ heat: 'espera', racks: 0.28 }),
    steps: [
      { from: layers[2] as number, look: { arrows: 2.6 } },
      { from: layers[3] as number, look: { arrows: 2.6, ring: true } },
    ],
    windows: layers,
    items: [
      { kind: 'spotlight', around: LINE_B, pad: [140, 150], alpha: 0.35, from: 0, to: 3 },
      { kind: 'routes', from: 3, to: seconds },
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
      {
        kind: 'balloon',
        at: { kind: 'route' },
        text: 'rotas reservadas dos robôs',
        tone: 'cyan',
        dx: -60,
        dy: -120,
        from: 3,
        to: 5,
      },
      {
        kind: 'balloon',
        at: { kind: 'node', name: 'B2', y: 0.7 },
        text: 'B2: {share}% pela linha A',
        tone: 'cyan',
        dx: 60,
        dy: 150,
        from: 5,
        to: 7,
      },
      { kind: 'bottleneck', from: 7, to: seconds },
    ],
  };
}

/** The worn motor: the AI reads it and stops the belt in time; without it, the belt breaks. */
function previsao(slow: number, seconds: number, shot: Shot, panelBelow: boolean): Segment {
  const spans = [
    { from: 190, to: 215, speed: 5 },
    { from: 215, to: slow, speed: 1 },
  ];
  const fast = localAt(spans, 215);
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
      { kind: 'forecast', pane: 'ai', motor: WORN, ...always(seconds) },
      {
        kind: 'caption',
        text: 'Sem IA, ninguém agenda a manutenção.',
        pane: 'no-ai',
        ...always(seconds),
      },
      {
        kind: 'caption',
        text: 'A IA prevê a quebra|pelos sensores do motor.',
        pane: 'ai',
        narrow: !panelBelow,
        ...always(seconds),
      },
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

/** The feed cut: 4:5, 60 s, the split screen one run above the other. */
export const FEED: CinemaFormat = {
  id: 'feed',
  width: 1080,
  height: 1350,
  split: 'stack',
  segments: [
    gancho(HOOK_SHOT),
    frase({ target: point(-6, 0.5, 0.5), radius: 30, phi: 0.62, theta: 0.42, turn: 0, glide: 1.4 }),
    dividida(
      S.failure.at + 9.5,
      5,
      12.5,
      {
        target: point(-6, 0.5, 0.5),
        radius: 30,
        phi: 0.6,
        theta: 0.42,
        turn: 0.06,
        focus: SPLIT_FOCUS,
      },
      'Mesmo galpão, mesmas falhas. Em cima, sem IA; embaixo, com IA.',
      'ai',
    ),
    raiox(XRAY_SHOT),
    previsao(
      224.5,
      14.5,
      {
        target: motor(WORN, 0.6, 2.5),
        radius: 10.5,
        phi: 0.6,
        theta: 5.8,
        turn: 0.04,
        focus: MOTOR_FOCUS,
      },
      false,
    ),
    numeros(224.5, 48, 12.5, ['entregas', 'ciclo', 'quebras'], true),
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
        { from: S.failure.at + 9.5, to: S.failure.at + 9.5, speed: 0, hold: 3 },
        { from: S.failure.at - 20, to: S.failure.at - 17, speed: 1 },
      ],
      shot: { target: point(-6, 0.5, 0.5), radius: 40, phi: 0.62, theta: 0.42, turn: 0.05 },
      look: look({ past: 1 }),
      steps: [{ from: 3, look: { past: 0 } }],
      items: [
        { kind: 'timeline', sim: [S.failure.at + 9.5, S.failure.at - 20], from: 0, to: 3 },
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
      {
        target: point(-6, 0.5, 0.5),
        radius: 24,
        phi: 0.6,
        theta: 0.42,
        turn: 0.06,
        focus: SPLIT_FOCUS,
      },
      'Mesmo galpão, mesmas falhas. À esquerda, sem IA; à direita, com IA.',
      undefined,
    ),
    raiox({ ...XRAY_SHOT, radius: 32 }),
    previsao(
      226,
      16,
      {
        target: motor(WORN, 0.6, -1.2, 2.4),
        radius: 9,
        phi: 0.62,
        theta: 5.8,
        turn: 0.04,
        focus: MOTOR_FOCUS,
      },
      true,
    ),
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

export const CINEMA_FORMATS: Record<CinemaFormatId, CinemaFormat> = {
  feed: FEED,
  completa: COMPLETA,
};

/** The cinema demo the page plays: ?demo=cinema (the feed cut), ?demo=cinema-completa, or none. */
export function cinemaFormatFrom(search: string): CinemaFormatId | null {
  const demo = new URLSearchParams(search).get('demo');
  return demo === 'cinema' ? 'feed' : demo === 'cinema-completa' ? 'completa' : null;
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
    const length =
      s.speed > 0 ? ((s.to - s.from) / s.speed) * CINEMA_FPS : (s.hold ?? 0) * CINEMA_FPS;
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

/** Words of a text, as the reading rule counts them (numbers included; "|" only breaks a line). */
export const words = (text: string): number =>
  text.replace(/\|/g, ' ').split(/\s+/).filter(Boolean).length;

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
      return words('NA FILA') + 1;
    case 'tag':
      return words('SEM IA');
    case 'badge':
      return 1;
    case 'pin':
      return words(item.label ?? '');
    case 'bottleneck':
      // Its title, its live words and the belt's name at the ring ("Esteira 3").
      return words(BOTTLENECK_TITLE) + words(live.bottleneck) + 2;
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
      return words(ADDRESS_LEAD) + words(ADDRESS);
    case 'timeline':
      // The moment it is at: "84 s".
      return 2;
    case 'routes':
    case 'spotlight':
    case 'shade':
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
  live: { readonly bottleneck: string },
): ReadingWindow[] {
  const out: ReadingWindow[] = [];
  for (const segment of f.segments) {
    const bounds = segment.windows ?? [0];
    bounds.forEach((from, i) => {
      const to = bounds[i + 1] ?? segment.seconds;
      const n = segment.items
        .filter((item) => item.from >= from && item.from < to)
        .reduce((sum, item) => sum + itemWords(item, live), 0);
      out.push({ segment: segment.id, from, to, words: n });
    });
  }
  return out;
}
