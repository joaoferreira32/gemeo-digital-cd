/**
 * Seed sets of the operations AI (phase 4). The README lists them.
 *
 *  - Training: any seed from 10 001 to 19 999; the learning agent draws
 *    its episodes from here and nowhere else.
 *  - Validation: 20 001 … 20 010; the heuristic is calibrated on them and
 *    the agent's tuning rounds are judged on them.
 *  - Test: 30 001 … 30 010; used once, for the final comparison.
 *  - Test of phase 4b: 30 011 … 30 020, never used before it; used once,
 *    for the final evaluation of the maintenance schedule and the
 *    bottleneck detector (registered in docs/resultados.md before measuring).
 */
export const TRAINING_SEEDS = { from: 10_001, to: 19_999 } as const;

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

export const VALIDATION_SEEDS: readonly number[] = range(20_001, 10);
export const TEST_SEEDS: readonly number[] = range(30_001, 10);
export const TEST_SEEDS_4B: readonly number[] = range(30_011, 10);

export type SeedSet = 'validation' | 'test' | 'teste-4b';

export function seedsOf(set: SeedSet): readonly number[] {
  if (set === 'validation') return VALIDATION_SEEDS;
  if (set === 'test') return TEST_SEEDS;
  if (set === 'teste-4b') return TEST_SEEDS_4B;
  throw new Error(`unknown seed set ${String(set)}`);
}

/** Test sets are used once, at the end: the benchmarks ask for --final. */
export function isTestSet(set: SeedSet): boolean {
  return set !== 'validation';
}
