// Compares two benchmark reports (bench/run.ts) and writes a Markdown table
// to the GitHub job summary. Each case carries its own gate: the steps-per-
// second cases block above a 10 % regression, the snapshot timing only warns
// (decided after measuring CI noise: A/A runs on one runner differed by up to
// 3.4 % in steps/s and 8.5 % in snapshot time).
//
//   node bench/compare.mjs head.json [base.json] [title] [--report-only]
//
// Exit code 1 when a blocking case regressed (unless --report-only).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const [headPath, basePath, title = 'Benchmark do motor'] = args.filter(
  (a) => a !== '--report-only',
);
const head = JSON.parse(readFileSync(headPath, 'utf8'));
const base = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : null;

/** Cases written before gates existed only warn, at the old 15 % threshold. */
const gateOf = (r) => r.gate ?? { threshold: 0.15, blocking: false };
const fmt = (v) =>
  v >= 100 ? Math.round(v).toLocaleString('pt-BR') : v.toFixed(3).replace('.', ',');
const pct = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
const spread = (s) => {
  const min = Math.min(...s);
  const max = Math.max(...s);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return (max - min) / mean;
};
const rule = (g) =>
  reportOnly
    ? 'só relatório'
    : g.blocking
      ? `bloqueia > ${pct(g.threshold)}`
      : `aviso > ${pct(g.threshold)}`;

const lines = [
  `## ${title}`,
  '',
  base
    ? '| Caso | Base | Este commit | Diferença | Regra | Variação entre repetições |'
    : '| Caso | Este commit | Variação entre repetições |',
  base ? '|---|---|---|---|---|---|' : '|---|---|---|',
];
let blocking = 0;
let warnings = 0;
for (const r of head.results) {
  const b = base?.results.find((x) => x.name === r.name);
  if (!b) {
    lines.push(
      base
        ? `| ${r.name} | — | ${fmt(r.value)} | — | ${rule(gateOf(r))} | ${pct(spread(r.samples))} |`
        : `| ${r.name} | ${fmt(r.value)} | ${pct(spread(r.samples))} |`,
    );
    continue;
  }
  const g = gateOf(r);
  // Positive change = better, whatever the unit direction.
  const change = r.better === 'higher' ? r.value / b.value - 1 : b.value / r.value - 1;
  const regressed = change < -g.threshold;
  let mark = '';
  if (regressed && !reportOnly) {
    if (g.blocking) {
      blocking++;
      mark = ' ⛔';
      console.log(
        `::error title=Desempenho::${r.name}: ${pct(change)} (limite ${pct(g.threshold)})`,
      );
    } else {
      warnings++;
      mark = ' ⚠️';
      console.log(
        `::warning title=Desempenho::${r.name}: ${pct(change)} (limite ${pct(g.threshold)})`,
      );
    }
  }
  lines.push(
    `| ${r.name} | ${fmt(b.value)} | ${fmt(r.value)} | ${pct(change)}${mark} | ${rule(g)} | ${pct(spread(r.samples))} |`,
  );
}
lines.push(
  '',
  !base
    ? 'Sem base para comparar.'
    : reportOnly
      ? 'Só relatório: não bloqueia.'
      : `Regressões bloqueantes: ${blocking} · avisos: ${warnings}.`,
  '',
);
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
process.exitCode = blocking > 0 ? 1 : 0;
