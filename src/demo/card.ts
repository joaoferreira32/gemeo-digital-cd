import type { DemoResult } from './run';

/**
 * The final card of the demo: the run with AI against the same run without
 * it (static routing, no maintenance schedule), from the breakdown to the end.
 * One run only, so the card says so and points to the README table with the
 * 95% intervals, the official results.
 */

export interface CardRow {
  readonly label: string;
  readonly ai: string;
  readonly noAi: string;
  /** "−27%" (better with AI), "+59%" (more deliveries with AI); empty when it does not apply. */
  readonly change: string;
}

/** What a card says around its numbers. */
export interface CardTexts {
  readonly title: string;
  readonly subtitle: string;
  /** Lines under the table: what the run stands for, and where the official result is. */
  readonly notes: readonly string[];
  /** Label of the last row. */
  readonly avoided: string;
}

export const CARD_TITLE = 'Resultado nesta execução';
export const CARD_SUBTITLE =
  'Com IA × sem IA (roteamento estático, sem manutenção preditiva): mesma seed, mesmas falhas, da quebra ao fim';
/** The scenario was picked to show each step: it is not the average. */
export const CARD_SCENARIO = 'Cenário escolhido para mostrar cada etapa; não representa a média.';
export const CARD_NOTE =
  'Uma execução só. O resultado oficial, com intervalo de confiança de 95%, está na tabela de benchmarks do README.';

/** The short demo's card (?demo=curta). */
export const SHORT_CARD: CardTexts = {
  title: CARD_TITLE,
  subtitle: CARD_SUBTITLE,
  notes: [CARD_SCENARIO, CARD_NOTE],
  avoided: 'Quebras evitadas pela manutenção',
};

/** The explained demo's card: shorter words, read in its 19 s (1 s for every 3 words). */
export const EXPLAINED_CARD: CardTexts = {
  title: CARD_TITLE,
  subtitle: 'Com IA × sem IA (roteamento fixo, sem manutenção preditiva), da quebra ao fim',
  notes: [
    CARD_SCENARIO,
    'Uma execução só. O resultado oficial, com IC de 95%, está na tabela do README.',
  ],
  avoided: 'Quebras evitadas',
};

const int = (v: number) => Math.round(v).toLocaleString('pt-BR');
const seconds = (v: number) => `${Math.round(v).toLocaleString('pt-BR')} s`;
function change(ai: number, noAi: number): string {
  if (!(noAi > 0) || !Number.isFinite(ai)) return '';
  const p = Math.round(((ai - noAi) / noAi) * 100);
  return p === 0 ? '0%' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}

export function cardRows(r: DemoResult, avoided = SHORT_CARD.avoided): CardRow[] {
  const { ai, noAi } = r;
  return [
    {
      label: 'Entregas',
      ai: int(ai.delivered),
      noAi: int(noAi.delivered),
      change: change(ai.delivered, noAi.delivered),
    },
    {
      label: 'p95 do ciclo',
      ai: seconds(ai.cycleP95),
      noAi: seconds(noAi.cycleP95),
      change: change(ai.cycleP95, noAi.cycleP95),
    },
    {
      label: 'p95 de espera',
      ai: seconds(ai.waitP95),
      noAi: seconds(noAi.waitP95),
      change: change(ai.waitP95, noAi.waitP95),
    },
    {
      label: 'Pior fila',
      ai: `${int(ai.waitingMax)} pacotes`,
      noAi: `${int(noAi.waitingMax)} pacotes`,
      change: change(ai.waitingMax, noAi.waitingMax),
    },
    { label: 'Quebras de esteira', ai: int(ai.breakdowns), noAi: int(noAi.breakdowns), change: '' },
    {
      label: avoided,
      ai: int(ai.avoided),
      noAi: int(noAi.avoided),
      change: '',
    },
  ];
}
