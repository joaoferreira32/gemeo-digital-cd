/**
 * Maintenance schedule (phase 4b) on the automatic failures, against the
 * simulation's own truth, seed by seed with and without the schedule. The
 * motor signals are simulated (src/sim/health.ts).
 *
 *   npm run bench:agenda -- --calibrate             validation seeds: lead time of the alarms
 *                                                   without the schedule, then the window at
 *                                                   its p10 and at its p20, and the choice
 *   npm run bench:agenda                            validation seeds: without × with the schedule
 *                                                   (maintenance of 30 s, then 45 s and 60 s)
 *   npm run bench:agenda -- --set teste-4b --final  the test seeds of phase 4b (used once)
 *
 * The window is a low percentile of the lead time (from the alarm to the
 * breakdown), never the median: waiting longer than the time a belt has
 * left is waiting for the breakdown. The choice between p10 and p20 was
 * fixed before measuring (docs/resultados.md): fewer breakdowns while the
 * maintenance waited; on a tie, more failures avoided; then the shorter
 * window. Each run is 30 minutes in its own process of the headless build.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  leadTimes,
  scoreSchedule,
  type ScheduleRun,
  type ScheduleRunOptions,
  type ScheduleScore,
} from '../src/ai/schedule-eval';
import { isTestSet, seedsOf, type SeedSet } from '../src/ai/seeds';
import { paired, type Paired } from '../src/ai/stats';
import { DEFAULT_SCHEDULE, type ScheduleParams } from '../src/sim/schedule';

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
if (set === 'test') {
  console.error(
    'As seeds 30.001 a 30.010 foram usadas no teste da Fase 4; a 4b usa --set teste-4b.',
  );
  process.exit(2);
}
if (flag('--calibrate') && set !== 'validation') {
  console.error('A calibração usa só as seeds de validação.');
  process.exit(2);
}
const seeds = seedsOf(set);
const seconds = Number(value('--seconds') ?? 1800);
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

type Job = { seed: number; tag: string } & ScheduleRunOptions;
type Tagged = ScheduleRun & { tag: string };

function simulate(job: Job): Promise<Tagged> {
  const { tag, ...rest } = job;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['build/headless/bench/agenda-job.js', JSON.stringify(rest)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0
        ? resolve({ ...(JSON.parse(out) as ScheduleRun), tag })
        : reject(new Error(`job ${code}`)),
    );
  });
}

async function runAll(jobs: Job[]): Promise<Tagged[]> {
  const queue = [...jobs];
  const out: Tagged[] = [];
  const workers = Math.max(1, Math.min(queue.length, availableParallelism() - 2));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let j = queue.shift(); j !== undefined; j = queue.shift()) out.push(await simulate(j));
    }),
  );
  return out;
}

const off = (seed: number): Job => ({ seed, tag: 'sem', seconds, schedule: false });
const on = (seed: number, tag: string, params: Partial<ScheduleParams>): Job => ({
  seed,
  tag,
  seconds,
  schedule: true,
  params,
});
const bySeed = (runs: readonly Tagged[], tag: string) =>
  seeds.map((s) => runs.find((r) => r.seed === s && r.tag === tag) as Tagged);

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');
const sgn = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const ci = (p: Paired) => `${sgn(p.mean)} (${sgn(p.low)} a ${sgn(p.high)}), ${p.wins} de ${p.n}`;
const q = (xs: readonly number[], p: number) =>
  xs.length ? (xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number) : NaN;
const hours = (seeds.length * seconds) / 3600;

/** Pools the score of several runs (sums; the waits are concatenated). */
function pool(runs: readonly ScheduleRun[]): ScheduleScore {
  const scores = runs.map(scoreSchedule);
  const sum = (f: (s: ScheduleScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  return {
    wears: sum((s) => s.wears),
    avoided: sum((s) => s.avoided),
    breakdowns: sum((s) => s.breakdowns),
    wornBreakdowns: sum((s) => s.wornBreakdowns),
    lostWhileWaiting: sum((s) => s.lostWhileWaiting),
    unneeded: sum((s) => s.unneeded),
    waits: scores.flatMap((s) => s.waits).sort((a, b) => a - b),
  };
}

/** What the schedule did, and the paired comparison against the runs without it. */
function report(label: string, without: readonly Tagged[], withIt: readonly Tagged[]) {
  const s = pool(withIt);
  const total = s.avoided + s.breakdowns;
  const stopped = (r: ScheduleRun) => r.brokenSeconds + r.serviceSeconds;
  const stuck = (r: ScheduleRun) => r.stuckBroken + r.stuckService;
  const stuckSeconds = (r: ScheduleRun) => r.stuckSecondsBroken + r.stuckSecondsService;
  const rows = {
    p95: paired(
      without.map((r) => r.cycleP95),
      withIt.map((r) => r.cycleP95),
      true,
    ),
    mean: paired(
      without.map((r) => r.cycleMean),
      withIt.map((r) => r.cycleMean),
      true,
    ),
    delivered: paired(
      without.map((r) => r.delivered),
      withIt.map((r) => r.delivered),
      false,
    ),
    stopped: paired(without.map(stopped), withIt.map(stopped), true),
    stuck: paired(without.map(stuck), withIt.map(stuck), true),
    stuckSeconds: paired(without.map(stuckSeconds), withIt.map(stuckSeconds), true),
  };
  const starts = withIt.flatMap((r) => r.starts);
  const kind = (drainable: boolean) => {
    const xs = starts.filter((x) => x.drainable === drainable);
    const waits = xs.map((x) => x.wait).sort((a, b) => a - b);
    const empty = xs.filter((x) => x.stuck === 0).length;
    return `${xs.length} paradas, espera mediana ${q(waits, 0.5).toFixed(0)} s, ${pct(empty / xs.length)} vazias`;
  };
  console.log(`\n### ${label}\n`);
  console.log(`| O que | Resultado |`);
  console.log(`|---|---|`);
  console.log(
    `| Quebras evitadas, entre as que tinham desgaste | ${pct(s.avoided / s.wears)} (${s.avoided} de ${s.wears}) |`,
  );
  console.log(
    `| Quebras evitadas, entre todas as de esteira | ${pct(s.avoided / total)} (${s.avoided} de ${total}; ${s.breakdowns - s.wornBreakdowns} súbitas) |`,
  );
  console.log(`| Quebras enquanto a manutenção esperava | ${s.lostWhileWaiting} |`);
  console.log(
    `| Manutenções sem desgaste (alarme falso) | ${s.unneeded} (${(s.unneeded / hours).toFixed(1)} por hora no CD) |`,
  );
  console.log(
    `| Espera do alarme ao início | mediana ${q(s.waits, 0.5).toFixed(0)} s, p90 ${q(s.waits, 0.9).toFixed(0)} s |`,
  );
  console.log(`| p95 do ciclo, ganho com a agenda (IC 95%, seeds melhores) | ${ci(rows.p95)} |`);
  console.log(`| Ciclo médio, ganho | ${ci(rows.mean)} |`);
  console.log(`| Entregas, ganho | ${ci(rows.delivered)} |`);
  console.log(
    `| Tempo de esteira parada, redução | ${ci(rows.stopped)} (${sum(without, stopped).toFixed(0)} → ${sum(withIt, stopped).toFixed(0)} esteira·s) |`,
  );
  console.log(
    `| Pacotes presos em esteira parada, redução | ${ci(rows.stuck)} (${sum(without, stuck)} → ${sum(withIt, stuck)}) |`,
  );
  console.log(
    `| Pacote·segundo em esteira parada, redução | ${ci(rows.stuckSeconds)} (${sum(without, stuckSeconds).toFixed(0)} → ${sum(withIt, stuckSeconds).toFixed(0)}) |`,
  );
  const load = (runs: readonly ScheduleRun[]) => {
    const k = (f: keyof ScheduleRun['injected']) => sum(runs, (r) => r.injected[f]);
    return `${k('wear')} desgastes, ${k('conveyor')} quebras de esteira, ${k('surge')} picos, ${k('robot')} robôs, ${k('dock')} docas`;
  };
  console.log(`| Falhas que o modo automático aplicou, sem a agenda | ${load(without)} |`);
  console.log(`| Falhas que o modo automático aplicou, com a agenda | ${load(withIt)} |`);
  console.log(`| Esteiras que a rota consegue esvaziar | ${kind(true)} |`);
  console.log(`| Esteiras sem outro caminho para o fluxo | ${kind(false)} |`);
  return { label, score: s, rows };
}

function sum(runs: readonly ScheduleRun[], f: (r: ScheduleRun) => number): number {
  return runs.reduce((a, r) => a + f(r), 0);
}

const t0 = performance.now();
console.log(
  `Agenda de manutenção (sinais simulados): ${seeds.length} seeds de ${set} (${seeds.join(', ')}), ${seconds / 60} min de falhas automáticas cada, roteamento pela heurística.`,
);
const output: Record<string, unknown> = { set, seeds, seconds };

if (flag('--calibrate')) {
  const without = await runAll(seeds.map(off));
  const leads = without.flatMap(leadTimes).sort((a, b) => a - b);
  const p10 = q(leads, 0.1);
  const p20 = q(leads, 0.2);
  console.log(
    `\nAntecedência dos alarmes sem a agenda (${leads.length} quebras com desgaste detectadas): p10 ${p10.toFixed(1)} s, p20 ${p20.toFixed(1)} s.`,
  );
  const windows = [
    { name: 'p10', window: Math.max(1, Math.floor(p10)) },
    { name: 'p20', window: Math.max(1, Math.floor(p20)) },
  ];
  const runs = await runAll(
    windows.flatMap(({ name, window }) => seeds.map((s) => on(s, name, { window }))),
  );
  const results = windows.map(({ name, window }) => ({
    name,
    window,
    ...report(
      `Prazo no ${name} da antecedência: ${window} s`,
      bySeed(without, 'sem'),
      bySeed(runs, name),
    ),
  }));
  // The rule fixed before measuring.
  const [a, b] = results as [(typeof results)[0], (typeof results)[0]];
  const pick =
    a.score.lostWhileWaiting !== b.score.lostWhileWaiting
      ? a.score.lostWhileWaiting < b.score.lostWhileWaiting
        ? a
        : b
      : a.score.avoided !== b.score.avoided
        ? a.score.avoided > b.score.avoided
          ? a
          : b
        : a.window <= b.window
          ? a
          : b;
  console.log(`\nEscolha (regra fixada antes de medir): ${pick.name}, prazo de ${pick.window} s.`);
  Object.assign(output, {
    leads,
    p10,
    p20,
    results,
    pick: { name: pick.name, window: pick.window },
  });
} else {
  const durations = (value('--duracoes') ?? '30,45,60').split(',').map(Number);
  const window = DEFAULT_SCHEDULE.window;
  const runs = await runAll([
    ...seeds.map(off),
    ...durations.flatMap((d) => seeds.map((s) => on(s, `m${d}`, { duration: d }))),
  ]);
  const without = bySeed(runs, 'sem');
  const leads = without.flatMap(leadTimes).sort((a, b) => a - b);
  console.log(
    `\nPrazo da agenda: ${window} s. Antecedência dos alarmes sem a agenda nestas seeds: p10 ${q(leads, 0.1).toFixed(1)} s, p20 ${q(leads, 0.2).toFixed(1)} s (${leads.length} quebras com desgaste detectadas).`,
  );
  const results = durations.map((d) =>
    report(`Manutenção planejada de ${d} s`, without, bySeed(runs, `m${d}`)),
  );
  Object.assign(output, { window, leads, results });
}
const out = value('--out');
if (out) writeFileSync(out, JSON.stringify(output, null, 1));
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
