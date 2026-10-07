/**
 * Every keyboard shortcut of the app, in one table: the page dispatches its
 * keys from it, the camera reads its held keys from it, and the help panel is
 * drawn from it. A test checks that no key does two things.
 *
 * Keys are KeyboardEvent.code values (the physical key, any layout). A
 * shortcut with `shift` only answers with Shift held; the same key without
 * Shift may do something else (R tilts the camera, ⇧R restarts), and the
 * camera then ignores it while Shift is down. Shortcuts without `shift` answer
 * with or without it ("+" is Shift + "=" on most layouts).
 */

/** Keys the camera reads while they are held down (continuous moves). */
export const CAMERA_KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  turnLeft: ['KeyQ'],
  turnRight: ['KeyE'],
  tiltUp: ['KeyR'],
  tiltDown: ['KeyF'],
  zoomIn: ['Equal', 'NumpadAdd'],
  zoomOut: ['Minus', 'NumpadSubtract'],
} as const;

export type ShortcutAction =
  /** Held keys and mouse gestures, handled by the camera itself. */
  | 'camera'
  | 'camera-preset'
  | 'next-robot'
  | 'pause'
  | 'speed'
  | 'failure'
  | 'auto-failures'
  | 'wear'
  | 'policy'
  | 'heat'
  | 'stress'
  | 'quality'
  | 'restart'
  | 'seek'
  | 'live'
  | 'continue'
  | 'kpi'
  | 'lab'
  | 'help'
  | 'close'
  /** Clicks: help text only. */
  | 'pick';

/** How the help writes the keys: `{ kbd }` in a key cap, plain strings as text. */
export type KeyLabel = string | { readonly kbd: string };

export interface Shortcut {
  readonly action: ShortcutAction;
  readonly codes: readonly string[];
  readonly shift?: boolean;
  readonly label: readonly KeyLabel[];
  readonly help: string;
}

const k = (kbd: string) => ({ kbd });

export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'camera', codes: [], label: ['Arrastar'], help: 'girar a câmera' },
  { action: 'camera', codes: [], label: ['Botão direito / ⇧ + arrastar'], help: 'mover (pan)' },
  { action: 'camera', codes: [], label: ['Roda do mouse'], help: 'zoom em direção ao cursor' },
  {
    action: 'camera',
    codes: [...CAMERA_KEYS.up, ...CAMERA_KEYS.left, ...CAMERA_KEYS.down, ...CAMERA_KEYS.right],
    label: [k('W'), k('A'), k('S'), k('D'), ' / setas'],
    help: 'mover',
  },
  {
    action: 'camera',
    codes: [...CAMERA_KEYS.turnLeft, ...CAMERA_KEYS.turnRight],
    label: [k('Q'), k('E')],
    help: 'girar',
  },
  {
    action: 'camera',
    codes: [...CAMERA_KEYS.tiltUp, ...CAMERA_KEYS.tiltDown],
    label: [k('R'), k('F')],
    help: 'inclinar',
  },
  {
    action: 'camera',
    codes: [...CAMERA_KEYS.zoomIn, ...CAMERA_KEYS.zoomOut],
    label: [k('+'), k('−')],
    help: 'zoom',
  },
  {
    action: 'camera-preset',
    codes: ['Digit1', 'Digit2', 'Digit3'],
    label: [k('1'), k('2'), k('3')],
    help: 'câmeras aérea, chão e seguir robô',
  },
  { action: 'next-robot', codes: ['KeyN'], label: [k('N')], help: 'seguir o próximo robô' },
  { action: 'pause', codes: ['Space'], label: [k('Espaço')], help: 'pausar / continuar' },
  {
    action: 'speed',
    codes: ['Comma', 'Period'],
    label: [k(','), k('.')],
    help: 'velocidade 1×, 4× ou 16×',
  },
  {
    action: 'failure',
    codes: ['Digit5', 'Digit6', 'Digit7', 'Digit8'],
    label: [k('5'), '…', k('8')],
    help: 'falhas: esteira quebrada, pico de pedidos, robô com defeito, doca bloqueada',
  },
  { action: 'auto-failures', codes: ['Digit9'], label: [k('9')], help: 'falhas automáticas' },
  {
    action: 'wear',
    codes: ['Digit0'],
    label: [k('0')],
    help: 'desgaste numa esteira: ela quebraria em 1 a 3 minutos; o halo do motor e o alarme de manutenção avisam antes (sinais simulados), e a IA agenda a manutenção para evitar a quebra',
  },
  {
    action: 'policy',
    codes: ['KeyP'],
    label: [k('P')],
    help: 'roteamento: heurística (a política oficial, ativa ao abrir), IA treinada (PPO) ou estático; o painel K compara com o estático ao vivo',
  },
  {
    action: 'heat',
    codes: ['KeyM'],
    label: [k('M')],
    help: 'mapa de calor: ocupação, tempo de espera, tráfego de robôs',
  },
  {
    action: 'stress',
    codes: ['KeyT'],
    label: [k('T')],
    help: 'teste de carga (taxa de pedidos alta)',
  },
  {
    action: 'quality',
    codes: ['KeyG'],
    label: [k('G')],
    help: 'trocar qualidade gráfica (desliga o modo automático)',
  },
  {
    action: 'restart',
    codes: ['KeyR'],
    shift: true,
    label: [k('⇧'), k('R')],
    help: 'reiniciar com a mesma seed',
  },
  {
    action: 'seek',
    codes: ['BracketLeft', 'BracketRight'],
    label: [k('['), k(']')],
    help: 'voltar / avançar 10 s na gravação (a simulação ao vivo espera)',
  },
  { action: 'live', codes: ['KeyL'], label: [k('L')], help: 'voltar ao vivo' },
  {
    action: 'continue',
    codes: ['KeyC'],
    label: [k('C'), ' ou ', k('Espaço'), ' no passado'],
    help: 'continuar daqui (o que vinha depois é descartado)',
  },
  {
    action: 'kpi',
    codes: ['KeyK'],
    label: [k('K')],
    help: 'painel de operação: vazão, tempo de ciclo, roteamento, manutenção, utilização',
  },
  { action: 'help', codes: ['KeyH'], label: [k('H')], help: 'atalhos e legenda' },
  { action: 'close', codes: ['Escape'], label: [k('Esc')], help: 'fechar painéis' },
  {
    action: 'pick',
    codes: [],
    label: ['Clique na cena'],
    help: 'histórico do robô, da esteira ou da doca',
  },
];

/** The shortcut a key press asks for, or undefined (camera keys and clicks are not here). */
export function shortcutFor(code: string, shift: boolean): Shortcut | undefined {
  const pick = (withShift: boolean) =>
    SHORTCUTS.find(
      (s) => s.codes.includes(code) && !!s.shift === withShift && s.action !== 'camera',
    );
  return (shift ? pick(true) : undefined) ?? pick(false);
}

/** Keys that do something else with Shift held: the camera leaves them alone then. */
export function shiftedElsewhere(code: string): boolean {
  return SHORTCUTS.some((s) => s.shift && s.codes.includes(code));
}
