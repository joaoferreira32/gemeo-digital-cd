/**
 * One process of `bench/gargalo.ts`: one controlled trial (or the reference
 * run of a seed), with the bottleneck detector run over it once per parameter
 * set; prints the result (src/ai/bottleneck-eval.ts) as one JSON line.
 */
import type { BottleneckParams } from '../src/ai/bottleneck';
import { runTrial, type TrialSpec } from '../src/ai/bottleneck-eval';

const { spec, params } = JSON.parse(process.argv[2] ?? '{}') as {
  spec: TrialSpec;
  params: Partial<BottleneckParams>[];
};
process.stdout.write(`${JSON.stringify(runTrial(spec, params))}\n`);
