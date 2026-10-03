import { ROBOT_STAGES, type RobotStage } from '../sim/fleet';
import type { EntityHistory } from '../worker/views';
import { formatInt } from './format';
import {
  STATE_GROUPS,
  SERIES,
  formatMinSec,
  html,
  meter,
  niceCeil,
  percent,
  stateGroupOf,
  svg,
} from './viz';

const W = 300;
const H = 60;
const BIN = 10;

/**
 * History of the robot, conveyor or dock clicked in the scene, for the
 * moment shown (live or past): what it is doing, how busy it was over the
 * last five minutes, and the events about it.
 */
export class HistoryPanel {
  /** Entity shown ("robot:3"), or null when closed. */
  entity: string | null = null;
  onClose: () => void = () => undefined;

  constructor(private readonly root: HTMLElement) {}

  show(entity: string): void {
    this.entity = entity;
    this.root.hidden = false;
    this.root.setAttribute('aria-busy', 'true');
  }

  close(): void {
    this.entity = null;
    this.root.hidden = true;
    this.onClose();
  }

  render(h: EntityHistory): void {
    if (h.entity !== this.entity) return;
    this.root.removeAttribute('aria-busy');
    const head = html('div', 'history__head');
    head.append(html('h2', 'history__title', h.label));
    const close = html('button', 'panel-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', `Fechar histórico de ${h.label}`);
    close.addEventListener('click', () => this.close());
    head.append(close);

    const status = html('p', 'history__status', h.status);
    const what =
      h.kind === 'robot'
        ? 'Tempo trabalhando'
        : h.kind === 'conveyor'
          ? 'Fluxo ÷ capacidade'
          : 'Entregas ÷ capacidade';
    const use = meter(what, h.use);
    const chartTitle = html(
      'h3',
      'kpi__section',
      h.kind === 'robot'
        ? 'Estado nos últimos 5 minutos'
        : `Pacotes a cada ${BIN} s, últimos 5 minutos`,
    );
    const chart = h.kind === 'robot' ? this.stateStrip(h) : this.columns(h);
    const axis = html('p', 'mini__axis mono muted');
    axis.append(
      html('span', '', '−5:00'),
      html('span', '', '−2:30'),
      html('span', '', formatMinSec(h.at)),
    );

    const list = html('ol', 'history__events');
    if (h.events.length === 0)
      list.append(html('li', 'history__empty muted', 'Nenhum evento até aqui.'));
    for (const e of h.events) {
      const li = html('li');
      li.dataset.kind = e.kind;
      li.append(html('span', 'mono muted', formatMinSec(e.time)), html('span', '', e.text));
      list.append(li);
    }
    this.root.replaceChildren(
      head,
      status,
      use,
      chartTitle,
      chart,
      axis,
      html('h3', 'kpi__section', 'Eventos'),
      list,
    );
  }

  /** One band per second, colored by state group, merged into runs; legend with each group's share. */
  private stateStrip(h: EntityHistory): HTMLElement {
    const wrap = html('div');
    const strip = svg('svg', {
      viewBox: `0 0 ${W} 18`,
      preserveAspectRatio: 'none',
      class: 'strip',
      role: 'img',
    });
    const n = h.series.length;
    const share = STATE_GROUPS.map(() => 0);
    let start = 0;
    const groupAt = (i: number) => {
      const v = h.series[i] as number;
      return v < 0 ? -1 : stateGroupOf(ROBOT_STAGES[v] as RobotStage);
    };
    for (let i = 1; i <= n; i++) {
      const g = groupAt(start);
      if (i < n && groupAt(i) === g) continue;
      if (g >= 0) {
        share[g]! += i - start;
        // A 1-unit gap in the surface color between runs keeps neighbors apart.
        const x = (start / n) * W;
        const w = Math.max(0.6, ((i - start) / n) * W - (i < n ? 0.8 : 0));
        strip.append(svg('rect', { x, y: 0, width: w, height: 18, fill: STATE_GROUPS[g]!.color }));
      }
      start = i;
    }
    const known = share.reduce((a, b) => a + b, 0) || 1;
    strip.setAttribute(
      'aria-label',
      STATE_GROUPS.map((g, i) => `${g.label} ${percent((share[i] as number) / known)}`).join(', '),
    );
    const legend = html('ul', 'legend-row');
    STATE_GROUPS.forEach((g, i) => {
      if (!share[i]) return;
      const li = html('li');
      const sw = html('span', 'swatch-dot');
      sw.style.background = g.color;
      li.append(
        sw,
        html('span', '', `${g.label} `),
        html('strong', 'mono', percent((share[i] as number) / known)),
      );
      legend.append(li);
    });
    wrap.append(strip, legend);
    return wrap;
  }

  /** Columns of packets per 10 s, one hue, a rounded data end, a clean top tick. */
  private columns(h: EntityHistory): HTMLElement {
    const wrap = html('div', 'columns');
    const bins: number[] = [];
    for (let i = 0; i < h.series.length; i += BIN) {
      let s = 0;
      for (let j = i; j < Math.min(h.series.length, i + BIN); j++) s += h.series[j] as number;
      bins.push(s);
    }
    const top = niceCeil(Math.max(1, ...bins));
    const chart = svg('svg', {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      class: 'mini__svg',
      role: 'img',
      'aria-label': `Pacotes a cada ${BIN} s: de ${formatInt(Math.min(...bins))} a ${formatInt(Math.max(...bins))}, agora ${formatInt(bins.at(-1) ?? 0)}`,
    });
    chart.append(svg('line', { x1: 0, x2: W, y1: H - 1, y2: H - 1, class: 'grid' }));
    const slot = W / bins.length;
    const bw = Math.min(slot - 2, 24);
    bins.forEach((v, i) => {
      if (v <= 0) return;
      const bh = (v / top) * (H - 4);
      const x = i * slot + (slot - bw) / 2;
      const r = Math.min(2, bh / 2);
      const y = H - 1 - bh;
      const bar = svg('path', {
        d: `M${x},${H - 1}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H - 1}Z`,
        fill: SERIES.line,
      });
      const t = svg('title');
      t.textContent = `${formatInt(v)} pacotes`;
      bar.append(t);
      chart.append(bar);
    });
    const scale = html('span', 'mini__top mono muted', formatInt(top));
    wrap.append(chart, scale);
    return wrap;
  }
}
