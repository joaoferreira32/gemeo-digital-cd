// Compares two benchmark reports (bench/run.ts) and writes a Markdown table
// to the GitHub job summary. Regressions beyond the threshold become
// warnings; the script never fails the job (warning-only, by decision).
//
//   node bench/compare.mjs head.json [base.json] [title]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const THRESHOLD = 0.15;
const [headPath, basePath, title = 'Benchmark do motor'] = process.argv.slice(2);
const head = JSON.parse(readFileSync(headPath, 'utf8'));
const base = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : null;

const fmt = (v) =>
  v >= 100 ? Math.round(v).toLocaleString('pt-BR') : v.toFixed(3).replace('.', ',');
const spread = (s) => {
  const min = Math.min(...s);
  const max = Math.max(...s);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return ((max - min) / mean) * 100;
};

const lines = [
  `## ${title}`,
  '',
  base
    ? '| Caso | Base | Este commit | Diferença | Variação entre repetições |'
    : '| Caso | Este commit | Variação entre repetições |',
  base ? '|---|---|---|---|---|' : '|---|---|---|',
];
let regressions = 0;
for (const r of head.results) {
  const b = base?.results.find((x) => x.name === r.name);
  if (!b) {
    lines.push(
      base
        ? `| ${r.name} | — | ${fmt(r.value)} | — | ${spread(r.samples).toFixed(1)}% |`
        : `| ${r.name} | ${fmt(r.value)} | ${spread(r.samples).toFixed(1)}% |`,
    );
    continue;
  }
  // Positive change = better, whatever the unit direction.
  const change = r.better === 'higher' ? r.value / b.value - 1 : b.value / r.value - 1;
  const mark = change < -THRESHOLD ? ' ⚠️' : '';
  if (change < -THRESHOLD) {
    regressions++;
    console.log(
      `::warning title=Desempenho::${r.name}: ${(change * 100).toFixed(1)}% (limite ${THRESHOLD * 100}%)`,
    );
  }
  lines.push(
    `| ${r.name} | ${fmt(b.value)} | ${fmt(r.value)} | ${(change * 100).toFixed(1)}%${mark} | ${spread(r.samples).toFixed(1)}% |`,
  );
}
lines.push(
  '',
  base
    ? `Regressões acima de ${THRESHOLD * 100}%: ${regressions} (apenas aviso).`
    : 'Sem base para comparar (primeira execução com benchmark).',
  '',
);
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
