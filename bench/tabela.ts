/**
 * The benchmark table of the README, generated (`npm run bench`): runs the
 * benchmarks on the validation and lab seeds and rewrites the table between
 * the markers of README.md, each number with its 95% interval. The test seeds
 * stay out: they are used once, and those results are in docs/resultados.md.
 * bench/tabela.json keeps the last numbers of every part, so a partial run
 * rewrites only its own rows.
 *
 *   npm run bench                         every part
 *   npm run bench -- motor laboratorio    only these parts
 *   npm run bench:motor                   the engine benchmark alone (the CI gate)
 *
 * Intervals: Student's t over the seeds (or over the repetitions, for the
 * engine); differences are paired seed by seed; shares are pooled over the
 * seeds with the seed as the unit of the interval (src/lab/stats.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { SCENARIO_LABEL, type ScenarioName } from '../src/ai/evaluate';
import { estimate, pooledShare, type Estimate } from '../src/lab/stats';

interface Row {
  readonly what: string;
  readonly result: string;
  readonly how: string;
}
interface Part {
  readonly key: string;
  /** The script and its arguments; `{out}` is the JSON it writes. */
  readonly args: readonly string[];
  readonly rows: (json: never) => Row[];
}
interface Paired {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
  readonly wins: number;
  readonly n: number;
}

const BEGIN = '<!-- bench:inicio (gerado por npm run bench; não editar à mão) -->';
const END = '<!-- bench:fim -->';
const STORE = 'bench/tabela.json';
const TMP = 'build/tabela';

const num = (v: number, d = 1) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v: number, d = 1, unit = '') =>
  `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)}${unit}`;
const pct = (v: number) => `${num(100 * v, 0)}%`;
const share = (e: Estimate) => `**${pct(e.mean)}** (IC 95% ${pct(e.low)} a ${pct(e.high)})`;
const gain = (p: Paired) =>
  `**${signed(100 * p.mean, 1, '%')}** (${signed(100 * p.low, 1, '%')} a ${signed(100 * p.high, 1, '%')}), ${p.wins} de ${p.n} seeds`;

const parts: Part[] = [
  {
    key: 'motor',
    args: ['bench/run.ts', '{out}'],
    rows: (json: { reps: number; results: { name: string; samples: number[] }[] }) =>
      json.results
        .filter((r) => r.name.includes('passos/s'))
        .map((r) => {
          const e = estimate(r.samples);
          return {
            what: r.name.replace(' (passos/s)', ''),
            result: `**${num(e.mean, 0)} passos/s** (IC 95% ${num(e.low, 0)} a ${num(e.high, 0)}), ${json.reps} repetições`,
            how: '`npm run bench:motor`',
          };
        }),
  },
  {
    key: 'rotas',
    args: ['bench/rotas.ts', '--out', '{out}'],
    rows: (json: { cmp: { scenario: ScenarioName; p95: Paired }[] }) =>
      json.cmp.map((c) => ({
        what: `Heurística × roteamento estático, p95 do ciclo: ${SCENARIO_LABEL[c.scenario].toLowerCase()}`,
        result: `ganho ${gain(c.p95)}`,
        how: '`npm run bench:rotas`',
      })),
  },
  {
    key: 'manutencao',
    args: ['bench/manutencao.ts', '--out', '{out}'],
    rows: (json: {
      scores: { alarms: number; trueAlarms: number; breakdowns: number; detected: number }[];
    }) => {
      const s = json.scores;
      return [
        {
          what: 'Manutenção preditiva: precisão dos alarmes',
          result: share(
            pooledShare(
              s.map((x) => x.trueAlarms),
              s.map((x) => x.alarms),
            ),
          ),
          how: '`npm run bench:manutencao`',
        },
        {
          what: 'Manutenção preditiva: quebras com desgaste detectadas (recall)',
          result: share(
            pooledShare(
              s.map((x) => x.detected),
              s.map((x) => x.breakdowns),
            ),
          ),
          how: '`npm run bench:manutencao`',
        },
      ];
    },
  },
  {
    key: 'agenda',
    args: ['bench/agenda.ts', '--duracoes', '30', '--out', '{out}'],
    rows: (json: {
      results: { rows: { p95: Paired }; bySeed: { avoided: number; wears: number }[] }[];
    }) => {
      const r = json.results[0] as (typeof json.results)[number];
      return [
        {
          what: 'Agenda de manutenção: quebras com desgaste evitadas',
          result: share(
            pooledShare(
              r.bySeed.map((x) => x.avoided),
              r.bySeed.map((x) => x.wears),
            ),
          ),
          how: '`npm run bench:agenda`',
        },
        {
          what: 'Agenda de manutenção (30 s), p95 do ciclo',
          result: `ganho ${gain(r.rows.p95)}`,
          how: '`npm run bench:agenda`',
        },
      ];
    },
  },
  {
    key: 'gargalo',
    args: ['bench/gargalo.ts', '--out', '{out}'],
    rows: (json: { bySeed: { formed: number; pointed: number; rightFirst: number }[] }) => {
      const s = json.bySeed;
      return [
        {
          what: 'Detector de gargalo, uma falha por vez: falhas com fila apontadas',
          result: share(
            pooledShare(
              s.map((x) => x.pointed),
              s.map((x) => x.formed),
            ),
          ),
          how: '`npm run bench:gargalo`',
        },
        {
          what: 'Detector de gargalo, uma falha por vez: causa certa no primeiro aviso',
          result: share(
            pooledShare(
              s.map((x) => x.rightFirst),
              s.map((x) => x.pointed),
            ),
          ),
          how: '`npm run bench:gargalo`',
        },
      ];
    },
  },
  {
    key: 'caos',
    args: ['bench/gargalo-caos.ts', '--out', '{out}'],
    rows: (json: {
      runs: {
        variants: { explanations: { judged: { correct: boolean; simultaneous: number } }[] }[];
      }[];
    }) => {
      // Variant 0: without the memory of failures; 1: the detector as configured.
      const of = (k: number, keep: (j: { correct: boolean; simultaneous: number }) => boolean) => {
        const list = json.runs.map((r) => r.variants[k]?.explanations ?? []);
        return pooledShare(
          list.map((l) => l.filter((e) => keep(e.judged) && e.judged.correct).length),
          list.map((l) => l.filter((e) => keep(e.judged)).length),
        );
      };
      const both = (keep: (j: { correct: boolean; simultaneous: number }) => boolean) =>
        `sem memória ${share(of(0, keep))}; com memória ${share(of(1, keep))}`;
      return [
        {
          what: 'Detector de gargalo, falhas automáticas: causa certa',
          result: both(() => true),
          how: '`npm run bench:gargalo-caos`',
        },
        {
          what: 'Detector de gargalo, falhas automáticas: causa certa com duas ou mais falhas ligadas',
          result: both((j) => j.simultaneous >= 2),
          how: '`npm run bench:gargalo-caos`',
        },
      ];
    },
  },
  {
    key: 'laboratorio',
    args: ['bench/lab.ts', '--out', '{out}'],
    rows: (json: {
      rows: {
        key: string;
        a: Estimate;
        b: Estimate;
        difference: Estimate & { lower: number; higher: number };
      }[];
    }) => {
      const row = (key: string) => json.rows.find((r) => r.key === key) as (typeof json.rows)[0];
      const p95 = row('cycleP95');
      const wait = row('waitP95');
      const tp = row('throughput');
      const d = (e: Estimate, unit: string) =>
        `**${signed(e.mean, 1, unit)}** (${signed(e.low, 1, unit)} a ${signed(e.high, 1, unit)})`;
      return [
        {
          what: 'Laboratório: demanda da Olist × constante (mesmo volume no dia), p95 do ciclo',
          result: `${num(p95.a.mean)} s → ${num(p95.b.mean)} s: ${d(p95.difference, ' s')}, pior em ${p95.difference.higher} de ${p95.difference.n} seeds`,
          how: '`npm run bench:lab`',
        },
        {
          what: 'Laboratório: demanda da Olist × constante, p95 de espera (a parte do ciclo parada em fila)',
          result: `${num(wait.a.mean)} s → ${num(wait.b.mean)} s: ${d(wait.difference, ' s')}, pior em ${wait.difference.higher} de ${wait.difference.n} seeds`,
          how: '`npm run bench:lab`',
        },
        {
          what: 'Laboratório: demanda da Olist × constante, vazão',
          result: `${d(tp.difference, '')} pacotes/min`,
          how: '`npm run bench:lab`',
        },
      ];
    },
  },
];

const wanted = process.argv.slice(2);
const unknown = wanted.filter((k) => !parts.some((p) => p.key === k));
if (unknown.length) {
  console.error(
    `Parte desconhecida: ${unknown.join(', ')}. Partes: ${parts.map((p) => p.key).join(', ')}.`,
  );
  process.exit(2);
}
/** Each part keeps where it was measured: a partial run leaves the other parts as they were. */
interface Measured {
  readonly rows: Row[];
  readonly date: string;
  readonly commit: string;
  readonly machine: string;
}
const store = existsSync(STORE)
  ? (JSON.parse(readFileSync(STORE, 'utf-8')) as Record<string, Measured>)
  : {};
mkdirSync(TMP, { recursive: true });
const tsx = 'node_modules/tsx/dist/cli.mjs';
const today = new Date().toISOString().slice(0, 10);
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf-8',
}).stdout.trim();
const machine = `Node ${process.version}, ${cpus()[0]?.model.trim() ?? 'CPU desconhecida'} (${cpus().length} núcleos lógicos)`;
for (const part of parts) {
  if (wanted.length && !wanted.includes(part.key)) continue;
  const out = `${TMP}/${part.key}.json`;
  const args = part.args.map((a) => (a === '{out}' ? out : a));
  console.log(`\n== ${part.key}: tsx ${args.join(' ')}\n`);
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [tsx, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`A parte ${part.key} falhou (código ${r.status}); a tabela não foi alterada.`);
    process.exit(1);
  }
  const rows = (part.rows as (json: unknown) => Row[])(JSON.parse(readFileSync(out, 'utf-8')));
  store[part.key] = { rows, date: today, commit, machine };
  console.log(`(${part.key}: ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}

const missing = parts.filter((p) => !store[p.key]).map((p) => p.key);
// Where the numbers come from: one line when every part was measured together.
const runs = new Map<string, string[]>();
for (const p of parts) {
  const m = store[p.key];
  if (!m) continue;
  const where = `${m.date} (commit \`${m.commit}\`), ${m.machine}`;
  runs.set(where, [...(runs.get(where) ?? []), p.key]);
}
const when =
  runs.size === 1
    ? [`Medida em ${[...runs.keys()][0]}.`]
    : [...runs].map(([where, keys]) => `${keys.join(', ')}: medidas em ${where}.`);
const lines = [
  BEGIN,
  '',
  ...when,
  'Seeds de validação (20.001 a 20.010) e do laboratório (50.001 a 50.010); as seeds de teste',
  'ficam de fora (usadas uma única vez; os resultados delas estão nas tabelas por fase abaixo).',
  'IC 95%: t de Student entre seeds (no motor, entre repetições); diferenças pareadas seed a',
  'seed; proporções somadas nas seeds, com o intervalo pela variação entre elas.',
  '',
  '| O que | Resultado | Como reproduzir |',
  '|---|---|---|',
  ...parts.flatMap((p) =>
    (store[p.key]?.rows ?? []).map((r) => `| ${r.what} | ${r.result} | ${r.how} |`),
  ),
  ...(missing.length ? ['', `Ainda sem medida: ${missing.join(', ')}.`] : []),
  '',
  END,
];
const readme = readFileSync('README.md', 'utf-8');
const from = readme.indexOf(BEGIN);
const to = readme.indexOf(END);
if (from < 0 || to < from) {
  console.error('Os marcadores da tabela não estão no README.md.');
  process.exit(1);
}
writeFileSync(
  'README.md',
  readme.slice(0, from) + lines.join('\n') + readme.slice(to + END.length),
);
writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);
spawnSync(
  process.execPath,
  ['node_modules/prettier/bin/prettier.cjs', '--write', 'README.md', STORE],
  {
    stdio: 'inherit',
  },
);
console.log('\nTabela do README atualizada.');
