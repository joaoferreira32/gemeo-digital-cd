import { deriveSeed, Rng } from './rng';
import type { StateReader, StateWriter } from './state';

/**
 * Failure injection: conveyor breakdowns, order surges, robot defects and
 * blocked docks. Each can be triggered on demand or by the automatic mode,
 * which draws from its own random stream (same seed → same chaos), so
 * enabling failures never shifts the order stream of a scenario.
 *
 * Three in four conveyor breakdowns of the automatic mode do not come out of
 * the blue: the belt first wears out for one to three minutes (a
 * Degradation), which the motor monitoring can notice (health.ts), and then
 * breaks. The fourth is sudden (think of an electrical fault), like the
 * breakdowns injected on demand.
 */

export type FailureKind = 'conveyor' | 'surge' | 'robot' | 'dock';

export interface ActiveFailure {
  readonly id: number;
  readonly kind: FailureKind;
  /** Conveyor edge id, robot id or dock index (-1 for a surge). */
  readonly target: number;
  readonly startedAt: number;
  readonly endsAt: number;
}

/** A conveyor wearing out: it breaks at `breaksAt`. Hidden from the viewer, like real wear. */
export interface Degradation {
  readonly id: number;
  readonly target: number;
  readonly onset: number;
  readonly breaksAt: number;
  /** How long the breakdown that follows lasts (drawn with the rest, at the onset). */
  readonly duration: number;
}

export type SimEventKind =
  | 'failure-start'
  | 'failure-end'
  | 'bypass-start'
  | 'bypass-end'
  /** The fleet watchdog broke a wait or rerouted a robot. */
  | 'watchdog'
  /** A robot has had no path for STUCK_SECONDS, and when it moves again. */
  | 'robot-stuck'
  | 'robot-moving'
  /** The motor monitoring raised an alarm on a conveyor (predictive maintenance). */
  | 'maintenance';

/** Something worth telling the viewer; the text is ready to show (pt-BR). */
export interface SimEvent {
  readonly id: number;
  readonly time: number;
  readonly kind: SimEventKind;
  readonly failure?: FailureKind;
  readonly target?: number;
  readonly text: string;
  /** Entities the event is about, as "robot:3", "conveyor:7", "dock:2" (history panels). */
  readonly about?: readonly string[];
}

/** What the injector can do to the world. */
export interface FailureHost {
  readonly conveyorCount: number;
  conveyorLabel(edgeId: number): string;
  isConveyorBroken(edgeId: number): boolean;
  /** Conveyors bridged by robot bypasses (picked more often: they make robots react). */
  readonly bypassEdges: readonly number[];
  setConveyorBroken(edgeId: number, broken: boolean): void;
  setSurge(factor: number): void;
  readonly robotCount: number;
  canBreakRobot(robotId: number): boolean;
  setRobotDefect(robotId: number, until: number): void;
  readonly dockCount: number;
  setDockBlocked(dockIndex: number, until: number): void;
  emit(kind: SimEventKind, text: string, failure?: FailureKind, target?: number): void;
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  conveyor: 'Esteira quebrada',
  surge: 'Pico de pedidos',
  robot: 'Robô com defeito',
  dock: 'Doca bloqueada',
};

export const SURGE_FACTOR = 2.5;

const DURATION: Record<FailureKind, readonly [number, number]> = {
  conveyor: [60, 90],
  surge: [45, 45],
  robot: [40, 60],
  dock: [40, 60],
};

/** Seconds from the onset of wear to the breakdown. */
export const WEAR_LEAD: readonly [number, number] = [60, 180];
/** Share of the automatic conveyor breakdowns that come without wear. */
export const SUDDEN_SHARE = 0.25;

const AUTO_WEIGHTS: Record<FailureKind, number> = {
  conveyor: 0.4,
  surge: 0.2,
  robot: 0.25,
  dock: 0.15,
};
const KINDS: readonly FailureKind[] = ['conveyor', 'surge', 'robot', 'dock'];

export class FailureInjector {
  readonly active: ActiveFailure[] = [];
  /** Conveyors wearing out toward a breakdown, in the order they started. */
  readonly degrading: Degradation[] = [];
  private auto = false;
  private readonly rng: Rng;
  private nextAutoAt = Infinity;
  private nextId = 1;

  constructor(
    private readonly host: FailureHost,
    seed: number,
    /** Mean seconds between automatic failures. */
    private readonly autoMeanInterval = 50,
    private readonly maxConcurrent = 2,
  ) {
    this.rng = new Rng(deriveSeed(seed, 'failures'));
  }

  get autoEnabled(): boolean {
    return this.auto;
  }

  save(w: StateWriter): void {
    w.bool(this.auto);
    w.int(this.rng.getState());
    w.float(this.nextAutoAt);
    w.int(this.nextId);
    w.int(this.active.length);
    for (const f of this.active) {
      w.int(f.id);
      w.pick(f.kind, KINDS);
      w.int(f.target);
      w.float(f.startedAt);
      w.float(f.endsAt);
    }
    w.int(this.degrading.length);
    for (const d of this.degrading) {
      w.int(d.id);
      w.int(d.target);
      w.float(d.onset);
      w.float(d.breaksAt);
      w.float(d.duration);
    }
  }

  load(r: StateReader): void {
    this.auto = r.bool();
    this.rng.setState(r.int());
    this.nextAutoAt = r.float();
    this.nextId = r.int();
    this.active.length = 0;
    const n = r.int();
    for (let i = 0; i < n; i++) {
      this.active.push({
        id: r.int(),
        kind: r.pick(KINDS),
        target: r.int(),
        startedAt: r.float(),
        endsAt: r.float(),
      });
    }
    this.degrading.length = 0;
    const m = r.int();
    for (let i = 0; i < m; i++) {
      this.degrading.push({
        id: r.int(),
        target: r.int(),
        onset: r.float(),
        breaksAt: r.float(),
        duration: r.float(),
      });
    }
  }

  setAuto(on: boolean, now: number): void {
    this.auto = on;
    this.nextAutoAt = on ? now + this.rng.exponential(1 / this.autoMeanInterval) : Infinity;
  }

  /**
   * Starts a failure. Without `target` one is drawn from the failure stream.
   * Returns null when nothing can fail (everything of that kind already failed).
   */
  inject(kind: FailureKind, now: number, target?: number): ActiveFailure | null {
    const t = target ?? this.pickTarget(kind);
    if (t === null || this.isActive(kind, t)) return null;
    const [lo, hi] = DURATION[kind];
    const endsAt = now + lo + (hi - lo) * this.rng.next();
    // A sudden breakdown of a belt that was wearing out ends its wear (it gets repaired).
    if (kind === 'conveyor') this.cancelWear(t);
    return this.start(kind, t, now, endsAt, this.nextId++);
  }

  /**
   * Starts the wear of a conveyor, which breaks one to three minutes later
   * (WEAR_LEAD). Without `target` one is drawn from the failure stream, like
   * for a breakdown. Returns null when the conveyor cannot wear (broken,
   * already wearing) or none can.
   */
  degrade(now: number, target?: number): Degradation | null {
    const t = target ?? this.pickTarget('conveyor');
    if (t === null || this.host.isConveyorBroken(t) || this.isWearing(t)) return null;
    if (this.isActive('conveyor', t)) return null;
    const [lo, hi] = DURATION.conveyor;
    const duration = lo + (hi - lo) * this.rng.next();
    const [a, b] = WEAR_LEAD;
    const breaksAt = now + a + (b - a) * this.rng.next();
    const d: Degradation = { id: this.nextId++, target: t, onset: now, breaksAt, duration };
    this.degrading.push(d);
    return d;
  }

  private start(
    kind: FailureKind,
    t: number,
    now: number,
    endsAt: number,
    id: number,
  ): ActiveFailure {
    const f: ActiveFailure = { id, kind, target: t, startedAt: now, endsAt };
    const h = this.host;
    switch (kind) {
      case 'conveyor':
        h.setConveyorBroken(t, true);
        h.emit('failure-start', `${h.conveyorLabel(t)} quebrou`, kind, t);
        break;
      case 'surge':
        h.setSurge(SURGE_FACTOR);
        h.emit(
          'failure-start',
          `Pico de pedidos: ${SURGE_FACTOR.toLocaleString('pt-BR')}× por ${Math.round(endsAt - now)} s`,
          kind,
          t,
        );
        break;
      case 'robot':
        h.setRobotDefect(t, endsAt);
        h.emit('failure-start', `Robô ${t + 1} com defeito`, kind, t);
        break;
      case 'dock':
        h.setDockBlocked(t, endsAt);
        h.emit('failure-start', `Doca ${t + 1} bloqueada`, kind, t);
        break;
    }
    this.active.push(f);
    return f;
  }

  update(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i] as ActiveFailure;
      if (now < f.endsAt) continue;
      this.active.splice(i, 1);
      this.end(f);
    }
    for (let i = 0; i < this.degrading.length;) {
      const d = this.degrading[i] as Degradation;
      if (now < d.breaksAt) {
        i++;
        continue;
      }
      this.degrading.splice(i, 1);
      this.start('conveyor', d.target, now, now + d.duration, d.id);
    }
    if (this.auto && now >= this.nextAutoAt) {
      // A belt wearing out counts: it will be a failure, so the limit holds when it breaks.
      if (this.active.length + this.degrading.length < this.maxConcurrent) {
        const kind = KINDS[
          this.rng.weightedIndex(KINDS.map((k) => AUTO_WEIGHTS[k]))
        ] as FailureKind;
        if (kind === 'conveyor' && this.rng.next() >= SUDDEN_SHARE) this.degrade(now);
        else this.inject(kind, now);
      }
      this.nextAutoAt = now + this.rng.exponential(1 / this.autoMeanInterval);
    }
  }

  private isWearing(target: number): boolean {
    return this.degrading.some((d) => d.target === target);
  }

  private cancelWear(target: number): void {
    const i = this.degrading.findIndex((d) => d.target === target);
    if (i >= 0) this.degrading.splice(i, 1);
  }

  private end(f: ActiveFailure): void {
    const h = this.host;
    switch (f.kind) {
      case 'conveyor':
        h.setConveyorBroken(f.target, false);
        h.emit('failure-end', `${h.conveyorLabel(f.target)} voltou a operar`, f.kind, f.target);
        break;
      case 'surge':
        h.setSurge(1);
        h.emit('failure-end', 'Pico de pedidos encerrado', f.kind, f.target);
        break;
      case 'robot':
        // The fleet repairs the robot on its own at endsAt.
        h.emit('failure-end', `Robô ${f.target + 1} consertado`, f.kind, f.target);
        break;
      case 'dock':
        h.emit('failure-end', `Doca ${f.target + 1} liberada`, f.kind, f.target);
        break;
    }
  }

  private isActive(kind: FailureKind, target: number): boolean {
    return this.active.some((f) => f.kind === kind && (kind === 'surge' || f.target === target));
  }

  private pickTarget(kind: FailureKind): number | null {
    const h = this.host;
    const pick = (candidates: number[]) =>
      candidates.length ? (candidates[this.rng.int(candidates.length)] as number) : null;
    switch (kind) {
      case 'conveyor': {
        const ok = (e: number) =>
          !h.isConveyorBroken(e) && !this.isActive('conveyor', e) && !this.isWearing(e);
        const spof = h.bypassEdges.filter(ok);
        const all = Array.from({ length: h.conveyorCount }, (_, i) => i).filter(ok);
        // 40 % of breakdowns hit a conveyor the robots can bridge.
        return this.rng.next() < 0.4 && spof.length ? pick(spof) : pick(all);
      }
      case 'surge':
        return this.isActive('surge', -1) ? null : -1;
      case 'robot':
        return pick(
          Array.from({ length: h.robotCount }, (_, i) => i).filter(
            (r) => h.canBreakRobot(r) && !this.isActive('robot', r),
          ),
        );
      case 'dock':
        return pick(
          Array.from({ length: h.dockCount }, (_, i) => i).filter((d) => !this.isActive('dock', d)),
        );
    }
  }
}
