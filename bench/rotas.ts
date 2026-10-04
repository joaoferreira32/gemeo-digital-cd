/**
 * Routing policies compared seed by seed on the four evaluation scenarios.
 *
 *   npm run bench:rotas                     static × heuristic, validation seeds
 *   npm run bench:rotas -- --calibrate      heuristic parameter grid, validation seeds
 *   npm run bench:rotas -- --set test --final   the test seeds (used once, at the end)
 *
 * Every (seed, scenario, policy) runs in a separate Node process from a pool
 * as large as the machine allows; results are paired by seed.
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { SCENARIOS, SCENARIO_LABEL, type EvalResult, type ScenarioName } from '../src/ai/evaluate';
import { seedsOf, type SeedSet } from '../src/ai/seeds';
import { paired } from '../src/ai/stats';
import { DEFAULT_HEURISTIC, type HeuristicParams, type RoutingPolicy } from '../src/sim/policy';

interface Job {
  seed: number;
  scenario: ScenarioName;
  policy: RoutingPolicy;
  heuristic?: Partial<HeuristicParams>;
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
            ['--import', 'tsx', 'bench/rotas-job.ts', JSON.stringify(batch)],
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
  const jobs: Job[] = [];
  for (const seed of seeds)
    for (const scenario of SCENARIOS)
      for (const policy of ['static', 'heuristic'] as const)
        jobs.push({ seed, scenario, policy, heuristic: DEFAULT_HEURISTIC, tag: policy });
  const results = await runAll(jobs);
  const cmp = compare(results, 'static', 'heuristic');
  console.log(`Heurística contra o roteamento estático, seeds de ${set} (${seeds.join(', ')}).`);
  console.log(`Parâmetros: ${JSON.stringify(DEFAULT_HEURISTIC)}\n`);
  console.log(
    '| Cenário | p95 do ciclo (estática → heurística) | ganho no p95 (IC 95%) | seeds melhores | ganho no p99 | idade máxima (estática → heurística) | vazão |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const c of cmp) {
    console.log(
      `| ${SCENARIO_LABEL[c.scenario]} | ${sec(c.base.p95)} → ${sec(c.cand.p95)} | ${pct(c.p95.mean)} (${pct(c.p95.low)} a ${pct(c.p95.high)}) | ${c.p95.wins} de ${c.p95.n} | ${pct(c.p99.mean)} | ${sec(c.base.oldest)} → ${sec(c.cand.oldest)} | ${pct(c.throughput.mean)} |`,
    );
  }
  const out = value('--out');
  if (out) writeFileSync(out, JSON.stringify({ set, seeds, cmp, results }, null, 1));
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
