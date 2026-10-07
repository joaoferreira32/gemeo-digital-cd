/**
 * Predictive maintenance: how well the motor alarm (CUSUM) anticipates the
 * conveyor breakdowns of the automatic failures, against the simulation's
 * own truth. The signals are simulated (src/sim/health.ts).
 *
 *   npm run bench:manutencao                       detector as configured, validation seeds
 *   npm run bench:manutencao -- --calibrate        grid of k and h, validation seeds
 *   npm run bench:manutencao -- --set test --final the test seeds (used once, at the end)
 *
 * Each seed is simulated once (30 minutes of automatic failures) in its own
 * process of the headless build; the per-second scores are kept, so the grid
 * replays the CUSUM over them without simulating again. The engine's own
 * alarms must match that replay exactly for the configured parameters.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  pool,
  replayAlarms,
  scoreRun,
  type DetectorScore,
  type MaintenanceRun,
} from '../src/ai/maintenance';
import { isTestSet, seedsOf, type SeedSet } from '../src/ai/seeds';
import { DEFAULT_DETECTOR, type DetectorParams } from '../src/sim/health';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const set = (value('--set') ?? 'validation') as SeedSet;
if (isTestSet(set) && !flag('--final')) {
  console.error('As seeds de teste são usadas uma única vez, no resultado final: use --final.');
  process.exit(2);
}
const seeds = seedsOf(set);
const seconds = Number(value('--seconds') ?? 1800);
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

function simulate(seed: number): Promise<MaintenanceRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['build/headless/bench/manutencao-job.js', JSON.stringify({ seed, seconds })],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0 ? resolve(JSON.parse(out) as MaintenanceRun) : reject(new Error(`job ${code}`)),
    );
  });
}

async function simulateAll(): Promise<MaintenanceRun[]> {
  const out: MaintenanceRun[] = [];
  const queue = [...seeds];
  const workers = Math.max(1, Math.min(queue.length, availableParallelism() - 2));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) out.push(await simulate(s));
    }),
  );
  return out.sort((a, b) => a.seed - b.seed);
}

function evaluate(runs: readonly MaintenanceRun[], p: DetectorParams) {
  const scores = runs.map((r) => scoreRun(r, p));
  return { pooled: pool(scores), scores };
}

const f1 = (s: DetectorScore) =>
  s.precision + s.recall > 0 ? (2 * s.precision * s.recall) / (s.precision + s.recall) : 0;
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(x * 100).toFixed(0)}%`);
const q = (xs: readonly number[], p: number) =>
  xs.length ? (xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number) : NaN;
const line = (s: DetectorScore) =>
  `precisão ${pct(s.precision)} (${s.trueAlarms} de ${s.alarms} alarmes) · recall ${pct(s.recall)} das quebras com desgaste (${s.detected} de ${s.breakdowns}), ${pct(s.recallAll)} de todas (+${s.suddenBreakdowns} súbitas) · antecedência mediana ${q(s.leads, 0.5).toFixed(0)} s (p10 ${q(s.leads, 0.1).toFixed(0)} s) · ${s.falsePerMotorHour.toFixed(2)} alarmes falsos por motor-hora`;

const t0 = performance.now();
const runs = await simulateAll();
console.log(
  `Manutenção preditiva (sinais simulados): ${seeds.length} seeds de ${set} (${seeds.join(', ')}), ${seconds / 60} min de falhas automáticas cada.\n`,
);
if (flag('--calibrate')) {
  const rows: { p: DetectorParams; s: DetectorScore }[] = [];
  for (const allowance of [1, 1.5, 2, 2.5, 3, 3.5, 4])
    for (const threshold of [8, 16, 24, 32, 48, 64, 96, 128])
      rows.push({
        p: { allowance, threshold },
        s: evaluate(runs, { allowance, threshold }).pooled,
      });
  rows.sort((a, b) => f1(b.s) - f1(a.s) || q(b.s.leads, 0.5) - q(a.s.leads, 0.5));
  console.log(
    '| k | h | F1 | precisão | recall (com desgaste) | antecedência mediana | antecedência p10 | alarmes falsos por motor-hora |',
  );
  console.log('|---|---|---|---|---|---|---|---|');
  for (const { p, s } of rows.slice(0, 15)) {
    console.log(
      `| ${p.allowance} | ${p.threshold} | ${f1(s).toFixed(2)} | ${pct(s.precision)} | ${pct(s.recall)} | ${q(s.leads, 0.5).toFixed(0)} s | ${q(s.leads, 0.1).toFixed(0)} s | ${s.falsePerMotorHour.toFixed(2)} |`,
    );
  }
  const out = value('--out');
  if (out) writeFileSync(out, JSON.stringify({ set, seeds, seconds, rows }, null, 1));
} else {
  const { pooled, scores } = evaluate(runs, DEFAULT_DETECTOR);
  // The replay over the scores must give exactly the alarms the engine raised.
  const key = (alarms: readonly { time: number; motor: number }[]) =>
    JSON.stringify(alarms.map((a) => `${a.time}:${a.motor}`).sort());
  const same = runs.every((r) => key(replayAlarms(r, DEFAULT_DETECTOR)) === key(r.alarms));
  console.log(`Detector: k = ${DEFAULT_DETECTOR.allowance}, h = ${DEFAULT_DETECTOR.threshold}`);
  console.log(`Alarmes do motor iguais aos da reavaliação: ${same ? 'sim' : 'NÃO'}\n`);
  console.log(`Todas as seeds: ${line(pooled)}\n`);
  runs.forEach((r, i) => console.log(`seed ${r.seed}: ${line(scores[i] as DetectorScore)}`));
  const out = value('--out');
  if (out) writeFileSync(out, JSON.stringify({ set, seeds, seconds, pooled, scores }, null, 1));
  if (!same) process.exitCode = 1;
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
