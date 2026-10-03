/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * The simulation never calls Math.random: every random decision comes from an
 * Rng created from the scenario seed, so the same seed always reproduces the
 * same run. Independent concerns (orders, failures, ...) use separate streams
 * derived with `deriveSeed`, so changing one scenario parameter does not shift
 * the random sequence of another — scenario A and B see the same orders.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Exponentially distributed interval for a Poisson process with the given rate. */
  exponential(rate: number): number {
    // 1 - next() is in (0, 1], so the log is always finite.
    return -Math.log(1 - this.next()) / rate;
  }

  /** Index drawn with probability proportional to `weights[i]`. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i] ?? 0;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Current internal state; enough to resume the exact same sequence. */
  getState(): number {
    return this.state;
  }

  /** Continues the sequence from a state read with `getState` (checkpoints). */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}

/** FNV-1a hash of the seed and a stream label, used to derive independent streams. */
export function deriveSeed(seed: number, stream: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  h = Math.imul(h, 0x01000193);
  for (let i = 0; i < stream.length; i++) {
    h ^= stream.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
