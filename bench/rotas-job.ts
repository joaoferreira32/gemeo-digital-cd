/**
 * One process of `bench/rotas.ts`: reads a list of evaluation jobs (JSON on
 * the command line) and prints one JSON result per line. A job with an
 * `agent` runs the trained network (ai/models/<agent>.onnx) through
 * onnxruntime-web, as the app does; the others run a built-in policy.
 */
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { createAgent, type Agent, type AgentInfo } from '../src/ai/agent';
import { evaluateAgentAsync } from '../src/ai/env';
import { evaluate, type ScenarioName } from '../src/ai/evaluate';
import type { HeuristicParams, RoutingPolicy } from '../src/sim/policy';

interface Job {
  seed: number;
  scenario: ScenarioName;
  policy: RoutingPolicy;
  heuristic?: Partial<HeuristicParams>;
  agent?: string;
  tag?: string;
}

ort.env.wasm.numThreads = 1;
const agents = new Map<string, Agent>();
async function agentOf(name: string): Promise<Agent> {
  let a = agents.get(name);
  if (!a) {
    const info = JSON.parse(readFileSync(`ai/models/${name}.json`, 'utf8')) as AgentInfo;
    a = await createAgent(ort, readFileSync(`ai/models/${name}.onnx`), info);
    agents.set(name, a);
  }
  return a;
}

const jobs = JSON.parse(process.argv[2] ?? '[]') as Job[];
for (const job of jobs) {
  const r = job.agent
    ? await evaluateAgentAsync(job.seed, job.scenario, await agentOf(job.agent))
    : evaluate(
        job.seed,
        job.scenario,
        job.policy,
        job.heuristic ? { heuristic: job.heuristic } : {},
      );
  process.stdout.write(`${JSON.stringify({ ...r, tag: job.tag ?? '' })}\n`);
}
