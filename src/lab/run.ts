import type { Agent } from '../ai/agent';
import { ACTION_LEVELS, observe } from '../ai/env';
import { HOURS_PER_WEEK, SECONDS_PER_HOUR } from '../sim/demand';
import type { RobotStage } from '../sim/fleet';
import { quantile } from '../sim/recorder';
import { World, type SimConfig } from '../sim/world';

/**
 * The scenario lab (phase 5): one scenario run on one seed, headless, with
 * the measures the lab compares. The world is built exactly as the
 * evaluation of phase 4 builds it (a test checks the same fingerprint), so a
 * lab scenario equal to an evaluation scenario is that evaluation.
 */

export type LabDemand = 'constante' | 'olist';
export type LabPolicy = 'static' | 'heuristic' | 'rl';

export interface LabScenario {
  /** Robots on the floor (0 … 40). */
  readonly robots: number;
  /** Belt speed, m/s. */
  readonly conveyorSpeed: number;
  /** A belt stopped for the whole run (its edge id), or -1. */
  readonly brokenConveyor: number;
  /** Mean orders per second (with the Olist demand, the weight of each hour multiplies it). */
  readonly arrivalRate: number;
  readonly demand: LabDemand;
  readonly policy: LabPolicy;
  readonly autoFailures: boolean;
  /** The maintenance schedule of phase 4b. */
  readonly maintenance: boolean;
}

/** The app as it opens: 40 robots, the heuristic, the maintenance schedule, constant demand. */
export const DEFAULT_SCENARIO: LabScenario = {
  robots: 40,
  conveyorSpeed: 2,
  brokenConveyor: -1,
  arrivalRate: 3.6,
  demand: 'constante',
  policy: 'heuristic',
  autoFailures: false,
  maintenance: true,
};

/** One day of the demand profile (24 hours of 60 simulated seconds). */
export const LAB_SECONDS = 24 * SECONDS_PER_HOUR;
/** Deliveries of the first minute (an empty building filling up) are not counted. */
export const LAB_WARMUP = 60;
/** The lab's own seeds, away from the training, validation and test sets. */
export const LAB_FIRST_SEED = 50_001;

export interface LabOptions {
  readonly seconds?: number;
  /** The 168 weights of the demand profile (public/demanda-olist.json), for the Olist demand. */
  readonly weights?: readonly number[];
  /** Hour of the week at the start (0: Monday 00h). */
  readonly startHour?: number;
  /** The routing network, for the trained policy. */
  readonly agent?: Agent;
}

export interface LabMetrics {
  /** Inbound packets delivered after the warm-up. */
  readonly delivered: number;
  /** Of them, per minute. */
  readonly throughput: number;
  /** Cycle time (order to dock) of those deliveries, seconds. */
  readonly cycleMean: number;
  readonly cycleP95: number;
  /** Share of capacity used after the warm-up: belts (mean of all), docks (mean), robots (busy time). */
  readonly beltUse: number;
  readonly dockUse: number;
  /** NaN without robots. */
  readonly robotUse: number;
}

/** Robot stages that count as busy (the same as the recorder's). */
const WORKING: ReadonlySet<RobotStage> = new Set([
  'toPickup',
  'loading',
  'toDrop',
  'unloading',
  'toPoint',
]);

export function labConfig(
  scenario: LabScenario,
  seed: number,
  options: LabOptions = {},
): Partial<SimConfig> {
  if (scenario.demand === 'olist' && !options.weights) {
    throw new Error('a demanda da Olist precisa do perfil (public/demanda-olist.json)');
  }
  return {
    seed,
    robots: scenario.robots,
    conveyorSpeed: scenario.conveyorSpeed,
    arrivalRate: scenario.arrivalRate,
    scheduleMaintenance: scenario.maintenance,
    ...(scenario.demand === 'olist'
      ? {
          demand: {
            weights: dayScaled(options.weights as readonly number[], options.startHour ?? 0),
            secondsPerHour: SECONDS_PER_HOUR,
            startHour: options.startHour ?? 0,
          },
        }
      : {}),
  };
}

/**
 * The profile rescaled so that the simulated day (24 hours from `startHour`)
 * averages 1: the rate of the scenario is then the mean rate of that day, as
 * the panel says, and the Olist demand differs from the constant one only in
 * its shape over the day, not in volume (a Monday of the Olist has 15.7% more
 * orders than the mean of the week).
 */
export function dayScaled(weights: readonly number[], startHour: number): number[] {
  let sum = 0;
  for (let h = 0; h < 24; h++) sum += weights[(startHour + h) % HOURS_PER_WEEK] as number;
  if (!(sum > 0)) throw new Error('o dia escolhido do perfil não tem pedidos');
  return weights.map((w) => (w * 24) / sum);
}

/** Builds the world of a scenario, ready to run (exposed for the tests). */
export function labWorld(scenario: LabScenario, seed: number, options: LabOptions = {}): World {
  const world = new World(labConfig(scenario, seed, options));
  world.setPolicy(scenario.policy === 'rl' ? 'external' : scenario.policy);
  if (scenario.brokenConveyor >= 0) world.setConveyorStatus(scenario.brokenConveyor, 'broken');
  if (scenario.autoFailures) world.failures.setAuto(true, 0);
  return world;
}

export async function runLab(
  scenario: LabScenario,
  seed: number,
  options: LabOptions = {},
): Promise<LabMetrics> {
  if (scenario.policy === 'rl' && !options.agent) {
    throw new Error('a IA de roteamento precisa da rede treinada');
  }
  const world = labWorld(scenario, seed, options);
  const perSecond = Math.round(1 / world.config.dt);
  const end = (options.seconds ?? LAB_SECONDS) * perSecond;
  const warmup = LAB_WARMUP * perSecond;
  const cycles: number[] = [];
  world.onDelivery = (p) => {
    if (p.origin >= 0 && world.tick > warmup) cycles.push(world.time - p.createdAt);
  };
  let exits = world.conveyorExits.slice();
  let deliveries = world.dockDeliveries.slice();
  let busy = 0;
  let robotSeconds = 0;
  const agent = scenario.policy === 'rl' ? options.agent : undefined;
  while (world.tick < end) {
    // The network decides at every simulated second, as in the app.
    if (agent && world.tick % perSecond === 0) {
      const levels = await agent(observe(world));
      world.setShares(levels.map((l) => l / (ACTION_LEVELS - 1)));
    }
    world.step();
    if (world.tick === warmup) {
      exits = world.conveyorExits.slice();
      deliveries = world.dockDeliveries.slice();
    }
    if (world.tick > warmup && world.tick % perSecond === 0 && world.fleet) {
      for (const r of world.fleet.robots) if (WORKING.has(r.stage)) busy++;
      robotSeconds += world.fleet.robots.length;
    }
  }
  const span = (end - warmup) / perSecond;
  let sum = 0;
  for (const c of cycles) sum += c;
  let belt = 0;
  world.conveyors.forEach((c, i) => {
    const moved = (world.conveyorExits[i] as number) - (exits[i] as number);
    belt += moved / ((c.speed / c.spacing) * span);
  });
  let dock = 0;
  world.docks.forEach((_, d) => {
    const moved = (world.dockDeliveries[d] as number) - (deliveries[d] as number);
    dock += Math.min(1, moved / (world.config.dockServiceRate * span));
  });
  return {
    delivered: cycles.length,
    throughput: (cycles.length / span) * 60,
    cycleMean: cycles.length ? sum / cycles.length : NaN,
    cycleP95: quantile(cycles, 0.95),
    beltUse: belt / world.conveyors.length,
    dockUse: dock / world.docks.length,
    robotUse: robotSeconds ? busy / robotSeconds : NaN,
  };
}
