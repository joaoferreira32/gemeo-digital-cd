import { conveyorCapacity } from '../sim/conveyor';
import type { Packet } from '../sim/packet';
import type { World } from '../sim/world';
import { Episode, type EvalResult, type ScenarioName } from './evaluate';

/**
 * The learning environment of the routing agent, on the same Episode as
 * every evaluation. Each step is one simulated second: the agent picks a
 * level for each routing choice (share of the alternative way = level ÷ 4),
 * the world runs one second, and the agent gets the reward and what it can
 * see of the building.
 */
export const ACTION_LEVELS = 5;
/** Packets older than this (s) are penalized on top of the queue. */
export const OLD_AFTER = 60;

export interface RewardWeights {
  /** Per packet in the building, per second (Little's law: the mean cycle time). */
  readonly perPacket: number;
  /** Extra per packet older than OLD_AFTER, per second (no packet left behind). */
  readonly perOldPacket: number;
}

export const DEFAULT_REWARD: RewardWeights = { perPacket: 1 / 100, perOldPacket: 1 / 20 };

export interface StepResult {
  readonly observation: Float32Array;
  readonly reward: number;
  readonly done: boolean;
}

export class RoutingEnv {
  private episode: Episode | null = null;
  readonly observationSize: number;
  readonly decisions: number;

  constructor(private readonly reward: RewardWeights = DEFAULT_REWARD) {
    // Sizes from a throwaway world (they only depend on the floor plan).
    const probe = new Episode(1, 'normal', 'external', { seconds: 1 });
    this.decisions = probe.world.routing.decisions.length;
    this.observationSize = observe(probe.world).length;
  }

  get world(): World {
    if (!this.episode) throw new Error('reset first');
    return this.episode.world;
  }

  reset(seed: number, scenario: ScenarioName, seconds?: number): Float32Array {
    this.episode = new Episode(
      seed,
      scenario,
      'external',
      seconds !== undefined ? { seconds } : {},
    );
    return observe(this.episode.world);
  }

  step(levels: ArrayLike<number>): StepResult {
    const episode = this.episode;
    if (!episode) throw new Error('reset first');
    const shares = Array.from({ length: this.decisions }, (_, i) =>
      Math.min(1, Math.max(0, (levels[i] ?? 0) / (ACTION_LEVELS - 1))),
    );
    episode.world.setShares(shares);
    episode.run(1);
    const { inBuilding, old } = census(episode.world);
    const reward = -(this.reward.perPacket * inBuilding + this.reward.perOldPacket * old);
    return { observation: observe(episode.world), reward, done: episode.done };
  }

  result(): EvalResult {
    if (!this.episode) throw new Error('reset first');
    return this.episode.result();
  }
}

/** Inbound packets in the building and how many of them are older than OLD_AFTER. */
export function census(world: World): { inBuilding: number; old: number } {
  const limit = world.time - OLD_AFTER;
  let inBuilding = 0;
  let old = 0;
  const count = (list: readonly Packet[]) => {
    for (const p of list) {
      if (p.origin < 0) continue;
      inBuilding++;
      if (p.createdAt < limit) old++;
    }
  };
  for (const inbound of world.inbounds) count(inbound.backlog);
  for (const c of world.conveyors) count(c.packets);
  for (const lane of world.lanes) {
    count(lane.pickup);
    count(lane.drop);
  }
  if (world.fleet) for (const r of world.fleet.robots) count(r.load);
  return { inBuilding, old };
}

/**
 * What the agent sees, all scaled to about 0 … 1: for each belt its fill,
 * the share of it queuing and whether it is broken; each robot bypass
 * (active, pickup fill); the inbound piles; the current shares; whether a
 * surge is on and the order rate; which docks are blocked.
 */
export function observe(world: World): Float32Array {
  const out: number[] = [];
  for (const c of world.conveyors) {
    const cap = conveyorCapacity(c);
    let blocked = 0;
    for (const p of c.packets) if (p.blocked) blocked++;
    out.push(c.packets.length / cap, blocked / cap, c.status === 'ok' ? 0 : 1);
  }
  for (const lane of world.lanes) out.push(lane.active ? 1 : 0, lane.pickup.length / lane.capacity);
  for (const inbound of world.inbounds) out.push(Math.min(1, inbound.backlog.length / 200));
  for (const s of world.routing.share) out.push(s);
  out.push(world.currentArrivalRate > world.baseRate + 1e-9 ? 1 : 0, world.currentArrivalRate / 10);
  for (const d of world.docks) out.push(d.blockedUntil > world.time ? 1 : 0);
  return Float32Array.from(out);
}

/** Evaluates any agent (a function of the observation) on one scenario, like `evaluate` does for the built-in policies. */
export function evaluateAgent(
  seed: number,
  scenario: ScenarioName,
  agent: (observation: Float32Array) => ArrayLike<number>,
  seconds?: number,
): EvalResult {
  const env = new RoutingEnv();
  let obs = env.reset(seed, scenario, seconds);
  for (;;) {
    const r = env.step(agent(obs));
    obs = r.observation;
    if (r.done) break;
  }
  return env.result();
}

export type { ScenarioName };
