/**
 * Seed sets of the operations AI (phase 4). The README lists them.
 *
 *  - Training: any seed from 10 001 to 19 999; the learning agent draws
 *    its episodes from here and nowhere else.
 *  - Validation: 20 001 … 20 010; the heuristic is calibrated on them and
 *    the agent's tuning rounds are judged on them.
 *  - Test: 30 001 … 30 010; used once, for the final comparison.
 */
export const TRAINING_SEEDS = { from: 10_001, to: 19_999 } as const;

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

export const VALIDATION_SEEDS: readonly number[] = range(20_001, 10);
export const TEST_SEEDS: readonly number[] = range(30_001, 10);

export type SeedSet = 'validation' | 'test';

export function seedsOf(set: SeedSet): readonly number[] {
  return set === 'validation' ? VALIDATION_SEEDS : TEST_SEEDS;
}
