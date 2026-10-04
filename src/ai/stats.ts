/**
 * Paired comparison of two policies over the same seeds: for each seed the
 * relative gain of the candidate over the baseline (positive = better),
 * then their mean with a 95% confidence interval (Student's t) and how many
 * seeds the candidate wins.
 */
export interface Paired {
  readonly n: number;
  /** Mean relative gain (0.05 = 5% better). */
  readonly mean: number;
  /** 95% confidence interval of the mean gain. */
  readonly low: number;
  readonly high: number;
  /** Seeds where the candidate is strictly better. */
  readonly wins: number;
}

/** Two-sided 97.5% quantile of Student's t for 1 … 30 degrees of freedom. */
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

export function tQuantile975(df: number): number {
  if (df < 1) return Infinity;
  return T975[Math.min(df, T975.length) - 1] as number;
}

/**
 * `lowerIsBetter`: for times (cycle, waiting) the gain is (base − cand) / base;
 * for throughput it is (cand − base) / base.
 */
export function paired(
  baseline: readonly number[],
  candidate: readonly number[],
  lowerIsBetter: boolean,
): Paired {
  if (baseline.length !== candidate.length) throw new Error('paired samples differ in size');
  const gains = baseline.map((b, i) => {
    const c = candidate[i] as number;
    return lowerIsBetter ? (b - c) / b : (c - b) / b;
  });
  const n = gains.length;
  const mean = gains.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? gains.reduce((a, g) => a + (g - mean) ** 2, 0) / (n - 1) : 0;
  const half = n > 1 ? tQuantile975(n - 1) * Math.sqrt(variance / n) : Infinity;
  return {
    n,
    mean,
    low: mean - half,
    high: mean + half,
    wins: gains.filter((g) => g > 1e-12).length,
  };
}
