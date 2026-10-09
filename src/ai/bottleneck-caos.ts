import type { FailureKind } from '../sim/failures';
import { waitingFor } from '../sim/queues';
import { applyInput, Recorder, type SimInput } from '../sim/recorder';
import { World, type Checkpoint } from '../sim/world';
import {
  BottleneckDetector,
  DEFAULT_BOTTLENECK,
  topologyOf,
  type BottleneckParams,
  type CauseKind,
} from './bottleneck';

/**
 * The causes of the bottleneck detector under the automatic failures (phase
 * 5): several failures at once, so "the failure the injector applied" does
 * not say by itself which one made a queue. The truth comes from
 * counterfactual runs, exactly: for each failure, the same seed is run again
 * from a checkpoint before it with that failure alone suppressed
 * (failures.ts: drawn as usual, never applied, holding its place in the limit
 * of failures), and the queues are measured every second, as the recorder
 * does, until HORIZON seconds after its end.
 *
 *  - Explanation: consecutive seconds with the same bottleneck and the same
 *    cause (what the screen showed). It is judged at its worst second (the
 *    largest queue at the bottleneck): a finding is held a few seconds after
 *    its evidence, when the queue may already be gone.
 *  - Candidates at a second: every failure on then, or ended at most
 *    AFTERMATH seconds before (a queue outlives its cause: a broken belt
 *    leaves a backlog that takes minutes to drain).
 *  - Causes: the candidates whose removal takes at least half of the queue
 *    at the bottleneck away (and at least MIN_SHRINK packets). None: no single
 *    failure made it; the layout and the demand did.
 *  - Right: the detector names one of the causes, or the layout when there
 *    is none. A robot defect is never named by the detector: when it is the
 *    only cause, the explanation is wrong.
 *  - Seconds: every second with a finding and at least the detector's own
 *    minimum queue at the bottleneck, judged the same way.
 *
 * The routing is the heuristic and the maintenance schedule is off (its
 * stops are decisions, not failures the injector applies).
 *
 * Several detectors (parameter sets) are judged on the same recording and
 * the same truth: they find the same bottlenecks at the same seconds (only
 * the memory of failures differs, and it changes the cause alone), so the
 * counterfactual queues are measured once.
 */

export const MIN_SHRINK = 6;
/**
 * Seconds after its end a failure is still a candidate. Chosen on the
 * validation seeds (docs/resultados.md, phase 5) with a control: a robot
 * defect almost never makes a belt or dock queue (0% of the explanations
 * while it is on), and up to 180 s after its end it is still at the noise
 * level (at most 3.5%, as often as a removal makes a queue grow by half);
 * from there on it rises to about 10%: removing any old failure eases the
 * whole building, and "the cause" stops being one failure.
 */
export const AFTERMATH = 180;
/** Seconds the counterfactual runs go on after each failure: the precision with longer windows. */
export const HORIZON = 600;
/** Findings are watched from this second on (the building has filled up). */
export const WATCH_FROM = 60;

/** The detector without the memory of failures. */
export const NO_MEMORY: Partial<BottleneckParams> = { memory: 0 };

/**
 * The calibration grid of the memory of failures, registered in
 * docs/resultados.md before calibrating: the window, the links, which stop
 * among several, and the memory before the surge rule or after it. In the
 * order of the tie-break: shorter window, narrower links, the stop that ended
 * last, the memory after the surge rule.
 */
export const MEMORY_GRID: readonly Partial<BottleneckParams>[] = [60, 120, 180].flatMap((memory) =>
  (['own', 'flow', 'routes'] as const).flatMap((memoryLinks) =>
    (['last', 'longest'] as const).flatMap((memoryPick) =>
      [false, true].map((memoryFirst) => ({ memory, memoryLinks, memoryPick, memoryFirst })),
    ),
  ),
);

/** A short name for a set of memory parameters ("120 s, fluxo, última, depois do pico"). */
export function memoryName(p: Partial<BottleneckParams>): string {
  if (!p.memory) return 'sem memória';
  const links = { own: 'só a própria', flow: 'pelo fluxo', routes: 'fluxo e rotas' };
  return `${p.memory} s, ${links[p.memoryLinks ?? 'flow']}, ${p.memoryPick === 'longest' ? 'a mais longa' : 'a última'}, ${p.memoryFirst ? 'antes do pico' : 'depois do pico'}`;
}

export interface CaosFailure {
  readonly id: number;
  readonly kind: FailureKind;
  readonly target: number;
  readonly startedAt: number;
  readonly endsAt: number;
}

export interface CaosJudgement {
  readonly second: number;
  /** Packets waiting for the bottleneck then, in the run as it was. */
  readonly queue: number;
  /** Failures on then (started, not yet ended). */
  readonly simultaneous: number;
  /**
   * Each failure on then or ended up to HORIZON seconds before, and the
   * packets its removal took off that queue.
   */
  readonly candidates: readonly (CaosFailure & { readonly shrink: number })[];
  /** The failures that made the queue (window AFTERMATH); empty: the layout and the demand. */
  readonly causes: readonly CaosFailure[];
  readonly correct: boolean;
}

export interface CaosExplanation {
  readonly from: number;
  readonly to: number;
  readonly resource: { readonly kind: 'conveyor' | 'dock'; readonly index: number };
  /** What the detector said; `memory`: a stop that had already ended (the memory of failures). */
  readonly cause: { readonly kind: CauseKind; readonly target: number; readonly memory: boolean };
  /** Judged at its worst second. */
  readonly judged: CaosJudgement;
}

/** One detector judged on a run. */
export interface CaosVariant {
  readonly params: Partial<BottleneckParams>;
  /** Every explanation (left out when only the counts were asked for). */
  readonly explanations?: CaosExplanation[];
  /** Explanations, and those right, by the failures on at the judged second (0, 1, 2 or more). */
  readonly judged: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  /**
   * Seconds with a finding and a queue of at least the minimum, and those
   * judged right, by the failures on in that second (0, 1, 2 or more).
   */
  readonly judgedSeconds: readonly [number, number, number];
  readonly rightSeconds: readonly [number, number, number];
}

export interface CaosRun {
  readonly seed: number;
  readonly seconds: number;
  readonly failures: CaosFailure[];
  readonly variants: CaosVariant[];
}

/** Queues every second of a counterfactual run, from `from` to `to`. */
interface Counterfactual {
  readonly from: number;
  readonly to: number;
  readonly conveyors: Int32Array;
  readonly docks: Int32Array;
}

/**
 * One seed under the automatic failures; each detector in `variants` (changes
 * to DEFAULT_BOTTLENECK) judged on it. `countsOnly` leaves the explanations out
 * (the calibration grid only needs the counts).
 */
export function runCaos(
  seed: number,
  seconds: number,
  variants: readonly Partial<BottleneckParams>[] = [{}],
  countsOnly = false,
): CaosRun {
  const rec = new Recorder({ seed });
  rec.input({ type: 'policy', policy: 'heuristic' });
  rec.input({ type: 'auto', on: true });
  const perSecond = Math.round(1 / rec.config.dt);
  const failures = new Map<number, CaosFailure>();
  for (let t = 0; t < seconds * perSecond; t++) {
    rec.step();
    for (const f of rec.live.failures.active) {
      if (!failures.has(f.id)) {
        failures.set(f.id, {
          id: f.id,
          kind: f.kind,
          target: f.target,
          startedAt: f.startedAt,
          endsAt: f.endsAt,
        });
      }
    }
  }
  const s = rec.series;
  const last = s.seconds - 1;
  const all = [...failures.values()];
  const without = new Map<number, Counterfactual>();
  for (const f of all) without.set(f.id, counterfactual(rec, f, last));

  const queueOf = (resource: CaosExplanation['resource'], sec: number) =>
    resource.kind === 'conveyor'
      ? s.conveyorQueue.get(sec * s.conveyors + resource.index)
      : s.dockQueue.get(sec * s.docks + resource.index);
  // The truth at a bottleneck and a second, the same for every detector.
  const truths = new Map<string, Omit<CaosJudgement, 'correct'>>();
  const truth = (resource: CaosExplanation['resource'], sec: number) => {
    const key = `${resource.kind}:${resource.index}:${sec}`;
    let found = truths.get(key);
    if (!found) {
      found = measure(resource, sec);
      truths.set(key, found);
    }
    return found;
  };
  const judge = (
    resource: CaosExplanation['resource'],
    cause: CaosExplanation['cause'],
    sec: number,
  ): CaosJudgement => {
    const t = truth(resource, sec);
    return { ...t, correct: rightAbout(cause.kind, cause.target, t.causes) };
  };
  const measure = (
    resource: CaosExplanation['resource'],
    sec: number,
  ): Omit<CaosJudgement, 'correct'> => {
    const queue = queueOf(resource, sec);
    const candidates = all
      .filter((f) => f.startedAt <= sec && f.endsAt >= sec - HORIZON)
      .map((f) => {
        const cf = without.get(f.id) as Counterfactual;
        const i = sec - cf.from;
        const other =
          resource.kind === 'conveyor'
            ? (cf.conveyors[i * s.conveyors + resource.index] as number)
            : (cf.docks[i * s.docks + resource.index] as number);
        return { ...f, shrink: queue - Math.min(0xffff, other) };
      });
    const j = { second: sec, queue, candidates };
    return {
      ...j,
      simultaneous: all.filter((f) => f.startedAt <= sec && f.endsAt > sec).length,
      causes: causesWithin(j, AFTERMATH),
    };
  };

  const topology = topologyOf(rec.live);
  const judged = variants.map((params) => judgeDetector(params));
  return { seed, seconds, failures: all, variants: judged };

  function judgeDetector(params: Partial<BottleneckParams>): CaosVariant {
    const detector = new BottleneckDetector(topology, params);
    const explanations: CaosExplanation[] = [];
    const judgedSeconds: [number, number, number] = [0, 0, 0];
    const rightSeconds: [number, number, number] = [0, 0, 0];
    let open: {
      from: number;
      to: number;
      key: string;
      resource: CaosExplanation['resource'];
      cause: CaosExplanation['cause'];
    } | null = null;
    const close = () => {
      if (!open) return;
      let worst = open.from;
      for (let sec = open.from + 1; sec <= open.to; sec++) {
        if (queueOf(open.resource, sec) > queueOf(open.resource, worst)) worst = sec;
      }
      const { from, to, resource, cause } = open;
      explanations.push({ from, to, resource, cause, judged: judge(resource, cause, worst) });
      open = null;
    };
    for (let sec = WATCH_FROM; sec <= last; sec++) {
      const b = detector.detect(s, sec);
      if (!b) {
        close();
        continue;
      }
      const resource = { kind: b.kind, index: b.index };
      const memory = b.cause.endedAgo !== undefined;
      const cause = { kind: b.cause.kind, target: b.cause.target, memory };
      const key = `${b.kind}:${b.index}:${b.cause.kind}:${b.cause.target}:${memory}`;
      if (open && (open.key !== key || open.to !== sec - 1)) close();
      if (open) open.to = sec;
      else open = { from: sec, to: sec, key, resource, cause };
      if (queueOf(resource, sec) >= DEFAULT_BOTTLENECK.minQueue) {
        const j = judge(resource, cause, sec);
        const on = Math.min(2, j.simultaneous) as 0 | 1 | 2;
        judgedSeconds[on] += 1;
        if (j.correct) rightSeconds[on] += 1;
      }
    }
    close();
    const counts: [number, number, number] = [0, 0, 0];
    const right: [number, number, number] = [0, 0, 0];
    for (const e of explanations) {
      const on = Math.min(2, e.judged.simultaneous) as 0 | 1 | 2;
      counts[on] += 1;
      if (e.judged.correct) right[on] += 1;
    }
    return {
      params,
      ...(countsOnly ? {} : { explanations }),
      judged: counts,
      right,
      judgedSeconds,
      rightSeconds,
    };
  }
}

/**
 * The causes of a judged queue with another window (at most HORIZON): the
 * candidates ended at most `window` seconds before whose removal takes at
 * least half of the queue away.
 */
export function causesWithin(
  j: Pick<CaosJudgement, 'second' | 'queue' | 'candidates'>,
  window: number,
): CaosFailure[] {
  return j.candidates
    .filter((c) => c.endsAt >= j.second - window && c.shrink >= Math.max(MIN_SHRINK, j.queue / 2))
    .map(({ shrink: _, ...f }) => f);
}

/** Does the cause the detector gave name one of the true causes? */
export function rightAbout(
  kind: CauseKind,
  target: number,
  causes: readonly { readonly kind: FailureKind; readonly target: number }[],
): boolean {
  if (causes.length === 0) return kind === 'layout';
  return causes.some((truth) => {
    switch (truth.kind) {
      case 'conveyor':
        return kind === 'conveyor' && target === truth.target;
      case 'dock':
        return kind === 'dock' && target === truth.target;
      case 'surge':
        return kind === 'surge';
      case 'robot':
        // The detector names belts and docks; a robot defect is never its explanation.
        return false;
    }
  });
}

/** The run again from before `failure`, without it, sampling the queues until HORIZON after its end. */
function counterfactual(rec: Recorder, failure: CaosFailure, last: number): Counterfactual {
  const perSecond = Math.round(1 / rec.config.dt);
  const startTick = Math.round(failure.startedAt * perSecond);
  let cp = rec.checkpoints[0] as Checkpoint;
  for (const c of rec.checkpoints) if (c.tick < startTick) cp = c;
  const from = Math.ceil(failure.startedAt);
  const to = Math.min(last, Math.floor(failure.endsAt + HORIZON));
  const nc = rec.series.conveyors;
  const nd = rec.series.docks;
  const conveyors = new Int32Array(Math.max(0, to - from + 1) * nc);
  const docks = new Int32Array(Math.max(0, to - from + 1) * nd);
  const c = new Int32Array(nc);
  const d = new Int32Array(nd);
  replay(rec, cp, [failure.id], to * perSecond, (w) => {
    if (w.tick % perSecond !== 0) return;
    const sec = w.tick / perSecond;
    if (sec < from) return;
    waitingFor(w, c, d);
    conveyors.set(c, (sec - from) * nc);
    docks.set(d, (sec - from) * nd);
  });
  return { from, to, conveyors, docks };
}

/**
 * The recording again from a checkpoint up to `tick`, with some failures
 * suppressed. A checkpoint is taken before the inputs of its tick, so those
 * (and every later one) are applied again, as the time travel does.
 * `visit` sees the world after every step.
 */
export function replay(
  rec: Recorder,
  cp: Checkpoint,
  suppress: readonly number[],
  tick: number,
  visit?: (w: World) => void,
): World {
  const world = new World({ ...rec.config, suppressFailures: suppress });
  world.loadState(cp);
  let i = rec.inputs.findIndex((x) => x.tick >= cp.tick);
  if (i < 0) i = rec.inputs.length;
  while (world.tick < tick) {
    while (i < rec.inputs.length && (rec.inputs[i] as { tick: number }).tick === world.tick) {
      applyInput(world, (rec.inputs[i] as { input: SimInput }).input);
      i++;
    }
    world.step();
    visit?.(world);
  }
  return world;
}
