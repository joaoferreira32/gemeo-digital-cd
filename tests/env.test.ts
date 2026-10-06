import { describe, expect, it } from 'vitest';
import { ACTION_LEVELS, RoutingEnv, census, evaluateAgent, observe } from '../src/ai/env';
import { evaluate } from '../src/ai/evaluate';
import { TEST_SEEDS, TRAINING_SEEDS, VALIDATION_SEEDS } from '../src/ai/seeds';
import { fingerprint } from '../src/sim/fingerprint';

describe('Routing environment', () => {
  it('sees a fixed-size view of the building and acts on the five routing choices', () => {
    const env = new RoutingEnv();
    expect(env.decisions).toBe(5);
    const obs = env.reset(10_001, 'normal', 30);
    expect(obs.length).toBe(env.observationSize);
    expect(obs.length).toBe(24 * 3 + 3 * 2 + 2 + 5 + 2 + 6);
    expect(Array.from(obs).every((v) => Number.isFinite(v) && v >= 0 && v <= 1.5)).toBe(true);
    const r = env.step([ACTION_LEVELS - 1, 0, 2, 1, 3]);
    expect(Array.from(env.world.routing.share)).toEqual([1, 0, 0.5, 0.25, 0.75]);
    expect(r.reward).toBeLessThan(0);
    expect(r.done).toBe(false);
    let steps = 1;
    for (;;) {
      steps++;
      if (env.step([0, 0, 0, 0, 0]).done) break;
    }
    expect(steps).toBe(30); // one step per simulated second
  });

  it('is deterministic: the same seed and actions give the same world', () => {
    const run = () => {
      const env = new RoutingEnv();
      env.reset(10_002, 'caos', 120);
      for (let t = 0; t < 120; t++) env.step([t % 5, (t * 3) % 5, 4, (t * 7) % 5, 2]);
      return fingerprint(env.world);
    };
    expect(run()).toBe(run());
  });

  it('an agent that never takes the alternative way measures exactly like the static policy', () => {
    for (const scenario of ['esteira', 'caos'] as const) {
      const agent = evaluateAgent(VALIDATION_SEEDS[0]!, scenario, () => [0, 0, 0, 0, 0], 300);
      const stat = evaluate(VALIDATION_SEEDS[0]!, scenario, 'static', { seconds: 300 });
      expect({ ...agent, policy: 'static' }).toEqual(stat);
    }
  }, 60_000);

  it('the reward counts inbound packets in the building and the old ones', () => {
    const env = new RoutingEnv({ perPacket: 1, perOldPacket: 10 });
    env.reset(10_003, 'pico', 200);
    let last = env.step([0, 0, 0, 0, 0]);
    for (let t = 1; t < 150; t++) last = env.step([0, 0, 0, 0, 0]);
    const { inBuilding, old } = census(env.world);
    expect(last.reward).toBe(-(inBuilding + 10 * old));
    expect(inBuilding).toBeGreaterThan(0);
    expect(observe(env.world)).toEqual(last.observation);
  });

  it('keeps the three seed sets apart', () => {
    const inTraining = (s: number) => s >= TRAINING_SEEDS.from && s <= TRAINING_SEEDS.to;
    expect(VALIDATION_SEEDS.some(inTraining)).toBe(false);
    expect(TEST_SEEDS.some(inTraining)).toBe(false);
    expect(VALIDATION_SEEDS.some((s) => TEST_SEEDS.includes(s))).toBe(false);
    expect(VALIDATION_SEEDS).toHaveLength(10);
    expect(TEST_SEEDS).toHaveLength(10);
  });
});
