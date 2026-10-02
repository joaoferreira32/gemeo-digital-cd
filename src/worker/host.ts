import { SnapshotWriter } from '../sim/snapshot';
import { World, type SimConfig } from '../sim/world';
import { STRESS_ARRIVAL_RATE, type SimCommand, type SimMessage } from './protocol';

/** Real milliseconds of simulation work per pump before yielding to messages. */
const BUDGET_MS = 40;
/** Minimum real milliseconds between two snapshots. */
const SNAPSHOT_INTERVAL_MS = 15;
/** Simulated seconds of backlog kept when the host cannot keep up (no spiral of death). */
const MAX_BACKLOG = 0.5;

/**
 * Runs a World in real time: the driver calls `pump()` often (a timer in the
 * worker), the host advances as many fixed steps as the elapsed real time ×
 * speed asks for — within a time budget so commands are never starved — and
 * posts a snapshot. The same class runs inline on the main thread for the
 * comparison benchmark.
 */
export class SimHost {
  private world: World;
  private writer: SnapshotWriter;
  private config: Partial<SimConfig> = {};
  private speed = 1;
  private stress = false;
  private accumulator = 0;
  private lastPump: number;
  private lastPost = -Infinity;
  private dirty = true;
  /** Steps run in the last pump and total, for diagnostics. */
  stepsLastPump = 0;

  constructor(
    private readonly post: (msg: SimMessage, transfer: Transferable[]) => void,
    private readonly clock: () => number,
  ) {
    this.world = new World(this.config);
    this.writer = new SnapshotWriter(this.world);
    this.lastPump = clock();
  }

  get currentWorld(): World {
    return this.world;
  }

  handle(cmd: SimCommand): void {
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
        this.world.failures.inject(cmd.kind, this.world.time, cmd.target);
        break;
      case 'auto':
        this.world.failures.setAuto(cmd.on, this.world.time);
        break;
      case 'stress':
        this.stress = cmd.on;
        this.world.setArrivalRate(cmd.on ? STRESS_ARRIVAL_RATE : this.world.config.arrivalRate);
        break;
      case 'advance':
        this.world.stepMany(Math.round(cmd.seconds / this.world.config.dt));
        break;
      case 'release':
        this.writer.recycle(cmd.buffer);
        return;
    }
    this.dirty = true;
    this.flush(true);
  }

  pump(): void {
    const now = this.clock();
    const elapsed = Math.min((now - this.lastPump) / 1000, 0.25);
    this.lastPump = now;
    const dt = this.world.config.dt;
    this.accumulator = Math.min(this.accumulator + elapsed * this.speed, MAX_BACKLOG + dt);
    let steps = 0;
    while (this.accumulator >= dt) {
      this.world.step();
      this.accumulator -= dt;
      steps++;
      if (this.clock() - now > BUDGET_MS) break;
    }
    this.stepsLastPump = steps;
    if (steps > 0) this.dirty = true;
    this.flush(false);
  }

  private restart(): void {
    this.world = new World(this.config);
    if (this.stress) this.world.setArrivalRate(STRESS_ARRIVAL_RATE);
    this.writer = new SnapshotWriter(this.world);
    this.accumulator = 0;
  }

  private flush(force: boolean): void {
    if (!this.dirty) return;
    const now = this.clock();
    if (!force && now - this.lastPost < SNAPSHOT_INTERVAL_MS) return;
    const buffer = this.writer.write({ speed: this.speed, stress: this.stress });
    this.post({ type: 'snapshot', buffer, events: this.writer.newEvents() }, [buffer]);
    this.lastPost = now;
    this.dirty = false;
  }
}
