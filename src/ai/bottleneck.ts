import type { World } from '../sim/world';

/**
 * Bottleneck detector (phase 4b): points at the belt or dock that holds the
 * flow back, says why in plain words, and shows how sure it can be about the
 * cause. A pure function of the recording (the per-second series of the
 * recorder), so it works at any moment of the run, the past included.
 *
 * A resource is a bottleneck when packets are waiting for it (src/sim/
 * queues.ts: the belt they must enter, the dock that must take them) and
 *  - it is stopped (broken, in maintenance, a blocked dock): whatever waits
 *    for it waits for the repair, growing or not; or
 *  - it runs close to its capacity over the moving window and the queue in
 *    front of it keeps growing, for some seconds already. A belt whose own
 *    exit is held further on has a full belt but little flow: the queue
 *    then shows in front of what holds it, which is the one named.
 * Among several, the one holding the most packets (the worst point).
 *
 * The cause, in this order: the resource's own failure (certain); a belt
 * stopped on another way of a routing choice that leads here (its traffic
 * was diverted to this one); an order surge while the queue grew or in the
 * window before; otherwise the layout itself (more demand than this resource
 * can take).
 */

/** What the detector reads, second by second; entries are [second × count + index]. */
export interface QueueSeries {
  readonly seconds: number;
  readonly conveyors: number;
  readonly docks: number;
  readonly conveyorQueue: { get(i: number): number };
  readonly dockQueue: { get(i: number): number };
  /** 0 running · 1 broken · 2 stopped for maintenance. */
  readonly conveyorState: { get(i: number): number };
  readonly dockBlocked: { get(i: number): number };
  readonly surge: { get(i: number): number };
  /** Cumulative counts. */
  readonly conveyorExits: { get(i: number): number };
  readonly dockDeliveries: { get(i: number): number };
}

/** The fixed facts about the floor the detector needs. */
export interface BottleneckTopology {
  /** "Esteira 9 (B3→B4)", by belt id; "Doca 3", by dock index. */
  readonly conveyorLabels: readonly string[];
  readonly dockLabels: readonly string[];
  /** Packets per second a belt can move, and a dock can sort. */
  readonly conveyorCapacity: number;
  readonly dockCapacity: number;
  /** The two ways of every routing choice (belt ids), as the heuristic sees them. */
  readonly ways: readonly {
    readonly primary: readonly number[];
    readonly alternative: readonly number[];
  }[];
  /** Belts the robots bridge when they stop. */
  readonly bypassEdges: readonly number[];
}

export interface BottleneckParams {
  /** Seconds of the moving window: use, and the low point of the queue. */
  readonly window: number;
  /** Seconds over which the growth of a queue is measured (least squares). */
  readonly trend: number;
  /** Packets waiting, at least. */
  readonly minQueue: number;
  /** Growth of the queue, packets per minute, at least. */
  readonly minRate: number;
  /** Share of its capacity a running resource uses, at least (a stopped one always qualifies). */
  readonly minUse: number;
  /** Seconds a running resource's queue has been growing, at least. */
  readonly minGrowing: number;
  /** Seconds a finding stays up after its last confirmation (no flicker). */
  readonly hold: number;
}

/**
 * Calibrated on the controlled trials of the validation seeds (npm run
 * bench:gargalo -- --calibrate, a 3 × 3 × 3 grid of the three thresholds):
 * with 12 packets and 70 % of use, 291 of the 293 failures that formed a
 * queue were pointed out, every first cause right, 0.8 findings per hour with
 * no failure. Smaller queues found the same failures a few seconds earlier but
 * pointed out 3 to 17 bottlenecks per hour with no failure; the growth rate
 * made no difference there (4, 6 and 10 per minute alike), so it stays at 6.
 */
export const DEFAULT_BOTTLENECK: BottleneckParams = {
  window: 60,
  trend: 20,
  minQueue: 12,
  minRate: 6,
  minUse: 0.7,
  minGrowing: 5,
  hold: 5,
};

export type CauseKind = 'conveyor' | 'service' | 'dock' | 'surge' | 'layout';

export interface Cause {
  readonly kind: CauseKind;
  /** Belt id (conveyor, service) or dock index; -1 for a surge or the layout. */
  readonly target: number;
  /** True when it is the resource's own failure; otherwise the most likely cause. */
  readonly certain: boolean;
  readonly text: string;
}

export interface Bottleneck {
  readonly kind: 'conveyor' | 'dock';
  readonly index: number;
  readonly label: string;
  /** Second it was last confirmed. */
  readonly second: number;
  readonly stopped: boolean;
  /** Share of its capacity used over the window (0 … 1). */
  readonly use: number;
  readonly queue: number;
  /** Growth of the queue, packets per minute. */
  readonly perMinute: number;
  /** Seconds since the queue was at its low point. */
  readonly growingFor: number;
  readonly cause: Cause;
  /** The whole finding in one sentence (pt-BR). */
  readonly text: string;
}

interface Candidate {
  readonly kind: 'conveyor' | 'dock';
  readonly index: number;
  readonly stopped: boolean;
  readonly use: number;
  readonly queue: number;
  readonly perMinute: number;
  readonly growingFor: number;
}

export class BottleneckDetector {
  readonly params: BottleneckParams;

  constructor(
    private readonly topology: BottleneckTopology,
    params: Partial<BottleneckParams> = {},
  ) {
    this.params = { ...DEFAULT_BOTTLENECK, ...params };
  }

  /** The bottleneck at second `at` of the recording, or null. */
  detect(s: QueueSeries, at: number): Bottleneck | null {
    const last = Math.min(Math.floor(at), s.seconds - 1);
    for (let t = last; t >= Math.max(0, last - this.params.hold); t--) {
      const c = this.best(s, t);
      if (c) return this.describe(s, c, t);
    }
    return null;
  }

  /** The worst candidate at second t (the most packets held back), or null. */
  private best(s: QueueSeries, t: number): Candidate | null {
    let best: Candidate | null = null;
    const consider = (c: Candidate | null) => {
      if (!c) return;
      if (
        !best ||
        c.queue > best.queue ||
        (c.queue === best.queue && c.perMinute > best.perMinute)
      ) {
        best = c;
      }
    };
    for (let i = 0; i < s.conveyors; i++) consider(this.candidate(s, t, 'conveyor', i));
    for (let i = 0; i < s.docks; i++) consider(this.candidate(s, t, 'dock', i));
    return best;
  }

  private candidate(
    s: QueueSeries,
    t: number,
    kind: 'conveyor' | 'dock',
    i: number,
  ): Candidate | null {
    const { window, trend, minQueue, minRate, minUse, minGrowing } = this.params;
    const n = kind === 'conveyor' ? s.conveyors : s.docks;
    const queues = kind === 'conveyor' ? s.conveyorQueue : s.dockQueue;
    const q = (sec: number) => queues.get(sec * n + i);
    const queue = q(t);
    if (queue < minQueue) return null;
    const stopped =
      kind === 'conveyor'
        ? s.conveyorState.get(t * s.conveyors + i) !== 0
        : s.dockBlocked.get(t * s.docks + i) !== 0;
    // Growth over the trend window (least squares), packets per minute.
    const from = Math.max(0, t - trend);
    const k = t - from + 1;
    let perMinute = 0;
    if (k >= 3) {
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let sxx = 0;
      for (let sec = from; sec <= t; sec++) {
        const x = sec - from;
        const y = q(sec);
        sx += x;
        sy += y;
        sxy += x * y;
        sxx += x * x;
      }
      perMinute = ((k * sxy - sx * sy) / (k * sxx - sx * sx)) * 60;
    }
    // Low point of the window: the queue has been growing since then.
    const start = Math.max(0, t - window);
    let low = Infinity;
    let lowAt = start;
    for (let sec = start; sec <= t; sec++) {
      const v = q(sec);
      if (v <= low) {
        low = v;
        lowAt = sec;
      }
    }
    const growingFor = t - lowAt;
    const use = this.use(s, t, kind, i);
    if (!stopped) {
      if (use < minUse || !(perMinute >= minRate)) return null;
      if (queue - low < minQueue / 2 || growingFor < minGrowing) return null;
    }
    return { kind, index: i, stopped, use, queue, perMinute, growingFor };
  }

  /** Share of its capacity a resource moved over the window ending at second t. */
  private use(s: QueueSeries, t: number, kind: 'conveyor' | 'dock', i: number): number {
    const from = Math.max(0, t - this.params.window);
    const span = t - from;
    if (span <= 0) return 0;
    const moved =
      kind === 'conveyor'
        ? s.conveyorExits.get(t * s.conveyors + i) - s.conveyorExits.get(from * s.conveyors + i)
        : s.dockDeliveries.get(t * s.docks + i) - s.dockDeliveries.get(from * s.docks + i);
    const capacity =
      (kind === 'conveyor' ? this.topology.conveyorCapacity : this.topology.dockCapacity) * span;
    return Math.min(1, moved / capacity);
  }

  private describe(s: QueueSeries, c: Candidate, t: number): Bottleneck {
    const top = this.topology;
    const label = c.kind === 'conveyor' ? top.conveyorLabels[c.index] : top.dockLabels[c.index];
    const cause = this.cause(s, c, t);
    const head = c.stopped
      ? `${label} ${c.kind === 'dock' ? 'bloqueada' : 'parada'}`
      : `${label} com ${Math.round(c.use * 100)}% de uso no último minuto`;
    const growing =
      c.perMinute >= this.params.minRate && c.growingFor > 0
        ? ` crescendo há ${c.growingFor} s (+${Math.round(c.perMinute)} por minuto)`
        : '';
    const text =
      `Gargalo: ${head}; fila de ${c.queue} pacotes${growing}. ` +
      `${cause.certain ? 'Causa' : 'Causa provável'}: ${cause.text}.`;
    return {
      kind: c.kind,
      index: c.index,
      label: label as string,
      second: t,
      stopped: c.stopped,
      use: c.use,
      queue: c.queue,
      perMinute: c.perMinute,
      growingFor: c.growingFor,
      cause,
      text,
    };
  }

  private cause(s: QueueSeries, c: Candidate, t: number): Cause {
    const top = this.topology;
    const state = (belt: number) => s.conveyorState.get(t * s.conveyors + belt);
    if (c.kind === 'conveyor' && c.stopped) {
      const bridged = top.bypassEdges.includes(c.index) ? ', e robôs fazem o desvio' : '';
      return state(c.index) === 2
        ? {
            kind: 'service',
            target: c.index,
            certain: true,
            text: `manutenção programada desta esteira${bridged}`,
          }
        : {
            kind: 'conveyor',
            target: c.index,
            certain: true,
            text: `quebra desta esteira${bridged}`,
          };
    }
    if (c.kind === 'dock' && c.stopped) {
      return { kind: 'dock', target: c.index, certain: true, text: 'doca bloqueada' };
    }
    if (c.kind === 'conveyor') {
      for (const way of top.ways) {
        for (const [mine, other] of [
          [way.primary, way.alternative],
          [way.alternative, way.primary],
        ] as const) {
          if (!mine.includes(c.index)) continue;
          const stopped = other.find(
            (belt) => belt !== c.index && !mine.includes(belt) && state(belt) !== 0,
          );
          if (stopped === undefined) continue;
          const service = state(stopped) === 2;
          return {
            kind: service ? 'service' : 'conveyor',
            target: stopped,
            certain: false,
            text: `${top.conveyorLabels[stopped]} ${service ? 'em manutenção' : 'quebrada'} desvia o fluxo para cá`,
          };
        }
      }
    }
    // A surge while this queue grew, or in the window before: it may have ended since, but
    // its wave of packets takes a while to cross the building (the piles, then the belts,
    // then the docks).
    let surge = false;
    for (let sec = Math.max(0, t - c.growingFor - this.params.window); sec <= t && !surge; sec++) {
      surge = s.surge.get(sec) !== 0;
    }
    if (surge) {
      return { kind: 'surge', target: -1, certain: false, text: 'pico de pedidos' };
    }
    return {
      kind: 'layout',
      target: -1,
      certain: false,
      text:
        c.kind === 'dock'
          ? 'a demanda passa da capacidade da doca'
          : 'a demanda passa da capacidade desta esteira',
    };
  }
}

/** The topology of a world, as the detector needs it. */
export function topologyOf(world: World): BottleneckTopology {
  return {
    conveyorLabels: world.conveyors.map((c) => world.conveyorLabel(c.edgeId)),
    dockLabels: world.docks.map((d) => `Doca ${d.index + 1}`),
    conveyorCapacity: world.config.conveyorSpeed / world.config.packetSpacing,
    dockCapacity: world.config.dockServiceRate,
    ways: world.heuristic.ways,
    bypassEdges: world.bypassEdges,
  };
}
