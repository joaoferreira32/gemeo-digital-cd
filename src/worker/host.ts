import { eventLogCsv } from '../sim/export';
import { fingerprint } from '../sim/fingerprint';
import { ROBOT_STAGES } from '../sim/fleet';
import {
  Recorder,
  STRESS_ARRIVAL_RATE,
  type RecordedInput,
  type RunReport,
  type SimInput,
} from '../sim/recorder';
import { SnapshotWriter } from '../sim/snapshot';
import type { SimConfig, World } from '../sim/world';
import type { SimCommand, SimMessage } from './protocol';
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

  constructor(
    private readonly post: (msg: SimMessage, transfer: Transferable[]) => void,
    private readonly clock: () => number,
  ) {
    this.recorder = new Recorder(this.config);
    this.writer = new SnapshotWriter(this.recorder.shown);
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
      case 'stress':
        this.input({ type: 'stress', on: cmd.on });
        break;
      case 'advance':
        if (rec.viewing) this.jump(() => rec.branch());
        rec.stepMany(Math.round(cmd.seconds / rec.config.dt));
        break;
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
        rec.step();
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
    const stress = keepStress && this.recorder.live.baseRate === STRESS_ARRIVAL_RATE;
    this.recorder = new Recorder(config);
    if (stress) this.recorder.input({ type: 'stress', on: true });
    this.writer.show(this.recorder.shown);
    this.accumulator = 0;
    this.lastEventId = 0;
    this.replay = null;
  }

  private input(input: SimInput): void {
    if (this.recorder.viewing) this.jump(() => this.recorder.input(input));
    else this.recorder.input(input);
  }

  /** Runs `change` (a seek, a branch, back to live) and makes the next frame a cut. */
  private jump(change: () => void): void {
    change();
    this.writer.show(this.recorder.shown);
    // The feed resumes after what the log already has (a branch drops the rest).
    this.lastEventId = this.recorder.events.at(-1)?.id ?? 0;
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
    this.post({ type: 'status', timeline: timeline(rec), kpis: rec.kpis(shown.time), stages }, []);
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
