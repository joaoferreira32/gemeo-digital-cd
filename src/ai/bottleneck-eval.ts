import type { FailureKind } from '../sim/failures';
import { Recorder } from '../sim/recorder';
import {
  BottleneckDetector,
  topologyOf,
  type BottleneckParams,
  type CauseKind,
} from './bottleneck';

/**
 * Controlled trials of the bottleneck detector (phase 4b): one failure applied
 * at a known moment of an otherwise calm run (heuristic routing, no other
 * failure), so the truth is known exactly. The same seed without the failure
 * is the reference: up to the failure both runs are the same, bit for bit,
 * and the difference in waiting packets afterwards is what the failure did.
 */

export interface TrialSpec {
  readonly seed: number;
  /** The failure applied at `t0`; null for the reference run of the seed. */
  readonly failure: { readonly kind: FailureKind; readonly target?: number } | null;
  readonly t0: number;
  /** Seconds the run lasts. */
  readonly seconds: number;
}

export interface TrialFinding {
  readonly second: number;
  readonly kind: 'conveyor' | 'dock';
  readonly index: number;
  readonly cause: CauseKind;
  readonly target: number;
}

export interface TrialRun {
  readonly spec: TrialSpec;
  /** False when the failure could not be applied (a robot already charging, ...). */
  readonly applied: boolean;
  /** When the failure ended (NaN for the reference, or one still on at the end). */
  readonly endsAt: number;
  /** Packets waiting, every second from 0 to the end. */
  readonly waiting: number[];
  /** Findings of the detector every second from `from`, one list per parameter set. */
  readonly from: number;
  readonly findings: TrialFinding[][];
}

/** Reference runs are watched from this second on (the building has filled up). */
export const WATCH_FROM = 60;

export function runTrial(
  spec: TrialSpec,
  paramSets: readonly Partial<BottleneckParams>[],
): TrialRun {
  const rec = new Recorder({ seed: spec.seed });
  rec.input({ type: 'policy', policy: 'heuristic' });
  const perSecond = Math.round(1 / rec.config.dt);
  rec.stepMany(spec.t0 * perSecond);
  let applied = spec.failure === null;
  let endsAt = NaN;
  // A robot that is charging (or already broken) cannot get a defect: that trial is left out.
  const robot = spec.failure?.kind === 'robot' ? spec.failure.target : undefined;
  if (spec.failure && (robot === undefined || rec.live.canBreakRobot(robot))) {
    const before = rec.live.failures.active.length;
    rec.input(
      spec.failure.target !== undefined
        ? { type: 'inject', kind: spec.failure.kind, target: spec.failure.target }
        : { type: 'inject', kind: spec.failure.kind },
    );
    const f = rec.live.failures.active[before];
    applied = f !== undefined;
    if (f) endsAt = f.endsAt;
  }
  rec.stepMany((spec.seconds - spec.t0) * perSecond);
  const s = rec.series;
  const waiting = Array.from({ length: s.seconds }, (_, i) => s.waiting.get(i));
  const from = spec.failure ? spec.t0 : WATCH_FROM;
  const topology = topologyOf(rec.live);
  const findings = paramSets.map((params) => {
    const detector = new BottleneckDetector(topology, params);
    const out: TrialFinding[] = [];
    for (let sec = from; sec < s.seconds; sec++) {
      const b = detector.detect(s, sec);
      if (b) {
        out.push({
          second: sec,
          kind: b.kind,
          index: b.index,
          cause: b.cause.kind,
          target: b.cause.target,
        });
      }
    }
    return out;
  });
  return { spec, applied, endsAt, waiting, from, findings };
}

/** Does a finding's cause name the failure that was applied? */
export function causeMatches(
  failure: { readonly kind: FailureKind; readonly target?: number },
  f: TrialFinding,
): boolean {
  switch (failure.kind) {
    case 'conveyor':
      return f.cause === 'conveyor' && f.target === failure.target;
    case 'dock':
      return f.cause === 'dock' && f.target === failure.target;
    case 'surge':
      return f.cause === 'surge';
    case 'robot':
      // The detector names belts and docks; a robot defect is never its explanation.
      return false;
  }
}

/** Packets a failure added to the queues, from the run with it and its reference (10 s means). */
export function extraWaiting(trial: TrialRun, reference: TrialRun, from: number, to: number) {
  let worst = 0;
  for (let t = from; t <= to; t++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, t - 9); k <= t; k++) {
      const a = trial.waiting[k];
      const b = reference.waiting[k];
      if (a === undefined || b === undefined) continue;
      sum += a - b;
      n++;
    }
    if (n) worst = Math.max(worst, sum / n);
  }
  return worst;
}
