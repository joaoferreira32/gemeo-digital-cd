/**
 * Bottleneck detector (phase 4b) in controlled trials: in every seed, a
 * reference run with no failure and one trial per failure, each applied alone
 * at a known moment (every belt, every dock, an order surge, three robots).
 *
 *   npm run bench:gargalo -- --calibrate             validation seeds, a grid of thresholds
 *   npm run bench:gargalo                            validation seeds, the detector as configured
 *   npm run bench:gargalo -- --set teste-4b --final  the test seeds of phase 4b (used once)
 *
 * The truth: a failure "formed a queue" when, against the reference run of
 * its seed (the same run, bit for bit, until the failure), it put at least
 * MIN_EXTRA more packets waiting (10 s mean) while it lasted or in the 30 s
 * after. The detector is right about a trial when it points out a bottleneck
 * in that time, and right about the cause when the cause it explains is the
 * failure the injector actually applied. The reference runs count the
 * bottlenecks pointed out with no failure at all.
 *
 * Choice of the thresholds (fixed before measuring, docs/resultados.md): among
 * the sets with at most one finding per hour in the reference runs, the most
 * queue-forming failures pointed out with the right cause at the first
 * finding; then fewer findings without failure; then a shorter median time to
 * point out; then the current default.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { DEFAULT_BOTTLENECK, type BottleneckParams } from '../src/ai/bottleneck';
import {
  causeMatches,
  extraWaiting,
  type TrialRun,
  type TrialSpec,
} from '../src/ai/bottleneck-eval';
import { isTestSet, seedsOf, type SeedSet } from '../src/ai/seeds';
import type { FailureKind } from '../src/sim/failures';

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
/** Failure at 150 s (the building has filled up), run until 330 s: every failure has ended by then. */
const T0 = 150;
const SECONDS = 330;
/** Packets a failure must add to the queues to count as forming one. */
const MIN_EXTRA = 10;
/** Seconds after the end of a failure still credited to it. */
const AFTER = 30;
const ROBOTS = [0, 10, 20];
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

const grid: Partial<BottleneckParams>[] = flag('--calibrate')
  ? [6, 8, 12].flatMap((minQueue) =>
      [4, 6, 10].flatMap((minRate) =>
        [0.7, 0.8, 0.9].map((minUse) => ({ minQueue, minRate, minUse })),
      ),
    )
  : [{}];

const failures: { kind: FailureKind; target?: number }[] = [
  ...Array.from({ length: 24 }, (_, target) => ({ kind: 'conveyor' as const, target })),
  ...Array.from({ length: 6 }, (_, target) => ({ kind: 'dock' as const, target })),
  { kind: 'surge' },
  ...ROBOTS.map((target) => ({ kind: 'robot' as const, target })),
];
const specs: TrialSpec[] = seeds.flatMap((seed) => [
  { seed, failure: null, t0: T0, seconds: SECONDS },
  ...failures.map((failure) => ({ seed, failure, t0: T0, seconds: SECONDS })),
]);

function simulate(spec: TrialSpec): Promise<TrialRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['build/headless/bench/gargalo-job.js', JSON.stringify({ spec, params: grid })],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0 ? resolve(JSON.parse(out) as TrialRun) : reject(new Error(`job ${code}`)),
    );
  });
}

async function runAll(): Promise<TrialRun[]> {
  const queue = [...specs];
  const out: TrialRun[] = [];
  const workers = Math.max(1, Math.min(queue.length, availableParallelism() - 2));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) out.push(await simulate(s));
    }),
  );
  return out;
}

const KIND_LABEL: Record<FailureKind, string> = {
  conveyor: 'Esteira quebrada',
  dock: 'Doca bloqueada',
  surge: 'Pico de pedidos',
  robot: 'Robô com defeito',
};

interface Score {
  /** Trials whose failure formed a queue, and how many of them were pointed out. */
  formed: number;
  pointed: number;
  /** Of those pointed out: the first finding names the failure applied. */
  rightFirst: number;
  /** Over every finding-second in the time credited to the failures that formed a queue. */
  findingSeconds: number;
  rightSeconds: number;
  /** Seconds from the failure to the first finding. */
  delays: number[];
  /** Failures that formed no queue but had a bottleneck pointed out while they lasted. */
  noQueuePointed: number;
  noQueue: number;
  /** Bottlenecks pointed out in the reference runs (episodes) and the hours watched. */
  falseEpisodes: number;
  referenceHours: number;
  byKind: Record<FailureKind, { formed: number; pointed: number; rightFirst: number }>;
}

/** Episodes: runs of consecutive seconds with a finding. */
function episodes(findings: readonly { second: number }[]): number {
  let n = 0;
  let last = -2;
  for (const f of findings) {
    if (f.second !== last + 1) n++;
    last = f.second;
  }
  return n;
}

function score(runs: readonly TrialRun[], p: number): Score {
  const s: Score = {
    formed: 0,
    pointed: 0,
    rightFirst: 0,
    findingSeconds: 0,
    rightSeconds: 0,
    delays: [],
    noQueuePointed: 0,
    noQueue: 0,
    falseEpisodes: 0,
    referenceHours: 0,
    byKind: {
      conveyor: { formed: 0, pointed: 0, rightFirst: 0 },
      dock: { formed: 0, pointed: 0, rightFirst: 0 },
      surge: { formed: 0, pointed: 0, rightFirst: 0 },
      robot: { formed: 0, pointed: 0, rightFirst: 0 },
    },
  };
  for (const seed of seeds) {
    const reference = runs.find((r) => r.spec.seed === seed && r.spec.failure === null)!;
    const ref = reference.findings[p] as TrialRun['findings'][number];
    s.falseEpisodes += episodes(ref);
    s.referenceHours += (SECONDS - reference.from) / 3600;
    for (const trial of runs) {
      const failure = trial.spec.failure;
      if (trial.spec.seed !== seed || !failure || !trial.applied) continue;
      const end = Math.min(
        SECONDS - 1,
        (Number.isFinite(trial.endsAt) ? trial.endsAt : SECONDS) + AFTER,
      );
      const credited = (trial.findings[p] as TrialRun['findings'][number]).filter(
        (f) => f.second >= T0 && f.second <= end,
      );
      const formed = extraWaiting(trial, reference, T0, end) >= MIN_EXTRA;
      const k = s.byKind[failure.kind];
      if (!formed) {
        s.noQueue++;
        if (credited.length) s.noQueuePointed++;
        continue;
      }
      s.formed++;
      k.formed++;
      if (!credited.length) continue;
      s.pointed++;
      k.pointed++;
      s.delays.push((credited[0] as { second: number }).second - T0);
      if (causeMatches(failure, credited[0] as TrialRun['findings'][number][number])) {
        s.rightFirst++;
        k.rightFirst++;
      }
      s.findingSeconds += credited.length;
      s.rightSeconds += credited.filter((f) => causeMatches(failure, f)).length;
    }
  }
  s.delays.sort((a, b) => a - b);
  return s;
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
const q = (xs: readonly number[], p: number) =>
  xs.length ? (xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] as number) : NaN;
const perHour = (s: Score) => s.falseEpisodes / s.referenceHours;

function report(s: Score) {
  console.log(`| O que | Resultado |`);
  console.log(`|---|---|`);
  console.log(
    `| Falhas que formaram fila (≥ ${MIN_EXTRA} pacotes a mais que sem a falha) | ${s.formed} de ${s.formed + s.noQueue} |`,
  );
  console.log(
    `| Apontadas pelo detector | ${pct(s.pointed, s.formed)} (${s.pointed} de ${s.formed}) |`,
  );
  console.log(
    `| Tempo até apontar | mediana ${q(s.delays, 0.5).toFixed(0)} s, p90 ${q(s.delays, 0.9).toFixed(0)} s |`,
  );
  console.log(
    `| **Causa correta** (o primeiro aviso nomeia a falha aplicada) | **${pct(s.rightFirst, s.pointed)}** (${s.rightFirst} de ${s.pointed}) |`,
  );
  console.log(
    `| Causa correta, em todos os segundos de aviso | ${pct(s.rightSeconds, s.findingSeconds)} (${s.rightSeconds} de ${s.findingSeconds} s) |`,
  );
  console.log(
    `| Falhas sem fila formada, com gargalo apontado | ${s.noQueuePointed} de ${s.noQueue} |`,
  );
  console.log(
    `| Gargalos apontados sem nenhuma falha aplicada | ${s.falseEpisodes} em ${s.referenceHours.toFixed(1)} h (${perHour(s).toFixed(1)} por hora) |`,
  );
  console.log(`\n| Falha aplicada | Formaram fila | Apontadas | Causa correta |`);
  console.log(`|---|---|---|---|`);
  for (const kind of ['conveyor', 'dock', 'surge', 'robot'] as const) {
    const k = s.byKind[kind];
    console.log(
      `| ${KIND_LABEL[kind]} | ${k.formed} | ${k.pointed} (${pct(k.pointed, k.formed)}) | ${k.rightFirst} (${pct(k.rightFirst, k.pointed)}) |`,
    );
  }
}

const t0 = performance.now();
console.log(
  `Detector de gargalo, ensaios controlados: ${seeds.length} seeds de ${set} (${seeds.join(', ')}); em cada uma, uma rodada sem falha e ${failures.length} com uma falha só, aplicada aos ${T0} s (24 esteiras, 6 docas, 1 pico, ${ROBOTS.length} robôs), roteamento pela heurística.\n`,
);
const runs = await runAll();
const skipped = runs.filter((r) => r.spec.failure && !r.applied).length;
if (skipped)
  console.log(`(${skipped} ensaios de robô ficaram de fora: o robô estava recarregando.)\n`);
const output: Record<string, unknown> = { set, seeds, t0: T0, seconds: SECONDS };
if (flag('--calibrate')) {
  const rows = grid.map((params, p) => ({
    params: { ...DEFAULT_BOTTLENECK, ...params },
    s: score(runs, p),
  }));
  const eligible = rows.filter((r) => perHour(r.s) <= 1);
  const key = (r: (typeof rows)[number]) => [
    -r.s.rightFirst,
    perHour(r.s),
    q(r.s.delays, 0.5),
    JSON.stringify(r.params) === JSON.stringify(DEFAULT_BOTTLENECK) ? 0 : 1,
  ];
  eligible.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++)
      if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    return 0;
  });
  console.log(
    '| fila mínima | crescimento mínimo (/min) | uso mínimo | apontadas | causa correta | mediana até apontar | sem falha (por hora) |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.params.minQueue} | ${r.params.minRate} | ${r.params.minUse} | ${r.s.pointed} de ${r.s.formed} | ${r.s.rightFirst} (${pct(r.s.rightFirst, r.s.pointed)}) | ${q(r.s.delays, 0.5).toFixed(0)} s | ${perHour(r.s).toFixed(1)} |`,
    );
  }
  const pick = eligible[0];
  if (pick) {
    console.log(
      `\nEscolha (regra fixada antes de medir): fila mínima ${pick.params.minQueue}, crescimento mínimo ${pick.params.minRate}/min, uso mínimo ${pick.params.minUse}.\n`,
    );
    report(pick.s);
  } else {
    console.log('\nNenhum conjunto ficou abaixo de um gargalo por hora sem falha.');
  }
  Object.assign(output, {
    rows: rows.map((r) => ({ params: r.params, ...r.s })),
    pick: pick?.params,
  });
} else {
  console.log(`Detector: ${JSON.stringify(DEFAULT_BOTTLENECK)}\n`);
  const s = score(runs, 0);
  report(s);
  Object.assign(output, { params: DEFAULT_BOTTLENECK, score: s });
}
const out = value('--out');
if (out) writeFileSync(out, JSON.stringify(output, null, 1));
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
