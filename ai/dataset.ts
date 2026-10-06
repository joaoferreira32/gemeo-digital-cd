/**
 * Demonstrations of the heuristic for the imitation start of the learning
 * agent (tuning round 2): episodes of the training seeds driven by the
 * heuristic teacher, in the agent's terms. One process writes one shard:
 *
 *   node build/headless/ai/dataset.js '{"from":10001,"episodes":20,"seed":1,"out":"ai/runs/bc/0"}'
 *
 * <out>.obs: f32[steps × observation], <out>.act: u8[steps × decisions],
 * <out>.rew: f32[steps], <out>.done: u8[steps] (1 on the last step of an
 * episode). Scenarios are drawn from `seed`; seeds go from `from` upward.
 */
import { writeFileSync } from 'node:fs';
import { RoutingEnv } from '../src/ai/env';
import { SCENARIOS } from '../src/ai/evaluate';
import { TRAINING_SEEDS } from '../src/ai/seeds';
import { HeuristicTeacher } from '../src/ai/teacher';
import { Rng } from '../src/sim/rng';

const { from, episodes, seed, out } = JSON.parse(process.argv[2] ?? '{}') as {
  from: number;
  episodes: number;
  seed: number;
  out: string;
};
if (from < TRAINING_SEEDS.from || from + episodes - 1 > TRAINING_SEEDS.to) {
  throw new Error('demonstrations come from the training seeds only');
}
const rng = new Rng(seed);
const env = new RoutingEnv();
const obs: number[] = [];
const act: number[] = [];
const rew: number[] = [];
const done: number[] = [];
for (let e = 0; e < episodes; e++) {
  const scenario = SCENARIOS[rng.int(SCENARIOS.length)] as (typeof SCENARIOS)[number];
  let o = env.reset(from + e, scenario);
  const teacher = new HeuristicTeacher(env.world);
  for (;;) {
    const levels = teacher.levels(env.world);
    obs.push(...o);
    act.push(...levels);
    const r = env.step(levels);
    rew.push(r.reward);
    done.push(r.done ? 1 : 0);
    o = r.observation;
    if (r.done) break;
  }
}
writeFileSync(`${out}.obs`, Float32Array.from(obs));
writeFileSync(`${out}.act`, Uint8Array.from(act));
writeFileSync(`${out}.rew`, Float32Array.from(rew));
writeFileSync(`${out}.done`, Uint8Array.from(done));
