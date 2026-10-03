import type { FailureKind, SimEvent } from './failures';
import { ROBOT_STAGES, type RobotStage } from './fleet';
import { fingerprint } from './fingerprint';
import { World, type Checkpoint, type SimConfig } from './world';

/** Order rate of the load test: far above capacity, so piles grow past 2 000 packets. */
export const STRESS_ARRIVAL_RATE = 40;

/**
 * What a viewer can do to the simulation. Recorded with the tick it was
 * applied at (between two ticks), and applied by the same function live and
 * in every replay, which is what makes a recording exact.
 */
export type SimInput =
  | { type: 'inject'; kind: FailureKind; target?: number }
  | { type: 'auto'; on: boolean }
  | { type: 'stress'; on: boolean };

export function applyInput(world: World, input: SimInput): void {
  switch (input.type) {
    case 'inject':
      world.failures.inject(input.kind, world.time, input.target);
      return;
    case 'auto':
      world.failures.setAuto(input.on, world.time);
      return;
    case 'stress':
      world.setArrivalRate(input.on ? STRESS_ARRIVAL_RATE : world.config.arrivalRate);
      return;
  }
}

export interface RecordedInput {
  readonly tick: number;
  readonly input: SimInput;
}

/** Stages in which a robot counts as busy for its utilization. */
const WORKING: ReadonlySet<RobotStage> = new Set([
  'toPickup',
  'loading',
  'toDrop',
  'unloading',
  'toPoint',
]);

/** Growable typed array. */
class Column<T extends Int32Array | Float32Array | Uint16Array> {
  length = 0;
  constructor(public data: T) {}

  push(v: number): void {
    if (this.length === this.data.length) {
      const grown = new (this.data.constructor as new (n: number) => T)(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = v;
  }

  get(i: number): number {
    return this.data[i] as number;
  }

  get bytes(): number {
    return this.data.byteLength;
  }
}

/**
 * One sample per simulated second of the recorded run, for the KPI panel,
 * the history panels and the timeline. Counters are cumulative, so any window
 * is a subtraction, at any moment of the recording.
 */
class Series {
  seconds = 0;
  readonly waiting = new Column(new Int32Array(1024));
  readonly delivered = new Column(new Int32Array(1024));
  /** Cycle time of every delivery, in order; `cycleEnd[s]` = deliveries up to second s. */
  readonly cycles = new Column(new Float32Array(4096));
  readonly cycleEnd = new Column(new Int32Array(1024));
  /** Per second × entity, cumulative. */
  readonly conveyorExits: Column<Int32Array>;
  readonly dockDeliveries: Column<Int32Array>;
  readonly robotBusy: Column<Uint16Array>;
  /** Robots busy during that second (for the live chart). */
  readonly busyNow = new Column(new Int32Array(1024));

  constructor(
    readonly conveyors: number,
    readonly docks: number,
    readonly robots: number,
  ) {
    this.conveyorExits = new Column(new Int32Array(1024 * Math.max(1, conveyors)));
    this.dockDeliveries = new Column(new Int32Array(1024 * Math.max(1, docks)));
    this.robotBusy = new Column(new Uint16Array(1024 * Math.max(1, robots)));
  }

  sample(w: World, newCycles: readonly number[]): void {
    const s = this.seconds;
    this.waiting.push(w.stats.waiting);
    this.delivered.push(w.metrics.delivered);
    for (const c of newCycles) this.cycles.push(c);
    this.cycleEnd.push(this.cycles.length);
    for (let c = 0; c < this.conveyors; c++) this.conveyorExits.push(w.conveyorExits[c] as number);
    for (let d = 0; d < this.docks; d++) this.dockDeliveries.push(w.dockDeliveries[d] as number);
    let busy = 0;
    const robots = w.fleet?.robots ?? [];
    for (let r = 0; r < this.robots; r++) {
      const working = WORKING.has((robots[r] as { stage: RobotStage }).stage) ? 1 : 0;
      busy += working;
      const before = s > 0 ? this.robotBusy.get((s - 1) * this.robots + r) : 0;
      this.robotBusy.push(before + working);
    }
    this.busyNow.push(busy);
    this.seconds++;
  }

  /** Keeps seconds 0 … `last` (inclusive). */
  truncate(last: number): void {
    const n = Math.max(0, Math.min(this.seconds, last + 1));
    this.seconds = n;
    this.waiting.length = n;
    this.delivered.length = n;
    this.cycleEnd.length = n;
    this.cycles.length = n > 0 ? this.cycleEnd.get(n - 1) : 0;
    this.conveyorExits.length = n * this.conveyors;
    this.dockDeliveries.length = n * this.docks;
    this.robotBusy.length = n * this.robots;
    this.busyNow.length = n;
  }

  get bytes(): number {
    return [
      this.waiting,
      this.delivered,
      this.cycles,
      this.cycleEnd,
      this.conveyorExits,
      this.dockDeliveries,
      this.robotBusy,
      this.busyNow,
    ].reduce((n, c) => n + c.bytes, 0);
  }
}

/** Stage changes of every robot: (tick, robot, stage index). */
class Journal {
  readonly ticks = new Column(new Int32Array(4096));
  readonly robots = new Column(new Int32Array(4096));
  readonly stages = new Column(new Int32Array(4096));

  add(tick: number, robot: number, stage: RobotStage): void {
    this.ticks.push(tick);
    this.robots.push(robot);
    this.stages.push(ROBOT_STAGES.indexOf(stage));
  }

  get length(): number {
    return this.ticks.length;
  }

  truncate(lastTick: number): void {
    let n = this.ticks.length;
    while (n > 0 && this.ticks.get(n - 1) > lastTick) n--;
    this.ticks.length = n;
    this.robots.length = n;
    this.stages.length = n;
  }

  get bytes(): number {
    return this.ticks.bytes + this.robots.bytes + this.stages.bytes;
  }
}

/** p-quantile by nearest rank (the value at rank ⌈p·n⌉), in O(n) with quickselect. */
export function quantile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  const a = Float64Array.from(values);
  const k = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1] as number;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((a[i] as number) < pivot) i++;
      while ((a[j] as number) > pivot) j--;
      if (i <= j) {
        const t = a[i] as number;
        a[i] = a[j] as number;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k] as number;
}

export interface Kpis {
  /** Second of the recording they describe. */
  readonly second: number;
  readonly windowSeconds: number;
  /** Deliveries per minute over the last minute. */
  readonly throughput: number;
  /** Cycle time (order to delivery) over the window, seconds. */
  readonly cycleMean: number;
  readonly cycleP95: number;
  readonly deliveries: number;
  /** 0 … 1 over the window: belt flow ÷ belt capacity, dock deliveries ÷ service rate, robot busy time. */
  readonly conveyorUse: Float32Array;
  readonly dockUse: Float32Array;
  readonly robotUse: Float32Array;
  /** Last `windowSeconds` seconds, one value per second (oldest first). */
  readonly chart: {
    readonly throughput: Float32Array;
    readonly waiting: Float32Array;
    readonly busyRobots: Float32Array;
  };
}

export interface RunReport {
  readonly format: 'gemeo-digital-cd/run';
  readonly version: 1;
  readonly config: SimConfig;
  readonly inputs: readonly RecordedInput[];
  readonly endTick: number;
  /** Fingerprint of the world at `endTick`: replaying the inputs must give it again. */
  readonly fingerprint: string;
}

export interface RecorderOptions {
  /** Simulated seconds between checkpoints. */
  readonly checkpointSeconds: number;
}

/**
 * Records a run so that any past moment can be shown again exactly, and the
 * run can continue from there on a new branch.
 *
 *  - Inputs are logged with their tick; checkpoints of the whole world are
 *    taken every `checkpointSeconds`.
 *  - Seeking restores the last checkpoint at or before the target into a
 *    second world (reused) and replays the inputs up to the target. The live
 *    world waits, untouched, at the head of the recording.
 *  - Continuing from the past (or giving an input there) makes the shown
 *    world the live one and drops everything recorded after that moment.
 *  - Alongside: the event log, every robot stage change and one sample per
 *    second for the KPIs and the timeline.
 *
 * A world at tick T always has the inputs of tick T applied (inputs come
 * between ticks); checkpoints are taken before them.
 */
export class Recorder {
  private liveWorld: World;
  private spare: World | null = null;
  private viewWorld: World | null = null;
  private target = -1;
  /** Index of the first input after the view world's tick. */
  private viewInput = 0;
  readonly config: SimConfig;
  readonly every: number;
  readonly inputs: RecordedInput[] = [];
  readonly checkpoints: Checkpoint[] = [];
  readonly events: SimEvent[] = [];
  readonly journal = new Journal();
  readonly series: Series;
  /** Ticks at which the run was continued from the past. */
  readonly branches: number[] = [];
  private lastEventId = 0;
  private lastDelivered = 0;

  constructor(config: Partial<SimConfig> = {}, options: Partial<RecorderOptions> = {}) {
    this.liveWorld = new World(config);
    this.config = this.liveWorld.config;
    this.every = Math.round((options.checkpointSeconds ?? 30) / this.config.dt);
    const w = this.liveWorld;
    this.series = new Series(w.conveyors.length, w.docks.length, w.fleet?.robots.length ?? 0);
    this.attach(w);
    this.checkpoints.push(w.saveState());
    this.series.sample(w, []);
  }

  /** The world at the head of the recording. */
  get live(): World {
    return this.liveWorld;
  }

  /** The world to show: the past one while seeking or viewing, the live one otherwise. */
  get shown(): World {
    return this.viewWorld ?? this.liveWorld;
  }

  get viewing(): boolean {
    return this.viewWorld !== null;
  }

  get headTick(): number {
    return this.liveWorld.tick;
  }

  /** True while the shown past world has not reached the requested moment yet. */
  get seeking(): boolean {
    return this.viewWorld !== null && this.viewWorld.tick !== this.target;
  }

  // ---------------------------------------------------------------- live

  input(input: SimInput): void {
    if (this.viewWorld) this.branch();
    const w = this.liveWorld;
    this.inputs.push({ tick: w.tick, input });
    applyInput(w, input);
    this.collectEvents();
  }

  step(): void {
    if (this.viewWorld) throw new Error('the live world waits while the past is shown');
    const w = this.liveWorld;
    w.step();
    this.collectEvents();
    const ticksPerSecond = Math.round(1 / this.config.dt);
    if (w.tick % ticksPerSecond === 0) {
      const delivered = w.metrics.delivered;
      this.series.sample(w, w.metrics.lastCycles(delivered - this.lastDelivered));
      this.lastDelivered = delivered;
    }
    if (w.tick % this.every === 0) this.checkpoints.push(w.saveState());
  }

  stepMany(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  // ---------------------------------------------------------------- time travel

  /**
   * Starts showing `tick` of the recording; `advance` gets there. The head
   * itself is the live world.
   */
  seekTo(tick: number): void {
    const target = Math.max(0, Math.min(this.headTick, Math.round(tick)));
    if (target === this.headTick) {
      this.backToLive();
      return;
    }
    const view = this.viewWorld ?? this.takeSpare();
    const cp = this.checkpointAtOrBefore(target);
    // Going on from where the shown world is beats a restore when it is closer.
    const continueFrom = this.viewWorld !== null && view.tick <= target && view.tick >= cp.tick;
    if (!continueFrom) {
      view.loadState(cp);
      this.viewInput = this.firstInputFrom(cp.tick);
      this.applyViewInputs(view);
    }
    this.viewWorld = view;
    this.target = target;
  }

  /** Replays up to `maxTicks` toward the requested moment; true once it is shown. */
  advance(maxTicks = Infinity): boolean {
    const view = this.viewWorld;
    if (!view) return true;
    for (let n = 0; view.tick < this.target && n < maxTicks; n++) {
      view.step();
      this.applyViewInputs(view);
    }
    return view.tick === this.target;
  }

  /** Seeks and replays all the way (tests, benchmarks). */
  seek(tick: number): World {
    this.seekTo(tick);
    this.advance();
    return this.shown;
  }

  backToLive(): void {
    if (this.viewWorld) this.spare = this.viewWorld;
    this.viewWorld = null;
    this.target = -1;
  }

  /**
   * Continues the run from the moment shown: that world becomes the live one
   * and everything recorded after it is dropped (a new branch).
   */
  branch(): void {
    const view = this.viewWorld;
    if (!view) return;
    this.advance();
    const t = view.tick;
    this.detach(this.liveWorld);
    this.spare = this.liveWorld;
    this.liveWorld = view;
    this.viewWorld = null;
    this.target = -1;
    this.attach(view);

    this.inputs.length = this.firstInputFrom(t + 1);
    let c = this.checkpoints.length;
    while (c > 1 && (this.checkpoints[c - 1] as Checkpoint).tick > t) c--;
    this.checkpoints.length = c;
    const time = t * this.config.dt;
    let e = this.events.length;
    while (e > 0 && (this.events[e - 1] as SimEvent).time > time + 1e-9) e--;
    this.events.length = e;
    this.lastEventId = e > 0 ? (this.events[e - 1] as SimEvent).id : 0;
    // The replay refilled the world's own feed with the events already logged.
    view.events.length = 0;
    this.journal.truncate(t);
    const ticksPerSecond = Math.round(1 / this.config.dt);
    this.series.truncate(Math.floor(t / ticksPerSecond));
    // Deliveries after the last kept sample belong to the next one.
    this.lastDelivered = this.series.delivered.get(this.series.seconds - 1);
    this.branches.push(t);
  }

  // ---------------------------------------------------------------- reading

  /** KPIs at second `second` of the recording, over the `window` seconds before it. */
  kpis(second: number, window = 300): Kpis {
    const s = this.series;
    const at = Math.max(0, Math.min(s.seconds - 1, Math.floor(second)));
    const from = Math.max(0, at - window);
    const span = at - from;
    const lastMinute = Math.max(0, at - 60);
    const throughput =
      at > lastMinute
        ? ((s.delivered.get(at) - s.delivered.get(lastMinute)) / (at - lastMinute)) * 60
        : 0;
    const c0 = s.cycleEnd.get(from);
    const c1 = s.cycleEnd.get(at);
    const cycles = s.cycles.data.subarray(c0, c1);
    let sum = 0;
    for (const c of cycles) sum += c;

    const w = this.shown;
    const conveyorUse = new Float32Array(s.conveyors);
    for (let c = 0; c < s.conveyors; c++) {
      const belt = w.conveyors[c] as { speed: number; spacing: number };
      const capacity = (belt.speed / belt.spacing) * span;
      const flow =
        s.conveyorExits.get(at * s.conveyors + c) - s.conveyorExits.get(from * s.conveyors + c);
      conveyorUse[c] = capacity > 0 ? flow / capacity : 0;
    }
    const dockUse = new Float32Array(s.docks);
    for (let d = 0; d < s.docks; d++) {
      const capacity = this.config.dockServiceRate * span;
      const n = s.dockDeliveries.get(at * s.docks + d) - s.dockDeliveries.get(from * s.docks + d);
      dockUse[d] = capacity > 0 ? Math.min(1, n / capacity) : 0;
    }
    const robotUse = new Float32Array(s.robots);
    for (let r = 0; r < s.robots; r++) {
      const busy = s.robotBusy.get(at * s.robots + r) - s.robotBusy.get(from * s.robots + r);
      robotUse[r] = span > 0 ? busy / span : 0;
    }

    const chart = {
      throughput: new Float32Array(window),
      waiting: new Float32Array(window),
      busyRobots: new Float32Array(window),
    };
    for (let i = 0; i < window; i++) {
      const sec = at - window + 1 + i;
      if (sec < 0) continue;
      const before = Math.max(0, sec - 60);
      chart.throughput[i] =
        sec > before ? ((s.delivered.get(sec) - s.delivered.get(before)) / (sec - before)) * 60 : 0;
      chart.waiting[i] = s.waiting.get(sec);
      chart.busyRobots[i] = s.busyNow.get(sec);
    }

    return {
      second: at,
      windowSeconds: window,
      throughput,
      cycleMean: cycles.length ? sum / cycles.length : NaN,
      cycleP95: quantile(cycles, 0.95),
      deliveries: cycles.length,
      conveyorUse,
      dockUse,
      robotUse,
      chart,
    };
  }

  /** Bytes kept for the time travel and the histories (checkpoints, logs, samples). */
  get memoryBytes(): number {
    let n = this.series.bytes + this.journal.bytes;
    for (const cp of this.checkpoints) n += cp.state.ints.byteLength + cp.state.floats.byteLength;
    return n + this.inputs.length * 64 + this.events.length * 160;
  }

  /** Everything needed to run this recording again from scratch. */
  report(): RunReport {
    return {
      format: 'gemeo-digital-cd/run',
      version: 1,
      config: this.config,
      inputs: this.inputs.map((i) => ({ tick: i.tick, input: { ...i.input } })),
      endTick: this.headTick,
      fingerprint: fingerprint(this.liveWorld),
    };
  }

  /** Runs a report again from tick 0; the result must end with the report's fingerprint. */
  static replay(report: RunReport, options: Partial<RecorderOptions> = {}): Recorder {
    if (report.format !== 'gemeo-digital-cd/run' || report.version !== 1) {
      throw new Error('not a run report of this simulator');
    }
    const rec = new Recorder(report.config, options);
    let i = 0;
    const inputs = report.inputs;
    for (;;) {
      while (i < inputs.length && (inputs[i] as RecordedInput).tick === rec.headTick) {
        rec.input((inputs[i] as RecordedInput).input);
        i++;
      }
      if (rec.headTick >= report.endTick) break;
      rec.step();
    }
    return rec;
  }

  // ---------------------------------------------------------------- internals

  private attach(w: World): void {
    if (w.fleet) w.fleet.onStage = (robot, stage) => this.journal.add(w.tick, robot, stage);
  }

  private detach(w: World): void {
    if (w.fleet) w.fleet.onStage = null;
  }

  private takeSpare(): World {
    const w = this.spare ?? new World(this.config);
    this.spare = null;
    return w;
  }

  private collectEvents(): void {
    for (const e of this.liveWorld.events) {
      if (e.id <= this.lastEventId) continue;
      this.events.push(e);
      this.lastEventId = e.id;
    }
  }

  private checkpointAtOrBefore(tick: number): Checkpoint {
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.checkpoints[mid] as Checkpoint).tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this.checkpoints[lo] as Checkpoint;
  }

  /** Index of the first input recorded at `tick` or later. */
  private firstInputFrom(tick: number): number {
    let lo = 0;
    let hi = this.inputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.inputs[mid] as RecordedInput).tick < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private applyViewInputs(view: World): void {
    while (
      this.viewInput < this.inputs.length &&
      (this.inputs[this.viewInput] as RecordedInput).tick === view.tick
    ) {
      applyInput(view, (this.inputs[this.viewInput] as RecordedInput).input);
      this.viewInput++;
    }
  }
}
