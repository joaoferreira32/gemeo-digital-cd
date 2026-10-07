/**
 * The scenario lab from the command line (the same runs as the panel on key
 * B, one process each): scenario A against scenario B on the lab seeds,
 * means with 95% intervals and the paired difference.
 *
 *   npm run bench:lab                         constant × Olist demand, same mean rate, 10 seeds
 *   npm run bench:lab -- --seeds 20
 *   npm run bench:lab -- --b '{"robots":20}'  B = A with these changes
 *   npm run bench:lab -- --out lab.json
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  DEFAULT_SCENARIO,
  LAB_FIRST_SEED,
  LAB_SECONDS,
  type LabMetrics,
  type LabScenario,
} from '../src/lab/run';
import { estimate, pairedDifference } from '../src/lab/stats';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const n = Number(value('--seeds') ?? 10);
const A: LabScenario = { ...DEFAULT_SCENARIO, ...JSON.parse(value('--a') ?? '{}') };
const B: LabScenario = {
  ...A,
  ...JSON.parse(value('--b') ?? JSON.stringify({ demand: 'olist' })),
};
const weights = (
  JSON.parse(readFileSync('public/demanda-olist.json', 'utf-8')) as { weights: number[] }
).weights;
const seeds = Array.from({ length: n }, (_, i) => LAB_FIRST_SEED + i);
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

function simulate(scenario: LabScenario, seed: number): Promise<LabMetrics> {
  return new Promise((resolve, reject) => {
    const job = {
      scenario,
      seed,
      seconds: LAB_SECONDS,
      ...(scenario.demand === 'olist' ? { weights, startHour: 0 } : {}),
    };
    const child = spawn(
      process.execPath,
      ['build/headless/bench/lab-job.js', JSON.stringify(job)],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0
        ? resolve((JSON.parse(out) as { metrics: LabMetrics }).metrics)
        : reject(new Error(`job ${code}`)),
    );
  });
}

const t0 = performance.now();
const jobs = seeds.flatMap((seed) => [
  { side: 'A' as const, seed },
  { side: 'B' as const, seed },
]);
const results: Record<'A' | 'B', LabMetrics[]> = { A: [], B: [] };
const queue = jobs.map((j, i) => ({ ...j, i }));
const workers = Math.max(1, Math.min(queue.length, availableParallelism() - 2));
const done = new Map<number, LabMetrics>();
await Promise.all(
  Array.from({ length: workers }, async () => {
    for (let j = queue.shift(); j !== undefined; j = queue.shift()) {
      done.set(j.i, await simulate(j.side === 'A' ? A : B, j.seed));
    }
  }),
);
jobs.forEach((j, i) => results[j.side].push(done.get(i) as LabMetrics));

const show = (s: LabScenario) =>
  `${s.robots} robôs, ${s.conveyorSpeed} m/s, ${s.brokenConveyor >= 0 ? `esteira ${s.brokenConveyor + 1} parada` : 'nenhuma esteira parada'}, ` +
  `${s.arrivalRate} pedidos/s em média, demanda ${s.demand === 'olist' ? 'da Olist (segunda-feira)' : 'constante'}, ` +
  `${s.policy}, ${s.autoFailures ? 'com' : 'sem'} falhas automáticas, ${s.maintenance ? 'com' : 'sem'} agenda de manutenção`;
console.log(
  `Laboratório: ${n} seeds a partir de ${LAB_FIRST_SEED}, um dia simulado cada (${LAB_SECONDS} s).`,
);
console.log(`A: ${show(A)}\nB: ${show(B)}\n`);
const fmt = (v: number, d = 1) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}`;
console.log('| Medida | A (IC 95%) | B (IC 95%) | B − A (IC 95%) | seeds B menor / maior |');
console.log('|---|---|---|---|---|');
const rows: Record<string, unknown>[] = [];
for (const [key, label, scale] of [
  ['cycleMean', 'Tempo de ciclo médio (s)', 1],
  ['cycleP95', 'p95 do ciclo (s)', 1],
  ['throughput', 'Vazão (pacotes/min)', 1],
  ['beltUse', 'Uso das esteiras (%)', 100],
  ['dockUse', 'Uso das docas (%)', 100],
  ['robotUse', 'Uso dos robôs (%)', 100],
] as const) {
  const a = results.A.map((m) => m[key] * scale);
  const b = results.B.map((m) => m[key] * scale);
  const ea = estimate(a);
  const eb = estimate(b);
  const d = pairedDifference(a, b);
  console.log(
    `| ${label} | ${fmt(ea.mean)} (${fmt(ea.low)} a ${fmt(ea.high)}) | ${fmt(eb.mean)} (${fmt(eb.low)} a ${fmt(eb.high)}) | ${sign(d.mean)} (${sign(d.low)} a ${sign(d.high)}) | ${d.lower} / ${d.higher} de ${d.n} |`,
  );
  rows.push({ key, label, a: ea, b: eb, difference: d });
}
const out = value('--out');
if (out) writeFileSync(out, JSON.stringify({ seeds, A, B, rows, results }, null, 1));
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s com ${workers} processos`);
