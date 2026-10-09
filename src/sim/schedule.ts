import type { Conveyor, ConveyorStatus } from './conveyor';
import type { Degradation, SimEventKind } from './failures';
import type { StateReader, StateWriter } from './state';

/**
 * Maintenance schedule (phase 4b): what the operations AI does with a motor
 * alarm (health.ts). The alarm says a belt is probably wearing out; left
 * alone it would break, stopping for 60 to 90 s with whatever is on it stuck.
 * Instead:
 *
 *  1. From the alarm on, the congestion heuristic routes around the belt (it
 *     sees it as cut, like a broken one), so it empties where its traffic has
 *     another way. Emptying takes as long as the packets already on their
 *     way need to pass: the belt's own length plus its longest feeder.
 *  2. The maintenance starts at the first second when the belt is empty (or
 *     that time is up, or it cannot be emptied: no other way for its traffic,
 *     or another routing than the heuristic), unless the demand forecast of
 *     the CD drops before the deadline: during an order surge that ends
 *     before the deadline, it waits for the end. That is the "moment of
 *     lowest demand" inside the time it has.
 *  3. At the deadline it starts anyway. The deadline is a low percentile of
 *     the lead time of the alarms measured on the validation seeds (how long
 *     a belt still had before breaking): waiting longer risks the very
 *     breakdown the maintenance is for.
 *  4. A planned maintenance stops the belt for `duration` seconds, shorter
 *     than a breakdown (an assumption: parts and crew are ready). If the belt
 *     really was wearing out, the wear is gone and the breakdown never comes:
 *     a failure avoided. If not, it was a false alarm, and the stop counts as
 *     one for nothing.
 *
 * If the belt breaks before its maintenance starts (the alarm came too late,
 * or a sudden breakdown), the plan is lost: a breakdown that happened while
 * the maintenance waited.
 */

export interface ScheduleParams {
  /** Longest wait from the alarm to the start of the maintenance, seconds. */
  readonly window: number;
  /** Seconds a planned maintenance stops the belt. */
  readonly duration: number;
  /** Drop of the demand forecast worth waiting for (0.2: at least 20 % lower). */
  readonly demandDrop: number;
}

/**
 * Window: 11 s, the p10 of the lead time of the motor alarms on the
 * validation seeds (heuristic routing, automatic failures, 47 worn belts
 * caught; npm run bench:agenda -- --calibrate). The p20 (15 s) gave exactly
 * the same results, since the wait almost never reaches the deadline (it is
 * the emptying, up to 10 s, or the end of a surge); the rule fixed before
 * measuring then picks the shorter one. The duration is an assumption,
 * measured at 30, 45 and 60 s.
 */
export const DEFAULT_SCHEDULE: ScheduleParams = { window: 11, duration: 30, demandDrop: 0.2 };

/** What the schedule needs from the world. */
export interface ScheduleHost {
  readonly conveyors: readonly Conveyor[];
  conveyorLabel(edgeId: number): string;
  setConveyorStatus(edgeId: number, status: ConveyorStatus): void;
  /** Ends the wear of a belt, if it has one, and returns it (the maintenance found it). */
  serviceWear(edgeId: number): Degradation | null;
  /** Orders per second the CD expects at time t (from what is known now, surges included). */
  forecastRate(t: number): number;
  /** Seconds the routing needs to empty a belt now; 0 when it cannot (see above). */
  drainSeconds(edgeId: number): number;
  emitService(kind: SimEventKind, text: string, edgeId: number): void;
}

/** A maintenance decided on an alarm, not started yet. */
export interface ServicePlan {
  readonly id: number;
  readonly target: number;
  readonly alarmAt: number;
  readonly deadline: number;
  /** When the belt is expected to be empty (the alarm, when it cannot be emptied). */
  readonly drainedBy: number;
  /** The viewer was told it waits for a lower demand. */
  postponed: boolean;
}

/** A maintenance under way: the belt is stopped until `endsAt`. */
export interface Service {
  readonly id: number;
  readonly target: number;
  readonly alarmAt: number;
  readonly startedAt: number;
  readonly endsAt: number;
  /** When the wear it found would have broken the belt (NaN: no wear, a false alarm). */
  readonly breaksAt: number;
}

export type OutcomeKind = 'avoided' | 'unneeded' | 'lost';

/** How one plan ended (benchmarks; not part of the state). */
export interface ServiceOutcome {
  readonly kind: OutcomeKind;
  readonly target: number;
  readonly alarmAt: number;
  /** Start of the maintenance, or the breakdown that came first. */
  readonly time: number;
  /** avoided: when the belt would have broken. */
  readonly breaksAt: number;
}

/** Times are multiples of dt in floating point: compare with a margin. */
const EPS = 1e-6;

export class MaintenanceSchedule {
  readonly params: ScheduleParams;
  /** 1 while a belt is being emptied for its maintenance (the heuristic routes around it). */
  readonly closing: Uint8Array;
  readonly plans: ServicePlan[] = [];
  readonly services: Service[] = [];
  /** When the last failure avoided on each belt was found (-1: never), for the scene. */
  readonly avoidedAt: Float64Array;
  avoided = 0;
  unneeded = 0;
  lost = 0;
  /** Called when a plan ends one way or another (benchmarks); not part of the state. */
  onOutcome: ((outcome: ServiceOutcome) => void) | null = null;
  private nextId = 1;

  constructor(
    private readonly host: ScheduleHost,
    private on: boolean,
    params: Partial<ScheduleParams> = {},
  ) {
    this.params = { ...DEFAULT_SCHEDULE, ...params };
    const { window, duration, demandDrop } = this.params;
    if (!(window > 0) || !(duration > 0) || !(demandDrop >= 0 && demandDrop < 1)) {
      throw new Error('maintenance schedule parameters out of range');
    }
    const n = host.conveyors.length;
    this.closing = new Uint8Array(n);
    this.avoidedAt = new Float64Array(n).fill(-1);
  }

  /** Plans maintenance on the alarms (config.scheduleMaintenance, or the 'maintenance' input). */
  get enabled(): boolean {
    return this.on;
  }

  /**
   * Switched during a run (the demo's run without AI): off drops the plans (the
   * belts being emptied go back to the routing) and ignores new alarms; a
   * maintenance under way finishes.
   */
  setEnabled(on: boolean): void {
    if (!on) {
      this.plans.length = 0;
      this.closing.fill(0);
    }
    this.on = on;
  }

  /** For the scene: 0 nothing · 1 maintenance planned (emptying) · 2 in maintenance. */
  stateOf(edgeId: number): number {
    if (this.services.some((s) => s.target === edgeId)) return 2;
    return this.plans.some((p) => p.target === edgeId) ? 1 : 0;
  }

  /** The motor alarm of a belt went up. */
  alarm(edgeId: number, now: number): void {
    if (!this.enabled || this.stateOf(edgeId) !== 0) return;
    const drain = this.host.drainSeconds(edgeId);
    this.plans.push({
      id: this.nextId++,
      target: edgeId,
      alarmAt: now,
      deadline: now + this.params.window,
      drainedBy: now + drain,
      postponed: false,
    });
    this.closing[edgeId] = 1;
    const label = this.host.conveyorLabel(edgeId);
    this.host.emitService(
      'service-planned',
      drain > 0
        ? `${label}: manutenção agendada; o fluxo é desviado e a esteira para quando esvaziar, em até ${this.params.window} s`
        : `${label}: manutenção agendada; sem outro caminho para o fluxo, a esteira para em até ${this.params.window} s`,
      edgeId,
    );
  }

  /** Once per simulated second, after the motor readings. */
  update(now: number): void {
    for (let i = this.services.length - 1; i >= 0; i--) {
      const s = this.services[i] as Service;
      if (now < s.endsAt - EPS) continue;
      this.services.splice(i, 1);
      const c = this.host.conveyors[s.target] as Conveyor;
      if (c.status === 'maintenance') this.host.setConveyorStatus(s.target, 'ok');
      this.host.emitService(
        'service-end',
        `${this.host.conveyorLabel(s.target)} voltou a operar depois da manutenção`,
        s.target,
      );
    }
    for (let i = 0; i < this.plans.length;) {
      const p = this.plans[i] as ServicePlan;
      const c = this.host.conveyors[p.target] as Conveyor;
      if (c.status !== 'ok') {
        this.plans.splice(i, 1);
        this.closing[p.target] = 0;
        this.lost++;
        this.host.emitService(
          'service-lost',
          `${this.host.conveyorLabel(p.target)} quebrou antes da manutenção agendada (${Math.round(now - p.alarmAt)} s depois do alarme)`,
          p.target,
        );
        this.onOutcome?.({
          kind: 'lost',
          target: p.target,
          alarmAt: p.alarmAt,
          time: now,
          breaksAt: now,
        });
        continue;
      }
      // The first check is a second after the alarm, when the routing has turned away from the
      // belt (the heuristic runs at the start of each second, before the motor readings).
      if (now >= p.alarmAt + 1 - EPS && this.ready(p, c, now)) {
        this.plans.splice(i, 1);
        this.start(p, now);
        continue;
      }
      i++;
    }
  }

  private ready(p: ServicePlan, c: Conveyor, now: number): boolean {
    if (now >= p.deadline - EPS) return true;
    if (c.packets.length > 0 && now < p.drainedBy - EPS) return false;
    const rate = this.host.forecastRate(now);
    for (let t = now + 1; t <= p.deadline + EPS; t++) {
      if (this.host.forecastRate(t) > rate * (1 - this.params.demandDrop)) continue;
      if (!p.postponed) {
        p.postponed = true;
        const drop = Math.round((1 - this.host.forecastRate(t) / rate) * 100);
        this.host.emitService(
          'service-planned',
          `${this.host.conveyorLabel(p.target)}: manutenção adiada ${Math.round(t - now)} s, para quando a demanda prevista cair ${drop}%`,
          p.target,
        );
      }
      return false;
    }
    return true;
  }

  private start(p: ServicePlan, now: number): void {
    const label = this.host.conveyorLabel(p.target);
    const wear = this.host.serviceWear(p.target);
    this.host.setConveyorStatus(p.target, 'maintenance');
    this.closing[p.target] = 0;
    this.services.push({
      id: p.id,
      target: p.target,
      alarmAt: p.alarmAt,
      startedAt: now,
      endsAt: now + this.params.duration,
      breaksAt: wear ? wear.breaksAt : NaN,
    });
    const after = Math.round(now - p.alarmAt);
    if (wear) {
      this.avoided++;
      this.avoidedAt[p.target] = now;
      this.host.emitService(
        'failure-avoided',
        `Falha evitada: ${label} parou para manutenção ${after} s depois do alarme e o desgaste foi corrigido (a quebra viria em ${Math.round(wear.breaksAt - now)} s)`,
        p.target,
      );
    } else {
      this.unneeded++;
      this.host.emitService(
        'service-start',
        `${label}: manutenção sem desgaste encontrado (alarme falso)`,
        p.target,
      );
    }
    this.onOutcome?.({
      kind: wear ? 'avoided' : 'unneeded',
      target: p.target,
      alarmAt: p.alarmAt,
      time: now,
      breaksAt: wear ? wear.breaksAt : NaN,
    });
  }

  save(w: StateWriter): void {
    w.bool(this.on);
    w.int(this.nextId);
    w.int(this.avoided);
    w.int(this.unneeded);
    w.int(this.lost);
    w.ints32(this.closing);
    w.floats64(this.avoidedAt);
    w.int(this.plans.length);
    for (const p of this.plans) {
      w.int(p.id);
      w.int(p.target);
      w.float(p.alarmAt);
      w.float(p.deadline);
      w.float(p.drainedBy);
      w.bool(p.postponed);
    }
    w.int(this.services.length);
    for (const s of this.services) {
      w.int(s.id);
      w.int(s.target);
      w.float(s.alarmAt);
      w.float(s.startedAt);
      w.float(s.endsAt);
      w.float(s.breaksAt);
    }
  }

  load(r: StateReader): void {
    this.on = r.bool();
    this.nextId = r.int();
    this.avoided = r.int();
    this.unneeded = r.int();
    this.lost = r.int();
    this.closing.set(r.ints32());
    this.avoidedAt.set(r.floats64());
    this.plans.length = 0;
    for (let n = r.int(); n > 0; n--) {
      this.plans.push({
        id: r.int(),
        target: r.int(),
        alarmAt: r.float(),
        deadline: r.float(),
        drainedBy: r.float(),
        postponed: r.bool(),
      });
    }
    this.services.length = 0;
    for (let n = r.int(); n > 0; n--) {
      this.services.push({
        id: r.int(),
        target: r.int(),
        alarmAt: r.float(),
        startedAt: r.float(),
        endsAt: r.float(),
        breaksAt: r.float(),
      });
    }
  }
}
