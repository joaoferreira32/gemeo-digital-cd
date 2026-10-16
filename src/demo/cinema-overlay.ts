import {
  ADDRESS,
  ADDRESS_LEAD,
  BOTTLENECK_TITLE,
  CARD_NOTE,
  CARD_TITLE,
  COMPARE_TITLE,
  COUNTER_LABEL,
  LOG_STATUS,
  MONITOR_TITLE,
  badgeText,
  type Anchor,
  type CinemaCardRow,
  type CinemaLogLine,
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
  /**
   * Where words may go (pixels): a feed's buttons and caption cover the
   * bottom of a video on a phone, and words should not touch its edges. The
   * whole frame when the format sets nothing.
   */
  readonly safe: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
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
  /** Packets delivered in the minute before the moment shown. */
  readonly rate: number;
  /** The simulated moment shown, and seconds into the segment (animations). */
  readonly time: number;
  readonly local: number;
  /** The AI's log (its last lines), and when the router last decided (s; −1: not deciding). */
  readonly log: readonly CinemaLogLine[];
  readonly decidedAt: number;
  /** The junctions where the router splits the flow. */
  readonly junctions: readonly string[];
  /** The router's two ways at a junction, now. */
  compare(node: string): CompareView | null;
  /** Each motor's alarm sum against its limit (1: the alarm), the AI side's. */
  readonly motors: readonly number[];
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

/** The router's two ways at a junction: the time it expects on each (Infinity: cut), the one it takes. */
export interface CompareView {
  readonly primary: { readonly name: string; readonly cost: number };
  readonly alternative: { readonly name: string; readonly cost: number };
  readonly chosen: 'primary' | 'alternative';
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
  pulses: 2,
  wave: 2,
  pin: 3,
  balloon: 4,
  compare: 4,
  forecast: 5,
  monitor: 5,
  log: 8,
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
  flash: 15,
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

/** Whether a point on screen is inside a pane, `margin` pixels in from its edges. */
const inside = (pane: Pane, [x, y]: readonly [number, number], margin: number): boolean =>
  x >= pane.x + margin &&
  x <= pane.x + pane.w - margin &&
  y >= pane.y + margin &&
  y <= pane.y + pane.h - margin;

/** The pane of a side (in a single layout, the whole screen). */
function paneOf(s: OverlayScene, side: CinemaSide | undefined): Pane {
  if (s.layout === 'single' || !side) {
    return { side: 'ai', x: 0, y: 0, w: s.width, h: s.height };
  }
  return s.panes.find((p) => p.side === side) ?? (s.panes[0] as Pane);
}

/** Where words may go in a pane: the pane inside the frame's safe area. */
function roomOf(s: OverlayScene, side: CinemaSide | undefined): Pane {
  const p = paneOf(s, side);
  const x = Math.max(p.x, s.safe.left);
  const y = Math.max(p.y, s.safe.top);
  const w = Math.min(p.x + p.w, s.safe.right) - x;
  const h = Math.min(p.y + p.h, s.safe.bottom) - y;
  return { side: p.side, x, y, w, h };
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
      if (p) pin(ctx, p, s.layout === 'single' ? 66 : 56, item.label ?? '', roomOf(s, item.pane));
      return;
    }
    case 'balloon': {
      const side = sideOf(s, item.pane);
      const p = s.point(item.at, side);
      if (!p) return;
      if (item.inSight && !inside(paneOf(s, item.pane), p, 24)) return;
      const text = item.text
        .replace('{share}', String(Math.round(s.share * 100)))
        .replace('{rate}', Math.round(s.rate).toLocaleString('pt-BR'));
      balloon(ctx, p, text, item.dx, item.dy, TONES[item.tone], 44, roomOf(s, item.pane));
      return;
    }
    case 'headline':
      headline(ctx, item.text, Math.max(64, s.safe.left + 28), 150, 118);
      return;
    case 'phrase':
      phrase(ctx, s, item.text, item.big === true);
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
      title(ctx, s, item.text);
      return;
    case 'bottleneck':
      bottleneck(ctx, s, item.link !== false);
      return;
    case 'pulses':
      pulses(ctx, s, item.pane);
      return;
    case 'wave':
      wave(ctx, s, item);
      return;
    case 'compare':
      compare(ctx, s, item);
      return;
    case 'log':
      log(ctx, s, item.pane, item.lines);
      return;
    case 'monitor':
      monitor(ctx, s, item.pane);
      return;
    case 'forecast':
      forecast(ctx, s, item.pane, item.motor);
      return;
    case 'card':
      card(ctx, s);
      return;
    case 'address':
      address(ctx, s, item.cta ?? '');
      return;
    case 'timeline':
      timeline(ctx, s);
      return;
    case 'flash':
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillRect(0, 0, s.width, s.height);
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
  // "⏪ …": the rewind's sign, drawn (two triangles pointing back), then the words.
  const rewind = text.startsWith('⏪ ');
  const words = rewind ? text.slice(2) : text;
  const icon = rewind ? size * 1.12 : 0;
  ctx.font = `700 ${size}px ${D}`;
  const w = ctx.measureText(words).width + icon;
  band(ctx, x - 28, y - size * 0.92, w + 56, size * 1.34);
  ctx.fillStyle = INK;
  if (rewind) {
    const h = size * 0.56;
    const cy = y - size * 0.34;
    for (const dx of [0, h * 0.72]) {
      ctx.beginPath();
      ctx.moveTo(x + dx, cy);
      ctx.lineTo(x + dx + h * 0.72, cy - h / 2);
      ctx.lineTo(x + dx + h * 0.72, cy + h / 2);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillText(words, x + icon, y);
}

/**
 * The sentence in the middle: big, centered, on a band. Over the split
 * screen it goes to the bottom, under both runs' counters; the cover's
 * (`big`) there too, as large as fits on one line, in a lit frame.
 */
function phrase(ctx: Ctx, s: OverlayScene, text: string, big: boolean): void {
  const split = s.layout === 'split';
  const room = Math.min(s.safe.right - s.safe.left - 100, 1400);
  let size = split ? 76 : 84;
  if (big) {
    // As large as fits on one line.
    ctx.font = `700 100px ${D}`;
    size = Math.min(100, Math.floor((100 * room) / ctx.measureText(text).width));
  }
  ctx.font = `700 ${size}px ${D}`;
  const ls = lines(ctx, text, room);
  const lh = size * 1.12;
  const w = Math.max(...ls.map((l) => ctx.measureText(l).width));
  const bottom = Math.min(s.height - 40, s.safe.bottom - 12);
  const top = split || big ? bottom - 20 - lh * ls.length : s.height * 0.44 - (lh * ls.length) / 2;
  band(ctx, (s.width - w) / 2 - 40, top - 26, w + 80, lh * ls.length + 46, big ? 0.92 : 0.74);
  if (big) {
    round(ctx, (s.width - w) / 2 - 40, top - 26, w + 80, lh * ls.length + 46, 14);
    ctx.lineWidth = 5;
    ctx.strokeStyle = CYAN;
    ctx.stroke();
  }
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
  const pane = roomOf(s, side);
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
  const pane = roomOf(s, side);
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
  const pane = roomOf(s, side);
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
  const by = Math.min(Math.max(ay + dy - bh / 2, pane.y + 16), pane.y + pane.h - bh - 16);
  const clamp = (x: number) => Math.min(Math.max(x, pane.x + 16), pane.x + pane.w - bw - 16);
  let left = dx < 0;
  let bx = left ? ax + dx - bw : ax + dx;
  if (bx < pane.x + 16 || bx + bw > pane.x + pane.w - 16) {
    // Short of room on its side: kept at the edge, unless there it would cover its own point.
    const kept = clamp(bx);
    const covers = ax >= kept - 13 && ax <= kept + bw + 13 && ay >= by - 13 && ay <= by + bh + 13;
    if (covers) {
      left = !left;
      bx = left ? ax - Math.abs(dx) - bw : ax + Math.abs(dx);
    } else bx = kept;
  }
  bx = clamp(bx);
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
function title(ctx: Ctx, s: OverlayScene, text: string): void {
  const size = 104;
  const x = Math.max(64, s.safe.left + 28);
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
function bottleneck(ctx: Ctx, s: OverlayScene, link: boolean): void {
  const b = s.bottleneck;
  if (!b) return;
  const size = 46;
  const x = Math.max(56, s.safe.left);
  const w = Math.min(s.width - 112, 1200, s.safe.right - x);
  const px = s.layout === 'single' && s.width > s.height ? (s.width - w) / 2 : x;
  ctx.font = `600 ${size}px ${D}`;
  const ls = lines(ctx, b.text, w - 80);
  const h = 96 + ls.length * size * 1.2 + 20;
  const y = Math.min(s.height - h - 60, s.safe.bottom - h - 12);
  const ring = link ? s.point({ kind: 'bottleneck' }, 'ai') : null;
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
const FORECAST_H = 26 + 3 * (CHART + 62) + 6;

/**
 * Where the motor's panel goes: beside the motor (one above the other), or
 * below it (side by side); above the AI's log when the pane has one, as tall
 * as fits there.
 */
function forecastBox(s: OverlayScene, pane: Pane): { x: number; y: number; w: number; h: number } {
  const log = s.items.find((i) => i.item.kind === 'log' && i.item.pane === pane.side);
  const floor =
    log && log.item.kind === 'log'
      ? logTop(pane, log.item.lines) - 12
      : Math.min(pane.y + pane.h, s.safe.bottom);
  if (s.split === 'side') {
    const y = Math.min(pane.y + pane.h - FORECAST_H - 190, floor - FORECAST_H);
    return { x: pane.x + 40, y, w: pane.w - 80, h: FORECAST_H };
  }
  const motor = s.point({ kind: 'motor', id: 15, y: 0.9 }, 'ai');
  const x = Math.max((motor?.[0] ?? pane.x + 360) + 150, pane.x + 520);
  const y = pane.y + (log ? 44 : 110);
  return { x, y, w: pane.x + pane.w - x - 30, h: Math.min(FORECAST_H, floor - y) };
}

/** The worn motor: vibration, temperature and the alarm sum, scaled to show the rise, with the limit drawn. */
function forecast(ctx: Ctx, s: OverlayScene, side: CinemaSide, motorId: number): void {
  const f = s.forecast;
  if (!f || f.sum.length < 2) return;
  const pane = roomOf(s, side);
  const { x, y, w, h } = forecastBox(s, pane);
  // The charts as tall as the panel lets them (each with its label above it).
  const chartH = Math.max(30, Math.min(CHART, (h - 32) / 3 - 62));
  const step = chartH + 62;
  const motor = s.point({ kind: 'motor', id: motorId, y: 0.9 }, side);
  if (motor) {
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(motor[0] + 18, motor[1]);
    ctx.lineTo(x, y + 60);
    ctx.stroke();
  }
  round(ctx, x, y, w, h, 14);
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
    const py = (v: number) => top + 36 + chartH - (chartH * (v - ymin)) / (ymax - ymin);
    ctx.fillStyle = 'rgba(230, 237, 243, 0.06)';
    ctx.fillRect(cx, top + 36, cw, chartH);
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
  chart(f.temperature, y + 26 + step, 'temperatura', '°C', SENSOR);
  chart(f.sum, y + 26 + 2 * step, 'CUSUM', '', YELLOW, f.limit);
}

/** The card: the changes as the rows' headlines, in the AI's color; each run's value under its name. */
function card(ctx: Ctx, s: OverlayScene): void {
  const rows = s.card;
  if (!rows) return;
  const wide = s.width > s.height;
  const w = Math.min(wide ? 1240 : s.width - 96, s.safe.right - s.safe.left);
  const x = (s.width - w) / 2;
  const notes = CARD_NOTE.split('|');
  const room = s.safe.bottom - s.safe.top - 20;
  let heights: number[] = rows.map((r) => (r.headline ? (wide ? 168 : 214) : wide ? 92 : 120));
  const fixed = 170 + 40 + notes.length * 44;
  const rowsH = heights.reduce((a, b) => a + b, 0);
  if (fixed + rowsH > room) heights = heights.map((v) => (v * (room - fixed)) / rowsH);
  const h = fixed + heights.reduce((a, b) => a + b, 0);
  const y = wide
    ? Math.min(Math.max((s.height - h) / 2, s.safe.top + 10), s.safe.bottom - h - 10)
    : Math.max(110, s.safe.top + 10);
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
function address(ctx: Ctx, s: OverlayScene, cta: string): void {
  const size = 50;
  ctx.font = `700 ${size}px ${D}`;
  const uw = ctx.measureText(ADDRESS).width;
  // The call to try it, first and larger, in the AI's color.
  const ctaSize = 58;
  ctx.font = `700 ${ctaSize}px ${D}`;
  const cw = cta ? ctx.measureText(cta).width : 0;
  const ctaH = cta ? ctaSize * 1.25 : 0;
  const lh = size * 0.62;
  const w = Math.min(Math.max(uw, cw) + 80, s.safe.right - s.safe.left);
  const h = ctaH + size * 1.2 + lh * 1.5 + 40;
  const x = (s.width - w) / 2;
  const withCard = s.items.some((i) => i.item.kind === 'card');
  const y = withCard ? Math.min(s.height - 200, s.safe.bottom - h - 12) : (s.height - h) / 2;
  round(ctx, x, y, w, h, 16);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.92)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(230, 237, 243, 0.35)';
  ctx.stroke();
  ctx.textAlign = 'center';
  if (cta) {
    ctx.font = `700 ${ctaSize}px ${D}`;
    ctx.fillStyle = CYAN;
    ctx.fillText(cta, s.width / 2, y + 22 + ctaSize * 0.95);
  }
  ctx.font = `600 ${lh}px ${D}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(ADDRESS_LEAD, s.width / 2, y + ctaH + 22 + lh);
  ctx.font = `700 ${size}px ${D}`;
  ctx.fillStyle = INK;
  ctx.fillText(ADDRESS, s.width / 2, y + ctaH + 22 + lh * 1.5 + size * 0.95);
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

// ---------------------------------------------------------------- the AI at work

/** Video seconds a pulse lasts (it is cut short when the router decides again sooner). */
const PULSE = 0.5;

/**
 * A ring at each junction where the router splits the flow, every time it
 * decides (each simulated second, while the AI routes): the real cadence, so
 * several a second when the run plays fast.
 */
function pulses(ctx: Ctx, s: OverlayScene, side: CinemaSide): void {
  if (s.decidedAt < 0 || s.speed <= 0) return;
  const age = (s.time - s.decidedAt) / s.speed;
  if (age >= PULSE) return;
  const p = age / PULSE;
  const pane = paneOf(s, side);
  ctx.save();
  ctx.beginPath();
  ctx.rect(pane.x, pane.y, pane.w, pane.h);
  ctx.clip();
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 3;
  ctx.globalAlpha *= 0.6 * (1 - p);
  for (const name of s.junctions) {
    const at = s.point({ kind: 'node', name, y: 0.85 }, side);
    if (!at) continue;
    ctx.beginPath();
    ctx.arc(at[0], at[1], 10 + 34 * p, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Rings going out from a point (the breakdown), one after another. */
function wave(ctx: Ctx, s: OverlayScene, item: Extract<Item, { kind: 'wave' }>): void {
  const at = s.point(item.at, 'ai');
  if (!at) return;
  const age = s.local - item.from;
  const life = 1.1;
  ctx.save();
  ctx.strokeStyle = INK;
  for (const delay of [0, 0.22, 0.44]) {
    const a = age - delay;
    if (a < 0 || a > life) continue;
    const p = a / life;
    ctx.globalAlpha = 0.85 * (1 - p);
    ctx.lineWidth = 6 * (1 - p) + 2;
    ctx.beginPath();
    ctx.arc(at[0], at[1], 24 + 460 * p, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** The router's costs at a junction: each way and the time it expects there; the one it takes lit. */
function compare(ctx: Ctx, s: OverlayScene, item: Extract<Item, { kind: 'compare' }>): void {
  const v = s.compare(item.node);
  const at = s.point({ kind: 'node', name: item.node, y: 0.9 }, 'ai');
  if (!v || !at) return;
  const pane = roomOf(s, 'ai');
  const value = (c: number) =>
    Number.isFinite(c) ? `${c.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : '∞';
  const rows = [
    { way: 'primary' as const, name: v.primary.name, text: value(v.primary.cost) },
    { way: 'alternative' as const, name: v.alternative.name, text: value(v.alternative.cost) },
  ];
  const size = 40;
  const rowH = size * 1.45;
  const titleSize = 28;
  ctx.font = `600 ${titleSize}px ${D}`;
  const tw = ctx.measureText(COMPARE_TITLE).width;
  ctx.font = `700 ${size}px ${D}`;
  const nameW = Math.max(...rows.map((r) => ctx.measureText(r.name).width));
  ctx.font = `700 ${size}px ${M}`;
  const valueW = Math.max(...rows.map((r) => ctx.measureText(r.text).width));
  const w = Math.max(tw, nameW + valueW + 50) + 48;
  const h = titleSize + 30 + rows.length * rowH + 12;
  let x = item.dx < 0 ? at[0] + item.dx - w : at[0] + item.dx;
  x = Math.min(Math.max(x, pane.x + 16), pane.x + pane.w - w - 16);
  // Under the side's tag (top left of the pane), above its bottom.
  const below = s.layout === 'split' ? 150 : 16;
  const y = Math.min(Math.max(at[1] + item.dy - h / 2, pane.y + below), pane.y + pane.h - h - 16);
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(at[0], at[1]);
  ctx.lineTo(item.dx < 0 ? x + w : x, y + h / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(at[0], at[1], 13, 0, Math.PI * 2);
  ctx.stroke();
  round(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.92)';
  ctx.fill();
  ctx.stroke();
  ctx.font = `600 ${titleSize}px ${D}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(COMPARE_TITLE, x + 24, y + titleSize + 10);
  rows.forEach((r, i) => {
    const ry = y + titleSize + 24 + i * rowH;
    const lit = r.way === v.chosen;
    if (lit) {
      round(ctx, x + 10, ry, w - 20, rowH - 6, 8);
      ctx.fillStyle = 'rgba(56, 225, 214, 0.18)';
      ctx.fill();
    }
    ctx.fillStyle = lit ? CYAN : MUTED;
    ctx.font = `700 ${size}px ${D}`;
    ctx.fillText(r.name, x + 24, ry + size * 1.02);
    ctx.font = `700 ${size}px ${M}`;
    ctx.textAlign = 'right';
    ctx.fillText(r.text, x + w - 24, ry + size * 1.02);
    ctx.textAlign = 'start';
  });
}

/** The log's letters (px): readable on a phone. */
const LOG_SIZE = 36;
const LOG_LINE = LOG_SIZE * 1.25;

/** Where the AI's log's box starts (its top), for `lines` lines and the status line, one row each. */
function logTop(room: Pane, lines: number): number {
  return room.y + room.h - ((lines + 1) * LOG_LINE + 22);
}

/** "128 s · IA assume…": the time, and the words. */
const logParts = (text: string): [string, string] => {
  const i = text.indexOf(' · ');
  return i < 0 ? ['', text] : [text.slice(0, i), text.slice(i + 3)];
};

/**
 * The AI's log at the bottom of its pane's room, against the right: its last
 * `shown` lines, the time of each in the AI's color, the newest coming in;
 * under them, while the router decides every second, LOG_STATUS with a dot
 * that beats with it. Long lines wrap; the box grows upward.
 */
function log(ctx: Ctx, s: OverlayScene, side: CinemaSide, shown: number): void {
  const lines = s.log.slice(-shown);
  if (lines.length === 0) return;
  const room = roomOf(s, side);
  const size = LOG_SIZE;
  ctx.font = `700 ${size}px ${D}`;
  const stampW = Math.max(...lines.map((l) => ctx.measureText(logParts(l.text)[0]).width));
  const maxText = room.w - 44 - stampW - 18 - 16;
  const wrapped = lines.map((l) => {
    const [stamp, text] = logParts(l.text);
    return { at: l.at, stamp, rows: wrap(ctx, text, maxText) };
  });
  const deciding = s.decidedAt >= 0;
  ctx.font = `600 ${size}px ${D}`;
  const statusRows = deciding ? wrap(ctx, LOG_STATUS, maxText + stampW + 18 - 30) : [];
  ctx.font = `700 ${size}px ${D}`;
  const textW = Math.max(
    ...wrapped.flatMap((l) => l.rows.map((r) => stampW + 18 + ctx.measureText(r).width)),
    ...statusRows.map((r) => 30 + ctx.measureText(r).width),
  );
  const w = Math.min(textW + 44, room.w);
  const rows = wrapped.reduce((n, l) => n + l.rows.length, 0) + statusRows.length;
  const h = rows * LOG_LINE + 22;
  const x = room.x + room.w - w;
  const y = room.y + room.h - h;
  round(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.9)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(56, 225, 214, 0.55)';
  ctx.stroke();
  const base = ctx.globalAlpha;
  let row = 0;
  for (const l of wrapped) {
    // A new line comes in over 0.4 s of video.
    const age = s.speed > 0 ? (s.time - l.at) / s.speed : 1;
    ctx.globalAlpha = base * Math.min(1, Math.max(0.15, age / 0.4));
    ctx.font = `700 ${size}px ${D}`;
    ctx.fillStyle = CYAN;
    ctx.fillText(l.stamp, x + 22, y + 11 + (row + 1) * LOG_LINE - size * 0.28);
    ctx.fillStyle = INK;
    for (const r of l.rows) {
      row++;
      ctx.fillText(r, x + 22 + stampW + 18, y + 11 + row * LOG_LINE - size * 0.28);
    }
  }
  ctx.globalAlpha = base;
  if (deciding) {
    const beat = s.speed > 0 ? (s.time - s.decidedAt) / s.speed : 1;
    ctx.fillStyle = CYAN;
    ctx.globalAlpha = base * (beat < PULSE ? 1 - 0.6 * (beat / PULSE) : 0.4);
    ctx.beginPath();
    ctx.arc(x + 22 + 9, y + 11 + (row + 1) * LOG_LINE - size * 0.6, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = base;
    ctx.font = `600 ${size}px ${D}`;
    ctx.fillStyle = MUTED;
    for (const r of statusRows) {
      row++;
      ctx.fillText(r, x + 22 + 30, y + 11 + row * LOG_LINE - size * 0.28);
    }
  }
}

/** Breaks a text into rows no wider than `width` (in the font set). */
function wrap(ctx: Ctx, text: string, width: number): string[] {
  return lines(ctx, text, width);
}

/**
 * The 24 motors' alarm sums (each one's CUSUM against the limit of its
 * alarm), read every second: a bar each, the cursor sweeping them once per
 * simulated second, the highest one named once it stands out, in the worn
 * motor's yellow.
 */
function monitor(ctx: Ctx, s: OverlayScene, side: CinemaSide): void {
  const sums = s.motors;
  if (sums.length === 0) return;
  const pane = roomOf(s, side);
  const { x, y, w, h } = forecastBox(s, pane);
  round(ctx, x, y, w, h, 14);
  ctx.fillStyle = 'rgba(6, 9, 13, 0.9)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = CYAN;
  ctx.stroke();
  ctx.font = `700 30px ${D}`;
  ctx.fillStyle = INK;
  ctx.fillText(MONITOR_TITLE, x + 26, y + 50);
  const top = y + 120;
  const bottom = y + h - 64;
  const cx = x + 26;
  const cw = w - 52;
  const step = cw / sums.length;
  const scale = (v: number) => ((bottom - top) * Math.min(1.15, Math.max(0, v))) / 1.15;
  // The alarm's limit (the sum reaching it raises the alarm).
  ctx.save();
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, bottom - scale(1));
  ctx.lineTo(cx + cw, bottom - scale(1));
  ctx.stroke();
  ctx.restore();
  let top1 = -1;
  sums.forEach((v, i) => {
    if (top1 < 0 || v > (sums[top1] as number)) top1 = i;
    const bh = Math.max(10, scale(v));
    const warm = Math.min(1, Math.max(0, (v - 0.15) / 0.35));
    ctx.fillStyle = warm > 0 ? YELLOW : SENSOR;
    ctx.globalAlpha = 0.55 + 0.45 * warm;
    ctx.fillRect(cx + i * step + step * 0.18, bottom - bh, step * 0.64, bh);
    ctx.globalAlpha = 1;
  });
  // The first and the last motor numbered (the one that stands out is named above its bar).
  ctx.font = `600 22px ${M}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  ctx.fillText('1', cx + 0.5 * step, bottom + 30);
  ctx.fillText(String(sums.length), cx + (sums.length - 0.5) * step, bottom + 30);
  ctx.textAlign = 'start';
  // Every motor is read once per simulated second: the cursor goes across them in that second.
  const sweep = s.time - Math.floor(s.time + 1e-9);
  ctx.fillStyle = CYAN;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(cx + sweep * cw - 2, top - 10, 4, bottom - top + 14);
  ctx.globalAlpha = 1;
  const best = sums[top1] ?? 0;
  if (top1 >= 0 && best >= 0.25) {
    const bx = cx + (top1 + 0.5) * step;
    const label = `Esteira ${top1 + 1}`;
    ctx.font = `700 30px ${D}`;
    const lw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(bx - lw / 2, cx), cx + cw - lw);
    ctx.fillStyle = YELLOW;
    ctx.fillText(label, lx, Math.max(top - 16, bottom - scale(best) - 14));
  }
}
