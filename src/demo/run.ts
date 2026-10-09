import { fingerprint } from '../sim/fingerprint';
import { quantile, Recorder, type SimInput } from '../sim/recorder';
import type { SimConfig } from '../sim/world';

/**
 * The demo (phase 6): one deterministic run of about a minute, in the order
 * of the roadmap: problem, diagnosis, solution. A belt breaks and the queue
 * grows under the static routing; the detector explains the bottleneck; only
 * then the AI takes over (the routing heuristic and the maintenance
 * schedule), diverts the flow, and the schedule catches a worn motor before
 * it breaks. Then the run goes back to just before the breakdown and plays
 * the same failures without AI, and the two are compared over the same span.
 * Until the AI takes over the two runs are the same, bit for bit.
 *
 * Everything that decides the outcome happens in the simulation at fixed
 * ticks: the inputs of the script, the jump back and the switch to no AI.
 * The page only picks the speed and the camera, so the numbers on the final
 * card are the same on any machine, and tests/demo.test.ts checks them.
 */

export interface DemoScript {
  readonly seed: number;
  /** Simulated seconds run at once before the demo is shown (the building fills up). */
  readonly warmup: number;
  /** The breakdown the story is about. */
  readonly failure: { readonly at: number; readonly target: number };
  /** The motor that starts wearing out: maintenance catches it; without AI it breaks. */
  readonly wear: { readonly at: number; readonly target: number };
  /**
   * The AI takes over here (the routing heuristic and the maintenance
   * schedule): after the queue and the explained bottleneck are on screen.
   */
  readonly aiAt: number;
  /** The run without AI branches here (a second before the breakdown, no input on that tick). */
  readonly branchAt: number;
  /** Both runs are compared from the breakdown to here (simulated seconds). */
  readonly end: number;
}

/**
 * Seed and times chosen for the story, not for the result (docs/resultados.md,
 * phase 6): with the wear on Esteira 16 (Q2→Q1, the only way to Doca 1), the
 * first seed of [2026, 7, 11, 42, 101, 333] where the breakdown of Esteira 9
 * ends before the alarm of the wear, the maintenance avoids the failure, and
 * without AI the worn belt breaks.
 */
export const DEMO: DemoScript = {
  seed: 2026,
  warmup: 94,
  failure: { at: 104, target: 8 },
  wear: { at: 118, target: 15 },
  aiAt: 146,
  branchAt: 103,
  end: 320,
};

/** The configuration of the demo run: the script's seed; no schedule until the AI takes over. */
export function demoConfig(script: DemoScript = DEMO): Partial<SimConfig> {
  return { seed: script.seed, scheduleMaintenance: false };
}

/** An input of the script; `ai` marks the AI taking over, which the run without AI never gets. */
export interface DemoInput {
  readonly at: number;
  readonly input: SimInput;
  readonly ai?: true;
}

/** The inputs of the script, in time order (simulated seconds). */
export function demoInputs(script: DemoScript = DEMO): DemoInput[] {
  const inputs: DemoInput[] = [
    {
      at: script.failure.at,
      input: { type: 'inject', kind: 'conveyor', target: script.failure.target },
    },
    { at: script.wear.at, input: { type: 'wear', target: script.wear.target } },
    { at: script.aiAt, input: { type: 'policy', policy: 'heuristic' }, ai: true },
    { at: script.aiAt, input: { type: 'maintenance', on: true }, ai: true },
  ];
  return inputs.sort((a, b) => a.at - b.at);
}

/** One side of the comparison, from the breakdown to the end. */
export interface DemoSide {
  /** Packets delivered in that span, and the p95 of their cycle and of their waiting (s). */
  readonly delivered: number;
  readonly cycleP95: number;
  readonly waitP95: number;
  /** Packets queuing at the worst second. */
  readonly waitingMax: number;
  /** Belts that broke down in that span, and failures the maintenance avoided. */
  readonly breakdowns: number;
  readonly avoided: number;
}

export interface DemoResult {
  readonly ai: DemoSide;
  readonly noAi: DemoSide;
}

/** The measures of the recording between two simulated seconds. */
export function measure(rec: Recorder, from: number, to: number): DemoSide {
  const s = rec.series;
  const c0 = s.cycleEnd.get(from);
  const c1 = s.cycleEnd.get(to);
  let waitingMax = 0;
  for (let t = from; t <= to; t++) waitingMax = Math.max(waitingMax, s.waiting.get(t));
  const inSpan = (time: number) => time >= from && time <= to;
  return {
    delivered: c1 - c0,
    // The same p95 as the panel K.
    cycleP95: quantile(s.cycles.data.subarray(c0, c1), 0.95),
    waitP95: quantile(s.waits.data.subarray(c0, c1), 0.95),
    waitingMax,
    breakdowns: rec.events.filter(
      (e) => e.kind === 'failure-start' && e.failure === 'conveyor' && inSpan(e.time),
    ).length,
    avoided: rec.events.filter((e) => e.kind === 'failure-avoided' && inSpan(e.time)).length,
  };
}

export type DemoPhase = 'ai' | 'ai-done' | 'no-ai' | 'done';

/**
 * Runs the script on a recorder: the worker host drives it in real time, the
 * tests all at once (runDemo). `beforeStep` must be called before every step.
 */
export class DemoRunner {
  readonly rec: Recorder;
  phase: DemoPhase = 'ai';
  ai: DemoSide | null = null;
  noAi: DemoSide | null = null;
  private readonly inputs: { tick: number; input: SimInput; ai: boolean }[];
  private next = 0;
  private readonly perSecond: number;

  constructor(readonly script: DemoScript = DEMO) {
    this.rec = new Recorder(demoConfig(script));
    this.perSecond = Math.round(1 / this.rec.config.dt);
    this.inputs = demoInputs(script).map(({ at, input, ai }) => ({
      tick: Math.round(at * this.perSecond),
      input,
      ai: ai === true,
    }));
    if (this.inputs.some((x) => x.tick <= this.tick(script.branchAt))) {
      throw new Error('the demo branches before its first input');
    }
    if (script.aiAt <= script.failure.at) throw new Error('the AI takes over before the problem');
    // Until the AI takes over, the run is the one without AI: the static routing.
    this.rec.input({ type: 'policy', policy: 'static' });
    for (let t = 0; t < this.tick(script.warmup); t++) this.step();
  }

  private tick(seconds: number): number {
    return Math.round(seconds * this.perSecond);
  }

  get endTick(): number {
    return this.tick(this.script.end);
  }

  /** The inputs of the script due at the head of the recording. */
  beforeStep(): void {
    const rec = this.rec;
    while (this.next < this.inputs.length) {
      const x = this.inputs[this.next] as { tick: number; input: SimInput; ai: boolean };
      if (x.tick !== rec.headTick) break;
      if (!(x.ai && this.phase === 'no-ai')) rec.input(x.input);
      this.next++;
    }
  }

  /** One step of the run (the inputs first); false at the end of the current side. */
  step(): boolean {
    if (this.rec.headTick >= this.endTick) return false;
    this.beforeStep();
    this.rec.step();
    return true;
  }

  /** At the end of the run with AI: its measures. */
  finishAi(): DemoSide {
    if (this.phase !== 'ai' || this.rec.headTick < this.endTick) throw new Error('not at the end');
    this.ai = measure(this.rec, this.script.failure.at, this.script.end);
    this.phase = 'ai-done';
    return this.ai;
  }

  /**
   * Back to just before the breakdown, as the time travel does, and on from
   * there without AI: the world there has the static routing and no schedule
   * yet, and the AI never takes over. The failures of the script come again
   * at their ticks.
   */
  rewind(): void {
    if (this.phase !== 'ai-done') throw new Error('the run with AI has not ended');
    const rec = this.rec;
    const at = this.tick(this.script.branchAt);
    if (!rec.viewing || rec.shown.tick !== at) rec.seek(at);
    // A new branch from there (with no input on that tick, nothing else would make one).
    rec.branch();
    this.next = this.inputs.findIndex((x) => x.tick > at);
    if (this.next < 0) this.next = this.inputs.length;
    this.phase = 'no-ai';
  }

  finishNoAi(): DemoSide {
    if (this.phase !== 'no-ai' || this.rec.headTick < this.endTick)
      throw new Error('not at the end');
    this.noAi = measure(this.rec, this.script.failure.at, this.script.end);
    this.phase = 'done';
    return this.noAi;
  }

  get result(): DemoResult | null {
    return this.ai && this.noAi ? { ai: this.ai, noAi: this.noAi } : null;
  }
}

/** The whole demo at once (tests, benchmarks): the result and the prints of both ends. */
export function runDemo(script: DemoScript = DEMO): {
  result: DemoResult;
  aiPrint: string;
  noAiPrint: string;
  runner: DemoRunner;
} {
  const runner = new DemoRunner(script);
  while (runner.step());
  runner.finishAi();
  const aiPrint = fingerprint(runner.rec.live);
  runner.rewind();
  while (runner.step());
  runner.finishNoAi();
  return {
    result: runner.result as DemoResult,
    aiPrint,
    noAiPrint: fingerprint(runner.rec.live),
    runner,
  };
}
