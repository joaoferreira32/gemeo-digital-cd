/**
 * The causes of the bottleneck detector under the automatic failures (phase
 * 5): several failures at once, judged against counterfactual runs (the
 * method is in src/ai/bottleneck-caos.ts). One hour per seed, heuristic
 * routing, maintenance schedule off. The detector without the memory of
 * failures and the detector as configured (DEFAULT_BOTTLENECK) are judged on
 * the same runs and the same truth, side by side.
 *
 *   npm run bench:gargalo-caos                                  validation seeds
 *   npm run bench:gargalo-caos -- --calibrate --ensaios e.json  the memory grid, validation seeds
 *   npm run bench:gargalo-caos -- --set teste-memoria --final   the test seeds of the memory (used once)
 *   npm run bench:gargalo-caos -- --out caos.json
 *
 * --ensaios: the output of `npm run bench:gargalo -- --memoria --out e.json`
 * (the same grid in the controlled trials of phase 4b), for the rule that
 * picks from the grid (docs/resultados.md): keep the first causes of the
 * trials all right and their seconds at least as right as without memory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { DEFAULT_BOTTLENECK, type BottleneckParams } from '../src/ai/bottleneck';
import {
  AFTERMATH,
  causesWithin,
  HORIZON,
  MEMORY_GRID,
  memoryName,
  MIN_SHRINK,
  NO_MEMORY,
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
if (set !== 'validation' && set !== 'teste-5' && set !== 'teste-memoria') {
  console.error('As seeds 30.001 a 30.020 já foram usadas (Fases 4 e 4b).');
  process.exit(2);
}
if (isTestSet(set) && !flag('--final')) {
  console.error('As seeds de teste são usadas uma única vez, no resultado final: use --final.');
  process.exit(2);
}
const calibrate = flag('--calibrate');
if (calibrate && set !== 'validation') {
  console.error('A calibração usa só as seeds de validação.');
  process.exit(2);
}
const seeds = seedsOf(set);
const SECONDS = Number(value('--seconds') ?? 3600);
const variants: Partial<BottleneckParams>[] = calibrate
  ? [NO_MEMORY, ...MEMORY_GRID]
  : [NO_MEMORY, {}];
if (spawnSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' }).status) {
  process.exit(1);
}

function simulate(seed: number): Promise<CaosRun> {
  return new Promise((resolve, reject) => {
    const job = { seed, seconds: SECONDS, variants, countsOnly: calibrate };
    const child = spawn(
      process.execPath,
      ['build/headless/bench/gargalo-caos-job.js', JSON.stringify(job)],
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
const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);
/** Totals of one detector over the seeds. */
const totals = (k: number) => {
  const get = (f: (v: CaosRun['variants'][number]) => readonly number[]) =>
    [0, 1, 2].map((i) => sum(runs.map((r) => f(r.variants[k]!)[i] as number)));
  return {
    judged: get((v) => v.judged),
    right: get((v) => v.right),
    judgedSeconds: get((v) => v.judgedSeconds),
    rightSeconds: get((v) => v.rightSeconds),
  };
};
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
const out = value('--out');

if (calibrate) {
  // The rule registered before calibrating (docs/resultados.md).
  const trials = value('--ensaios');
  const key = (p: Partial<BottleneckParams>) => memoryName({ ...DEFAULT_BOTTLENECK, ...p });
  let allowed: ((p: Partial<BottleneckParams>) => boolean) | null = null;
  if (trials) {
    const rows = (
      JSON.parse(readFileSync(trials, 'utf-8')) as {
        rows: {
          params: BottleneckParams;
          pointed: number;
          rightFirst: number;
          findingSeconds: number;
          rightSeconds: number;
        }[];
      }
    ).rows;
    const base = rows.find((r) => !r.params.memory);
    if (!base) throw new Error('os ensaios não têm a rodada sem memória');
    const baseSeconds = base.rightSeconds / base.findingSeconds;
    const ok = new Map(
      rows.map((r) => [
        memoryName(r.params),
        r.rightFirst === r.pointed && r.rightSeconds / r.findingSeconds >= baseSeconds,
      ]),
    );
    allowed = (p) => ok.get(key(p)) ?? false;
    console.log(
      `Ensaios controlados da 4b (validação), sem memória: causa certa no primeiro aviso ${pct(base.rightFirst, base.pointed)}, nos segundos de aviso ${pct(base.rightSeconds, base.findingSeconds)}.\n`,
    );
  } else {
    console.log('(Sem --ensaios: a tabela sai sem a restrição dos ensaios controlados.)\n');
  }
  const table = variants.map((p, k) => ({ p, k, ...totals(k) }));
  const share = (x: (typeof table)[number]) => sum(x.right) / sum(x.judged);
  const base = table[0]!;
  console.log(
    '| Memória | Explicações certas | Com 2+ falhas ligadas | Segundos | Ensaios da 4b |',
  );
  console.log('|---|---|---|---|---|');
  for (const x of [...table].sort((a, b) => share(b) - share(a))) {
    console.log(
      `| ${key(x.p)} | ${pct(sum(x.right), sum(x.judged))} | ${pct(x.right[2]!, x.judged[2]!)} | ${pct(sum(x.rightSeconds), sum(x.judgedSeconds))} | ${allowed ? (x.k === 0 ? 'referência' : allowed(x.p) ? 'mantém' : 'piora') : '—'} |`,
    );
  }
  if (allowed) {
    // Ties: the grid is already in the order of the tie-break, so the first best wins.
    let pick: (typeof table)[number] | null = null;
    for (const x of table.slice(1)) {
      if (!allowed(x.p)) continue;
      if (!pick || share(x) > share(pick)) pick = x;
    }
    if (pick && share(pick) > share(base)) {
      console.log(
        `\nEscolha (regra registrada antes de calibrar): ${key(pick.p)}: ${pct(sum(pick.right), sum(pick.judged))} das explicações certas, contra ${pct(sum(base.right), sum(base.judged))} sem memória.`,
      );
      console.log(`Parâmetros: ${JSON.stringify(pick.p)}`);
    } else {
      console.log(
        '\nNenhuma combinação melhorou a validação mantendo os ensaios: a memória não entra.',
      );
    }
  }
  if (out)
    writeFileSync(out, JSON.stringify({ set, seeds, seconds: SECONDS, variants, runs }, null, 1));
  console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s com ${workers} processos`);
  process.exit(0);
}

// Side by side: without memory (column A) and as configured (column B).
const NAMES = ['Sem memória', `Com memória (${memoryName(DEFAULT_BOTTLENECK)})`] as const;
const explained = (k: number) =>
  runs.flatMap((r) => (r.variants[k]!.explanations ?? []).map((e) => ({ seed: r.seed, e })));
const lists = [explained(0), explained(1)] as const;
type Item = (typeof lists)[0][number];
const cell = (list: Item[]) => {
  const right = list.filter((x) => x.e.judged.correct).length;
  return `${pct(right, list.length)} (${right} de ${list.length})`;
};
const row = (label: string, keep: (x: Item) => boolean) =>
  `| ${label} | ${cell(lists[0].filter(keep))} | ${cell(lists[1].filter(keep))} |`;
console.log(`| Explicações | ${NAMES[0]} | ${NAMES[1]} |`);
console.log('|---|---|---|');
console.log(row('Todas', () => true));
for (const [label, n] of [
  ['Nenhuma falha ligada no momento julgado', 0],
  ['Uma falha ligada', 1],
  ['Duas ou mais falhas ligadas (simultâneas)', 2],
] as const) {
  console.log(row(label, (x) => Math.min(2, x.e.judged.simultaneous) === n));
}
const [ta, tb] = [totals(0), totals(1)];
console.log(
  `| Segundos na tela (fila ≥ 12) | ${pct(sum(ta.rightSeconds), sum(ta.judgedSeconds))} (${sum(ta.rightSeconds)} de ${sum(ta.judgedSeconds)} s) | ${pct(sum(tb.rightSeconds), sum(tb.judgedSeconds))} (${sum(tb.rightSeconds)} de ${sum(tb.judgedSeconds)} s) |`,
);
console.log(
  `| Segundos com duas ou mais falhas ligadas | ${pct(ta.rightSeconds[2]!, ta.judgedSeconds[2]!)} | ${pct(tb.rightSeconds[2]!, tb.judgedSeconds[2]!)} |`,
);

const KIND: Record<FailureKind, string> = {
  conveyor: 'esteira quebrada',
  dock: 'doca bloqueada',
  surge: 'pico de pedidos',
  robot: 'robô com defeito',
};
const said = (e: CaosExplanation) => {
  const c = e.cause;
  const own = c.target === e.resource.index && (c.kind === 'dock') === (e.resource.kind === 'dock');
  if (c.memory) {
    if (c.kind === 'surge') return 'sobra do pico de pedidos';
    if (c.kind === 'dock')
      return own ? 'sobra do bloqueio desta doca' : 'sobra do bloqueio de outra doca';
    const what = c.kind === 'service' ? 'manutenção' : 'quebra';
    return own ? `sobra da ${what} desta esteira` : `sobra da ${what} de outra esteira`;
  }
  if (c.kind === 'conveyor' || c.kind === 'service') {
    const what = c.kind === 'service' ? 'manutenção' : 'quebra';
    return own ? `${what} desta esteira` : `${what} de outra esteira (desvio)`;
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

console.log('\nPela causa verdadeira:\n');
console.log(`| Causa verdadeira | ${NAMES[0]} | ${NAMES[1]} |`);
console.log('|---|---|---|');
const only = (k: FailureKind) => (x: Item) =>
  x.e.judged.causes.length > 0 && x.e.judged.causes.every((c) => c.kind === k);
for (const k of ['conveyor', 'dock', 'surge', 'robot'] as const)
  console.log(row(`Só ${KIND[k]}`, only(k)));
console.log(
  row('Falhas de tipos diferentes', (x) => new Set(x.e.judged.causes.map((c) => c.kind)).size > 1),
);
console.log(row('Nenhuma falha (desenho e demanda)', (x) => x.e.judged.causes.length === 0));

for (const k of [0, 1] as const) {
  console.log(`\nPela causa que o detector deu (${NAMES[k].toLowerCase()}):\n`);
  console.log('| Causa dita | Explicações | Certa | % |');
  console.log('|---|---|---|---|');
  for (const s of [...new Set(lists[k].map((x) => said(x.e)))].sort()) {
    const list = lists[k].filter((x) => said(x.e) === s);
    const right = list.filter((x) => x.e.judged.correct).length;
    console.log(`| ${s} | ${list.length} | ${right} | ${pct(right, list.length)} |`);
  }
}

// Sensitivity: the same explanations with a shorter and a longer window.
console.log('\nCom outra janela (quanto tempo depois do fim uma falha ainda pode ser a causa):\n');
console.log(`| Janela | ${NAMES[0]} | ${NAMES[1]} |`);
console.log('|---|---|---|');
for (const w of [60, AFTERMATH, HORIZON]) {
  const ok = (x: Item) => rightAbout(x.e.cause.kind, x.e.cause.target, causesWithin(x.e.judged, w));
  console.log(
    `| ${w} s${w === AFTERMATH ? ' (a medida principal)' : ''} | ${pct(lists[0].filter(ok).length, lists[0].length)} | ${pct(lists[1].filter(ok).length, lists[1].length)} |`,
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
  for (const { e } of lists[0]) {
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

const wrong = lists[1].filter((x) => !x.e.judged.correct);
console.log(`\nExplicações erradas, ${NAMES[1].toLowerCase()} (${wrong.length}):`);
for (const { seed, e } of wrong) {
  const r = e.resource;
  console.log(
    `- seed ${seed}, ${e.from}–${e.to} s, ${r.kind === 'conveyor' ? 'esteira' : 'doca'} ${r.index + 1} ` +
      `(fila ${e.judged.queue} aos ${e.judged.second} s, ${e.judged.simultaneous} falha(s) ligada(s)): ` +
      `disse "${said(e)}", verdadeira: ${truthOf(e)}`,
  );
}
if (out)
  writeFileSync(out, JSON.stringify({ set, seeds, seconds: SECONDS, variants, runs }, null, 1));
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s com ${workers} processos`);
