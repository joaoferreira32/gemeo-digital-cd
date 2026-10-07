import type { Timeline, TimelineMarker } from '../worker/views';
import { formatInt } from './format';
import { formatMinSec } from './viz';

/**
 * Marker colors: the scene's alert red for breakdowns (and a breakdown that
 * came while its maintenance waited), amber for surges and motor alarms,
 * cyan for the watchdog and for planned maintenance and the failures it avoided.
 */
const MARKER_COLOR: Record<TimelineMarker['kind'], string> = {
  conveyor: '#ff4d5e',
  robot: '#ff4d5e',
  dock: '#ff4d5e',
  stuck: '#ff4d5e',
  surge: '#f2a541',
  watchdog: '#38e1d6',
  maintenance: '#f2a541',
  service: '#38e1d6',
  avoided: '#38e1d6',
  lost: '#ff4d5e',
};

/** Markers drawn as dots (moments); the others are bars (intervals). */
const POINTS: ReadonlySet<TimelineMarker['kind']> = new Set([
  'watchdog',
  'maintenance',
  'avoided',
  'lost',
]);

export interface TimelineActions {
  seek(time: number): void;
  live(): void;
  branch(): void;
  exportCsv(): void;
  exportReport(): void;
  loadReport(file: File): void;
}

/**
 * The recording along the bottom of the screen. Dragging the handle shows a
 * past moment (the live run waits); "Ao vivo" goes back to the head;
 * "Continuar daqui", or any command given in the past, continues the run
 * from the moment shown on a new branch.
 */
export class TimelineBar {
  private readonly range: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly branchBtn: HTMLButtonElement;
  private readonly tooltip: HTMLElement;
  private data: Timeline | null = null;
  private dragging = false;
  private lastSent = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: TimelineActions,
  ) {
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.range = q<HTMLInputElement>('#tl-range');
    this.canvas = q<HTMLCanvasElement>('#tl-canvas');
    this.label = q('#tl-time');
    this.liveBtn = q<HTMLButtonElement>('#tl-live');
    this.branchBtn = q<HTMLButtonElement>('#tl-branch');
    this.tooltip = q('#tl-tooltip');

    this.range.addEventListener('input', () => {
      this.dragging = true;
      const now = performance.now();
      // A few seeks per second: each one restores a checkpoint in the worker.
      if (now - this.lastSent > 60) {
        this.lastSent = now;
        this.actions.seek(Number(this.range.value));
      }
      this.renderLabel(Number(this.range.value));
    });
    this.range.addEventListener('change', () => {
      this.dragging = false;
      this.actions.seek(Number(this.range.value));
    });
    this.liveBtn.addEventListener('click', () => this.actions.live());
    this.branchBtn.addEventListener('click', () => this.actions.branch());
    q('#tl-csv').addEventListener('click', () => this.actions.exportCsv());
    q('#tl-report').addEventListener('click', () => this.actions.exportReport());
    const file = q<HTMLInputElement>('#tl-file');
    q('#tl-load').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) this.actions.loadReport(f);
      file.value = '';
    });

    const track = q('.timeline__track');
    track.addEventListener('pointermove', (e) => this.hover(e.clientX));
    track.addEventListener('pointerleave', () => (this.tooltip.hidden = true));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  get viewing(): boolean {
    return this.data?.viewing ?? false;
  }

  get shown(): number {
    return this.data?.shown ?? 0;
  }

  get head(): number {
    return this.data?.head ?? 0;
  }

  update(t: Timeline): void {
    this.data = t;
    this.range.max = String(Math.max(1, Math.floor(t.head)));
    if (!this.dragging) this.range.value = String(Math.floor(t.shown));
    this.root.dataset.mode = t.viewing ? 'past' : 'live';
    this.liveBtn.disabled = !t.viewing;
    this.branchBtn.disabled = !t.viewing;
    this.renderLabel(this.dragging ? Number(this.range.value) : t.shown);
    this.draw();
  }

  private renderLabel(shown: number): void {
    const t = this.data;
    if (!t) return;
    const text = t.viewing
      ? `${formatMinSec(shown)} de ${formatMinSec(t.head)}${t.seeking ? ' · buscando…' : ''}`
      : `${formatMinSec(t.head)} · ao vivo`;
    this.label.textContent = text;
    this.range.setAttribute(
      'aria-valuetext',
      t.viewing
        ? `${formatMinSec(shown)} de ${formatMinSec(t.head)}, passado`
        : `${formatMinSec(t.head)}, ao vivo`,
    );
  }

  private draw(): void {
    const t = this.data;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g || !t) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const head = Math.max(1, t.head);
    const xOf = (sec: number) => (sec / head) * w;

    // Packets waiting over the run: a quiet wash with a hairline on top.
    const top = 9;
    const base = h - 2;
    const n = t.strip.length;
    if (n > 0) {
      g.beginPath();
      g.moveTo(0, base);
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * w;
        g.lineTo(x, base - ((t.strip[i] as number) / t.stripMax) * (base - top));
      }
      g.lineTo(w, base);
      g.closePath();
      g.fillStyle = 'rgb(230 237 243 / 0.16)';
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * w;
        const y = base - ((t.strip[i] as number) / t.stripMax) * (base - top);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgb(230 237 243 / 0.6)';
      g.lineWidth = 1;
      g.stroke();
    }
    // Failures, stuck robots and planned maintenance as bars along the top; moments as dots.
    for (const m of t.markers) {
      g.fillStyle = MARKER_COLOR[m.kind];
      const x0 = xOf(m.start);
      if (POINTS.has(m.kind)) {
        g.beginPath();
        g.arc(x0, 4, m.kind === 'avoided' || m.kind === 'lost' ? 3.5 : 2.5, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      const x1 = xOf(m.end ?? t.head);
      g.globalAlpha = m.kind === 'stuck' ? 0.7 : m.kind === 'service' ? 0.55 : 0.9;
      g.fillRect(x0, m.kind === 'stuck' ? 7 : 0, Math.max(2, x1 - x0), m.kind === 'stuck' ? 2 : 5);
      g.globalAlpha = 1;
    }
    // Branch points: where the run was continued from the past.
    g.fillStyle = 'rgb(230 237 243 / 0.7)';
    for (const b of t.branches) g.fillRect(xOf(b) - 0.5, 0, 1, h);
    // Past: the part after the moment shown is dimmed.
    if (t.viewing) {
      const x = xOf(this.dragging ? Number(this.range.value) : t.shown);
      g.fillStyle = 'rgb(10 14 19 / 0.55)';
      g.fillRect(x, 0, w - x, h);
    }
  }

  private hover(clientX: number): void {
    const t = this.data;
    if (!t) return;
    const box = this.canvas.getBoundingClientRect();
    const sec = ((clientX - box.left) / box.width) * t.head;
    const slack = (6 / box.width) * t.head;
    const hits = t.markers.filter(
      (m) => sec >= m.start - slack && sec <= (m.end ?? t.head) + slack,
    );
    const bucket = Math.min(
      t.strip.length - 1,
      Math.max(0, Math.floor((sec / Math.max(1, t.head)) * t.strip.length)),
    );
    const lines = [
      `${formatMinSec(sec)} · até ${formatInt(t.strip[bucket] ?? 0)} pacotes na fila`,
      ...hits.slice(-3).map((m) => m.label),
    ];
    this.tooltip.replaceChildren(
      ...lines.map((l, i) => {
        const p = document.createElement(i === 0 ? 'strong' : 'span');
        p.textContent = l;
        return p;
      }),
    );
    this.tooltip.hidden = false;
    const x = clientX - box.left;
    this.tooltip.style.left = `${Math.min(box.width - 260, Math.max(0, x - 120))}px`;
  }
}
