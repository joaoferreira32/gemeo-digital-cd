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
 *  - Test of phase 5: 30 021 … 30 030, never used before it; used once, for
 *    the causes of the bottleneck detector under the automatic failures
 *    (registered in docs/resultados.md before measuring).
 *  - Test of the detector with memory: 30 031 … 30 040, never used before it;
 *    used once, the detectors without and with the memory of failures side by
 *    side (registered in docs/resultados.md before calibrating).
 */
export const TRAINING_SEEDS = { from: 10_001, to: 19_999 } as const;

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

export const VALIDATION_SEEDS: readonly number[] = range(20_001, 10);
export const TEST_SEEDS: readonly number[] = range(30_001, 10);
export const TEST_SEEDS_4B: readonly number[] = range(30_011, 10);
export const TEST_SEEDS_5: readonly number[] = range(30_021, 10);
export const TEST_SEEDS_MEMORY: readonly number[] = range(30_031, 10);

export type SeedSet = 'validation' | 'test' | 'teste-4b' | 'teste-5' | 'teste-memoria';

export function seedsOf(set: SeedSet): readonly number[] {
  if (set === 'validation') return VALIDATION_SEEDS;
  if (set === 'test') return TEST_SEEDS;
  if (set === 'teste-4b') return TEST_SEEDS_4B;
  if (set === 'teste-5') return TEST_SEEDS_5;
  if (set === 'teste-memoria') return TEST_SEEDS_MEMORY;
  throw new Error(`unknown seed set ${String(set)}`);
}

/** Test sets are used once, at the end: the benchmarks ask for --final. */
export function isTestSet(set: SeedSet): boolean {
  return set !== 'validation';
}
