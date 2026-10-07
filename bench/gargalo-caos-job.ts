/**
 * One process of `bench/gargalo-caos.ts`: one seed under the automatic
 * failures, every explanation of the bottleneck detector judged against
 * counterfactual runs (src/ai/bottleneck-caos.ts); prints it as one JSON line.
 */
import { runCaos } from '../src/ai/bottleneck-caos';

const { seed, seconds } = JSON.parse(process.argv[2] ?? '{}') as { seed: number; seconds: number };
process.stdout.write(`${JSON.stringify(runCaos(seed, seconds))}\n`);
