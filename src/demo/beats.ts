import { DEMO, type DemoScript } from './run';

/**
 * The demo as the viewer sees it: beats over the simulated time of the
 * script (src/demo/run.ts), each with its speed, its camera shot and its
 * caption. The video is silent, so the captions tell the story. The times
 * follow the run of the script (the same on every machine); tests/demo.test.ts
 * checks that what each beat says happens inside it.
 */

export type BeatId =
  | 'aberto'
  | 'robos'
  | 'falha'
  | 'desvio'
  | 'fila'
  | 'gargalo'
  | 'manutencao'
  | 'segue'
  | 'volta'
  | 'sem-ia'
  | 'resultado';

/** What the camera looks at: the whole floor, a belt (its middle), a node, a working robot. */
export type ShotTarget =
  | { readonly kind: 'center' }
  | { readonly kind: 'belt'; readonly id: number }
  | { readonly kind: 'node'; readonly name: string }
  | { readonly kind: 'robot' };

export interface Shot {
  readonly target: ShotTarget;
  /** Distance to the target (m), polar angle from straight down and azimuth (rad). */
  readonly radius: number;
  readonly phi: number;
  readonly theta: number;
  /** Radians the camera turns around the target during the beat (a slow travelling). */
  readonly turn: number;
  /** A light depth of field focused on the target. */
  readonly focus: boolean;
}

export interface Beat {
  readonly id: BeatId;
  /** The run with AI, the jump back, the run without AI, or the final card. */
  readonly side: 'ai' | 'rewind' | 'no-ai' | 'card';
  /** Simulated seconds it covers (the jump back and the card have none) and its speed. */
  readonly from: number;
  readonly to: number;
  readonly speed: number;
  /** Real seconds, for the beats without simulated time. */
  readonly hold: number;
  readonly title: string;
  /**
   * The caption under the title. `{gargalo}` is the detector's explanation at
   * that moment, `{evento}` the last event of the beat's kinds (live texts).
   */
  readonly text: string;
  /** Events the caption follows ({evento}). */
  readonly events?: readonly string[];
  readonly shot: Shot;
  /** Heat map layer during the beat. */
  readonly heat: 'off' | 'espera';
}

const center = (radius: number, phi: number, theta: number, turn: number): Shot => ({
  target: { kind: 'center' },
  radius,
  phi,
  theta,
  turn,
  focus: false,
});

/** The beats of the demo script. */
export function demoBeats(script: DemoScript = DEMO): Beat[] {
  const f = script.failure;
  const w = script.wear;
  return [
    {
      id: 'aberto',
      side: 'ai',
      from: script.warmup,
      to: script.warmup + 5,
      speed: 1,
      hold: 0,
      title: 'Um centro de distribuição, simulado no navegador',
      text: '24 esteiras, 6 docas e 40 robôs; cada instante fica gravado e pode ser revisto',
      shot: center(80, 0.66, 0.15, 0.3),
      heat: 'off',
    },
    {
      id: 'robos',
      side: 'ai',
      from: script.warmup + 5,
      to: f.at,
      speed: 1,
      hold: 0,
      title: '40 robôs, nenhuma colisão',
      text: 'cada robô reserva no tempo o caminho por onde vai passar',
      shot: { target: { kind: 'robot' }, radius: 11, phi: 1.02, theta: 0, turn: 0.5, focus: true },
      heat: 'off',
    },
    {
      id: 'falha',
      side: 'ai',
      from: f.at,
      to: f.at + 6,
      speed: 2,
      hold: 0,
      title: 'Falha: a Esteira 9 (B3→B4) quebrou',
      text: 'os pacotes que vinham por ela começam a parar',
      shot: {
        target: { kind: 'belt', id: f.target },
        radius: 15,
        phi: 0.95,
        theta: 0.5,
        turn: 0.15,
        focus: true,
      },
      heat: 'off',
    },
    {
      id: 'desvio',
      side: 'ai',
      from: f.at + 6,
      to: f.at + 18,
      speed: 3,
      hold: 0,
      title: 'A IA desvia o fluxo',
      text: 'as setas mostram a rota escolhida: o tráfego passa pela linha A, e robôs levam pacotes por fora da esteira parada',
      shot: {
        target: { kind: 'node', name: 'B2' },
        radius: 21,
        phi: 0.82,
        theta: 0.9,
        turn: 0.2,
        focus: true,
      },
      heat: 'off',
    },
    {
      id: 'fila',
      side: 'ai',
      from: f.at + 18,
      to: f.at + 42,
      speed: 4,
      hold: 0,
      title: 'Mesmo assim, a fila cresce',
      text: 'no mapa de calor, o vermelho é tempo de espera',
      shot: {
        target: { kind: 'belt', id: f.target },
        radius: 42,
        phi: 0.5,
        theta: 0.3,
        turn: 0.2,
        focus: false,
      },
      heat: 'espera',
    },
    {
      id: 'gargalo',
      side: 'ai',
      from: f.at + 42,
      to: 190,
      speed: 8,
      hold: 0,
      title: 'A IA aponta o gargalo e explica a causa',
      text: '{gargalo}',
      shot: {
        target: { kind: 'belt', id: f.target },
        radius: 24,
        phi: 0.8,
        theta: -0.2,
        turn: 0.15,
        focus: true,
      },
      heat: 'off',
    },
    {
      id: 'manutencao',
      side: 'ai',
      from: 190,
      to: 230,
      speed: 6,
      hold: 0,
      title: 'Manutenção preditiva',
      text: '{evento}',
      events: ['maintenance', 'service-planned', 'failure-avoided'],
      shot: {
        target: { kind: 'belt', id: w.target },
        radius: 15,
        phi: 0.92,
        theta: 2.2,
        turn: 0.2,
        focus: true,
      },
      heat: 'off',
    },
    {
      id: 'segue',
      side: 'ai',
      from: 230,
      to: script.end,
      speed: 32,
      hold: 0,
      title: 'A operação se recupera',
      text: 'com IA, até o fim do trecho comparado',
      shot: center(72, 0.66, 0.6, 0.35),
      heat: 'off',
    },
    {
      id: 'volta',
      side: 'rewind',
      from: script.branchAt,
      to: script.branchAt,
      speed: 0,
      hold: 2.5,
      title: 'Volta no tempo',
      text: 'até um segundo antes da quebra, para rodar a mesma execução sem IA',
      shot: center(72, 0.66, 0.95, 0),
      heat: 'off',
    },
    {
      id: 'sem-ia',
      side: 'no-ai',
      from: script.branchAt,
      to: script.end,
      speed: 32,
      hold: 0,
      title: 'A mesma execução, sem IA',
      text: 'roteamento estático e sem manutenção preditiva. {evento}',
      events: ['failure-start'],
      shot: center(64, 0.6, 0.95, 0.35),
      heat: 'espera',
    },
    {
      id: 'resultado',
      side: 'card',
      from: script.end,
      to: script.end,
      speed: 0,
      hold: 8,
      title: 'Resultado nesta execução',
      text: '',
      shot: center(78, 0.66, 1.3, 0.15),
      heat: 'off',
    },
  ];
}

/** Real seconds the demo lasts (the jump back and the card, plus each beat's simulated time at its speed). */
export function wallSeconds(beats: readonly Beat[]): number {
  return beats.reduce((t, b) => t + (b.speed > 0 ? (b.to - b.from) / b.speed : b.hold), 0);
}

/** The beat of a side at a simulated time (the last one once past its end). */
export function beatAt(beats: readonly Beat[], side: Beat['side'], time: number): Beat {
  const of = beats.filter((b) => b.side === side);
  for (const b of of) if (time < b.to) return b;
  return of.at(-1) as Beat;
}
