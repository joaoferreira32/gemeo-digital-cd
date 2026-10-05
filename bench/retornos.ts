/**
 * Mean episode return (the reward the agent is trained on) of the static
 * routing and of the heuristic, per scenario, on training seeds: the
 * reference lines of the learning curves (scripts/curvas.mjs).
 *
 *   node build/headless/bench/retornos.js 11000 10    (seeds 11000 … 11009, one process)
 */
import { census, DEFAULT_REWARD } from '../src/ai/env';
import { Episode, SCENARIOS } from '../src/ai/evaluate';
import { TRAINING_SEEDS } from '../src/ai/seeds';

const from = Number(process.argv[2] ?? 11_000);
const n = Number(process.argv[3] ?? 10);
if (from < TRAINING_SEEDS.from || from + n - 1 > TRAINING_SEEDS.to) {
  throw new Error('reference returns come from training seeds only');
}
const out: Record<string, Record<string, number>> = {};
for (const policy of ['static', 'heuristic'] as const) {
  for (const scenario of SCENARIOS) {
    let sum = 0;
    for (let seed = from; seed < from + n; seed++) {
      const episode = new Episode(seed, scenario, policy);
      let ret = 0;
      while (!episode.done) {
        episode.run(1);
        const { inBuilding, old } = census(episode.world);
        ret -= DEFAULT_REWARD.perPacket * inBuilding + DEFAULT_REWARD.perOldPacket * old;
      }
      sum += ret;
    }
    (out[policy] ??= {})[scenario] = sum / n;
  }
}
process.stdout.write(`${JSON.stringify({ from, n, returns: out })}\n`);
