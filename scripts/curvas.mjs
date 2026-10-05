/**
 * Learning curves of the routing agent's tuning rounds, as an SVG for the
 * README (docs/curvas-rl.svg) and the plotted numbers (docs/curvas-rl.csv).
 *
 *   node scripts/curvas.mjs rodada1 rodada2 ...
 *
 * Each round's curve is the mean return of its last 100 training episodes
 * (rollout/ep_rew_mean in ai/runs/<round>/progress.csv), over the decisions
 * of PPO. The reference lines (static routing and heuristic, same reward,
 * training seeds) are computed here by bench/retornos.ts on the headless
 * build, 40 seeds per scenario in 4 processes.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const rounds = process.argv.slice(2);
if (!rounds.length) {
  console.error('uso: node scripts/curvas.mjs rodada1 rodada2 ...');
  process.exit(2);
}
const LABEL = {
  rodada1: 'Rodada 1 · PPO a partir de pesos aleatórios',
  rodada2: 'Rodada 2 · imitação da heurística + PPO',
  rodada3: 'Rodada 3',
};
// Validated against the figure's surface (dataviz validator, dark mode): all checks pass.
const SERIES = ['#1fa9a0', '#c98500', '#9085e9'];
const SURFACE = '#0f141a';
const GRID = '#232c36';
const AXIS = '#3a4652';
const REFERENCE = '#8b97a3';
const TEXT = '#e6edf3';
const MUTED = '#9aa6b2';

// Reference returns (mean over the four scenarios, as the training draws them uniformly).
execFileSync(process.execPath, ['scripts/build-headless.mjs'], { stdio: 'inherit' });
const parts = await Promise.all(
  [0, 1, 2, 3].map(
    (k) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          'build/headless/bench/retornos.js',
          String(11_000 + k * 10),
          '10',
        ]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('exit', (code) =>
          code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`retornos ${code}`)),
        );
      }),
  ),
);
const reference = {};
for (const policy of ['static', 'heuristic']) {
  const scenarios = Object.keys(parts[0].returns[policy]);
  const perScenario = scenarios.map(
    (s) => parts.reduce((a, p) => a + p.returns[policy][s], 0) / parts.length,
  );
  reference[policy] = perScenario.reduce((a, b) => a + b, 0) / perScenario.length;
}

const curves = rounds.map((name) => {
  const lines = readFileSync(`ai/runs/${name}/progress.csv`, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const x = head.indexOf('time/total_timesteps');
  const y = head.indexOf('rollout/ep_rew_mean');
  const points = lines
    .slice(1)
    .map((l) => l.split(','))
    .filter((r) => r[y] !== '' && Number.isFinite(Number(r[y])))
    .map((r) => [Number(r[x]), Number(r[y])]);
  return { name, points };
});

const csv = ['rodada,decisoes,retorno_medio_100_episodios'];
for (const c of curves) for (const [x, y] of c.points) csv.push(`${c.name},${x},${y.toFixed(1)}`);
csv.push(
  `estatica,,${reference.static.toFixed(1)}`,
  `heuristica,,${reference.heuristic.toFixed(1)}`,
);
writeFileSync('docs/curvas-rl.csv', `${csv.join('\n')}\n`);

// Layout.
const W = 760;
const H = 380 + 20 * rounds.length;
const M = { left: 64, right: 172, top: 64 + 20 * rounds.length, bottom: 48 };
const xMax = Math.max(...curves.flatMap((c) => c.points.map((p) => p[0])));
const ys = [
  ...curves.flatMap((c) => c.points.map((p) => p[1])),
  reference.static,
  reference.heuristic,
];
const step = 1000;
const yMin = Math.floor(Math.min(...ys) / step) * step;
const yMax = Math.ceil(Math.max(...ys) / step) * step;
const px = (v) => M.left + (v / xMax) * (W - M.left - M.right);
const py = (v) => M.top + ((yMax - v) / (yMax - yMin)) * (H - M.top - M.bottom);
const num = (v) => Math.round(v).toLocaleString('pt-BR').replace('-', '−');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const out = [];
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`,
  `<title id="t">Curvas de aprendizado do agente de roteamento</title>`,
  `<desc id="d">Retorno médio dos últimos 100 episódios de treino ao longo das decisões do PPO, por rodada, com as referências do roteamento estático (${num(reference.static)}) e da heurística (${num(reference.heuristic)}). Os números estão em docs/curvas-rl.csv.</desc>`,
  `<style>text{font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;fill:${MUTED}}.t{fill:${TEXT};font-size:15px;font-weight:600}.v{fill:${TEXT}}</style>`,
  `<rect width="${W}" height="${H}" rx="8" fill="${SURFACE}"/>`,
  `<text class="t" x="${M.left}" y="28">Retorno médio por episódio durante o treino</text>`,
  `<text x="${M.left}" y="48">média dos últimos 100 episódios · seeds de treino · maior é melhor (menos pacotes esperando)</text>`,
);
// Grid and y labels.
for (let v = yMin; v <= yMax; v += step) {
  out.push(
    `<line x1="${M.left}" x2="${W - M.right}" y1="${py(v)}" y2="${py(v)}" stroke="${GRID}" stroke-width="1"/>`,
    `<text x="${M.left - 8}" y="${py(v) + 4}" text-anchor="end">${num(v)}</text>`,
  );
}
// x axis.
out.push(
  `<line x1="${M.left}" x2="${W - M.right}" y1="${H - M.bottom}" y2="${H - M.bottom}" stroke="${AXIS}" stroke-width="1"/>`,
);
for (let v = 0; v <= xMax + 1; v += 500_000) {
  const label = v === 0 ? '0' : `${(v / 1e6).toLocaleString('pt-BR')} mi`;
  out.push(`<text x="${px(v)}" y="${H - M.bottom + 18}" text-anchor="middle">${label}</text>`);
}
out.push(
  `<text x="${(M.left + W - M.right) / 2}" y="${H - 10}" text-anchor="middle">decisões de treino do PPO</text>`,
);
// Reference lines, labelled at the right edge.
for (const [policy, label] of [
  ['heuristic', 'heurística'],
  ['static', 'roteamento estático'],
]) {
  const y = py(reference[policy]);
  out.push(
    `<line x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}" stroke="${REFERENCE}" stroke-width="1.5"/>`,
    `<text class="v" x="${W - M.right + 8}" y="${y + 4}">${label} ${num(reference[policy])}</text>`,
  );
}
// Rounds: 2px lines, legend row above the plot, value at the end of each line.
curves.forEach((c, i) => {
  const color = SERIES[i % SERIES.length];
  const d = c.points
    .map(([x, y], k) => `${k ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`)
    .join('');
  out.push(
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
  );
  const [lx, ly] = c.points[c.points.length - 1];
  out.push(
    `<circle cx="${px(lx)}" cy="${py(ly)}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`,
  );
  // Legend: one row per round, a line key in the round's color (the text keeps the text color).
  const legendY = 66 + i * 20;
  out.push(
    `<line x1="${M.left}" x2="${M.left + 18}" y1="${legendY}" y2="${legendY}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`,
    `<text class="v" x="${M.left + 24}" y="${legendY + 4}">${esc(LABEL[c.name] ?? c.name)}: ${num(ly)} no fim</text>`,
  );
});
out.push('</svg>');
writeFileSync('docs/curvas-rl.svg', `${out.join('\n')}\n`);
console.log(
  `docs/curvas-rl.svg e docs/curvas-rl.csv: ${rounds.join(', ')}; referências estática ${num(reference.static)}, heurística ${num(reference.heuristic)}`,
);
