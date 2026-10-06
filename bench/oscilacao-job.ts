/**
 * One process of `bench/oscilacao.ts`: runs evaluation episodes with one
 * routing policy and prints, per episode, how much the shares moved after the
 * warm-up (one JSON line each).
 */
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { createAgent, type AgentInfo } from '../src/ai/agent';
import { ACTION_LEVELS, RoutingEnv } from '../src/ai/env';
import { Episode, WARMUP_SECONDS, type ScenarioName } from '../src/ai/evaluate';
import { HeuristicTeacher } from '../src/ai/teacher';
import type { HeuristicParams } from '../src/sim/policy';

interface Job {
  /** heuristic: continuous shares; teacher: the heuristic in levels; agent: a trained network. */
  policy: 'heuristic' | 'teacher' | 'agent';
  agent?: string;
  /** Parameters of the heuristic other than the calibrated ones (analysis). */
  heuristic?: Partial<HeuristicParams>;
  seed: number;
  scenario: ScenarioName;
  tag: string;
}

/** Changes of level, reversals of direction and total variation of the shares, after the warm-up. */
function movement(series: number[][]) {
  let levelChanges = 0;
  let reversals = 0;
  let variation = 0;
  const choices = series[0]?.length ?? 0;
  const lastDirection = new Array<number>(choices).fill(0);
  const level = (s: number) => Math.round(s * (ACTION_LEVELS - 1));
  for (let t = WARMUP_SECONDS + 1; t < series.length; t++) {
    const prev = series[t - 1] as number[];
    const now = series[t] as number[];
    for (let d = 0; d < choices; d++) {
      const delta = (now[d] as number) - (prev[d] as number);
      variation += Math.abs(delta);
      if (level(now[d] as number) !== level(prev[d] as number)) levelChanges++;
      if (Math.abs(delta) > 1e-9) {
        const direction = Math.sign(delta);
        if (lastDirection[d] && direction !== lastDirection[d]) reversals++;
        lastDirection[d] = direction;
      }
    }
  }
  const minutes = (series.length - WARMUP_SECONDS - 1) / 60;
  return {
    levelChanges: levelChanges / minutes,
    reversals: reversals / minutes,
    variation: variation / minutes,
  };
}

ort.env.wasm.numThreads = 1;
const agents = new Map<string, Awaited<ReturnType<typeof createAgent>>>();
const jobs = JSON.parse(process.argv[2] ?? '[]') as Job[];
for (const job of jobs) {
  // The shares in effect during each second of the episode.
  const series: number[][] = [];
  if (job.policy === 'heuristic') {
    const episode = new Episode(
      job.seed,
      job.scenario,
      'heuristic',
      job.heuristic ? { heuristic: job.heuristic } : {},
    );
    while (!episode.done) {
      episode.run(1);
      series.push(Array.from(episode.world.routing.share));
    }
  } else {
    const env = new RoutingEnv();
    let obs = env.reset(job.seed, job.scenario);
    const teacher = new HeuristicTeacher(env.world);
    let agent = job.agent ? agents.get(job.agent) : undefined;
    if (job.policy === 'agent' && !agent) {
      const name = job.agent as string;
      const info = JSON.parse(readFileSync(`ai/models/${name}.json`, 'utf8')) as AgentInfo;
      agent = await createAgent(ort, readFileSync(`ai/models/${name}.onnx`), info);
      agents.set(name, agent);
    }
    for (;;) {
      const levels =
        job.policy === 'teacher'
          ? teacher.levels(env.world)
          : await (agent as NonNullable<typeof agent>)(obs);
      series.push(levels.map((l) => l / (ACTION_LEVELS - 1)));
      const r = env.step(levels);
      obs = r.observation;
      if (r.done) break;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ tag: job.tag, seed: job.seed, scenario: job.scenario, ...movement(series) })}\n`,
  );
}
