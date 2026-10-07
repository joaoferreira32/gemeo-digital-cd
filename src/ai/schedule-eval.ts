import type { FailureKind } from '../sim/failures';
import { quantile } from '../sim/recorder';
import type { ScheduleParams, ServiceOutcome } from '../sim/schedule';
import { World } from '../sim/world';

/**
 * Evaluation of the maintenance schedule (phase 4b) on the automatic
 * failures, against the truth the simulation knows (which belt was wearing
 * out and when it would break). One run = one seed, the congestion heuristic
 * routing (the official policy), automatic failures from the start, with or
 * without the schedule; the same seed gives both runs the same orders and the
 * same random streams, so they are compared seed by seed.
 */

export const WARMUP_SECONDS = 60;

export interface ScheduleRunOptions {
  readonly seconds: number;
  readonly schedule: boolean;
  readonly params?: Partial<ScheduleParams>;
}

export interface Breakdown {
  readonly id: number;
  readonly time: number;
  readonly target: number;
  /** It ended a wear (the schedule could have avoided it); otherwise sudden. */
  readonly worn: boolean;
}

export interface ScheduleRun {
  readonly seed: number;
  readonly seconds: number;
  readonly schedule: boolean;
  readonly params: ScheduleParams;
  /** Conveyor breakdowns that happened during the run. */
  readonly breakdowns: Breakdown[];
  /** Every wear that started, with when it would break. */
  readonly degradations: { id: number; target: number; onset: number; breaksAt: number }[];
  /** Motor alarms: second and belt. */
  readonly alarms: { time: number; motor: number }[];
  /** Failures the automatic mode started, by kind, and wears started (the load the run faced). */
  readonly injected: Record<FailureKind | 'wear', number>;
  /** How each maintenance plan ended (schedule on). */
  readonly outcomes: ServiceOutcome[];
  /** Belt-seconds stopped by breakdowns, and by planned maintenance. */
  readonly brokenSeconds: number;
  readonly serviceSeconds: number;
  /** Packets on a belt at the moment it stopped (they wait for it): breakdowns, maintenance. */
  readonly stuckBroken: number;
  readonly stuckService: number;
  /** Packet-seconds on stopped belts (how many waited, and for how long): breakdowns, maintenance. */
  readonly stuckSecondsBroken: number;
  readonly stuckSecondsService: number;
  /** Each maintenance started: the belt, the wait since its alarm, the packets left on it. */
  readonly starts: { target: number; wait: number; stuck: number; drainable: boolean }[];
  /** Inbound packets delivered after the warm-up, and their cycle time (order to dock), s. */
  readonly delivered: number;
  readonly cycleMean: number;
  readonly cycleP95: number;
  readonly cycleP99: number;
}

export function recordScheduleRun(seed: number, options: ScheduleRunOptions): ScheduleRun {
  const w = new World({
    seed,
    scheduleMaintenance: options.schedule,
    ...(options.params ? { schedule: options.params } : {}),
  });
  w.setPolicy('heuristic');
  w.failures.setAuto(true, 0);
  const perSecond = Math.round(1 / w.config.dt);
  const warmup = WARMUP_SECONDS * perSecond;
  const cycles: number[] = [];
  w.onDelivery = (p) => {
    if (p.origin >= 0 && w.tick > warmup) cycles.push(w.time - p.createdAt);
  };
  const outcomes: ServiceOutcome[] = [];
  w.schedule.onOutcome = (o) => outcomes.push(o);

  const degradations = new Map<
    number,
    { id: number; target: number; onset: number; breaksAt: number }
  >();
  const breakdowns = new Map<number, Breakdown>();
  const alarms: { time: number; motor: number }[] = [];
  const injected: Record<FailureKind | 'wear', number> = {
    conveyor: 0,
    surge: 0,
    robot: 0,
    dock: 0,
    wear: 0,
  };
  const status = w.conveyors.map((c) => c.status);
  let brokenTicks = 0;
  let serviceTicks = 0;
  let stuckBroken = 0;
  let stuckService = 0;
  let stuckTicksBroken = 0;
  let stuckTicksService = 0;
  const starts: ScheduleRun['starts'] = [];
  let lastEvent = 0;
  for (let t = 0; t < options.seconds * perSecond; t++) {
    w.step();
    for (const d of w.failures.degrading) {
      if (!degradations.has(d.id)) {
        degradations.set(d.id, {
          id: d.id,
          target: d.target,
          onset: d.onset,
          breaksAt: d.breaksAt,
        });
      }
    }
    for (const f of w.failures.active) {
      if (f.kind !== 'conveyor' || breakdowns.has(f.id)) continue;
      breakdowns.set(f.id, {
        id: f.id,
        time: f.startedAt,
        target: f.target,
        worn: degradations.has(f.id),
      });
    }
    w.conveyors.forEach((c, i) => {
      if (c.status === 'broken') {
        brokenTicks++;
        stuckTicksBroken += c.packets.length;
      } else if (c.status === 'maintenance') {
        serviceTicks++;
        stuckTicksService += c.packets.length;
      }
      if (c.status !== status[i]) {
        if (status[i] === 'ok' && c.status === 'broken') stuckBroken += c.packets.length;
        if (status[i] === 'ok' && c.status === 'maintenance') {
          stuckService += c.packets.length;
          const o = outcomes.at(-1) as ServiceOutcome;
          starts.push({
            target: i,
            wait: o.time - o.alarmAt,
            stuck: c.packets.length,
            drainable: w.drainSeconds(i) > 0,
          });
        }
        status[i] = c.status;
      }
    });
    for (const e of w.events) {
      if (e.id <= lastEvent) continue;
      lastEvent = e.id;
      if (e.kind === 'maintenance') alarms.push({ time: e.time, motor: e.target as number });
      if (e.kind === 'failure-start' && e.failure) injected[e.failure]++;
    }
  }
  let sum = 0;
  for (const c of cycles) sum += c;
  return {
    seed,
    seconds: options.seconds,
    schedule: options.schedule,
    params: w.schedule.params,
    breakdowns: [...breakdowns.values()],
    degradations: [...degradations.values()],
    alarms,
    injected: { ...injected, wear: degradations.size },
    outcomes,
    brokenSeconds: brokenTicks / perSecond,
    serviceSeconds: serviceTicks / perSecond,
    stuckBroken,
    stuckService,
    stuckSecondsBroken: stuckTicksBroken / perSecond,
    stuckSecondsService: stuckTicksService / perSecond,
    starts,
    delivered: cycles.length,
    cycleMean: cycles.length ? sum / cycles.length : NaN,
    cycleP95: quantile(cycles, 0.95),
    cycleP99: quantile(cycles, 0.99),
  };
}

/**
 * Lead time of each wear the alarm caught, in a run without the schedule:
 * from the first alarm on that belt during the wear to the breakdown (the
 * same rule as the phase 4 evaluation of the alarm, src/ai/maintenance.ts).
 */
export function leadTimes(run: ScheduleRun): number[] {
  const out: number[] = [];
  for (const d of run.degradations) {
    if (!run.breakdowns.some((b) => b.id === d.id)) continue;
    const first = run.alarms
      .filter((a) => a.motor === d.target && d.onset <= a.time && a.time < d.breaksAt)
      .reduce((m, a) => Math.min(m, a.time), Infinity);
    if (Number.isFinite(first)) out.push(d.breaksAt - first);
  }
  return out.sort((a, b) => a - b);
}

/** What the schedule did in one run (schedule on). */
export interface ScheduleScore {
  /** Wears that ran their course in the run: avoided, or ended in a breakdown. */
  readonly wears: number;
  readonly avoided: number;
  /** Breakdowns of any kind that happened, and how many came after a wear. */
  readonly breakdowns: number;
  readonly wornBreakdowns: number;
  /** Breakdowns that came while a maintenance waited (after its alarm, before its start). */
  readonly lostWhileWaiting: number;
  /** Maintenance that found no wear (false alarms). */
  readonly unneeded: number;
  /** Seconds from the alarm to the start of each maintenance. */
  readonly waits: number[];
}

export function scoreSchedule(run: ScheduleRun): ScheduleScore {
  const avoided = run.outcomes.filter((o) => o.kind === 'avoided');
  const worn = run.breakdowns.filter((b) => b.worn);
  return {
    wears: avoided.length + worn.length,
    avoided: avoided.length,
    breakdowns: run.breakdowns.length,
    wornBreakdowns: worn.length,
    lostWhileWaiting: run.outcomes.filter((o) => o.kind === 'lost').length,
    unneeded: run.outcomes.filter((o) => o.kind === 'unneeded').length,
    waits: run.outcomes
      .filter((o) => o.kind !== 'lost')
      .map((o) => o.time - o.alarmAt)
      .sort((a, b) => a - b),
  };
}
