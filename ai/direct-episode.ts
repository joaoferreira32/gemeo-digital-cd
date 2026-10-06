/**
 * Runs an episode straight on the engine (no server) with the actions given,
 * and prints its measures and fingerprint. The Python fidelity test compares
 * this with the same episode driven through ai/env-server.ts.
 *
 *   node --import tsx ai/direct-episode.ts '{"seed":10001,"scenario":"caos","seconds":60,"actions":[[0,1,2,3,4], …]}'
 */
import { RoutingEnv } from '../src/ai/env';
import type { ScenarioName } from '../src/ai/evaluate';
import { fingerprint } from '../src/sim/fingerprint';

const { seed, scenario, seconds, actions } = JSON.parse(process.argv[2] ?? '{}') as {
  seed: number;
  scenario: ScenarioName;
  seconds: number;
  actions: number[][];
};
const env = new RoutingEnv();
env.reset(seed, scenario, seconds);
let rewards = 0;
for (const levels of actions) {
  const r = env.step(levels);
  rewards += Math.fround(r.reward);
  if (r.done) break;
}
process.stdout.write(
  JSON.stringify({ ...env.result(), fingerprint: fingerprint(env.world), rewards }),
);
