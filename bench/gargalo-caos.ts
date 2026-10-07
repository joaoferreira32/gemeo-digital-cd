/**
 * The causes of the bottleneck detector under the automatic failures (phase
 * 5): several failures at once, judged against counterfactual runs (the
 * method is in src/ai/bottleneck-caos.ts). One hour per seed, heuristic
 * routing, maintenance schedule off.
 *
 *   npm run bench:gargalo-caos                           validation seeds
 *   npm run bench:gargalo-caos -- --set teste-5 --final  the test seeds of phase 5 (used once)
 *   npm run bench:gargalo-caos -- --out caos.json
 *
 * The 98% to 100% of phase 4b came from controlled trials, one failure at a
 * time; this is the number for the hard case, reported whatever it is.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  AFTERMATH,
  causesWithin,
  HORIZON,
  MIN_SHRINK,
  rightAbout,
  type CaosExplanation,
  type CaosRun,
} from '../src/ai/bottleneck-caos';
import { isTestSet, seedsOf, type SeedSet } from '../src/ai/seeds';
import type { FailureKind } from '../src/sim/failures';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const set = (value('--set') ?? 'validation') as SeedSet;
if (set !== 'validation' && set !== 'teste-5') {
  console.error('As seeds 30.001 a 30.020 já foram usadas (Fases 4 e 4b): use --set teste-5.');
  process.exit(2);
}
if (isTestSet(set) && !flag('--final')) {
  console.error('As seeds de teste são usadas uma única vez, no resultado final: use --final.');
  process.exit(2);
}
const seeds = seedsOf(set);
const SECONDS = Number(value('--seconds') ?? 3600);
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

function simulate(seed: number): Promise<CaosRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['build/headless/bench/gargalo-caos-job.js', JSON.stringify({ seed, seconds: SECONDS })],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0 ? resolve(JSON.parse(out) as CaosRun) : reject(new Error(`job ${code}`)),
    );
  });
}

const t0 = performance.now();
const queue = [...seeds];
const runs: CaosRun[] = [];
const workers = Math.max(1, Math.min(queue.length, availableParallelism() - 2));
await Promise.all(
  Array.from({ length: workers }, async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) runs.push(await simulate(s));
  }),
);
runs.sort((a, b) => a.seed - b.seed);

const pct = (a: number, b: number) =>
  b ? `${((100 * a) / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
const all = runs.flatMap((r) => r.explanations.map((e) => ({ seed: r.seed, e })));
const row = (label: string, list: typeof all) => {
  const right = list.filter((x) => x.e.judged.correct).length;
  return `| ${label} | ${list.length} | ${right} | ${pct(right, list.length)} |`;
};
const KIND: Record<FailureKind, string> = {
  conveyor: 'esteira quebrada',
  dock: 'doca bloqueada',
  surge: 'pico de pedidos',
  robot: 'robô com defeito',
};
const said = (e: CaosExplanation) => {
  const c = e.cause;
  if (c.kind === 'conveyor' || c.kind === 'service') {
    const what = c.kind === 'service' ? 'manutenção' : 'quebra';
    return c.target === e.resource.index && e.resource.kind === 'conveyor'
      ? `${what} desta esteira`
      : `${what} da esteira ${c.target + 1} (desvio)`;
  }
  if (c.kind === 'dock') return 'doca bloqueada';
  if (c.kind === 'surge') return 'pico de pedidos';
  return 'desenho e demanda';
};
const truthOf = (e: CaosExplanation) =>
  e.judged.causes.length === 0
    ? 'nenhuma falha (desenho e demanda)'
    : e.judged.causes
        .map((c) => `${KIND[c.kind]}${c.target >= 0 ? ` ${c.target + 1}` : ''}`)
        .join(' ou ');

const failures = runs.flatMap((r) => r.failures);
const byKind = (k: FailureKind) => failures.filter((f) => f.kind === k).length;
console.log(
  `Causas do detector de gargalo com falhas automáticas: seeds ${seeds[0]} a ${seeds.at(-1)} (${set}), ` +
    `${SECONDS} s cada, roteamento heurístico, agenda de manutenção desligada.`,
);
console.log(
  `Falhas aplicadas: ${failures.length} (${byKind('conveyor')} esteiras, ${byKind('dock')} docas, ` +
    `${byKind('surge')} picos, ${byKind('robot')} robôs). Causa verdadeira: a falha (ligada ou encerrada ` +
    `há até ${AFTERMATH} s) cuja remoção tira pelo menos metade da fila do gargalo (e ${MIN_SHRINK} pacotes).\n`,
);
console.log('| Explicações | Total | Causa certa | % |');
console.log('|---|---|---|---|');
console.log(row('Todas', all));
for (const [label, n] of [
  ['Nenhuma falha ligada no momento julgado', 0],
  ['Uma falha ligada', 1],
  ['Duas ou mais falhas ligadas (simultâneas)', 2],
] as const) {
  console.log(
    row(
      label,
      all.filter((x) => Math.min(2, x.e.judged.simultaneous) === n),
    ),
  );
}
console.log(
  row(
    'Duas ou mais candidatas (ligadas ou recentes)',
    all.filter((x) => x.e.judged.candidates.length >= 2),
  ),
);
const judged = [0, 1, 2].map((k) => runs.reduce((n, r) => n + (r.judgedSeconds[k] as number), 0));
const right = [0, 1, 2].map((k) => runs.reduce((n, r) => n + (r.rightSeconds[k] as number), 0));
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
console.log(
  `| Segundos na tela (fila ≥ 12) | ${sum(judged)} | ${sum(right)} | ${pct(sum(right), sum(judged))} |`,
);
console.log(
  `| Segundos com duas ou mais falhas ligadas | ${judged[2]} | ${right[2]} | ${pct(right[2] as number, judged[2] as number)} |`,
);

console.log('\nPela causa verdadeira:\n');
console.log('| Causa verdadeira | Explicações | Causa certa | % |');
console.log('|---|---|---|---|');
const only = (k: FailureKind) => (x: (typeof all)[number]) =>
  x.e.judged.causes.length > 0 && x.e.judged.causes.every((c) => c.kind === k);
for (const k of ['conveyor', 'dock', 'surge', 'robot'] as const) {
  console.log(row(`Só ${KIND[k]}`, all.filter(only(k))));
}
console.log(
  row(
    'Falhas de tipos diferentes',
    all.filter((x) => new Set(x.e.judged.causes.map((c) => c.kind)).size > 1),
  ),
);
console.log(
  row(
    'Nenhuma falha (desenho e demanda)',
    all.filter((x) => x.e.judged.causes.length === 0),
  ),
);

console.log('\nPela causa que o detector deu:\n');
console.log('| Causa dita | Explicações | Certa | % |');
console.log('|---|---|---|---|');
const saidKinds = [...new Set(all.map((x) => said(x.e).replace(/ \d+ /, ' N ')))].sort();
for (const s of saidKinds) {
  console.log(
    row(
      s,
      all.filter((x) => said(x.e).replace(/ \d+ /, ' N ') === s),
    ),
  );
}

// Sensitivity: the same explanations with a shorter and a longer window.
console.log('\nCom outra janela (quanto tempo depois do fim uma falha ainda pode ser a causa):\n');
console.log('| Janela | Todas | Com duas ou mais falhas ligadas |');
console.log('|---|---|---|');
for (const w of [60, AFTERMATH, HORIZON]) {
  const ok = (x: (typeof all)[number]) =>
    rightAbout(x.e.cause.kind, x.e.cause.target, causesWithin(x.e.judged, w));
  const two = all.filter((x) => x.e.judged.simultaneous >= 2);
  console.log(
    `| ${w} s${w === AFTERMATH ? ' (a medida principal)' : ''} | ${pct(all.filter(ok).length, all.length)} | ${pct(two.filter(ok).length, two.length)} |`,
  );
}

// The control that fixed the window: a robot defect almost never makes a belt or dock queue.
console.log(
  '\nControle da janela: entre as candidatas, quantas tiram metade da fila (causa) e quantas a aumentam em metade (ruído), pelo tempo desde o fim da falha:\n',
);
console.log(
  '| Desde o fim | Defeito de robô: causa | Outras falhas: causa | Outras: aumentam a fila |',
);
console.log('|---|---|---|---|');
const lags: [string, number, number][] = [
  ['ligada', -Infinity, 0],
  ['até 60 s', 0, 60],
  ['60 a 120 s', 60, 120],
  ['120 a 180 s', 120, 180],
  ['180 a 300 s', 180, 300],
  ['300 a 600 s', 300, HORIZON],
];
for (const [label, lo, hi] of lags) {
  const tally = { robot: [0, 0], other: [0, 0, 0] };
  for (const { e } of all) {
    const j = e.judged;
    const min = Math.max(MIN_SHRINK, j.queue / 2);
    for (const c of j.candidates) {
      const ago = j.second - c.endsAt;
      if (!(lo === -Infinity ? ago <= 0 : ago > lo && ago <= hi)) continue;
      const t = c.kind === 'robot' ? tally.robot : tally.other;
      t[0] = (t[0] as number) + 1;
      if (c.shrink >= min) t[1] = (t[1] as number) + 1;
      if (-c.shrink >= min) t[2] = (t[2] ?? 0) + 1;
    }
  }
  const [rn, rc] = tally.robot as [number, number];
  const [on, oc, oa] = tally.other as [number, number, number];
  console.log(`| ${label} | ${pct(rc, rn)} de ${rn} | ${pct(oc, on)} de ${on} | ${pct(oa, on)} |`);
}

const wrong = all.filter((x) => !x.e.judged.correct);
console.log(`\nExplicações erradas (${wrong.length}):`);
for (const { seed, e } of wrong) {
  const r = e.resource;
  console.log(
    `- seed ${seed}, ${e.from}–${e.to} s, ${r.kind === 'conveyor' ? 'esteira' : 'doca'} ${r.index + 1} ` +
      `(fila ${e.judged.queue} aos ${e.judged.second} s, ${e.judged.simultaneous} falha(s) ligada(s)): ` +
      `disse "${said(e)}", verdadeira: ${truthOf(e)}`,
  );
}
const out = value('--out');
if (out) writeFileSync(out, JSON.stringify({ set, seeds, seconds: SECONDS, runs }, null, 1));
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s com ${workers} processos`);
