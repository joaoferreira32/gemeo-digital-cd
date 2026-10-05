import { readFileSync, readdirSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import { createAgent, levelsFromLogits, type AgentInfo } from '../src/ai/agent';
import { criterion, type Pair } from '../src/ai/criterion';
import { evaluateAgentAsync } from '../src/ai/env';
import { evaluate, SCENARIOS, type EvalResult, type ScenarioName } from '../src/ai/evaluate';

ort.env.wasm.numThreads = 1;

describe('Routing agent', () => {
  it('takes the best level of each choice from the network scores', () => {
    const logits = [
      [0, 1, 5, 2, 3],
      [9, 1, 1, 1, 1],
      [0, 0, 0, 0, 0.1],
      [-3, -1, -2, -5, -4],
      [1, 1, 1, 1, 1],
    ].flat();
    // Ties keep the first (lowest) level, like argmax in PyTorch.
    expect(levelsFromLogits(logits, 5, 5)).toEqual([2, 0, 4, 1, 0]);
  });

  it('an asynchronous agent that never takes the alternative way measures like the static policy', async () => {
    const r = await evaluateAgentAsync(20_003, 'esteira', async () => [0, 0, 0, 0, 0], 200);
    const s = evaluate(20_003, 'esteira', 'static', { seconds: 200 });
    expect({ ...r, policy: 'static' }).toEqual(s);
  }, 60_000);

  // Every exported network (ai/train.py writes the logits PyTorch gives for
  // eight probe observations): onnxruntime-web, as the app and the benchmark
  // run it, must give the same scores and so the same actions.
  const models = readdirSync('ai/models').filter((f) => f.endsWith('.json'));
  it('there is an exported network to check', () => {
    expect(models.length).toBeGreaterThan(0);
  });
  for (const file of models) {
    it(`${file}: onnxruntime-web gives the scores and actions of PyTorch`, async () => {
      const meta = JSON.parse(readFileSync(`ai/models/${file}`, 'utf8')) as AgentInfo & {
        probe: { observations: number[][]; logits: number[][] };
      };
      const model = readFileSync(`ai/models/${file.replace(/\.json$/, '.onnx')}`);
      const session = await ort.InferenceSession.create(model);
      const agent = await createAgent(ort, model, meta);
      for (let i = 0; i < meta.probe.observations.length; i++) {
        const obs = Float32Array.from(meta.probe.observations[i] as number[]);
        const out = await session.run({ obs: new ort.Tensor('float32', obs, [1, obs.length]) });
        const got = Array.from(out.logits!.data as Float32Array);
        const want = meta.probe.logits[i] as number[];
        const diff = Math.max(...got.map((v, k) => Math.abs(v - (want[k] as number))));
        expect(diff).toBeLessThan(1e-4);
        expect(await agent(obs)).toEqual(levelsFromLogits(want, meta.decisions, meta.levels));
      }
    }, 60_000);
  }
});

describe('Success criterion of the agent', () => {
  const result = (scenario: ScenarioName, seed: number, p95: number, extra = {}): EvalResult => ({
    seed,
    scenario,
    policy: 'heuristic',
    delivered: 1000,
    throughputPerMin: 200,
    cycleMean: p95 / 2,
    cycleP95: p95,
    cycleP99: p95 * 1.2,
    cycleMax: p95 * 1.5,
    oldestMax: p95 * 1.4,
    ...extra,
  });
  /** Ten seeds per scenario; `gain(scenario, seed)` is the candidate's relative p95 gain. */
  const pairs = (gain: (s: ScenarioName, seed: number) => number, extra = {}): Pair[] =>
    SCENARIOS.flatMap((scenario) =>
      Array.from({ length: 10 }, (_, seed) => {
        const base = 100 + seed * 7;
        const g = gain(scenario, seed);
        return {
          scenario,
          base: result(scenario, seed, base),
          cand: result(scenario, seed, base * (1 - g), extra),
        };
      }),
    );

  it('passes an agent clearly better everywhere', () => {
    const r = criterion(pairs((_, seed) => 0.05 + (seed % 3) * 0.01));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails when the mean gain is below 3%, even if it wins every seed', () => {
    const r = criterion(pairs(() => 0.02));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label.startsWith('ganho médio'))?.ok).toBe(false);
  });

  it('fails when one scenario is significantly worse, even with a large mean gain', () => {
    const r = criterion(pairs((s, seed) => (s === 'normal' ? -0.04 - (seed % 2) * 0.01 : 0.12)));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === 'p95 não piora em normal')?.ok).toBe(false);
  });

  it('fails when the worst wait grows (a packet left behind to help the average)', () => {
    const r = criterion(
      SCENARIOS.flatMap((scenario) =>
        Array.from({ length: 10 }, (_, seed) => ({
          scenario,
          base: result(scenario, seed, 100 + seed),
          cand: result(scenario, seed, (100 + seed) * 0.9, { oldestMax: (100 + seed) * 1.4 * 1.2 }),
        })),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label.startsWith('idade máxima'))?.ok).toBe(false);
  });

  it('fails on a throughput loss', () => {
    const r = criterion(pairs(() => 0.06, { throughputPerMin: 190 }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === 'sem perda de vazão')?.ok).toBe(false);
  });
});
