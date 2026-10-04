import type { HeuristicParams, RoutingPolicy } from '../sim/policy';
import { applyInput, quantile, type SimInput } from '../sim/recorder';
import { World, type SimConfig } from '../sim/world';

/**
 * The four evaluation scenarios of the routing comparison. Ten simulated
 * minutes each; deliveries of the first minute (an empty building filling
 * up) are not counted. Only packets that came in through the inbounds count
 * (including those robots carried around a broken belt): stock orders go from
 * a rack to a dock by robot, never through a routing choice, and their much
 * longer cycle (p95 128 s against 37 s on the belts) would bury the effect.
 */
export type ScenarioName = 'normal' | 'esteira' | 'pico' | 'caos';
export const SCENARIOS: readonly ScenarioName[] = ['normal', 'esteira', 'pico', 'caos'];

export const SCENARIO_LABEL: Record<ScenarioName, string> = {
  normal: 'Normal',
  esteira: 'Esteira com alternativa quebrada',
  pico: 'Pico de pedidos',
  caos: 'Falhas automáticas',
};

export const EPISODE_SECONDS = 600;
export const WARMUP_SECONDS = 60;

interface ScenarioSpec {
  readonly config: Partial<SimConfig>;
  readonly inputs: readonly { at: number; input: SimInput }[];
}

const SPECS: Record<ScenarioName, ScenarioSpec> = {
  normal: { config: {}, inputs: [] },
  // Two belts that have an alternative way: A2→A3 (Esteira 3), then B2→B3
  // (Esteira 8); each breakdown lasts 60 to 90 s.
  esteira: {
    config: {},
    inputs: [
      { at: 120, input: { type: 'inject', kind: 'conveyor', target: 2 } },
      { at: 330, input: { type: 'inject', kind: 'conveyor', target: 7 } },
    ],
  },
  // Demand 22% above the normal rate, with two 2.5× surges of 45 s.
  pico: {
    config: { arrivalRate: 4.4 },
    inputs: [
      { at: 150, input: { type: 'inject', kind: 'surge' } },
      { at: 390, input: { type: 'inject', kind: 'surge' } },
    ],
  },
  caos: { config: {}, inputs: [{ at: 0, input: { type: 'auto', on: true } }] },
};

export interface EvalResult {
  readonly seed: number;
  readonly scenario: ScenarioName;
  readonly policy: RoutingPolicy;
  /** Deliveries of inbound packets after the warm-up. */
  readonly delivered: number;
  readonly throughputPerMin: number;
  /** Cycle time (order to dock) of those deliveries, seconds. */
  readonly cycleMean: number;
  readonly cycleP95: number;
  readonly cycleP99: number;
  readonly cycleMax: number;
  /** Age of the oldest packet still in the building, at its worst moment (s). */
  readonly oldestMax: number;
}

/**
 * One evaluation episode: the world of a scenario and seed, the scenario's
 * inputs applied at their exact ticks, and the measures. The evaluation of
 * every policy and the learning environment run on this same class, so
 * training and comparison see the same simulation.
 */
export class Episode {
  readonly world: World;
  /** Cycle times of inbound packets delivered after the warm-up (s). */
  readonly cycles: number[] = [];
  /** Age of the oldest inbound packet in the building, worst so far (s). */
  oldestMax = 0;
  readonly endTick: number;
  readonly perSecond: number;
  private readonly warmup: number;
  private readonly pending: { at: number; input: SimInput }[];

  constructor(
    readonly seed: number,
    readonly scenario: ScenarioName,
    readonly policy: RoutingPolicy,
    options: { heuristic?: Partial<HeuristicParams>; seconds?: number } = {},
  ) {
    const spec = SPECS[scenario];
    const world = new World({
      seed,
      ...spec.config,
      ...(options.heuristic ? { heuristic: options.heuristic } : {}),
    });
    world.setPolicy(policy);
    this.world = world;
    this.perSecond = Math.round(1 / world.config.dt);
    this.endTick = (options.seconds ?? EPISODE_SECONDS) * this.perSecond;
    this.warmup = WARMUP_SECONDS * this.perSecond;
    this.pending = [...spec.inputs].sort((a, b) => a.at - b.at);
    world.onDelivery = (p) => {
      if (p.origin >= 0 && world.tick > this.warmup) this.cycles.push(world.time - p.createdAt);
    };
  }

  get done(): boolean {
    return this.world.tick >= this.endTick;
  }

  /** Runs `seconds` more of the episode (never past its end). */
  run(seconds: number): void {
    const world = this.world;
    const until = Math.min(this.endTick, world.tick + Math.round(seconds * this.perSecond));
    while (world.tick < until) {
      while (
        this.pending.length &&
        (this.pending[0] as { at: number }).at * this.perSecond === world.tick
      ) {
        applyInput(world, (this.pending.shift() as { input: SimInput }).input);
      }
      world.step();
      if (world.tick % this.perSecond === 0) {
        this.oldestMax = Math.max(this.oldestMax, oldestAge(world));
      }
    }
  }

  result(): EvalResult {
    let sum = 0;
    let max = 0;
    for (const c of this.cycles) {
      sum += c;
      max = Math.max(max, c);
    }
    const minutes = (this.world.tick - this.warmup) / this.perSecond / 60;
    return {
      seed: this.seed,
      scenario: this.scenario,
      policy: this.policy,
      delivered: this.cycles.length,
      throughputPerMin: this.cycles.length / minutes,
      cycleMean: this.cycles.length ? sum / this.cycles.length : NaN,
      cycleP95: quantile(this.cycles, 0.95),
      cycleP99: quantile(this.cycles, 0.99),
      cycleMax: max,
      oldestMax: this.oldestMax,
    };
  }
}

/**
 * Runs one scenario with one routing policy. The world is built the same
 * way for every policy, so a seed gives the same orders to all of them: the
 * comparison is paired, seed by seed.
 */
export function evaluate(
  seed: number,
  scenario: ScenarioName,
  policy: RoutingPolicy,
  options: { heuristic?: Partial<HeuristicParams>; seconds?: number } = {},
): EvalResult {
  const episode = new Episode(seed, scenario, policy, options);
  episode.run(Infinity);
  return episode.result();
}

/** Age of the oldest inbound packet not yet delivered (piles, belts, bypasses, robots). */
export function oldestAge(world: World): number {
  let oldest = world.time;
  const look = (list: readonly { createdAt: number; origin: number }[]) => {
    for (const p of list) if (p.origin >= 0 && p.createdAt < oldest) oldest = p.createdAt;
  };
  for (const inbound of world.inbounds) {
    const head = inbound.backlog[0];
    if (head && head.createdAt < oldest) oldest = head.createdAt;
  }
  for (const c of world.conveyors) look(c.packets);
  for (const lane of world.lanes) {
    look(lane.pickup);
    look(lane.drop);
  }
  if (world.fleet) for (const r of world.fleet.robots) look(r.load);
  return world.time - oldest;
}
