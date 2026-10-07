import { ROBOT_STAGES, type RobotStage } from '../sim/fleet';
import type { WarehouseLayout } from '../sim/layout';
import type { Kpis } from '../sim/recorder';
import type { MaintenanceStatus, RoutingStatus } from '../worker/protocol';
import type { Measures, PolicyChoice } from '../worker/routing';
import { formatInt, formatRate, formatSeconds } from './format';
import {
  STATE_GROUPS,
  SERIES,
  formatAgo,
  formatMinSec,
  html,
  meter,
  niceCeil,
  percent,
  stateGroupOf,
  svg,
  useColor,
} from './viz';

const W = 360;
const H = 54;

interface Mini {
  readonly key: keyof Kpis['chart'];
  readonly title: string;
  readonly unit: string;
  readonly digits: number;
}

/** Three measures with different scales: three small charts, never a second y-axis. */
const MINIS: readonly Mini[] = [
  { key: 'throughput', title: 'Vazão', unit: 'entregas no último minuto', digits: 0 },
  { key: 'waiting', title: 'Pacotes na fila', unit: 'pacotes', digits: 0 },
  { key: 'busyRobots', title: 'Robôs trabalhando', unit: 'robôs', digits: 0 },
];

/**
 * Operations panel (key K). Everything is computed in the simulation worker
 * for the moment shown (live or past); the panel only draws it.
 */
export class KpiPanel {
  readonly root: HTMLElement;
  private readonly tiles: HTMLElement;
  private readonly routing: HTMLElement;
  private readonly maintenance: HTMLElement;
  private maintenanceStatus: MaintenanceStatus | null = null;
  private routingStatus: { r: RoutingStatus; labels: Record<PolicyChoice, string> } | null = null;
  private readonly when: HTMLElement;
  private readonly states: HTMLElement;
  private readonly charts: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly tableToggle: HTMLButtonElement;
  private readonly docks: HTMLElement;
  private readonly belts: HTMLElement;
  private readonly robots: HTMLElement;
  private readonly robotSummary: HTMLElement;
  private readonly svgs: SVGSVGElement[] = [];
  private kpis: Kpis | null = null;
  private last: { stages: readonly number[]; time: number; past: boolean } | null = null;
  /** Crosshair position (index in the window) or -1. */
  private cursor = -1;
  /** Called when a robot or conveyor is chosen in the panel (opens its history). */
  onPick: (entity: string) => void = () => undefined;

  constructor(
    root: HTMLElement,
    private readonly layout: WarehouseLayout,
  ) {
    this.root = root;
    root.replaceChildren();
    const head = html('div', 'kpi__head');
    head.append(html('h2', 'kpi__title', 'Operação'), (this.when = html('p', 'kpi__when muted')));
    const close = html('button', 'panel-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar painel de operação');
    close.addEventListener('click', () => this.toggle(false));
    head.append(close);
    root.append(head);

    this.tiles = html('div', 'kpi__tiles');
    root.append(this.tiles);

    root.append(html('h3', 'kpi__section', 'Roteamento'));
    this.routing = html('div', 'kpi__routing');
    root.append(this.routing);

    root.append(html('h3', 'kpi__section', 'Manutenção preditiva'));
    this.maintenance = html('div', 'kpi__routing');
    root.append(this.maintenance);

    root.append(html('h3', 'kpi__section', 'Robôs agora'));
    this.states = html('div', 'states');
    root.append(this.states);

    const chartHead = html('div', 'kpi__chart-head');
    chartHead.append(html('h3', 'kpi__section', 'Últimos 5 minutos'));
    this.tableToggle = html('button', 'link-button', 'Ver tabela');
    this.tableToggle.type = 'button';
    this.tableToggle.setAttribute('aria-expanded', 'false');
    this.tableToggle.addEventListener('click', () => {
      const open = this.table.hidden;
      this.table.hidden = !open;
      this.tableToggle.setAttribute('aria-expanded', String(open));
      this.tableToggle.textContent = open ? 'Ver gráficos' : 'Ver tabela';
      this.charts.hidden = open;
      if (open) this.renderTable();
    });
    chartHead.append(this.tableToggle);
    root.append(chartHead);
    this.charts = html('div', 'minis');
    this.charts.tabIndex = 0;
    this.charts.setAttribute('role', 'group');
    this.charts.setAttribute(
      'aria-label',
      'Gráficos dos últimos 5 minutos. Setas para a esquerda e para a direita percorrem os valores.',
    );
    for (const m of MINIS) {
      const block = html('div', 'mini');
      const title = html('p', 'mini__title');
      title.append(
        html('span', '', m.title),
        html('span', 'muted', ` · ${m.unit}`),
        html('span', 'mini__value mono'),
      );
      const chart = svg('svg', {
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        class: 'mini__svg',
        'aria-hidden': 'true',
      });
      this.svgs.push(chart);
      const plot = html('div', 'mini__plot');
      plot.append(chart, html('span', 'mini__top mono muted'));
      block.append(title, plot);
      this.charts.append(block);
    }
    const axis = html('p', 'mini__axis mono muted');
    axis.append(html('span', '', '−5:00'), html('span', '', '−2:30'), html('span', '', 'agora'));
    this.charts.append(axis);
    this.tooltip = html('div', 'viz-tooltip');
    this.tooltip.hidden = true;
    this.charts.append(this.tooltip);
    root.append(this.charts);
    this.table = html('table', 'kpi__table mono');
    this.table.hidden = true;
    root.append(this.table);
    this.bindCrosshair();

    root.append(html('h3', 'kpi__section', 'Docas · entregas ÷ capacidade de serviço'));
    this.docks = html('div', 'meters');
    root.append(this.docks);
    root.append(html('h3', 'kpi__section', 'Esteiras mais ocupadas · fluxo ÷ capacidade'));
    this.belts = html('div', 'meters');
    root.append(this.belts);
    root.append(html('h3', 'kpi__section', 'Robôs · tempo trabalhando'));
    this.robotSummary = html('p', 'kpi__note');
    this.robots = html('div', 'cells');
    const scale = html('p', 'scale mono muted');
    const bar = html('span', 'scale__bar');
    bar.style.background = `linear-gradient(90deg, ${useColor(0)}, ${useColor(1)})`;
    scale.append(html('span', '', '0%'), bar, html('span', '', '100%'));
    root.append(this.robotSummary, this.robots, scale);
    root.append(
      html(
        'p',
        'kpi__note muted',
        'Utilização nos últimos 5 minutos simulados. Clique numa esteira, num robô ou na cena para ver o histórico.',
      ),
    );
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  toggle(force?: boolean): boolean {
    const open = force ?? !this.open;
    this.root.hidden = !open;
    document.getElementById('btn-kpi')?.setAttribute('aria-expanded', String(open));
    if (open && this.kpis && this.last) {
      this.update(this.kpis, this.last.stages, this.last.time, this.last.past);
    }
    if (open && this.routingStatus) {
      this.updateRouting(this.routingStatus.r, this.routingStatus.labels);
    }
    if (open && this.maintenanceStatus) this.updateMaintenance(this.maintenanceStatus);
    return open;
  }

  update(k: Kpis, stages: readonly number[], shownTime: number, past: boolean): void {
    this.kpis = k;
    this.last = { stages, time: shownTime, past };
    if (!this.open) return;
    this.when.textContent = past
      ? `Revendo ${formatMinSec(shownTime)} da gravação`
      : `Ao vivo · ${formatMinSec(shownTime)}`;
    this.renderTiles(k);
    this.renderStates(stages);
    this.renderCharts(k);
    if (!this.table.hidden) this.renderTable();
    this.renderUse(k);
  }

  /** What the maintenance schedule has done so far in the run, and what it is doing now. */
  updateMaintenance(m: MaintenanceStatus): void {
    this.maintenanceStatus = m;
    if (!this.open) return;
    if (!m.enabled) {
      this.maintenance.replaceChildren(
        html('p', 'kpi__note muted', 'Agenda de manutenção desligada.'),
      );
      return;
    }
    const plural = (n: number, one: string, many: string) =>
      `${formatInt(n)} ${n === 1 ? one : many}`;
    const head = html('p', 'kpi__note');
    head.append(
      html('strong', '', plural(m.avoided, 'falha evitada', 'falhas evitadas')),
      html(
        'span',
        'muted',
        ` · ${plural(m.unneeded, 'manutenção', 'manutenções')} sem desgaste encontrado · ` +
          `${plural(m.lost, 'quebra', 'quebras')} enquanto a manutenção esperava`,
      ),
    );
    const now: string[] = [];
    if (m.inService.length) now.push(`Em manutenção: ${m.inService.join(', ')}`);
    if (m.planned.length) now.push(`Esvaziando para a manutenção: ${m.planned.join(', ')}`);
    this.maintenance.replaceChildren(
      head,
      html(
        'p',
        'kpi__note muted',
        now.length
          ? now.join(' · ')
          : 'No alarme de um motor, a IA desvia o fluxo, esvazia a esteira e para para manutenção antes da quebra.',
      ),
    );
  }

  /**
   * Who routes, and the live comparison with a copy of the run that kept the
   * static routing from the moment of the switch (same seed and inputs).
   */
  updateRouting(r: RoutingStatus, labels: Record<PolicyChoice, string>): void {
    this.routingStatus = { r, labels };
    if (!this.open) return;
    const head = html('p', 'kpi__note');
    head.append(html('span', 'muted', 'Ativo: '), html('strong', '', labels[r.shown]));
    if (r.wanted !== r.shown && r.agent === 'loading') {
      head.append(html('span', 'muted', ' · carregando a IA…'));
    }
    if (r.decisions > 0) {
      const ms = r.decisionMs.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
      head.append(
        html(
          'span',
          'muted',
          ` · ${formatInt(r.decisions)} decisões da IA, ${ms} ms cada em média`,
        ),
      );
    }
    const c = r.compare;
    if (!c) {
      const why =
        r.shown === 'static'
          ? 'Com P, troque para a heurística ou para a IA: o painel compara ao vivo com uma cópia da simulação que segue no roteamento estático.'
          : 'A comparação ao vivo volta quando a simulação volta ao presente.';
      this.routing.replaceChildren(head, html('p', 'kpi__note muted', why));
      return;
    }
    const table = html('table', 'kpi__table mono');
    const row = (cells: string[], tag: 'th' | 'td' = 'td') => {
      const tr = html('tr', '');
      for (const text of cells) tr.append(html(tag, '', text));
      return tr;
    };
    const diff = (a: number, b: number, lowerIsBetter: boolean, unit: string, digits = 0) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
      const d = a - b;
      const pct = b !== 0 ? ` (${d >= 0 ? '+' : '−'}${Math.abs((d / b) * 100).toFixed(0)}%)` : '';
      const better = lowerIsBetter ? d < 0 : d > 0;
      const sign = d >= 0 ? '+' : '−';
      return `${sign}${Math.abs(d).toFixed(digits)}${unit}${pct}${Math.abs(d) > 1e-9 ? (better ? ' ✓' : '') : ''}`;
    };
    const val = (m: Measures, k: keyof Measures, digits = 0) =>
      Number.isFinite(m[k]) ? m[k].toFixed(digits) : '—';
    table.append(
      row(['', labels[r.shown], 'Estático (cópia)', 'Diferença'], 'th'),
      row([
        'Ciclo médio (s)',
        val(c.live, 'cycle', 1),
        val(c.shadow, 'cycle', 1),
        diff(c.live.cycle, c.shadow.cycle, true, ' s', 1),
      ]),
      row([
        'Vazão (/min)',
        val(c.live, 'throughput', 1),
        val(c.shadow, 'throughput', 1),
        diff(c.live.throughput, c.shadow.throughput, false, '', 1),
      ]),
      row([
        'Na fila',
        val(c.live, 'waiting'),
        val(c.shadow, 'waiting'),
        diff(c.live.waiting, c.shadow.waiting, true, ''),
      ]),
      row([
        `Entregas desde ${formatMinSec(c.since)}`,
        val(c.live, 'delivered'),
        val(c.shadow, 'delivered'),
        diff(c.live.delivered, c.shadow.delivered, false, ''),
      ]),
    );
    this.routing.replaceChildren(
      head,
      table,
      html(
        'p',
        'kpi__note muted',
        'Ciclo médio e vazão dos últimos 2 min. A cópia recebe as mesmas falhas e o mesmo teste de carga; as falhas automáticas são sorteadas com a mesma semente.',
      ),
    );
  }

  private renderTiles(k: Kpis): void {
    const tile = (label: string, value: string, sub: string) => {
      const t = html('article', 'tile');
      t.append(html('h4', 'tile__label', label), html('p', 'tile__value', value));
      t.append(html('p', 'tile__sub muted', sub));
      return t;
    };
    this.tiles.replaceChildren(
      tile('Vazão', formatInt(k.throughput), 'entregas no último minuto'),
      tile('Ciclo médio', formatSeconds(k.cycleMean), 'do pedido à doca, 5 min'),
      tile('Ciclo p95', formatSeconds(k.cycleP95), '95% das entregas abaixo'),
      tile('Entregas', formatInt(k.deliveries), 'nos últimos 5 min'),
    );
  }

  private renderStates(stages: readonly number[]): void {
    const counts = STATE_GROUPS.map(() => 0);
    stages.forEach((n, i) => {
      counts[stateGroupOf(ROBOT_STAGES[i] as RobotStage)]! += n;
    });
    const bar = html('div', 'stack');
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      STATE_GROUPS.map((g, i) => `${g.label}: ${counts[i]}`).join(', '),
    );
    const legend = html('ul', 'legend-row');
    STATE_GROUPS.forEach((g, i) => {
      const n = counts[i] as number;
      if (n > 0) {
        const seg = html('span', 'stack__seg');
        seg.style.flexGrow = String(n);
        seg.style.background = g.color;
        seg.title = `${g.label}: ${n}`;
        bar.append(seg);
      }
      const item = html('li');
      const sw = html('span', 'swatch-dot');
      sw.style.background = g.color;
      item.append(sw, html('span', '', `${g.label} `), html('strong', 'mono', String(n)));
      legend.append(item);
    });
    this.states.replaceChildren(bar, legend);
  }

  private renderCharts(k: Kpis): void {
    MINIS.forEach((m, i) => {
      const data = k.chart[m.key];
      const chart = this.svgs[i] as SVGSVGElement;
      let max = 0;
      for (const v of data) max = Math.max(max, v);
      const top = niceCeil(max * 1.1);
      const n = data.length;
      const x = (j: number) => (j / Math.max(1, n - 1)) * W;
      const y = (v: number) => H - 2 - (v / top) * (H - 6);
      let line = '';
      for (let j = 0; j < n; j++)
        line += `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(data[j] as number).toFixed(1)}`;
      const area = `${line}L${W},${H - 2}L0,${H - 2}Z`;
      chart.replaceChildren(
        svg('line', { x1: 0, x2: W, y1: H - 2, y2: H - 2, class: 'grid' }),
        svg('line', { x1: 0, x2: W, y1: y(top), y2: y(top), class: 'grid' }),
        svg('path', { d: area, fill: SERIES.wash }),
        svg('path', { d: line, class: 'mini__line', stroke: SERIES.line }),
      );
      const block = chart.closest('.mini') as HTMLElement;
      (block.querySelector('.mini__top') as HTMLElement).textContent = formatInt(top);
      const last = data[n - 1] ?? 0;
      (block.querySelector('.mini__value') as HTMLElement).textContent = m.digits
        ? formatRate(last)
        : formatInt(last);
    });
    this.drawCursor();
  }

  private renderTable(): void {
    const k = this.kpis;
    if (!k) return;
    const n = k.chart.throughput.length;
    const rows: string[][] = [];
    for (let j = n - 1; j >= 0; j -= 30) {
      rows.push([
        formatAgo(n - 1 - j),
        formatRate(k.chart.throughput[j] as number),
        formatInt(k.chart.waiting[j] as number),
        formatInt(k.chart.busyRobots[j] as number),
      ]);
    }
    const head = html('thead');
    const hr = html('tr');
    for (const h of ['Quando', 'Vazão', 'Fila', 'Robôs']) hr.append(html('th', '', h));
    head.append(hr);
    const body = html('tbody');
    for (const r of rows) {
      const tr = html('tr');
      for (const c of r) tr.append(html('td', '', c));
      body.append(tr);
    }
    this.table.replaceChildren(head, body);
  }

  private renderUse(k: Kpis): void {
    this.docks.replaceChildren(...Array.from(k.dockUse, (u, d) => meter(`Doca ${d + 1}`, u)));
    const edges = this.layout.graph.edges;
    const top = Array.from(k.conveyorUse, (u, e) => ({ u, e }))
      .sort((a, b) => b.u - a.u || a.e - b.e)
      .slice(0, 8);
    this.belts.replaceChildren(
      ...top.map(({ u, e }) => {
        const edge = edges[e]!;
        const name = `E${e + 1} ${this.layout.graph.node(edge.from).name}→${this.layout.graph.node(edge.to).name}`;
        const row = meter(name, u);
        row.classList.add('meter--pick');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.addEventListener('click', () => this.onPick(`conveyor:${e}`));
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this.onPick(`conveyor:${e}`);
          }
        });
        return row;
      }),
    );
    const use = Array.from(k.robotUse);
    if (use.length) {
      const mean = use.reduce((a, b) => a + b, 0) / use.length;
      let lo = 0;
      let hi = 0;
      use.forEach((u, i) => {
        if (u < (use[lo] as number)) lo = i;
        if (u > (use[hi] as number)) hi = i;
      });
      this.robotSummary.textContent =
        `Média ${percent(mean)} · menos ocupado: Robô ${lo + 1} (${percent(use[lo] as number)})` +
        ` · mais ocupado: Robô ${hi + 1} (${percent(use[hi] as number)})`;
    }
    this.robots.replaceChildren(
      ...use.map((u, r) => {
        const cell = html('button', 'cell');
        cell.type = 'button';
        cell.style.background = useColor(u);
        cell.setAttribute('aria-label', `Robô ${r + 1}: ${percent(u)} do tempo trabalhando`);
        cell.title = `Robô ${r + 1}: ${percent(u)}`;
        cell.addEventListener('click', () => this.onPick(`robot:${r}`));
        return cell;
      }),
    );
  }

  private bindCrosshair(): void {
    const set = (clientX: number, target: Element) => {
      const box = target.getBoundingClientRect();
      const n = this.kpis?.chart.throughput.length ?? 0;
      if (!n) return;
      const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      this.cursor = Math.round(f * (n - 1));
      this.drawCursor();
    };
    for (const s of this.svgs) {
      s.addEventListener('pointermove', (e) => set(e.clientX, s));
    }
    this.charts.addEventListener('pointerleave', () => {
      this.cursor = -1;
      this.drawCursor();
    });
    this.charts.addEventListener('keydown', (e) => {
      const n = this.kpis?.chart.throughput.length ?? 0;
      if (!n) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const from = this.cursor < 0 ? n - 1 : this.cursor;
        const step = e.shiftKey ? 30 : 5;
        this.cursor = Math.min(n - 1, Math.max(0, from + (e.key === 'ArrowLeft' ? -step : step)));
        this.drawCursor();
      } else if (e.key === 'Escape') {
        this.cursor = -1;
        this.drawCursor();
      }
    });
    this.charts.addEventListener('blur', () => {
      this.cursor = -1;
      this.drawCursor();
    });
  }

  private drawCursor(): void {
    for (const s of this.svgs) s.querySelector('.cursor')?.remove();
    const k = this.kpis;
    if (this.cursor < 0 || !k) {
      this.tooltip.hidden = true;
      return;
    }
    const n = k.chart.throughput.length;
    const x = (this.cursor / Math.max(1, n - 1)) * W;
    for (const s of this.svgs) {
      s.append(svg('line', { x1: x, x2: x, y1: 0, y2: H, class: 'cursor' }));
    }
    const ago = n - 1 - this.cursor;
    this.tooltip.replaceChildren(html('strong', '', formatAgo(ago)));
    for (const m of MINIS) {
      const v = k.chart[m.key][this.cursor] as number;
      const row = html('span');
      row.append(
        html('span', 'muted', `${m.title} `),
        html('span', 'mono', m.digits ? formatRate(v) : formatInt(v)),
      );
      this.tooltip.append(row);
    }
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${Math.min(70, Math.max(0, (this.cursor / n) * 100 - 15))}%`;
  }
}
