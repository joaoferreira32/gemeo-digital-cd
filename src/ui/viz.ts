import type { RobotStage } from '../sim/fleet';

/**
 * Shared pieces of the charts in the panels (KPIs, history, timeline).
 *
 * Robot states use the scene's own hues (the 3D view and the legend already
 * say cyan = working, amber = charging, red = broken), stepped into the
 * chart lightness band of the dark panels. The order of the groups is part of
 * the color safety: checked with the dataviz palette validator on the panel
 * surface (#10161d), every adjacent pair passes the color-vision-deficiency
 * separation (worst ΔE 10.3) and the normal-vision floor (worst 19.6). The
 * gray of idle robots is the de-emphasis neutral, low chroma on purpose.
 * Every group also carries a text label, so color is never the only cue.
 */
export interface StateGroup {
  readonly key: 'defect' | 'work' | 'charge' | 'idle';
  readonly label: string;
  readonly color: string;
  readonly stages: readonly RobotStage[];
}

export const STATE_GROUPS: readonly StateGroup[] = [
  { key: 'defect', label: 'Com defeito', color: '#e05a5a', stages: ['defect'] },
  {
    key: 'work',
    label: 'Trabalhando',
    color: '#1fa9a0',
    stages: ['toPickup', 'loading', 'toDrop', 'unloading', 'toPoint'],
  },
  { key: 'charge', label: 'Recarregando', color: '#c98500', stages: ['toCharger', 'charging'] },
  { key: 'idle', label: 'Ociosos', color: '#6b7884', stages: ['parked', 'toPark'] },
];

export function stateGroupOf(stage: RobotStage): number {
  return Math.max(
    0,
    STATE_GROUPS.findIndex((g) => g.stages.includes(stage)),
  );
}

/** Single-hue sequential ramp (cyan) for utilization: dark near the panel at 0, bright at 1. */
export function useColor(u: number): string {
  const t = Math.min(1, Math.max(0, u));
  const lo = [0x17, 0x32, 0x38];
  const hi = [0x6c, 0xf0, 0xe6];
  const c = lo.map((a, i) => Math.round(a + ((hi[i] as number) - a) * t));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

/** Line and fill of the single-series charts. */
export const SERIES = { line: '#38e1d6', wash: 'rgb(56 225 214 / 0.1)' } as const;

/** "4:05", "1:02:03" (mm:ss under an hour). */
export function formatMinSec(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "−1:23" before the moment shown, "agora" at it. */
export function formatAgo(seconds: number): string {
  return seconds < 0.5 ? 'agora' : `−${formatMinSec(seconds)}`;
}

export function percent(u: number): string {
  return `${Math.round(Math.min(1, Math.max(0, u)) * 100)}%`;
}

/** A clean tick value (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k) at or above `v`. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Horizontal meter: label, track with fill, value (text in ink, never in the fill color). */
export function meter(label: string, value: number, note = ''): HTMLElement {
  const row = html('div', 'meter');
  row.append(html('span', 'meter__label', label));
  const track = html('span', 'meter__track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  const fill = html('span', 'meter__fill');
  fill.style.width = `${Math.min(100, Math.max(0, value * 100))}%`;
  track.append(fill);
  row.append(track, html('span', 'meter__value mono', note || percent(value)));
  return row;
}
