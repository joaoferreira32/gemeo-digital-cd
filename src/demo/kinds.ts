import { demoBeats, type Beat } from './beats';
import { EXPLAINED_CARD, SHORT_CARD, type CardTexts } from './card';
import { CHAPTERS, explainedBeats } from './explicada';
import { DEMO_SCRIPTS, type DemoKindId, type DemoScript } from './run';

/** One of the two demos: its script in the worker, its beats on the page, its card. */
export interface DemoKind {
  readonly id: DemoKindId;
  readonly script: DemoScript;
  readonly beats: readonly Beat[];
  /** Chapter names, for "Etapa X de 9" (none in the short demo). */
  readonly chapters: readonly string[];
  readonly card: CardTexts;
  /**
   * The explained demo's presentation: big captions, the chapter line, the
   * speed badge, slower camera glides and, with reduced motion, a short fade
   * instead of a cut.
   */
  readonly explained: boolean;
}

export const DEMO_KINDS: Record<DemoKindId, DemoKind> = {
  explicada: {
    id: 'explicada',
    script: DEMO_SCRIPTS.explicada,
    beats: explainedBeats(DEMO_SCRIPTS.explicada),
    chapters: CHAPTERS,
    card: EXPLAINED_CARD,
    explained: true,
  },
  curta: {
    id: 'curta',
    script: DEMO_SCRIPTS.curta,
    beats: demoBeats(DEMO_SCRIPTS.curta),
    chapters: [],
    card: SHORT_CARD,
    explained: false,
  },
};

/** The demo the page plays: the explained one, or the short one at ?demo=curta. */
export function demoKindFrom(search: string): DemoKindId {
  return new URLSearchParams(search).get('demo') === 'curta' ? 'curta' : 'explicada';
}
