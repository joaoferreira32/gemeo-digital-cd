/**
 * One process of `bench/rotas.ts`: reads a list of evaluation jobs (JSON on
 * the command line) and prints one JSON result per line.
 */
import { evaluate, type ScenarioName } from '../src/ai/evaluate';
import type { HeuristicParams, RoutingPolicy } from '../src/sim/policy';

interface Job {
  seed: number;
  scenario: ScenarioName;
  policy: RoutingPolicy;
  heuristic?: Partial<HeuristicParams>;
  tag?: string;
}

const jobs = JSON.parse(process.argv[2] ?? '[]') as Job[];
for (const job of jobs) {
  const r = evaluate(
    job.seed,
    job.scenario,
    job.policy,
    job.heuristic ? { heuristic: job.heuristic } : {},
  );
  process.stdout.write(`${JSON.stringify({ ...r, tag: job.tag ?? '' })}\n`);
}
