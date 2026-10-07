import { tQuantile975 } from '../ai/stats';

/**
 * Statistics of the lab: a mean with its 95% confidence interval (Student's
 * t), and the paired difference B − A over the same seeds (each seed gives
 * both scenarios the same orders and the same random streams, so the
 * difference seed by seed removes most of the noise).
 */
export interface Estimate {
  readonly n: number;
  readonly mean: number;
  readonly low: number;
  readonly high: number;
}

export function estimate(values: readonly number[]): Estimate {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return { n, mean: NaN, low: NaN, high: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
  const half = n > 1 ? tQuantile975(n - 1) * Math.sqrt(variance / n) : Infinity;
  return { n, mean, low: mean - half, high: mean + half };
}

export interface PairedEstimate extends Estimate {
  /** Seeds where B is lower than A, and higher. */
  readonly lower: number;
  readonly higher: number;
}

/** B − A, seed by seed (pairs with a missing value on either side are left out). */
export function pairedDifference(a: readonly number[], b: readonly number[]): PairedEstimate {
  if (a.length !== b.length) throw new Error('paired samples differ in size');
  const d: number[] = [];
  a.forEach((x, i) => {
    const y = b[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) d.push(y - x);
  });
  return {
    ...estimate(d),
    lower: d.filter((x) => x < 0).length,
    higher: d.filter((x) => x > 0).length,
  };
}

/**
 * A share pooled over seeds (Σ hits / Σ trials) with its 95% interval, the
 * seed as the unit: the trials of one seed are not independent (one queue
 * yields several explanations), so the interval comes from how much the
 * seeds differ (the variance of a ratio estimator, linearized), not from the
 * count of trials. Clamped to [0, 1]; when every seed has the same share the
 * interval closes on it.
 */
export function pooledShare(hits: readonly number[], trials: readonly number[]): Estimate {
  if (hits.length !== trials.length) throw new Error('hits and trials differ in size');
  const n = hits.length;
  const total = trials.reduce((a, b) => a + b, 0);
  if (n === 0 || total === 0) return { n, mean: NaN, low: NaN, high: NaN };
  const share = hits.reduce((a, b) => a + b, 0) / total;
  if (n === 1) return { n, mean: share, low: 0, high: 1 };
  const residuals = hits.reduce((a, h, i) => a + (h - share * (trials[i] as number)) ** 2, 0);
  const se = Math.sqrt((n / (n - 1)) * residuals) / total;
  const half = tQuantile975(n - 1) * se;
  return { n, mean: share, low: Math.max(0, share - half), high: Math.min(1, share + half) };
}
