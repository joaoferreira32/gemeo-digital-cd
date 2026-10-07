/**
 * One process of `bench/gargalo-caos.ts`: one seed under the automatic
 * failures, every explanation of the bottleneck detector judged against
 * counterfactual runs (src/ai/bottleneck-caos.ts); prints it as one JSON line.
 */
import type { BottleneckParams } from '../src/ai/bottleneck';
import { runCaos } from '../src/ai/bottleneck-caos';

const { seed, seconds, variants, countsOnly } = JSON.parse(process.argv[2] ?? '{}') as {
  seed: number;
  seconds: number;
  variants: Partial<BottleneckParams>[];
  countsOnly: boolean;
};
process.stdout.write(`${JSON.stringify(runCaos(seed, seconds, variants, countsOnly))}\n`);
