import {
  ADDRESS,
  ADDRESS_LEAD,
  BOTTLENECK_TITLE,
  CARD_NOTE,
  CARD_TITLE,
  COUNTER_LABEL,
  badgeText,
  type Anchor,
  type CinemaCardRow,
  type Item,
  type Pane,
  type Tone,
} from './cinema';
import type { CinemaSide } from './cinema-run';

/**
 * What the cinema demo draws over the scene (src/demo/cinema.ts says what and
 * when): big words on dark bands, so they read on a phone; labels fixed to
 * points of the scene, through each pane's camera; the X-ray's routes; the
 * worn motor's charts; the card. Drawn on a 2D canvas the size of the video,
 * the same on screen and in the recording. Colors keep one meaning: the queue
 * red, the AI cyan, "sem IA" orange, a stopped belt grey with ⚠, a worn
 * motor's warning yellow. Sizes are designed for 1080 px, the short side of
 * both formats.
 */

export interface OverlayScene {
  readonly width: number;
  readonly height: number;
  readonly split: 'stack' | 'side';
  readonly layout: 'single' | 'split';
  readonly panes: readonly Pane[];
  readonly items: readonly { readonly item: Item; readonly alpha: number }[];
  /** The speed the run plays at (the badge). */
  readonly speed: number;
  /** Where a point of the scene is on screen, in a side's pane, or null when out of sight. */
  point(anchor: Anchor, side: CinemaSide): readonly [number, number] | null;
  /** Every robot's reserved route on screen (the X-ray, the AI side's pane). */
  routes(): readonly (readonly (readonly [number, number])[])[];
  /** The counter: the queue of the belt that broke, by side (the same measure in both). */
  readonly queue: Readonly<Record<CinemaSide, number>>;
  /** Share of B2's packets going by line A (0 … 1). */
  readonly share: number;
  /** The detector's card (its live words) and the belt's short name, or null. */
  readonly bottleneck: { readonly text: string; readonly label: string } | null;
  /** The worn motor's readings, one per simulated second, and the alarm's limit. */
  readonly forecast: {
    readonly vibration: readonly number[];
    readonly temperature: readonly number[];
    readonly sum: readonly number[];
    readonly limit: number;
  } | null;
  readonly card: readonly CinemaCardRow[] | null;
  /** The time travel's bar: the moment it points at, from where to where it goes, the breakdown (s). */
  readonly timeline: {
    readonly at: number;
    readonly from: number;
    readonly to: number;
    readonly breakAt: number;
  };
}

export const INK = '#f2f6fa';
const MUTED = 'rgba(230, 237, 243, 0.78)';
export const CYAN = '#38e1d6';
export const RED = '#ff5d5d';
export const ORANGE = '#ff8f3a';
const GREY = '#9aa4ae';
export const YELLOW = '#ffd166';
const SENSOR = '#c9d4de';
const DARK = '#071015';
const D = '"Barlow Condensed", "Arial Narrow", sans-serif';
const M = '"JetBrains Mono", ui-monospace, monospace';
const TONES: Record<Tone, string> = { red: RED, cyan: CYAN, ink: INK, grey: GREY };

type Ctx = CanvasRenderingContext2D;

/** Draw order: what is under, first; the words on top. */
const ORDER: Record<Item['kind'], number> = {
  shade: 0,
  spotlight: 1,
  routes: 2,
  pin: 3,
  balloon: 4,
  forecast: 5,
  bottleneck: 6,
  counter: 7,
  tag: 8,
  caption: 9,
  headline: 9,
  phrase: 9,
  title: 10,
  badge: 11,
  timeline: 12,
  card: 13,
  address: 14,
};

export function drawCinema(ctx: Ctx, s: OverlayScene): void {
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const items = [...s.items].sort((a, b) => ORDER[a.item.kind] - ORDER[b.item.kind]);
  let dividerDone = false;
  for (const { item, alpha } of items) {
    // The line between the runs goes under the words and the badge.
    if (!dividerDone && ORDER[item.kind] >= ORDER.counter) {
      divider(ctx, s);
      dividerDone = true;
    }
    if (alpha <= 0.001) continue;
    ctx.globalAlpha = alpha;
    drawItem(ctx, s, item);
    ctx.globalAlpha = 1;
  }
  if (!dividerDone) divider(ctx, s);
  ctx.restore();
}

function divider(ctx: Ctx, s: OverlayScene): void {
  if (s.layout !== 'split') return;
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  if (s.split === 'stack') ctx.fillRect(0, s.height / 2 - 3, s.width, 6);
  else ctx.fillRect(s.width / 2 - 3, 0, 6, s.height);
}

/** The pane of a side (in a single layout, the whole screen). */
function paneOf(s: OverlayScene, side: CinemaSide | undefined): Pane {
  if (s.layout === 'single' || !side) {
    return { side: 'ai', x: 0, y: 0, w: s.width, h: s.height };
  }
  return s.panes.find((p) => p.side === side) ?? (s.panes[0] as Pane);
}

const sideOf = (s: OverlayScene, side: CinemaSide | undefined): CinemaSide =>
  s.layout === 'single' ? 'ai' : (side ?? 'ai');

function drawItem(ctx: Ctx, s: OverlayScene, item: Item): void {
  switch (item.kind) {
    case 'shade':
      ctx.fillStyle = `rgba(4, 6, 9, ${item.alpha})`;
      ctx.fillRect(0, 0, s.width, s.height);
      return;
    case 'spotlight':
      spotlight(ctx, s, item);
      return;
    case 'routes':
      routes(ctx, s.routes());
      return;
    case 'pin': {
      const p = s.point(item.at, sideOf(s, item.pane));
      if (p) pin(ctx, p, s.layout === 'single' ? 66 : 56, item.label ?? '', paneOf(s, item.pane));
      return;
    }
    case 'balloon': {
      const side = sideOf(s, item.pane);
      const p = s.point(item.at, side);
      if (!p) return;
      const text = item.text.replace('{share}', String(Math.round(s.share * 100)));
      balloon(ctx, p, text, item.dx, item.dy, TONES[item.tone], 44, paneOf(s, item.pane));
      return;
    }
    case 'headline':
      headline(ctx, item.text, 64, 150, 118);
      return;
    case 'phrase':
      phrase(ctx, s, item.text);
      return;
    case 'caption':
      caption(ctx, s, item.text, item.pane, item.narrow === true);
      return;
    case 'counter':
      counter(ctx, s, item.pane);
      return;
    case 'tag':
      tag(ctx, s, item.pane);
      return;
    case 'badge':
      badge(ctx, s);
      return;
    case 'title':
      title(ctx, item.text);
      return;
    case 'bottleneck':
      bottleneck(ctx, s);
      return;
    case 'forecast':
      forecast(ctx, s, item.pane, item.motor);
      return;
    case 'card':
      card(ctx, s);
      return;
    case 'address':
      address(ctx, s);
      return;
    case 'timeline':
      timeline(ctx, s);
      return;
  }
}

// ---------------------------------------------------------------- pieces

function round(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A dark band behind words (they read over any scene, on a phone too). */
function band(ctx: Ctx, x: number, y: number, w: number, h: number, alpha = 0.66): void {
  round(ctx, x, y, w, h, 14);
  ctx.fillStyle = `rgba(6, 9, 13, ${alpha})`;
  ctx.fill();
}

/** Breaks `text` into lines no wider than `width` ("|" forces a break). */
function lines(ctx: Ctx, text: string, width: number): string[] {
  const out: string[] = [];
  for (const part of text.split('|')) {
    let line = '';
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

function headline(ctx: Ctx, text: string, x: number, y: number, size: number): void {
  ctx.font = `700 ${size}px ${D}`;
  const w = ctx.measureText(text).width;
  band(ctx, x - 28, y - size * 0.92, w + 56, size * 1.34);
  ctx.fillStyle = INK;
  ctx.fillText(text, x, y);
}

/** The sentence in the middle: big, centered, on a band. */
function phrase(ctx: Ctx, s: OverlayScene, text: string): void {
  const size = 84;
  ctx.font = `700 ${size}px ${D}`;
  const ls = lines(ctx, text, Math.min(s.width - 180, 1400));
  const lh = size * 1.12;
  const w = Math.max(...ls.map((l) => ctx.measureText(l).width));
  const top = s.height * 0.44 - (lh * ls.length) / 2;
  band(ctx, (s.width - w) / 2 - 40, top - 26, w + 80, lh * ls.length + 46, 0.74);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ls.forEach((l, i) => ctx.fillText(l, s.width / 2, top + size * 0.9 + i * lh));
  ctx.textAlign = 'start';
}

/** Words at the bottom of a pane (or of the screen), on a band. */
function caption(
  ctx: Ctx,
  s: OverlayScene,
  text: string,
  side: CinemaSide | undefined,
  narrow: boolean,
): void {
  const pane = paneOf(s, side);
  // Beside the motor's panel the words get a narrow column: a little smaller, two lines.
  const size = narrow ? 46 : s.layout === 'split' ? 50 : 56;
  const x = pane.x + 56;
  ctx.font = `700 ${size}px ${D}`;
  const panel = narrow ? forecastBox(s, pane) : null;
  const maxW = panel ? panel.x - x - 34 : pane.w - 150;
  const ls = lines(ctx, text, maxW);
  const lh = size * 1.16;
  const w = Math.max(...ls.map((l) => ctx.measureText(l).width));
  const last = pane.y + pane.h - 40;
  const top = last - lh * (ls.length - 1) - size * 0.9;
  band(ctx, x - 26, top, w + 52, lh * ls.length + size * 0.25);
  ctx.fillStyle = INK;
  ls.forEach((l, i) => ctx.fillText(l, x, top + size * 0.9 + i * lh));
}

/** The belt's queue under its label: red alone, the side's color side by side; one measure everywhere. */
function counter(ctx: Ctx, s: OverlayScene, side: CinemaSide | undefined): void {
  const single = s.layout === 'single';
  const pane = paneOf(s, side);
  const size = single ? 180 : 170;
  const x = pane.x + pane.w - (single ? 64 : 44);
  const y = pane.y + (single ? 262 : s.split === 'stack' && side === 'ai' ? 96 : 70);
  const value = Math.round(s.queue[sideOf(s, side)]).toLocaleString('pt-BR');
  const color = single ? RED : side === 'no-ai' ? ORANGE : CYAN;
  ctx.font = `700 ${size * 0.26}px ${D}`;
  const lw = ctx.measureText(COUNTER_LABEL).width;
  ctx.font = `700 ${size}px ${M}`;
  const vw = ctx.measureText(value).width;
  const w = Math.max(lw, vw);
  band(ctx, x - w - 30, y - size * 0.3, w + 56, size * 1.32);
  ctx.textAlign = 'right';
  ctx.font = `700 ${size * 0.26}px ${D}`;
  ctx.fillStyle = INK;
  ctx.fillText(COUNTER_LABEL, x, y);
  ctx.font = `700 ${size}px ${M}`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y + size * 0.92);
  ctx.textAlign = 'start';
}

function tag(ctx: Ctx, s: OverlayScene, side: CinemaSide): void {
  const pane = paneOf(s, side);
  const text = side === 'ai' ? 'COM IA' : 'SEM IA';
  const size = 48;
  const x = pane.x + 40;
  const y = pane.y + (s.split === 'stack' && side === 'ai' ? 60 : 34);
  ctx.font = `700 ${size}px ${D}`;
  const tw = ctx.measureText(text).width;
  round(ctx, x, y, tw + size * 0.9, size * 1.35, 8);
  ctx.fillStyle = side === 'ai' ? CYAN : ORANGE;
  ctx.fill();
  ctx.fillStyle = DARK;
  ctx.fillText(text, x + size * 0.45, y + size * 1.02);
}

/** The speed, once: by the headline alone, on the line between the runs side by side. */
function badge(ctx: Ctx, s: OverlayScene): void {
  const text = badgeText(s.speed);
  if (!text) return;
  const size = s.layout === 'split' ? 42 : 40;
  const [cx, cy] =
    s.layout === 'single'
      ? [130, 262]
      : s.split === 'stack'
        ? [s.width / 2, s.height / 2]
        : [s.width / 2, s.height / 2];
  ctx.font = `700 ${size}px ${M}`;
  const w = ctx.measureText(text).width + 36;
  const h = size * 1.4;
  round(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = DARK;
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy + size * 0.36);
  ctx.textAlign = 'start';
}

/** ⚠ standing on a stopped belt, with its name beside it. */
function pin(
  ctx: Ctx,
  at: readonly [number, number],
  size: number,
  label: string,
  pane: Pane,
): void {
  const [x, y] = at;
  const cy = y - size * 0.9;
  if (label) {
    const fs = Math.round(size * 0.62);
    ctx.font = `700 ${fs}px ${D}`;
    const tw = ctx.measureText(label).width;
    const bw = tw + fs * 0.9 + size * 0.5;
    // The name goes to the side with room for it.
    const right = x + bw <= pane.x + pane.w - 16;
    const bx = right ? x : x - bw;
    round(ctx, bx, cy - fs * 0.78, bw, fs * 1.56, fs * 0.5);
    ctx.fillStyle = 'rgba(6, 9, 13, 0.88)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = GREY;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(label, right ? bx + bw - fs * 0.45 : bx + fs * 0.45, cy + fs * 0.34);
    ctx.textAlign = 'start';
  }
  ctx.beginPath();
  ctx.arc(x, cy, size * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.88)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = GREY;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, cy - size * 0.36);
  ctx.lineTo(x + size * 0.38, cy + size * 0.3);
  ctx.lineTo(x - size * 0.38, cy + size * 0.3);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.fillStyle = DARK;
  ctx.fillRect(x - 3, cy - size * 0.16, 6, size * 0.26);
  ctx.fillRect(x - 3, cy + size * 0.15, 6, 6);
  ctx.strokeStyle = GREY;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, cy + size * 0.62);
  ctx.lineTo(x, y);
  ctx.stroke();
}

/** A label fixed to a point: a ring on it, a line, the words in a box; kept inside its pane. */
function balloon(
  ctx: Ctx,
  at: readonly [number, number],
  text: string,
  dx: number,
  dy: number,
  color: string,
  size: number,
  pane: Pane,
): void {
  const [ax, ay] = at;
  ctx.font = `700 ${size}px ${D}`;
  const bw = ctx.measureText(text).width + size;
  const bh = size * 1.55;
  let left = dx < 0;
  let bx = left ? ax + dx - bw : ax + dx;
  if (bx < pane.x + 16 || bx + bw > pane.x + pane.w - 16) {
    left = !left;
    bx = left ? ax - Math.abs(dx) - bw : ax + Math.abs(dx);
  }
  bx = Math.min(Math.max(bx, pane.x + 16), pane.x + pane.w - bw - 16);
  const by = Math.min(Math.max(ay + dy - bh / 2, pane.y + 16), pane.y + pane.h - bh - 16);
  const ex = left ? bx + bw : bx;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ex, by + bh / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ax, ay, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(ax, ay, 5, 0, Math.PI * 2);
  ctx.fill();
  round(ctx, bx, by, bw, bh, 10);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.9)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.fillText(text, bx + size * 0.5, by + bh * 0.68);
}

/** The X-ray's title: a band dark enough that the routes passing under it do not show. */
function title(ctx: Ctx, text: string): void {
  const size = 104;
  const x = 64;
  const y = 140;
  ctx.font = `700 ${size}px ${D}`;
  const w = ctx.measureText(text).width;
  band(ctx, x - 28, y - size * 0.92, w + 56, size * 1.34, 0.95);
  ctx.fillStyle = INK;
  ctx.fillText(text, x, y);
}

/** Every robot's reserved route, as glowing dashes. */
function routes(ctx: Ctx, all: readonly (readonly (readonly [number, number])[])[]): void {
  ctx.save();
  ctx.setLineDash([18, 10]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pts of all) {
    if (pts.length < 2) continue;
    for (const [width, a] of [
      [18, 0.2],
      [6, 0.95],
    ] as const) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = `rgba(56, 225, 214, ${a})`;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Darkens a pane but an ellipse around the subject, softly. */
function spotlight(ctx: Ctx, s: OverlayScene, item: Extract<Item, { kind: 'spotlight' }>): void {
  const pane = paneOf(s, item.pane);
  const side = sideOf(s, item.pane);
  const ps = item.around.map((a) => s.point(a, side)).filter((p) => p !== null);
  if (ps.length === 0) return;
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + item.pad[0];
  const ry = (Math.max(...ys) - Math.min(...ys)) / 2 + item.pad[1];
  ctx.save();
  ctx.beginPath();
  ctx.rect(pane.x, pane.y, pane.w, pane.h);
  ctx.clip();
  // The dark everywhere but inside the ellipse, as one path filled with the even-odd rule
  // would leave a hard edge; a radial gradient in the ellipse's own space fades it.
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0.55, 0, 0, 1);
  g.addColorStop(0, 'rgba(4, 6, 9, 0)');
  g.addColorStop(1, `rgba(4, 6, 9, ${item.alpha})`);
  ctx.fillStyle = g;
  const big = 4 * Math.max(s.width / rx, s.height / ry);
  ctx.fillRect(-big, -big, 2 * big, 2 * big);
  ctx.restore();
}

/** The detector's card at the bottom, a line to its ring, the belt's name by the ring. */
function bottleneck(ctx: Ctx, s: OverlayScene): void {
  const b = s.bottleneck;
  if (!b) return;
  const size = 46;
  const x = 56;
  const w = Math.min(s.width - 112, 1200);
  const px = s.layout === 'single' && s.width > s.height ? (s.width - w) / 2 : x;
  ctx.font = `600 ${size}px ${D}`;
  const ls = lines(ctx, b.text, w - 80);
  const h = 96 + ls.length * size * 1.2 + 20;
  const y = s.height - h - 60;
  const ring = s.point({ kind: 'bottleneck' }, 'ai');
  if (ring) {
    const [ax, ay] = ring;
    const sx = Math.min(Math.max(ax, px + 40), px + w - 40);
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ax, ay, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `700 40px ${D}`;
    const tw = ctx.measureText(b.label).width;
    band(ctx, ax + 26, ay - 56, tw + 32, 56, 0.85);
    ctx.fillStyle = CYAN;
    ctx.fillText(b.label, ax + 42, ay - 15);
  }
  round(ctx, px, y, w, h, 14);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.92)';
  ctx.fill();
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.font = `700 32px ${D}`;
  ctx.fillStyle = CYAN;
  ctx.fillText(BOTTLENECK_TITLE, px + 40, y + 56);
  ctx.font = `600 ${size}px ${D}`;
  ctx.fillStyle = INK;
  ls.forEach((l, i) => ctx.fillText(l, px + 40, y + 56 + size * 1.25 + i * size * 1.2));
}

const CHART = 84;
const STEP = CHART + 62;
const FORECAST_H = 26 + 3 * STEP + 6;

/** Where the motor's panel goes: beside the motor (one above the other), or below it (side by side). */
function forecastBox(s: OverlayScene, pane: Pane): { x: number; y: number; w: number } {
  if (s.split === 'side') {
    return { x: pane.x + 40, y: pane.y + pane.h - FORECAST_H - 190, w: pane.w - 80 };
  }
  const motor = s.point({ kind: 'motor', id: 15, y: 0.9 }, 'ai');
  const x = Math.max((motor?.[0] ?? pane.x + 360) + 150, pane.x + 520);
  return { x, y: pane.y + 110, w: pane.x + pane.w - x - 30 };
}

/** The worn motor: vibration, temperature and the alarm sum, scaled to show the rise, with the limit drawn. */
function forecast(ctx: Ctx, s: OverlayScene, side: CinemaSide, motorId: number): void {
  const f = s.forecast;
  if (!f || f.sum.length < 2) return;
  const pane = paneOf(s, side);
  const { x, y, w } = forecastBox(s, pane);
  const motor = s.point({ kind: 'motor', id: motorId, y: 0.9 }, side);
  if (motor) {
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(motor[0] + 18, motor[1]);
    ctx.lineTo(x, y + 60);
    ctx.stroke();
  }
  round(ctx, x, y, w, FORECAST_H, 14);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.9)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = CYAN;
  ctx.stroke();
  const chart = (
    values: readonly number[],
    top: number,
    label: string,
    unit: string,
    color: string,
    limit?: number,
  ) => {
    const lo = Math.min(...values, limit ?? Infinity);
    const hi = Math.max(...values, limit ?? -Infinity);
    const pad = (hi - lo) * 0.08 || 1;
    const ymin = lo - pad;
    const ymax = hi + pad;
    const cx = x + 26;
    const cw = w - 52;
    const py = (v: number) => top + 36 + CHART - (CHART * (v - ymin)) / (ymax - ymin);
    ctx.fillStyle = 'rgba(230, 237, 243, 0.06)';
    ctx.fillRect(cx, top + 36, cw, CHART);
    ctx.font = `700 30px ${D}`;
    ctx.fillStyle = INK;
    ctx.fillText(label, cx, top + 24);
    const last = values[values.length - 1] as number;
    ctx.font = `700 30px ${M}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    const v = last.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    ctx.fillText(unit ? `${v} ${unit}` : v, cx + cw, top + 24);
    ctx.textAlign = 'start';
    if (limit !== undefined) {
      ctx.save();
      ctx.setLineDash([12, 8]);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, py(limit));
      ctx.lineTo(cx + cw, py(limit));
      ctx.stroke();
      ctx.restore();
      ctx.font = `700 26px ${D}`;
      ctx.fillStyle = INK;
      ctx.fillText('limite do alarme', cx + 8, py(limit) + 28);
    }
    ctx.beginPath();
    values.forEach((value, i) => {
      const px = cx + (cw * i) / (values.length - 1);
      if (i) ctx.lineTo(px, py(value));
      else ctx.moveTo(px, py(value));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  chart(f.vibration, y + 26, 'vibração', 'mm/s', SENSOR);
  chart(f.temperature, y + 26 + STEP, 'temperatura', '°C', SENSOR);
  chart(f.sum, y + 26 + 2 * STEP, 'CUSUM', '', YELLOW, f.limit);
}

/** The card: the changes as the rows' headlines, in the AI's color; each run's value under its name. */
function card(ctx: Ctx, s: OverlayScene): void {
  const rows = s.card;
  if (!rows) return;
  const wide = s.width > s.height;
  const w = wide ? 1240 : s.width - 96;
  const x = (s.width - w) / 2;
  const heights = rows.map((r) => (r.headline ? (wide ? 168 : 214) : wide ? 92 : 120));
  const notes = CARD_NOTE.split('|');
  const h = 170 + heights.reduce((a, b) => a + b, 0) + 40 + notes.length * 44;
  const y = wide ? (s.height - h) / 2 : 110;
  round(ctx, x, y, w, h, 18);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.93)';
  ctx.fill();
  ctx.fillStyle = CYAN;
  ctx.fillRect(x, y, w, 8);
  ctx.font = `700 72px ${D}`;
  ctx.fillStyle = INK;
  ctx.fillText(CARD_TITLE, x + 48, y + 104);
  const colNo = x + w * (wide ? 0.7 : 0.64);
  const colAi = x + w - 48;
  ctx.font = `700 38px ${D}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = ORANGE;
  ctx.fillText('SEM IA', colNo, y + 104);
  ctx.fillStyle = CYAN;
  ctx.fillText('COM IA', colAi, y + 104);
  ctx.textAlign = 'start';
  let yy = y + 150;
  rows.forEach((r, i) => {
    ctx.fillStyle = 'rgba(230, 237, 243, 0.14)';
    ctx.fillRect(x + 48, yy, w - 96, 2);
    const big = wide ? 112 : 132;
    if (r.headline) {
      ctx.font = `700 ${big}px ${D}`;
      ctx.fillStyle = CYAN;
      ctx.fillText(r.headline, x + 44, yy + big);
      const hw = ctx.measureText(r.headline).width;
      ctx.font = `700 50px ${D}`;
      ctx.fillStyle = INK;
      ctx.fillText(r.label, x + 44 + hw + 26, yy + big - 4);
    } else {
      ctx.font = `700 50px ${D}`;
      ctx.fillStyle = INK;
      ctx.fillText(r.label, x + 48, yy + (wide ? 66 : 82));
    }
    const vy = r.headline ? (wide ? yy + big - 4 : yy + 194) : yy + (wide ? 66 : 82);
    ctx.textAlign = 'right';
    ctx.font = `700 58px ${D}`;
    ctx.fillStyle = ORANGE;
    ctx.fillText(r.noAi, colNo, vy);
    ctx.fillStyle = CYAN;
    ctx.fillText(r.ai, colAi, vy);
    ctx.textAlign = 'start';
    yy += heights[i] as number;
  });
  ctx.font = `600 38px ${D}`;
  ctx.fillStyle = MUTED;
  notes.forEach((l, i) => ctx.fillText(l, x + 48, y + h - 34 - (notes.length - 1 - i) * 44));
}

/** Where the code is: two lines on a dark band with a thin border. */
function address(ctx: Ctx, s: OverlayScene): void {
  const size = 50;
  ctx.font = `700 ${size}px ${D}`;
  const uw = ctx.measureText(ADDRESS).width;
  const lh = size * 0.62;
  const w = uw + 80;
  const h = size * 1.2 + lh * 1.5 + 40;
  const x = (s.width - w) / 2;
  const withCard = s.items.some((i) => i.item.kind === 'card');
  const y = withCard ? s.height - 200 : (s.height - h) / 2;
  round(ctx, x, y, w, h, 16);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.92)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(230, 237, 243, 0.35)';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.font = `600 ${lh}px ${D}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(ADDRESS_LEAD, s.width / 2, y + 22 + lh);
  ctx.font = `700 ${size}px ${D}`;
  ctx.fillStyle = INK;
  ctx.fillText(ADDRESS, s.width / 2, y + 22 + lh * 1.5 + size * 0.95);
  ctx.textAlign = 'start';
}

/** The time travel: a bar of the run, the moment going back along it. */
function timeline(ctx: Ctx, s: OverlayScene): void {
  const t = s.timeline;
  const bw = Math.min(s.width - 240, 1300);
  const x = (s.width - bw) / 2;
  const y = s.height * 0.42;
  // The bar covers the stretch the travel crosses, with some room before it.
  const start = Math.max(0, t.to - 10);
  const span = Math.max(t.from - start, 1);
  const sx = (time: number) => x + (bw * (time - start)) / span;
  band(ctx, x - 40, y - 110, bw + 80, 170, 0.82);
  ctx.fillStyle = 'rgba(230, 237, 243, 0.25)';
  ctx.fillRect(x, y, bw, 8);
  ctx.fillStyle = CYAN;
  ctx.fillRect(x, y, Math.max(0, sx(t.at) - x), 8);
  // The breakdown, a grey mark (the stopped belt's color).
  ctx.fillStyle = GREY;
  ctx.fillRect(sx(t.breakAt) - 2, y - 18, 4, 44);
  ctx.fillStyle = CYAN;
  ctx.beginPath();
  ctx.arc(sx(t.at), y + 4, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.font = `700 52px ${D}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(t.at)} s`, sx(t.at), y - 40);
  ctx.textAlign = 'start';
}
