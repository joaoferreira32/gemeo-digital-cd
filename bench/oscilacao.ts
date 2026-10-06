/**
 * How much each routing policy moves the split at the five routing choices,
 * per simulated minute, on the validation seeds (after the warm-up):
 *
 *   npm run bench:oscilacao -- --rl rodada2-imitacao,rodada2
 *   npm run bench:oscilacao -- --variante '{"smoothing":0.15}'   (a variant of the heuristic too)
 *
 *  - level changes: the share rounded to the agent's five levels changed
 *    (the continuous heuristic is rounded the same way, so the count is fair);
 *  - reversals: the share moved up after moving down, or the other way (the
 *    oscillation itself);
 *  - variation: the sum of |change of share| (in units of the whole flow).
 * All three are summed over the five choices. Policies: the heuristic
 * (continuous), the heuristic in levels (the imitation's teacher) and each
 * trained network named. Tests the hypothesis that the imitated network beats
 * the heuristic by moving the split less in congestion.
 */
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { SCENARIOS, SCENARIO_LABEL, type ScenarioName } from '../src/ai/evaluate';
import { VALIDATION_SEEDS } from '../src/ai/seeds';
import { tQuantile975 } from '../src/ai/stats';
import { DEFAULT_HEURISTIC, type HeuristicParams } from '../src/sim/policy';

interface Job {
  policy: 'heuristic' | 'teacher' | 'agent';
  agent?: string;
  heuristic?: Partial<HeuristicParams>;
  seed: number;
  scenario: ScenarioName;
  tag: string;
}
interface Row {
  tag: string;
  seed: number;
  scenario: ScenarioName;
  levelChanges: number;
  reversals: number;
  variation: number;
}

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const agents = (value('--rl') ?? '').split(',').filter(Boolean);
const variantText = value('--variante');
const variant = variantText ? (JSON.parse(variantText) as Partial<HeuristicParams>) : null;
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

const jobs: Job[] = [];
for (const seed of VALIDATION_SEEDS)
  for (const scenario of SCENARIOS) {
    jobs.push({ policy: 'heuristic', seed, scenario, tag: 'heurística' });
    jobs.push({ policy: 'teacher', seed, scenario, tag: 'heurística em níveis' });
    for (const agent of agents) jobs.push({ policy: 'agent', agent, seed, scenario, tag: agent });
    if (variant) {
      const heuristic = { ...DEFAULT_HEURISTIC, ...variant };
      jobs.push({ policy: 'heuristic', heuristic, seed, scenario, tag: 'heurística variante' });
    }
  }
const procs = Math.max(1, Math.min(jobs.length, availableParallelism() - 2));
const batches: Job[][] = Array.from({ length: procs }, () => []);
jobs.forEach((j, i) => (batches[i % procs] as Job[]).push(j));
const rows: Row[] = [];
const t0 = performance.now();
await Promise.all(
  batches.map(
    (batch) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['build/headless/bench/oscilacao-job.js', JSON.stringify(batch)],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            rows.push(JSON.parse(buf.slice(0, nl)) as Row);
            buf = buf.slice(nl + 1);
          }
        });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`job ${code}`))));
      }),
  ),
);

const tags = [
  'heurística',
  'heurística em níveis',
  ...agents,
  ...(variant ? ['heurística variante'] : []),
];
const summary = (xs: number[]) => {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const half = tQuantile975(n - 1) * (sd / Math.sqrt(n));
  return `${m.toFixed(1)} (±${half.toFixed(1)})`;
};
console.log(
  `Movimento da divisão nas 5 escolhas de roteamento, por minuto simulado (soma das 5), seeds de validação (${VALIDATION_SEEDS.join(', ')}); média das 10 seeds (± meia largura do IC 95%).\n`,
);
for (const [key, title] of [
  ['levelChanges', 'Mudanças de nível por minuto'],
  ['reversals', 'Inversões de sentido por minuto'],
  ['variation', 'Variação total da fração por minuto'],
] as const) {
  console.log(`${title}:\n`);
  console.log(`| Cenário | ${tags.join(' | ')} |`);
  console.log(`|---|${tags.map(() => '---').join('|')}|`);
  for (const scenario of SCENARIOS) {
    const cells = tags.map((tag) =>
      summary(rows.filter((r) => r.tag === tag && r.scenario === scenario).map((r) => r[key])),
    );
    console.log(`| ${SCENARIO_LABEL[scenario]} | ${cells.join(' | ')} |`);
  }
  console.log('');
}
const out = value('--out');
if (out) writeFileSync(out, JSON.stringify({ agents, rows }, null, 1));
console.log(`${((performance.now() - t0) / 1000).toFixed(0)} s`);
