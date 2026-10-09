import { BottleneckDetector, topologyOf } from '../ai/bottleneck';
import { DemoRunner } from '../demo/run';
import { ACTION_LEVELS, observe } from '../ai/env';
import { eventLogCsv } from '../sim/export';
import { fingerprint } from '../sim/fingerprint';
import { ROBOT_STAGES } from '../sim/fleet';
import {
  applyInput,
  Recorder,
  STRESS_ARRIVAL_RATE,
  type RecordedInput,
  type RunReport,
  type SimInput,
} from '../sim/recorder';
import { SnapshotWriter } from '../sim/snapshot';
import type { SimConfig, World } from '../sim/world';
import type { SimCommand, SimMessage } from './protocol';
import {
  choiceOf,
  LazyAgent,
  policyOf,
  StaticShadow,
  type AgentLoader,
  type PolicyChoice,
} from './routing';
import { history, timeline } from './views';

/** Real milliseconds of simulation work per pump before yielding to messages. */
const BUDGET_MS = 40;
/** Minimum real milliseconds between two snapshots. */
const SNAPSHOT_INTERVAL_MS = 15;
/** Real milliseconds between two status messages (timeline, KPIs). */
const STATUS_INTERVAL_MS = 500;
/** Simulated seconds of backlog kept when the host cannot keep up (no spiral of death). */
const MAX_BACKLOG = 0.5;

/**
 * Runs a recorded World in real time: the driver calls `pump()` often (a
 * timer in the worker), the host advances as many fixed steps as the elapsed
 * real time × speed asks for — within a time budget so commands are never
 * starved — and posts a snapshot. While a past moment is shown the live run
 * waits; a seek replays toward its target within the same budget, so the
 * page sees it fast-forward and can ask for another moment at any time.
 * The same class runs inline on the main thread for the comparison benchmark.
 */
export class SimHost {
  private recorder: Recorder;
  private writer: SnapshotWriter;
  private config: Partial<SimConfig> = {};
  private speed = 1;
  private accumulator = 0;
  private lastPump: number;
  private lastPost = -Infinity;
  private lastStatus = -Infinity;
  private dirty = true;
  private lastEventId = 0;
  /** A report being run again: the inputs left and the end to reach. */
  private replay: { report: RunReport; next: number } | null = null;
  /** Steps run in the last pump, for diagnostics. */
  stepsLastPump = 0;
  /**
   * Routing chosen by the viewer, and the one waiting for the network to load.
   * A run starts with the official policy, the heuristic (decided on the
   * validation seeds; docs/resultados.md).
   */
  private choice: PolicyChoice = 'heuristic';
  private wanted: PolicyChoice | null = null;
  private readonly agent: LazyAgent;
  private modelUrl = '';
  /** Tick of the last decision of the network, and whether one is on its way. */
  private decidedTick = -1;
  private pending = false;
  /** Decisions of the network so far and the time they took (observation, inference, answer). */
  private decisions = 0;
  private decisionMs = 0;
  private readonly shadow = new StaticShadow();
  /** Reads the recording: the bottleneck of any moment shown, live or past. */
  private detector: BottleneckDetector;
  /** The demo being played (its script decides the inputs), or null. */
  private demo: DemoRunner | null = null;

  constructor(
    // Only array buffers are transferred (the snapshots); typed without the DOM
    // lib so that Node code (bench/demo-memoria.ts) can host it too.
    private readonly post: (msg: SimMessage, transfer: ArrayBuffer[]) => void,
    private readonly clock: () => number,
    /** How the routing network is loaded (tests give their own). */
    agentLoader?: AgentLoader,
  ) {
    this.agent = new LazyAgent(agentLoader);
    this.recorder = new Recorder(this.config);
    this.writer = new SnapshotWriter(this.recorder.shown);
    this.detector = new BottleneckDetector(topologyOf(this.recorder.live));
    this.lastPump = clock();
  }

  get currentWorld(): World {
    return this.recorder.shown;
  }

  get currentRecorder(): Recorder {
    return this.recorder;
  }

  handle(cmd: SimCommand): void {
    const rec = this.recorder;
    switch (cmd.type) {
      case 'init':
        this.config = cmd.config ?? {};
        this.restart();
        break;
      case 'restart':
        this.restart();
        break;
      case 'speed':
        this.speed = Math.max(0, cmd.speed);
        this.accumulator = 0;
        break;
      case 'inject':
        this.input(
          cmd.target !== undefined
            ? { type: 'inject', kind: cmd.kind, target: cmd.target }
            : { type: 'inject', kind: cmd.kind },
        );
        break;
      case 'auto':
        this.input({ type: 'auto', on: cmd.on });
        break;
      case 'wear':
        this.input({ type: 'wear' });
        break;
      case 'stress':
        this.input({ type: 'stress', on: cmd.on });
        break;
      case 'policy':
        this.modelUrl = cmd.model ?? this.modelUrl;
        this.choose(cmd.policy);
        break;
      case 'advance': {
        // A tool for tests and captures: at once, the learning agent's shares held.
        if (rec.viewing) this.jump(() => rec.branch());
        const steps = Math.round(cmd.seconds / rec.config.dt);
        for (let i = 0; i < steps; i++) {
          rec.step();
          this.shadow.step();
        }
        break;
      }
      case 'seek':
        this.jump(() => rec.seekTo(Math.round(cmd.time / rec.config.dt)));
        break;
      case 'live':
        this.jump(() => rec.backToLive());
        break;
      case 'branch':
        this.jump(() => rec.branch());
        break;
      case 'export':
        this.post(this.exportFile(cmd.what), []);
        return;
      case 'load-report':
        this.loadReport(cmd.report);
        break;
      case 'history':
        try {
          this.post({ type: 'history', history: history(rec, cmd.entity) }, []);
        } catch (e) {
          this.post({ type: 'error', message: (e as Error).message }, []);
        }
        return;
      case 'release':
        this.writer.recycle(cmd.buffer);
        return;
      case 'demo':
        this.handleDemo(cmd.action);
        break;
    }
    this.dirty = true;
    this.lastStatus = -Infinity;
    this.flush(true);
  }

  pump(): void {
    const now = this.clock();
    const elapsed = Math.min((now - this.lastPump) / 1000, 0.25);
    this.lastPump = now;
    const rec = this.recorder;
    let steps = 0;
    if (this.replay) {
      steps = this.runReplay(now);
    } else if (rec.viewing) {
      // A seek on its way: replay toward the target, one simulated second at a time.
      const second = Math.round(1 / rec.config.dt);
      while (rec.seeking && this.clock() - now < BUDGET_MS) {
        rec.advance(second);
        steps += second;
      }
      this.accumulator = 0;
    } else {
      const dt = rec.config.dt;
      this.accumulator = Math.min(this.accumulator + elapsed * this.speed, MAX_BACKLOG + dt);
      while (this.accumulator >= dt) {
        if (this.awaitingAgent()) break;
        if (this.demo) {
          // The demo's inputs come at their ticks; each side stops at the end of the script.
          if (!this.demo.step()) {
            this.endDemoSide();
            this.accumulator = 0;
            break;
          }
        } else {
          rec.step();
          this.shadow.step();
        }
        this.accumulator -= dt;
        steps++;
        if (this.clock() - now > BUDGET_MS) break;
      }
    }
    this.stepsLastPump = steps;
    if (steps > 0) this.dirty = true;
    this.flush(false);
    if (now - this.lastStatus >= STATUS_INTERVAL_MS) this.postStatus(now);
  }

  /**
   * A new run with the same configuration. The load test stays on across a
   * restart (as the page shows it); it becomes an input at tick 0, so the
   * recording still says everything.
   */
  private restart(config: Partial<SimConfig> = this.config, keepStress = true): void {
    this.demo = null;
    const stress = keepStress && this.recorder.live.baseRate === STRESS_ARRIVAL_RATE;
    this.recorder = new Recorder(config);
    this.detector = new BottleneckDetector(topologyOf(this.recorder.live));
    if (stress) this.recorder.input({ type: 'stress', on: true });
    // The routing chosen stays on across a restart too, as an input at tick 0.
    if (keepStress && this.choice !== 'static') {
      this.recorder.input({ type: 'policy', policy: policyOf(this.choice) });
    }
    this.writer.show(this.recorder.shown);
    this.accumulator = 0;
    this.lastEventId = 0;
    this.replay = null;
    this.decidedTick = -1;
    this.syncShadow();
  }

  private input(input: SimInput): void {
    if (this.recorder.viewing) {
      this.jump(() => this.recorder.input(input));
    } else {
      this.recorder.input(input);
      this.shadow.apply(input, applyInput);
    }
  }

  /** Runs `change` (a seek, a branch, back to live) and makes the next frame a cut. */
  private jump(change: () => void): void {
    change();
    this.writer.show(this.recorder.shown);
    // The feed resumes after what the log already has (a branch drops the rest).
    this.lastEventId = this.recorder.events.at(-1)?.id ?? 0;
    // A branch continues with whoever routed at that moment.
    if (!this.recorder.viewing) this.choice = choiceOf(this.recorder.live.policy);
    this.syncShadow();
  }

  /**
   * Who routes from now on. The learning agent first needs its network: the
   * switch happens when it has loaded (a second or so, the first time).
   */
  private choose(choice: PolicyChoice): void {
    if (choice === 'rl' && !this.agent.ready) {
      this.wanted = 'rl';
      this.agent.load(this.modelUrl, () => {
        if (this.wanted === 'rl' && this.agent.ready) this.choose('rl');
        else this.wanted = null;
        this.lastStatus = -Infinity;
      });
      return;
    }
    this.wanted = null;
    this.choice = choice;
    this.decidedTick = -1;
    this.input({ type: 'policy', policy: policyOf(choice) });
    this.syncShadow();
  }

  /** The static copy runs while the live run (not a past moment) uses another routing. */
  private syncShadow(): void {
    const rec = this.recorder;
    if (!rec.viewing && !this.replay && !this.demo && rec.live.policy !== 'static') {
      this.shadow.start(rec.live);
    } else {
      this.shadow.stop();
    }
  }

  /**
   * The demo: a new recording of its script, already warmed up; then, when
   * the run with AI has ended and the page shows the moment before the
   * breakdown, on from there without AI; or back to the ordinary app.
   */
  private handleDemo(action: 'start' | 'compare' | 'stop'): void {
    if (action === 'stop') {
      this.demo = null;
      this.syncShadow();
      return;
    }
    if (action === 'start') {
      this.restart();
      const demo = new DemoRunner();
      this.demo = demo;
      this.recorder = demo.rec;
      this.detector = new BottleneckDetector(topologyOf(demo.rec.live));
      this.writer.show(demo.rec.shown);
      this.accumulator = 0;
      this.lastEventId = demo.rec.events.at(-1)?.id ?? 0;
      this.choice = 'heuristic';
      this.syncShadow();
      this.postDemo();
      return;
    }
    const demo = this.demo;
    if (!demo || demo.phase !== 'ai-done') return;
    this.jump(() => demo.rewind());
    this.accumulator = 0;
    this.postDemo();
  }

  /** The end of a side of the demo: its measures, and the page is told. */
  private endDemoSide(): void {
    const demo = this.demo as DemoRunner;
    if (demo.phase === 'ai') demo.finishAi();
    else if (demo.phase === 'no-ai') demo.finishNoAi();
    else return;
    this.postDemo();
  }

  private postDemo(): void {
    const demo = this.demo;
    if (!demo) return;
    this.post({ type: 'demo', phase: demo.phase, result: demo.result }, []);
  }

  /**
   * With the learning agent routing, every simulated second starts with its
   * decision, recorded as an input (so the past replays it exactly, without
   * the network). The answer is asynchronous: the run waits for it.
   */
  private awaitingAgent(): boolean {
    const rec = this.recorder;
    const agent = this.agent.ready;
    if (rec.live.policy !== 'external' || !agent) return false;
    const tick = rec.headTick;
    if (tick % Math.round(1 / rec.config.dt) !== 0 || this.decidedTick === tick) return false;
    if (!this.pending) {
      this.pending = true;
      const started = this.clock();
      agent(observe(rec.live)).then(
        (levels) => {
          this.pending = false;
          this.decisions++;
          this.decisionMs += this.clock() - started;
          // Moved on meanwhile (a seek, a restart): the answer is for another moment.
          if (this.recorder !== rec || rec.viewing || rec.headTick !== tick) return;
          rec.input({ type: 'shares', shares: levels.map((l) => l / (ACTION_LEVELS - 1)) });
          this.decidedTick = tick;
        },
        (err: unknown) => {
          this.pending = false;
          this.post({ type: 'error', message: `Agente de roteamento: ${String(err)}` }, []);
        },
      );
    }
    return true;
  }

  private loadReport(report: RunReport): void {
    if (report?.format !== 'gemeo-digital-cd/run' || report.version !== 1) {
      this.post({ type: 'error', message: 'Este arquivo não é um relatório do simulador.' }, []);
      return;
    }
    this.config = report.config;
    this.restart(report.config, false);
    this.replay = { report, next: 0 };
  }

  /** Runs the report as fast as the budget allows; returns the steps taken. */
  private runReplay(start: number): number {
    const job = this.replay as { report: RunReport; next: number };
    const rec = this.recorder;
    const inputs = job.report.inputs;
    let steps = 0;
    for (;;) {
      while (
        job.next < inputs.length &&
        (inputs[job.next] as RecordedInput).tick === rec.headTick
      ) {
        rec.input((inputs[job.next] as RecordedInput).input);
        job.next++;
      }
      if (rec.headTick >= job.report.endTick) {
        const print = fingerprint(rec.live);
        this.post(
          {
            type: 'replay',
            progress: 1,
            done: true,
            ok: print === job.report.fingerprint,
            fingerprint: print,
          },
          [],
        );
        this.replay = null;
        this.speed = 0;
        this.choice = choiceOf(rec.live.policy);
        this.syncShadow();
        return steps;
      }
      if (this.clock() - start > BUDGET_MS) break;
      rec.step();
      steps++;
    }
    this.post(
      { type: 'replay', progress: rec.headTick / Math.max(1, job.report.endTick), done: false },
      [],
    );
    return steps;
  }

  private exportFile(what: 'csv' | 'report'): SimMessage {
    const rec = this.recorder;
    const seconds = Math.round(rec.headTick * rec.config.dt);
    const base = `gemeo-cd-seed${rec.config.seed}-${seconds}s`;
    return what === 'csv'
      ? {
          type: 'export',
          filename: `${base}-eventos.csv`,
          mime: 'text/csv;charset=utf-8',
          text: eventLogCsv(rec),
        }
      : {
          type: 'export',
          filename: `${base}-relatorio.json`,
          mime: 'application/json',
          text: JSON.stringify(rec.report(), null, 1),
        };
  }

  private postStatus(now: number): void {
    const rec = this.recorder;
    const shown = rec.shown;
    const stages = new Array<number>(ROBOT_STAGES.length).fill(0);
    for (const r of shown.fleet?.robots ?? []) stages[ROBOT_STAGES.indexOf(r.stage)]!++;
    const routing = {
      shown: choiceOf(shown.policy),
      wanted: this.wanted ?? this.choice,
      agent: this.agent.state,
      agentError: this.agent.error,
      decisionMs: this.decisions ? this.decisionMs / this.decisions : NaN,
      decisions: this.decisions,
      compare: rec.viewing ? null : this.shadow.compare(rec.live),
    };
    const second = Math.min(rec.series.seconds - 1, Math.floor(shown.time + 1e-9));
    const schedule = shown.schedule;
    const maintenance = {
      enabled: schedule.enabled,
      avoided: schedule.avoided,
      unneeded: schedule.unneeded,
      lost: schedule.lost,
      planned: schedule.plans.map((p) => shown.conveyorLabel(p.target)),
      inService: schedule.services.map((s) => shown.conveyorLabel(s.target)),
    };
    this.post(
      {
        type: 'status',
        timeline: timeline(rec),
        kpis: rec.kpis(shown.time),
        stages,
        routing,
        bottleneck: this.detector.detect(rec.series, second),
        maintenance,
      },
      [],
    );
    this.lastStatus = now;
  }

  private flush(force: boolean): void {
    if (!this.dirty) return;
    const now = this.clock();
    if (!force && now - this.lastPost < SNAPSHOT_INTERVAL_MS) return;
    const rec = this.recorder;
    const shown = rec.shown;
    const buffer = this.writer.write({
      speed: rec.viewing ? 0 : this.speed,
      stress: shown.baseRate === STRESS_ARRIVAL_RATE,
      mode: rec.viewing ? 1 : 0,
      head: rec.headTick * rec.config.dt,
    });
    // The feed follows the live run only; the past keeps its log.
    const events = rec.viewing ? [] : rec.events.filter((e) => e.id > this.lastEventId);
    const lastEvent = events.at(-1);
    if (lastEvent) this.lastEventId = lastEvent.id;
    this.post({ type: 'snapshot', buffer, events }, [buffer]);
    this.lastPost = now;
    this.dirty = false;
  }
}
