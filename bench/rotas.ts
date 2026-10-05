/**
 * Routing policies compared seed by seed on the four evaluation scenarios.
 *
 *   npm run bench:rotas                     static × heuristic, validation seeds
 *   npm run bench:rotas -- --rl rodada1     also the trained agent (ai/models/rodada1.onnx)
 *                                           against the heuristic, with the success criterion;
 *                                           several agents at once: --rl a,b (one pass over the seeds)
 *   npm run bench:rotas -- --teacher        also the heuristic in the agent's five levels
 *                                           (what the imitation start teaches)
 *   npm run bench:rotas -- --calibrate      heuristic parameter grid, validation seeds
 *   npm run bench:rotas -- --set test --final   the test seeds (used once, at the end)
 *
 * Every (seed, scenario, policy) runs in a separate Node process from a pool
 * as large as the machine allows; results are paired by seed. The jobs run
 * the headless build (scripts/build-headless.mjs), rebuilt here first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { criterion } from '../src/ai/criterion';
import { SCENARIOS, SCENARIO_LABEL, type EvalResult, type ScenarioName } from '../src/ai/evaluate';
import { seedsOf, type SeedSet } from '../src/ai/seeds';
import { paired } from '../src/ai/stats';
import { DEFAULT_HEURISTIC, type HeuristicParams, type RoutingPolicy } from '../src/sim/policy';

interface Job {
  seed: number;
  scenario: ScenarioName;
  policy: RoutingPolicy;
  heuristic?: Partial<HeuristicParams>;
  /** Trained agent (ai/models/<agent>.onnx) instead of a built-in policy. */
  agent?: string;
  tag: string;
}
type Result = EvalResult & { tag: string };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const set = (value('--set') ?? 'validation') as SeedSet;
if (set === 'test' && !flag('--final')) {
  console.error('As seeds de teste são usadas uma única vez, no resultado final: use --final.');
  process.exit(2);
}
const seeds = seedsOf(set);
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

async function runAll(jobs: Job[]): Promise<Result[]> {
  const procs = Math.max(1, Math.min(jobs.length, availableParallelism() - 2));
  const batches: Job[][] = Array.from({ length: procs }, () => []);
  jobs.forEach((j, i) => (batches[i % procs] as Job[]).push(j));
  const out: Result[] = [];
  await Promise.all(
    batches.map(
      (batch) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['build/headless/bench/rotas-job.js', JSON.stringify(batch)],
            { stdio: ['ignore', 'pipe', 'inherit'] },
          );
          let buf = '';
          child.stdout.on('data', (d: Buffer) => {
            buf += d.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              out.push(JSON.parse(buf.slice(0, nl)) as Result);
              buf = buf.slice(nl + 1);
            }
          });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`job ${code}`))));
        }),
    ),
  );
  return out;
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const sec = (x: number) => `${x.toFixed(1)} s`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Results of one tag and scenario, ordered like the seeds (for pairing). */
function pick(results: Result[], tag: string, scenario: ScenarioName): Result[] {
  return seeds.map((s) => {
    const r = results.find((x) => x.tag === tag && x.scenario === scenario && x.seed === s);
    if (!r) throw new Error(`missing ${tag} ${scenario} ${s}`);
    return r;
  });
}

function compare(results: Result[], base: string, cand: string) {
  return SCENARIOS.map((scenario) => {
    const b = pick(results, base, scenario);
    const c = pick(results, cand, scenario);
    const col = (rs: Result[], k: keyof EvalResult) => rs.map((r) => r[k] as number);
    return {
      scenario,
      p95: paired(col(b, 'cycleP95'), col(c, 'cycleP95'), true),
      p99: paired(col(b, 'cycleP99'), col(c, 'cycleP99'), true),
      oldest: paired(col(b, 'oldestMax'), col(c, 'oldestMax'), true),
      throughput: paired(col(b, 'throughputPerMin'), col(c, 'throughputPerMin'), false),
      base: {
        p95: mean(col(b, 'cycleP95')),
        oldest: mean(col(b, 'oldestMax')),
        tp: mean(col(b, 'throughputPerMin')),
      },
      cand: {
        p95: mean(col(c, 'cycleP95')),
        oldest: mean(col(c, 'oldestMax')),
        tp: mean(col(c, 'throughputPerMin')),
      },
    };
  });
}

const t0 = performance.now();
if (flag('--calibrate')) {
  const grid: HeuristicParams[] = [];
  for (const delayWeight of [0.5, 1, 2])
    for (const temperature of [0.25, 0.5, 1])
      for (const smoothing of [0.3]) grid.push({ delayWeight, temperature, smoothing });
  const jobs: Job[] = [];
  for (const seed of seeds)
    for (const scenario of SCENARIOS) {
      jobs.push({ seed, scenario, policy: 'static', tag: 'static' });
      grid.forEach((h, i) =>
        jobs.push({ seed, scenario, policy: 'heuristic', heuristic: h, tag: `h${i}` }),
      );
    }
  const results = await runAll(jobs);
  const rows = grid.map((h, i) => {
    const cmp = compare(results, 'static', `h${i}`);
    const score = mean(cmp.map((c) => c.p95.mean));
    const worst = Math.min(...cmp.map((c) => c.p95.mean));
    const oldest = Math.min(...cmp.map((c) => c.oldest.mean));
    return { h, score, worst, oldest, cmp };
  });
  rows.sort((a, b) => b.score - a.score);
  console.log(
    `Calibração nas seeds de ${set} (${seeds.join(', ')}), ganho no p95 sobre a estática:\n`,
  );
  console.log(
    '| peso da fila | escala (s) | ganho médio no p95 | pior cenário | pior ganho na idade máxima |',
  );
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.h.delayWeight} | ${r.h.temperature} | ${pct(r.score)} | ${pct(r.worst)} | ${pct(r.oldest)} |`,
    );
  }
  const out = value('--out');
  if (out) writeFileSync(out, JSON.stringify({ set, seeds, rows, results }, null, 1));
} else {
  const agents = (value('--rl') ?? '').split(',').filter(Boolean);
  const jobs: Job[] = [];
  for (const seed of seeds)
    for (const scenario of SCENARIOS) {
      for (const policy of ['static', 'heuristic'] as const)
        jobs.push({ seed, scenario, policy, heuristic: DEFAULT_HEURISTIC, tag: policy });
      for (const agent of agents) {
        jobs.push({ seed, scenario, policy: 'external', agent, tag: `rl:${agent}` });
      }
      if (flag('--teacher')) {
        jobs.push({ seed, scenario, policy: 'external', agent: '@teacher', tag: 'teacher' });
      }
    }
  const results = await runAll(jobs);
  const table = (title: string, base: string, cand: string, names: [string, string]) => {
    const cmp = compare(results, base, cand);
    console.log(`${title}, seeds de ${set} (${seeds.join(', ')}).\n`);
    console.log(
      `| Cenário | p95 do ciclo (${names[0]} → ${names[1]}) | ganho no p95 (IC 95%) | seeds melhores | ganho no p99 | idade máxima (${names[0]} → ${names[1]}) | vazão |`,
    );
    console.log('|---|---|---|---|---|---|---|');
    for (const c of cmp) {
      console.log(
        `| ${SCENARIO_LABEL[c.scenario]} | ${sec(c.base.p95)} → ${sec(c.cand.p95)} | ${pct(c.p95.mean)} (${pct(c.p95.low)} a ${pct(c.p95.high)}) | ${c.p95.wins} de ${c.p95.n} | ${pct(c.p99.mean)} | ${sec(c.base.oldest)} → ${sec(c.cand.oldest)} | ${pct(c.throughput.mean)} |`,
      );
    }
    console.log('');
    return cmp;
  };
  console.log(`Parâmetros da heurística: ${JSON.stringify(DEFAULT_HEURISTIC)}\n`);
  const cmp = table('Heurística contra o roteamento estático', 'static', 'heuristic', [
    'estática',
    'heurística',
  ]);
  if (flag('--teacher')) {
    table(
      'Heurística em cinco níveis (o professor da imitação) contra a heurística',
      'heuristic',
      'teacher',
      ['heurística', 'em níveis'],
    );
  }
  const rl: Record<
    string,
    { cmp: ReturnType<typeof compare>; check: ReturnType<typeof criterion> }
  > = {};
  for (const agent of agents) {
    const tag = `rl:${agent}`;
    const vsHeuristic = table(`Agente ${agent} contra a heurística`, 'heuristic', tag, [
      'heurística',
      'agente',
    ]);
    table(`Agente ${agent} contra o roteamento estático`, 'static', tag, ['estática', 'agente']);
    const pairs = seeds.flatMap((seed) =>
      SCENARIOS.map((scenario) => {
        const find = (t: string) =>
          results.find((r) => r.tag === t && r.seed === seed && r.scenario === scenario) as Result;
        return { scenario, base: find('heuristic'), cand: find(tag) };
      }),
    );
    const check = criterion(pairs);
    console.log(
      `Critério de sucesso do agente ${agent} (contra a heurística): ${check.ok ? 'CUMPRIDO' : 'NÃO cumprido'}`,
    );
    for (const c of check.checks) console.log(`  ${c.ok ? 'ok ' : 'NÃO'}  ${c.label}: ${c.detail}`);
    console.log('');
    rl[agent] = { cmp: vsHeuristic, check };
  }
  const out = value('--out');
  if (out) writeFileSync(out, JSON.stringify({ set, seeds, cmp, rl, results }, null, 1));
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
