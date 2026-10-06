import type { Degradation } from '../sim/failures';
import type { DetectorParams } from '../sim/health';
import { World } from '../sim/world';

/**
 * Evaluation of the motor alarm (predictive maintenance) against the truth
 * the simulation knows: which conveyor was wearing out, and when it broke.
 *
 *  - An alarm is true when it goes up while that conveyor is wearing out
 *    (between the onset and the breakdown); otherwise it is false.
 *  - A breakdown is detected when an alarm went up on its conveyor during
 *    its wear; the lead time is from that first alarm to the breakdown. An
 *    alarm already up before the wear began does not count (conservative).
 *  - Sudden breakdowns (no wear) cannot be anticipated; they count in the
 *    recall over all breakdowns, not in the recall over worn ones.
 *  - Breakdowns after the end of the run are left out.
 */

/** What the evaluation needs from one run of the automatic failures. */
export interface MaintenanceRun {
  readonly seed: number;
  readonly seconds: number;
  /** scores[motor][second − 1]: the z score, or null while the motor is stopped. */
  readonly scores: (number | null)[][];
  readonly degradations: Degradation[];
  /** Every conveyor breakdown; `worn` when it ended a wear (it keeps the wear's id). */
  readonly breakdowns: { id: number; time: number; motor: number; worn: boolean }[];
  /** Alarms the engine raised: second and motor. */
  readonly alarms: { time: number; motor: number }[];
}

/** Runs the automatic failures of a seed for `seconds` and records the run. */
export function recordMaintenance(
  seed: number,
  seconds: number,
  detector?: Partial<DetectorParams>,
): MaintenanceRun {
  const w = new World({ seed, ...(detector ? { detector } : {}) });
  w.failures.setAuto(true, 0);
  const scores = w.conveyors.map(() => new Array<number | null>(seconds).fill(null));
  w.health.onScore = (motor, z) => {
    (scores[motor] as (number | null)[])[Math.round(w.time) - 1] = z;
  };
  const degradations = new Map<number, Degradation>();
  const breakdowns = new Map<number, { id: number; time: number; motor: number; worn: boolean }>();
  const alarms: { time: number; motor: number }[] = [];
  let lastEvent = 0;
  const perSecond = Math.round(1 / w.config.dt);
  for (let t = 0; t < seconds * perSecond; t++) {
    w.step();
    for (const d of w.failures.degrading) if (!degradations.has(d.id)) degradations.set(d.id, d);
    for (const f of w.failures.active) {
      if (f.kind !== 'conveyor' || breakdowns.has(f.id)) continue;
      breakdowns.set(f.id, {
        id: f.id,
        time: f.startedAt,
        motor: f.target,
        worn: degradations.has(f.id),
      });
    }
    for (const e of w.events) {
      if (e.id <= lastEvent) continue;
      lastEvent = e.id;
      if (e.kind === 'maintenance') {
        alarms.push({ time: Math.round(e.time), motor: e.target as number });
      }
    }
  }
  return {
    seed,
    seconds,
    scores,
    degradations: [...degradations.values()],
    breakdowns: [...breakdowns.values()],
    alarms,
  };
}

export interface DetectorScore {
  readonly alarms: number;
  readonly trueAlarms: number;
  /** True alarms ÷ alarms (NaN without alarms). */
  readonly precision: number;
  /** Breakdowns that came after wear, and how many of them were detected. */
  readonly breakdowns: number;
  readonly detected: number;
  /** Detected ÷ breakdowns that came after wear. */
  readonly recall: number;
  readonly suddenBreakdowns: number;
  /** Detected ÷ all conveyor breakdowns, sudden ones included. */
  readonly recallAll: number;
  /** Seconds of warning of each detected breakdown, ascending. */
  readonly leads: number[];
  /** Seconds of a running motor without wear, summed over the motors (exposure to false alarms). */
  readonly healthyMotorSeconds: number;
  /** False alarms per hour of a healthy running motor. */
  readonly falsePerMotorHour: number;
}

/**
 * The seconds at which the CUSUM alarm goes up, from the per-second z scores
 * of one motor (null while it is stopped). Same rule as MotorHealth.update.
 */
export function cusumAlarms(
  scores: readonly (number | null)[],
  allowance: number,
  threshold: number,
): number[] {
  const out: number[] = [];
  let sum = 0;
  let up = false;
  scores.forEach((z, i) => {
    if (z === null) {
      sum = 0;
      up = false;
      return;
    }
    sum = Math.max(0, sum + z - allowance);
    if (!up && sum >= threshold) {
      up = true;
      out.push(i + 1);
    } else if (up && sum === 0) {
      up = false;
    }
  });
  return out;
}

/** The alarms the CUSUM would raise in a run with other parameters (the scores do not depend on them). */
export function replayAlarms(
  run: MaintenanceRun,
  params: DetectorParams,
): { time: number; motor: number }[] {
  return run.scores.flatMap((series, motor) =>
    cusumAlarms(series, params.allowance, params.threshold).map((time) => ({ time, motor })),
  );
}

/** Scores a run: the engine's own alarms, or a replay with `params`. */
export function scoreRun(run: MaintenanceRun, params?: DetectorParams): DetectorScore {
  const alarms = params ? replayAlarms(run, params) : run.alarms;
  const { degradations, seconds } = run;
  const wearing = (motor: number, t: number) =>
    degradations.some((d) => d.target === motor && d.onset <= t && t < d.breaksAt);
  const trueAlarms = alarms.filter((a) => wearing(a.motor, a.time)).length;
  const counted = degradations.filter((d) => d.breaksAt <= seconds);
  const leads: number[] = [];
  for (const d of counted) {
    const first = alarms
      .filter((a) => a.motor === d.target && d.onset <= a.time && a.time < d.breaksAt)
      .reduce((m, a) => Math.min(m, a.time), Infinity);
    if (Number.isFinite(first)) leads.push(d.breaksAt - first);
  }
  leads.sort((a, b) => a - b);
  let healthy = 0;
  run.scores.forEach((series, motor) =>
    series.forEach((z, i) => {
      if (z !== null && !wearing(motor, i + 1)) healthy++;
    }),
  );
  const sudden = run.breakdowns.filter((b) => !b.worn && b.time <= seconds).length;
  return summarize({
    alarms: alarms.length,
    trueAlarms,
    breakdowns: counted.length,
    detected: leads.length,
    suddenBreakdowns: sudden,
    leads,
    healthyMotorSeconds: healthy,
  });
}

/** Pools several runs into one score (sums, then ratios). */
export function pool(scores: readonly DetectorScore[]): DetectorScore {
  const sum = (f: (s: DetectorScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  return summarize({
    alarms: sum((s) => s.alarms),
    trueAlarms: sum((s) => s.trueAlarms),
    breakdowns: sum((s) => s.breakdowns),
    detected: sum((s) => s.detected),
    suddenBreakdowns: sum((s) => s.suddenBreakdowns),
    leads: scores.flatMap((s) => s.leads).sort((a, b) => a - b),
    healthyMotorSeconds: sum((s) => s.healthyMotorSeconds),
  });
}

function summarize(
  c: Omit<DetectorScore, 'precision' | 'recall' | 'recallAll' | 'falsePerMotorHour'>,
): DetectorScore {
  const all = c.breakdowns + c.suddenBreakdowns;
  return {
    ...c,
    precision: c.alarms ? c.trueAlarms / c.alarms : NaN,
    recall: c.breakdowns ? c.detected / c.breakdowns : NaN,
    recallAll: all ? c.detected / all : NaN,
    falsePerMotorHour: c.healthyMotorSeconds
      ? (c.alarms - c.trueAlarms) / (c.healthyMotorSeconds / 3600)
      : NaN,
  };
}
