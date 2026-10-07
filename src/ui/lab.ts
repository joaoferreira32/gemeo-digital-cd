import { LabPool, type LabOutcome, type WorkerLike } from '../lab/pool';
import {
  DEFAULT_SCENARIO,
  LAB_FIRST_SEED,
  LAB_SECONDS,
  type LabMetrics,
  type LabScenario,
} from '../lab/run';
import { estimate, pairedDifference } from '../lab/stats';
import { HOURS_PER_WEEK, WEEKDAYS } from '../sim/demand';
import { html, niceCeil, svg } from './viz';

/**
 * The scenario lab ("e se…?", key B): two scenarios side by side, run on the
 * same seeds in a pool of Web Workers, compared with means, 95% intervals and
 * the paired difference seed by seed. The chart fills in as the runs finish.
 *
 * Colors of the two scenarios: categorical slots 1 and 2 of the panels'
 * charts, checked with the dataviz palette validator on the panel surface
 * (#10161d): color-vision-deficiency separation ΔE 15.1, normal vision 21.3,
 * contrast above 3:1. Every mark also has its scenario in the legend, and the
 * values are in the tables, so color is never the only cue.
 */
export const SIDE_COLOR = { A: '#1fa9a0', B: '#c98500' } as const;
const SURFACE = '#10161d';
const GRID = '#212b35';
const CONNECTOR = '#4b5763';

type Side = 'A' | 'B';

interface Measure {
  readonly key: keyof LabMetrics;
  readonly label: string;
  readonly unit: string;
  /** Multiplier for display (shares as percentages). */
  readonly scale: number;
  readonly digits: number;
  readonly chart: boolean;
}

const MEASURES: readonly Measure[] = [
  { key: 'cycleMean', label: 'Tempo de ciclo médio', unit: 's', scale: 1, digits: 1, chart: true },
  { key: 'cycleP95', label: 'p95 do ciclo', unit: 's', scale: 1, digits: 1, chart: true },
  { key: 'waitP95', label: 'p95 de espera', unit: 's', scale: 1, digits: 1, chart: true },
  { key: 'throughput', label: 'Vazão', unit: 'pacotes/min', scale: 1, digits: 1, chart: true },
  { key: 'beltUse', label: 'Uso das esteiras', unit: '%', scale: 100, digits: 1, chart: true },
  { key: 'dockUse', label: 'Uso das docas', unit: '%', scale: 100, digits: 1, chart: false },
  { key: 'robotUse', label: 'Uso dos robôs', unit: '%', scale: 100, digits: 1, chart: false },
];

export interface LabPanelOptions {
  /** "Esteira 3 (A2→A3)", by belt id. */
  readonly conveyorLabels: readonly string[];
  /** The routing network, without extension. */
  readonly modelUrl: string;
  /** public/demanda-olist.json. */
  readonly demandUrl: string;
  readonly spawn: () => WorkerLike;
  /** Logical processors of the machine (navigator.hardwareConcurrency). */
  readonly cores: number;
}

const number = (v: number, digits: number) =>
  Number.isFinite(v)
    ? v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';

export class LabPanel {
  private readonly root: HTMLElement;
  private readonly forms: Record<Side, HTMLFieldSetElement>;
  private readonly seeds: HTMLSelectElement;
  private readonly workers: HTMLSelectElement;
  private readonly weekday: HTMLSelectElement;
  private readonly runButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly results: HTMLElement;
  private pool: LabPool | null = null;
  private weights: Promise<number[]> | null = null;
  /** Results of the last comparison: per side, per seed (null while running). */
  private outcome: Record<Side, (LabMetrics | null)[]> = { A: [], B: [] };
  private errors: string[] = [];
  private seedList: number[] = [];
  private shown: Record<Side, LabScenario> = { A: DEFAULT_SCENARIO, B: DEFAULT_SCENARIO };
  private frame = 0;

  constructor(
    root: HTMLElement,
    private readonly options: LabPanelOptions,
  ) {
    this.root = root;
    root.replaceChildren();
    const head = html('div', 'kpi__head');
    head.append(html('h2', 'kpi__title', 'Laboratório: e se…?'));
    const close = html('button', 'panel-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar o laboratório');
    close.addEventListener('click', () => this.toggle(false));
    head.append(close);
    root.append(
      head,
      html(
        'p',
        'kpi__note muted',
        `Dois cenários nas mesmas seeds: cada seed dá aos dois os mesmos pedidos e os mesmos sorteios, ` +
          `então a diferença seed a seed é do cenário, não da sorte. Cada rodada simula um dia ` +
          `(${LAB_SECONDS / 60} minutos simulados; uma hora da demanda da Olist dura um minuto) ` +
          `e roda em segundo plano, sem parar a simulação da tela.`,
      ),
    );

    const sides = html('div', 'lab__sides');
    this.forms = {
      A: this.scenarioForm('A', DEFAULT_SCENARIO),
      B: this.scenarioForm('B', { ...DEFAULT_SCENARIO, demand: 'olist' }),
    };
    sides.append(this.forms.A, this.forms.B);
    root.append(sides);

    const run = html('div', 'lab__run');
    this.seeds = this.select('Seeds', [
      ['5', '5'],
      ['10', '10'],
      ['20', '20'],
    ]);
    this.seeds.value = '10';
    const auto = Math.max(1, Math.min(8, options.cores - 1));
    this.workers = this.select('Workers', [
      ['auto', `automático (${auto})`],
      ['1', '1'],
      ['2', '2'],
      ['4', '4'],
      ['8', '8'],
    ]);
    this.weekday = this.select(
      'Dia da demanda Olist',
      WEEKDAYS.map((d, i) => [String(i), d] as [string, string]),
    );
    this.runButton = html('button', 'lab__go', 'Rodar comparação');
    this.runButton.type = 'button';
    this.runButton.addEventListener('click', () => void this.run());
    this.cancelButton = html('button', '', 'Cancelar');
    this.cancelButton.type = 'button';
    this.cancelButton.disabled = true;
    this.cancelButton.addEventListener('click', () => this.cancel());
    for (const s of [this.seeds, this.workers, this.weekday])
      run.append(s.parentElement as HTMLElement);
    run.append(this.runButton, this.cancelButton);
    root.append(run);

    const progress = html('div', 'lab__progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Rodadas concluídas');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    this.bar = html('span', 'lab__bar');
    progress.append(this.bar);
    this.status = html('p', 'kpi__note muted');
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = `Seeds a partir de ${number(LAB_FIRST_SEED, 0)}, fora dos conjuntos de treino, validação e teste.`;
    this.results = html('div', 'lab__results');
    root.append(progress, this.status, this.results);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  toggle(force?: boolean): boolean {
    const open = force ?? !this.open;
    this.root.hidden = !open;
    document.getElementById('btn-lab')?.setAttribute('aria-expanded', String(open));
    if (open) this.runButton.focus();
    return open;
  }

  private select(
    label: string,
    options: readonly (readonly [string, string])[],
  ): HTMLSelectElement {
    const wrap = html('label', 'lab__field');
    wrap.append(html('span', 'muted', label));
    const s = html('select', '');
    for (const [value, text] of options) {
      const o = html('option', '', text);
      o.value = value;
      s.append(o);
    }
    wrap.append(s);
    return s;
  }

  private scenarioForm(side: Side, s: LabScenario): HTMLFieldSetElement {
    const f = html('fieldset', 'lab__side');
    const legend = html('legend', '');
    const key = html('span', 'lab__key');
    key.style.background = SIDE_COLOR[side];
    legend.append(key, `Cenário ${side}`);
    f.append(legend);
    const field = (label: string, input: HTMLElement) => {
      const wrap = html('label', 'lab__field');
      wrap.append(html('span', 'muted', label), input);
      f.append(wrap);
    };
    const num = (name: string, value: number, min: number, max: number, step: number) => {
      const i = html('input', '');
      i.type = 'number';
      i.name = name;
      i.min = String(min);
      i.max = String(max);
      i.step = String(step);
      i.value = String(value);
      return i;
    };
    const choice = (
      name: string,
      value: string,
      options: readonly (readonly [string, string])[],
    ) => {
      const sel = html('select', '');
      sel.name = name;
      for (const [v, text] of options) {
        const o = html('option', '', text);
        o.value = v;
        sel.append(o);
      }
      sel.value = value;
      return sel;
    };
    const check = (name: string, value: boolean) => {
      const i = html('input', '');
      i.type = 'checkbox';
      i.name = name;
      i.checked = value;
      return i;
    };
    field('Robôs', num('robots', s.robots, 0, 40, 1));
    field(
      'Velocidade das esteiras',
      choice('conveyorSpeed', String(s.conveyorSpeed), [
        ['1.5', '1,5 m/s'],
        ['2', '2,0 m/s'],
        ['2.5', '2,5 m/s'],
      ]),
    );
    field(
      'Esteira parada o dia todo',
      choice('brokenConveyor', String(s.brokenConveyor), [
        ['-1', 'nenhuma'],
        ...this.options.conveyorLabels.map((l, i) => [String(i), l] as [string, string]),
      ]),
    );
    field('Pedidos por segundo (média do dia)', num('arrivalRate', s.arrivalRate, 0.5, 8, 0.1));
    field(
      'Demanda',
      choice('demand', s.demand, [
        ['constante', 'constante'],
        ['olist', 'Olist, hora a hora'],
      ]),
    );
    field(
      'Roteamento',
      choice('policy', s.policy, [
        ['heuristic', 'heurística (oficial)'],
        ['static', 'estático'],
        ['rl', 'IA treinada (PPO)'],
      ]),
    );
    field('Falhas automáticas', check('autoFailures', s.autoFailures));
    field('Agenda de manutenção', check('maintenance', s.maintenance));
    return f;
  }

  private read(side: Side): LabScenario {
    const f = this.forms[side];
    const get = (name: string) => f.querySelector(`[name="${name}"]`) as HTMLInputElement;
    const clamp = (v: number, lo: number, hi: number, fallback: number) =>
      Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    return {
      robots: Math.round(clamp(Number(get('robots').value), 0, 40, DEFAULT_SCENARIO.robots)),
      conveyorSpeed: Number(get('conveyorSpeed').value),
      brokenConveyor: Number(get('brokenConveyor').value),
      arrivalRate: clamp(Number(get('arrivalRate').value), 0.5, 8, DEFAULT_SCENARIO.arrivalRate),
      demand: get('demand').value === 'olist' ? 'olist' : 'constante',
      policy: get('policy').value as LabScenario['policy'],
      autoFailures: get('autoFailures').checked,
      maintenance: get('maintenance').checked,
    };
  }

  private loadWeights(): Promise<number[]> {
    this.weights ??= fetch(this.options.demandUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`perfil da Olist não encontrado (${r.status})`);
        return r.json() as Promise<{ weights: number[] }>;
      })
      .then((p) => {
        if (p.weights.length !== HOURS_PER_WEEK) throw new Error('perfil da Olist inválido');
        return p.weights;
      });
    return this.weights;
  }

  private async run(): Promise<void> {
    const A = this.read('A');
    const B = this.read('B');
    const n = Number(this.seeds.value);
    const size =
      this.workers.value === 'auto'
        ? Math.max(1, Math.min(8, this.options.cores - 1))
        : Number(this.workers.value);
    const startHour = Number(this.weekday.value) * 24;
    this.seedList = Array.from({ length: n }, (_, i) => LAB_FIRST_SEED + i);
    this.outcome = { A: new Array(n).fill(null), B: new Array(n).fill(null) };
    this.errors = [];
    this.shown = { A, B };
    this.setRunning(true);
    this.status.textContent = 'Preparando…';
    let weights: number[] | undefined;
    try {
      if (A.demand === 'olist' || B.demand === 'olist') weights = await this.loadWeights();
    } catch (err) {
      this.weights = null;
      this.status.textContent = `Não foi possível rodar: ${(err as Error).message}`;
      this.setRunning(false);
      return;
    }
    if (this.pool?.size !== size) {
      this.pool?.dispose();
      this.pool = new LabPool(size, this.options.spawn);
    }
    const jobs = this.seedList.flatMap((seed) =>
      (['A', 'B'] as const).map((side) => {
        const scenario = side === 'A' ? A : B;
        return {
          scenario,
          seed,
          seconds: LAB_SECONDS,
          ...(scenario.demand === 'olist' && weights ? { weights, startHour } : {}),
          ...(scenario.policy === 'rl' ? { modelUrl: this.options.modelUrl } : {}),
        };
      }),
    );
    const started = performance.now();
    const tick = (done: number, total: number) => {
      const seconds = (performance.now() - started) / 1000;
      this.bar.style.width = `${(done / total) * 100}%`;
      this.bar.parentElement?.setAttribute(
        'aria-valuenow',
        String(Math.round((done / total) * 100)),
      );
      this.status.textContent = `${done} de ${total} rodadas · ${size} ${size === 1 ? 'worker' : 'workers'} · ${number(seconds, 1)} s`;
    };
    tick(0, jobs.length);
    this.renderResults();
    try {
      await this.pool.run(jobs, (done, total, index, out: LabOutcome) => {
        const side: Side = index % 2 === 0 ? 'A' : 'B';
        const seed = Math.floor(index / 2);
        if ('metrics' in out) this.outcome[side][seed] = out.metrics;
        else
          this.errors.push(
            `seed ${number(this.seedList[seed] as number, 0)}, cenário ${side}: ${out.error}`,
          );
        tick(done, total);
        this.scheduleRender();
      });
      const seconds = (performance.now() - started) / 1000;
      this.status.textContent =
        `${jobs.length} rodadas em ${number(seconds, 1)} s com ${size} ${size === 1 ? 'worker' : 'workers'}` +
        (this.errors.length ? ` · ${this.errors.length} com erro` : '');
    } catch {
      this.status.textContent = 'Comparação cancelada.';
    }
    this.setRunning(false);
    this.renderResults();
  }

  private cancel(): void {
    this.pool?.cancel();
  }

  private setRunning(running: boolean): void {
    this.runButton.disabled = running;
    this.cancelButton.disabled = !running;
    for (const f of Object.values(this.forms)) f.disabled = running;
  }

  private scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderResults();
    });
  }

  private renderResults(): void {
    const out = this.outcome;
    const table = html('table', 'kpi__table lab__table');
    const row = (cells: (string | Node)[], tag: 'th' | 'td' = 'td') => {
      const tr = html('tr', '');
      for (const c of cells) {
        const cell = html(tag, '');
        cell.append(c);
        tr.append(cell);
      }
      return tr;
    };
    const keyed = (side: Side) => {
      const span = html('span', '');
      const key = html('span', 'lab__key');
      key.style.background = SIDE_COLOR[side];
      span.append(key, `Cenário ${side}`);
      return span;
    };
    table.append(
      row(['Medida', keyed('A'), keyed('B'), 'B − A (IC 95%)', 'Seeds: B menor / maior'], 'th'),
    );
    for (const m of MEASURES) {
      const values = (side: Side) =>
        out[side].map((x) => (x ? (x[m.key] as number) * m.scale : NaN));
      const a = estimate(values('A'));
      const b = estimate(values('B'));
      const d = pairedDifference(values('A'), values('B'));
      const fmt = (e: { mean: number; low: number; high: number; n: number }) =>
        e.n === 0
          ? '—'
          : e.n === 1
            ? number(e.mean, m.digits)
            : `${number(e.mean, m.digits)} (${number(e.low, m.digits)} a ${number(e.high, m.digits)})`;
      const signed = (v: number) =>
        (v > 0 ? '+' : v < 0 ? '−' : '') + number(Math.abs(v), m.digits);
      table.append(
        row([
          `${m.label} (${m.unit})`,
          fmt(a),
          fmt(b),
          d.n === 0
            ? '—'
            : d.n === 1
              ? signed(d.mean)
              : `${signed(d.mean)} (${signed(d.low)} a ${signed(d.high)})`,
          d.n ? `${d.lower} / ${d.higher} de ${d.n}` : '—',
        ]),
      );
    }

    const legend = html('p', 'lab__legend');
    legend.append(keyed('A'), keyed('B'));
    legend.append(
      html('span', 'muted', 'cada linha é uma seed; no alto, a média com o intervalo de 95%'),
    );
    const charts = html('div', 'lab__charts');
    for (const m of MEASURES.filter((x) => x.chart)) charts.append(this.chart(m));

    const perSeed = html('details', 'lab__perseed');
    perSeed.append(html('summary', '', 'Valores por seed'));
    const t = html('table', 'kpi__table lab__table mono');
    t.append(row(['Seed', ...MEASURES.flatMap((m) => [`${m.label} A`, `${m.label} B`])], 'th'));
    this.seedList.forEach((seed, i) => {
      t.append(
        row([
          number(seed, 0),
          ...MEASURES.flatMap((m) =>
            (['A', 'B'] as const).map((side) => {
              const x = out[side][i];
              return x ? number((x[m.key] as number) * m.scale, m.digits) : '…';
            }),
          ),
        ]),
      );
    });
    perSeed.append(t);

    const notes: HTMLElement[] = [];
    const scenarioNote = (side: Side) => {
      const s = this.shown[side];
      const parts = [
        `${s.robots} robôs`,
        `${number(s.conveyorSpeed, 1)} m/s`,
        s.brokenConveyor >= 0
          ? `${this.options.conveyorLabels[s.brokenConveyor]} parada`
          : 'nenhuma esteira parada',
        `${number(s.arrivalRate, 1)} pedidos/s em média`,
        s.demand === 'olist' ? 'demanda da Olist' : 'demanda constante',
        s.policy === 'heuristic' ? 'heurística' : s.policy === 'static' ? 'estático' : 'IA (PPO)',
        s.autoFailures ? 'com falhas automáticas' : 'sem falhas',
        s.maintenance ? 'com agenda de manutenção' : 'sem agenda de manutenção',
      ];
      const p = html('p', 'kpi__note');
      p.append(keyed(side), `: ${parts.join(' · ')}`);
      return p;
    };
    if (this.seedList.length) notes.push(scenarioNote('A'), scenarioNote('B'));
    for (const e of this.errors) notes.push(html('p', 'kpi__note lab__error', e));
    this.results.replaceChildren(
      ...(this.seedList.length ? [table, legend, charts, perSeed] : []),
      ...notes,
    );
  }

  /**
   * One measure: a dumbbell per seed (A and B on one axis, joined), and on top
   * the mean of each scenario with its 95% interval. One axis per chart.
   */
  private chart(m: Measure): HTMLElement {
    const wrap = html('figure', 'lab__chart');
    wrap.append(html('figcaption', '', `${m.label} · ${m.unit}`));
    const value = (side: Side, i: number) => {
      const x = this.outcome[side][i];
      return x ? (x[m.key] as number) * m.scale : NaN;
    };
    const n = this.seedList.length;
    const all: number[] = [];
    const means = {
      A: estimate(this.outcome.A.map((_, i) => value('A', i))),
      B: estimate(this.outcome.B.map((_, i) => value('B', i))),
    };
    for (let i = 0; i < n; i++) all.push(value('A', i), value('B', i));
    for (const e of Object.values(means)) {
      if (Number.isFinite(e.low)) all.push(e.low, e.high);
      else if (Number.isFinite(e.mean)) all.push(e.mean);
    }
    const finite = all.filter((v) => Number.isFinite(v));
    const W = 360;
    const left = 40;
    const right = 14;
    const top = 8;
    const meanRows = 2;
    const rowH = 9;
    const H = top + meanRows * 14 + 10 + n * rowH + 24;
    const chart = svg('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'lab__svg',
      role: 'img',
    });
    const summary = (['A', 'B'] as const)
      .map((s) =>
        means[s].n
          ? `cenário ${s}: média ${number(means[s].mean, m.digits)}`
          : `cenário ${s}: sem resultado ainda`,
      )
      .join('; ');
    chart.setAttribute(
      'aria-label',
      `${m.label} (${m.unit}), ${summary}. Valores por seed na tabela abaixo.`,
    );
    wrap.append(chart);
    if (!finite.length) return wrap;
    let lo = Math.min(...finite);
    let hi = Math.max(...finite);
    if (m.unit === '%') {
      lo = 0;
      hi = Math.min(100, Math.max(hi, 10));
    } else {
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
      lo = Math.max(0, lo - pad);
      hi = hi + pad;
    }
    const step = niceCeil((hi - lo) / 3);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (v: number) => left + ((v - lo) / (hi - lo)) * (W - left - right);
    // As many decimals as the step needs (a step of 1.5 must not print 217.5 as 218).
    let decimals = 0;
    while (
      decimals < 3 &&
      Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6
    ) {
      decimals++;
    }
    const plotBottom = H - 18;
    // Recessive solid hairlines and the axis labels (text tokens, never the series colors).
    for (let v = lo; v <= hi + step * 1e-6; v += step) {
      chart.append(
        svg('line', {
          x1: x(v),
          x2: x(v),
          y1: top,
          y2: plotBottom,
          stroke: GRID,
          'stroke-width': 1,
        }),
      );
      const t = svg('text', { x: x(v), y: H - 5, class: 'lab__tick', 'text-anchor': 'middle' });
      t.textContent = number(v, decimals);
      chart.append(t);
    }
    const dot = (cx: number, cy: number, color: string, r: number) =>
      svg('circle', { cx, cy, r, fill: color, stroke: SURFACE, 'stroke-width': 2 });
    (['A', 'B'] as const).forEach((side, k) => {
      const e = means[side];
      const y = top + 6 + k * 14;
      const label = svg('text', { x: 4, y: y + 3, class: 'lab__tick' });
      label.textContent = `média ${side}`;
      chart.append(label);
      if (!e.n) return;
      if (Number.isFinite(e.low) && Number.isFinite(e.high)) {
        chart.append(
          svg('line', {
            x1: x(Math.max(lo, e.low)),
            x2: x(Math.min(hi, e.high)),
            y1: y,
            y2: y,
            stroke: SIDE_COLOR[side],
            'stroke-width': 2,
            'stroke-linecap': 'round',
          }),
        );
      }
      chart.append(dot(x(e.mean), y, SIDE_COLOR[side], 5));
      // The value on the dot's own row, past the end of its interval (before it when there is
      // no room): the two means never stack on each other, however close they are.
      const end = x(Math.min(hi, Number.isFinite(e.high) ? e.high : e.mean)) + 8;
      const start = x(Math.max(lo, Number.isFinite(e.low) ? e.low : e.mean)) - 8;
      const after = end <= W - right - 32 || start < left + 40;
      const v = svg('text', {
        x: after ? end : start,
        y: y + 3.5,
        class: 'lab__value',
        'text-anchor': after ? 'start' : 'end',
      });
      v.textContent = number(e.mean, m.digits);
      chart.append(v);
    });
    const first = top + meanRows * 14 + 14;
    for (let i = 0; i < n; i++) {
      const y = first + i * rowH;
      const a = value('A', i);
      const b = value('B', i);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        chart.append(
          svg('line', {
            x1: x(a),
            x2: x(b),
            y1: y,
            y2: y,
            stroke: CONNECTOR,
            'stroke-width': 2,
            'stroke-linecap': 'round',
          }),
        );
      }
      for (const side of ['A', 'B'] as const) {
        const v = side === 'A' ? a : b;
        if (!Number.isFinite(v)) continue;
        chart.append(dot(x(v), y, SIDE_COLOR[side], 4));
        // The hover target is bigger than the 4 px dot; the value leads the tooltip.
        const hit = svg('circle', { cx: x(v), cy: y, r: 10, fill: 'transparent' });
        const tip = svg('title');
        tip.textContent = `${number(v, m.digits)} ${m.unit} · cenário ${side} · seed ${number(this.seedList[i] as number, 0)}`;
        hit.append(tip);
        chart.append(hit);
      }
    }
    return wrap;
  }
}
