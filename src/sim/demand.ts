/**
 * Demand that follows the hours of a week (phase 5): the configured order
 * rate times the weight of the hour of the week the simulation is in. The
 * weights come from the Olist orders (public/demanda-olist.json, CC BY-NC-SA
 * 4.0, built by scripts/demanda_olist.py) and average 1 over the week, so the
 * configured rate stays the mean rate of a week.
 *
 * Time is compressed: `secondsPerHour` simulated seconds stand for one hour of
 * the week (60: a day in 24 simulated minutes). The weight changes at each
 * hour, in steps, like the hourly counts it comes from.
 */
export interface DemandProfile {
  /** One weight per hour of the week, Monday 00h to Sunday 23h; mean 1. */
  readonly weights: readonly number[];
  /** Simulated seconds per hour of the week. */
  readonly secondsPerHour: number;
  /** Hour of the week at simulated time 0 (0: Monday 00h). */
  readonly startHour: number;
}

export const HOURS_PER_WEEK = 168;

/** Simulated seconds per hour of the week in the app and the lab: a day in 24 minutes. */
export const SECONDS_PER_HOUR = 60;

export const WEEKDAYS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

/** Hour of the week (0 … 167) at simulated time t. */
export function hourOfWeek(d: DemandProfile, t: number): number {
  const h = d.startHour + Math.floor(t / d.secondsPerHour + 1e-9);
  return ((h % HOURS_PER_WEEK) + HOURS_PER_WEEK) % HOURS_PER_WEEK;
}

/** Weight of the demand at simulated time t. */
export function demandWeight(d: DemandProfile, t: number): number {
  return d.weights[hourOfWeek(d, t)] as number;
}

/** "segunda, 14h" for an hour of the week. */
export function hourLabel(hour: number): string {
  return `${WEEKDAYS[Math.floor(hour / 24)]}, ${hour % 24}h`;
}

export function validateDemand(d: DemandProfile): void {
  if (d.weights.length !== HOURS_PER_WEEK) {
    throw new Error(`demand profile needs ${HOURS_PER_WEEK} weights, got ${d.weights.length}`);
  }
  if (!d.weights.every((w) => Number.isFinite(w) && w >= 0)) {
    throw new Error('demand weights must be finite and not negative');
  }
  if (!(d.secondsPerHour > 0)) throw new Error('secondsPerHour must be positive');
  if (!Number.isInteger(d.startHour) || d.startHour < 0 || d.startHour >= HOURS_PER_WEEK) {
    throw new Error('startHour must be an hour of the week (0 … 167)');
  }
}
