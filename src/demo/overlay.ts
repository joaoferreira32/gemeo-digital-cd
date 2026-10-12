import type { CardRow } from './card';

/**
 * What the demo draws over the scene: the caption of the beat, a thin
 * progress line, a small brand, and the final card with big numbers; in the
 * explained demo also the chapter ("Etapa X de 9"), the speed badge, a
 * warning, the queue counter, the detector's card, the timeline going back
 * and the last screen. Drawn on a 2D canvas, not in HTML, because the
 * recording captures canvases only: the same drawing goes over the scene on
 * screen and into each video frame. Sizes are designed at 1080 px; the
 * explained demo scales by the smaller side, so a phone held upright gets
 * captions it can read.
 */

export interface OverlayCard {
  readonly title: string;
  readonly subtitle: string;
  readonly rows: readonly CardRow[];
  readonly notes: readonly string[];
}

export interface OverlayState {
  readonly title: string;
  readonly text: string;
  /** How visible the caption is (0 … 1). */
  readonly alpha: number;
  /** How far the demo is (0 … 1). */
  readonly progress: number;
  readonly card: OverlayCard | null;
  readonly cardAlpha: number;
  /** A line in the corner while the run is being prepared (empty otherwise). */
  readonly status: string;
  /** The explained demo's presentation (big captions and what goes with them). */
  readonly large: boolean;
  /** The chapter of the explained demo. */
  readonly step: { readonly index: number; readonly count: number; readonly name: string } | null;
  /** "2,5×", "pausado", or nothing at real time. */
  readonly badge: string;
  readonly alert: string;
  /** Packets queuing now, and one sample per simulated second for the small chart. */
  readonly counter: { readonly value: number; readonly history: readonly number[] } | null;
  /** The detector's card, big (empty when not shown). */
  readonly bottleneck: string;
  /** The timeline going back: from the end of the run to the branch, now at `at` (s). */
  readonly timeline: { readonly from: number; readonly to: number; readonly at: number } | null;
  /** The last screen's text (empty before it). */
  readonly end: string;
  /** A dark veil over the scene (0 … 1): hides a camera cut with reduced motion. */
  readonly veil: number;
}

const INK = '#e6edf3';
const MUTED = 'rgba(230, 237, 243, 0.68)';
const AMBER = '#f2a541';
const CYAN = '#38e1d6';
const RED = '#ff5d5d';
const PANEL = 'rgba(10, 14, 19, 0.9)';
const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

/** Breaks `text` into lines no wider than `width` (the font already set). */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const px = (v: number) => `${Math.round(v)}px`;

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: OverlayState,
): void {
  // The explained demo scales by the smaller side (a phone upright); the short one by the height.
  const u = (s.large ? Math.min(w, h) : h) / 1080;
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  if (s.veil > 0.001) {
    ctx.globalAlpha = Math.min(1, s.veil) * 0.85;
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);
  }

  // Brand, top left, over a soft shade (the scene behind it can be busy). On a
  // phone held upright the explained demo's chapter line takes that room.
  if (!(s.large && w < h)) drawBrand(ctx, u, s.status);
  else if (s.status) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = AMBER;
    ctx.font = `500 ${px(17 * u)} ${MONO}`;
    ctx.fillText(s.status, 56 * u, 132 * u);
  }

  if (s.large) {
    drawStep(ctx, w, u, s);
    if (s.counter) drawCounter(ctx, w, u, s.counter);
    if (s.alert) drawAlert(ctx, w, h, u, s.alert);
    if (s.timeline) drawTimeline(ctx, w, h, u, s.timeline);
  }

  // Caption, bottom left, over a soft shade for legibility.
  if (s.alpha > 0.001 && (s.title || s.text) && !s.end) {
    ctx.globalAlpha = s.alpha;
    if (s.large) drawLargeCaption(ctx, w, h, u, s);
    else drawCaption(ctx, w, h, u, s);
  }
  if (s.large && s.bottleneck && s.alpha > 0.001) {
    ctx.globalAlpha = s.alpha;
    drawBottleneck(ctx, w, h, u, s.bottleneck);
  }

  // Progress, a thin line along the bottom.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(230, 237, 243, 0.12)';
  ctx.fillRect(0, h - 5 * u, w, 5 * u);
  ctx.fillStyle = CYAN;
  ctx.fillRect(0, h - 5 * u, w * Math.min(1, Math.max(0, s.progress)), 5 * u);

  // The card a little bigger in the explained demo (it is read on a phone too).
  if (s.card && s.cardAlpha > 0.001)
    drawCard(ctx, w, h, u * (s.large ? 1.1 : 1), s.card, s.cardAlpha);
  if (s.end) drawEnd(ctx, w, h, u, s.end);
  ctx.restore();
}

function drawBrand(ctx: CanvasRenderingContext2D, u: number, status: string): void {
  const corner = ctx.createRadialGradient(0, 0, 0, 0, 0, 620 * u);
  corner.addColorStop(0, 'rgba(10, 14, 19, 0.75)');
  corner.addColorStop(1, 'rgba(10, 14, 19, 0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = corner;
  ctx.fillRect(0, 0, 620 * u, 620 * u);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = INK;
  ctx.font = `600 ${px(24 * u)} ${DISPLAY}`;
  ctx.fillText('GÊMEO DIGITAL · CENTRO DE DISTRIBUIÇÃO', 56 * u, 70 * u);
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${px(17 * u)} ${MONO}`;
  ctx.fillText('demo determinística · a mesma em qualquer máquina', 56 * u, 100 * u);
  if (status) {
    ctx.fillStyle = AMBER;
    ctx.fillText(status, 56 * u, 132 * u);
  }
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  s: OverlayState,
): void {
  const shade = ctx.createLinearGradient(0, h, 0, h - 330 * u);
  shade.addColorStop(0, 'rgba(10, 14, 19, 0.82)');
  shade.addColorStop(1, 'rgba(10, 14, 19, 0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, h - 330 * u, w, 330 * u);
  const x = 56 * u;
  const width = Math.min(w * 0.62, 1180 * u);
  ctx.font = `500 ${px(30 * u)} ${DISPLAY}`;
  const lines = wrap(ctx, s.text, width);
  let y = h - 64 * u - (lines.length - 1) * 38 * u;
  ctx.font = `700 ${px(54 * u)} ${DISPLAY}`;
  const titleY = y - 52 * u;
  ctx.fillStyle = AMBER;
  ctx.fillRect(x, titleY - 44 * u, 6 * u, 52 * u);
  ctx.fillStyle = INK;
  ctx.fillText(s.title, x + 22 * u, titleY);
  ctx.font = `500 ${px(30 * u)} ${DISPLAY}`;
  ctx.fillStyle = 'rgba(230, 237, 243, 0.86)';
  for (const line of lines) {
    ctx.fillText(line, x + 22 * u, y);
    y += 38 * u;
  }
}

/** The explained demo's caption: big, on a dark band across the bottom. */
function drawLargeCaption(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  s: OverlayState,
): void {
  const x = 56 * u;
  const width = Math.min(w - 2 * x - 28 * u, 1760 * u);
  const textSize = 58 * u;
  const lineH = textSize * 1.22;
  ctx.font = `500 ${px(textSize)} ${DISPLAY}`;
  const lines = wrap(ctx, s.text, width);
  ctx.font = `700 ${px(72 * u)} ${DISPLAY}`;
  const titleLines = s.title ? wrap(ctx, s.title, width) : [];
  const band = 72 * u + titleLines.length * 82 * u + lines.length * lineH + 30 * u;
  const shade = ctx.createLinearGradient(0, h, 0, h - band - 120 * u);
  shade.addColorStop(0, 'rgba(10, 14, 19, 0.92)');
  shade.addColorStop(0.75, 'rgba(10, 14, 19, 0.78)');
  shade.addColorStop(1, 'rgba(10, 14, 19, 0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, h - band - 120 * u, w, band + 120 * u);
  let y = h - 56 * u - (lines.length - 1) * lineH;
  let ty = y - lineH * 0.2 - 18 * u - (titleLines.length - 1) * 82 * u - 30 * u;
  ctx.fillStyle = AMBER;
  ctx.fillRect(x, ty - 60 * u, 8 * u, 70 * u + (titleLines.length - 1) * 82 * u);
  ctx.fillStyle = INK;
  ctx.font = `700 ${px(72 * u)} ${DISPLAY}`;
  for (const line of titleLines) {
    ctx.fillText(line, x + 28 * u, ty);
    ty += 82 * u;
  }
  ctx.font = `500 ${px(textSize)} ${DISPLAY}`;
  ctx.fillStyle = 'rgba(230, 237, 243, 0.94)';
  for (const line of lines) {
    ctx.fillText(line, x + 28 * u, y);
    y += lineH;
  }
}

/** "ETAPA 4 DE 9 · A FILA CRESCE", nine segments under it, and the speed badge beside it. */
function drawStep(ctx: CanvasRenderingContext2D, w: number, u: number, s: OverlayState): void {
  if (!s.step && !s.badge) return;
  ctx.globalAlpha = 1;
  const top = 64 * u;
  let label = '';
  let labelW = 0;
  if (s.step) {
    label = `ETAPA ${s.step.index} DE ${s.step.count} · ${s.step.name.toLocaleUpperCase('pt-BR')}`;
    ctx.font = `700 ${px(36 * u)} ${DISPLAY}`;
    labelW = ctx.measureText(label).width;
  }
  ctx.font = `700 ${px(32 * u)} ${MONO}`;
  const badgeW = s.badge ? ctx.measureText(s.badge).width + 40 * u : 0;
  const gap = s.badge && s.step ? 24 * u : 0;
  const total = labelW + gap + badgeW;
  let x = Math.max(56 * u, (w - total) / 2);
  const panelW = total + 48 * u;
  ctx.fillStyle = 'rgba(10, 14, 19, 0.78)';
  ctx.fillRect(x - 24 * u, top - 46 * u, panelW, s.step ? 92 * u : 64 * u);
  if (s.step) {
    ctx.fillStyle = INK;
    ctx.font = `700 ${px(36 * u)} ${DISPLAY}`;
    ctx.fillText(label, x, top);
    // The nine segments: done, current, to come.
    const segW = (labelW - (s.step.count - 1) * 6 * u) / s.step.count;
    for (let i = 1; i <= s.step.count; i++) {
      ctx.fillStyle =
        i < s.step.index ? CYAN : i === s.step.index ? AMBER : 'rgba(230, 237, 243, 0.2)';
      ctx.fillRect(x + (i - 1) * (segW + 6 * u), top + 18 * u, segW, 8 * u);
    }
    x += labelW + gap;
  }
  if (s.badge) {
    ctx.fillStyle = s.badge === 'pausado' ? INK : AMBER;
    ctx.fillRect(x, top - 36 * u, badgeW, 46 * u);
    ctx.fillStyle = '#0a0e13';
    ctx.font = `700 ${px(32 * u)} ${MONO}`;
    ctx.fillText(s.badge, x + 20 * u, top);
  }
}

function drawAlert(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  text: string,
): void {
  ctx.globalAlpha = 1;
  ctx.font = `700 ${px(56 * u)} ${DISPLAY}`;
  const label = `⚠ ${text}`;
  const tw = Math.min(ctx.measureText(label).width, w - 160 * u);
  const bx = (w - tw) / 2 - 36 * u;
  const by = Math.min(190 * u, h * 0.2);
  ctx.fillStyle = 'rgba(40, 8, 8, 0.88)';
  ctx.fillRect(bx, by, tw + 72 * u, 88 * u);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 4 * u;
  ctx.strokeRect(bx, by, tw + 72 * u, 88 * u);
  ctx.fillStyle = '#ffd6d6';
  ctx.fillText(label, bx + 36 * u, by + 62 * u, w - 160 * u);
}

/** The queue, top right: the number now, and a small chart since the breakdown. */
function drawCounter(
  ctx: CanvasRenderingContext2D,
  w: number,
  u: number,
  c: { readonly value: number; readonly history: readonly number[] },
): void {
  ctx.globalAlpha = 1;
  const pw = 400 * u;
  const ph = 230 * u;
  const x = w - pw - 40 * u;
  const y = 130 * u;
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, pw, ph);
  ctx.fillStyle = RED;
  ctx.fillRect(x, y, pw, 5 * u);
  ctx.fillStyle = MUTED;
  ctx.font = `600 ${px(28 * u)} ${DISPLAY}`;
  ctx.fillText('PACOTES NA FILA', x + 26 * u, y + 48 * u);
  ctx.fillStyle = INK;
  ctx.font = `600 ${px(84 * u)} ${MONO}`;
  ctx.fillText(Math.round(c.value).toLocaleString('pt-BR'), x + 26 * u, y + 130 * u);
  const hist = c.history;
  if (hist.length > 1) {
    const top = Math.max(50, ...hist);
    const cx = x + 26 * u;
    const cy = y + ph - 22 * u;
    const cw = pw - 52 * u;
    const ch = 64 * u;
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const px2 = cx + (cw * i) / Math.max(1, hist.length - 1);
      const py2 = cy - (ch * v) / top;
      if (i === 0) ctx.moveTo(px2, py2);
      else ctx.lineTo(px2, py2);
    });
    ctx.stroke();
  }
}

/** The detector's card, big and highlighted, above the caption. */
function drawBottleneck(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  text: string,
): void {
  const pw = Math.min(w - 112 * u, 1500 * u);
  ctx.font = `500 ${px(46 * u)} ${DISPLAY}`;
  const lines = wrap(ctx, text, pw - 96 * u);
  const ph = (96 + lines.length * 58 + 30) * u;
  const x = (w - pw) / 2;
  const y = Math.max(200 * u, h * 0.42 - ph / 2);
  ctx.save();
  ctx.shadowColor = 'rgba(242, 165, 65, 0.55)';
  ctx.shadowBlur = 40 * u;
  ctx.fillStyle = 'rgba(10, 14, 19, 0.94)';
  ctx.fillRect(x, y, pw, ph);
  ctx.restore();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 4 * u;
  ctx.strokeRect(x, y, pw, ph);
  ctx.fillStyle = AMBER;
  ctx.font = `700 ${px(30 * u)} ${DISPLAY}`;
  ctx.fillText('CARTÃO DO GARGALO · DETECTOR AO VIVO', x + 48 * u, y + 56 * u);
  ctx.fillStyle = INK;
  ctx.font = `500 ${px(46 * u)} ${DISPLAY}`;
  let ly = y + 112 * u;
  for (const line of lines) {
    ctx.fillText(line, x + 48 * u, ly);
    ly += 58 * u;
  }
}

/** The timeline going back to the moment before the breakdown. */
function drawTimeline(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  t: { readonly from: number; readonly to: number; readonly at: number },
): void {
  ctx.globalAlpha = 1;
  const bw = Math.min(w - 200 * u, 1300 * u);
  const x = (w - bw) / 2;
  const y = h * 0.42;
  const sx = (time: number) => x + (bw * time) / t.from;
  ctx.fillStyle = 'rgba(10, 14, 19, 0.82)';
  ctx.fillRect(x - 40 * u, y - 110 * u, bw + 80 * u, 190 * u);
  ctx.fillStyle = 'rgba(230, 237, 243, 0.25)';
  ctx.fillRect(x, y, bw, 8 * u);
  ctx.fillStyle = CYAN;
  ctx.fillRect(x, y, sx(t.at) - x, 8 * u);
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${px(28 * u)} ${MONO}`;
  ctx.fillText('0 s', x, y + 56 * u);
  ctx.fillText(`${Math.round(t.from)} s`, x + bw - 80 * u, y + 56 * u);
  ctx.fillStyle = RED;
  ctx.fillRect(sx(t.to) - 2 * u, y - 18 * u, 4 * u, 44 * u);
  ctx.font = `600 ${px(26 * u)} ${DISPLAY}`;
  ctx.fillText('quebra', sx(t.to) - 30 * u, y + 56 * u);
  ctx.fillStyle = AMBER;
  ctx.beginPath();
  ctx.arc(sx(t.at), y + 4 * u, 18 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.font = `700 ${px(40 * u)} ${MONO}`;
  ctx.fillText(`${Math.round(t.at)} s`, sx(t.at) - 50 * u, y - 40 * u);
}

function drawEnd(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  text: string,
): void {
  ctx.globalAlpha = 0.94;
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.font = `600 ${px(60 * u)} ${DISPLAY}`;
  const lines = wrap(ctx, text, w - 160 * u);
  let y = h / 2 - ((lines.length - 1) * 74 * u) / 2;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  for (const line of lines) {
    ctx.fillText(line, w / 2, y);
    y += 74 * u;
  }
  ctx.fillStyle = AMBER;
  ctx.fillRect(w / 2 - 60 * u, y - 20 * u, 120 * u, 6 * u);
  ctx.textAlign = 'start';
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  u: number,
  card: OverlayCard,
  alpha: number,
): void {
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = alpha;
  const pw = Math.min(w - 80 * u, 1420 * u);
  // The panel fits what it holds: title, subtitle, table, notes.
  ctx.font = `500 ${px(28 * u)} ${DISPLAY}`;
  const subtitle = wrap(ctx, card.subtitle, pw - 128 * u);
  ctx.font = `500 ${px(24 * u)} ${DISPLAY}`;
  const notes = card.notes.flatMap((n) => wrap(ctx, n, pw - 128 * u));
  const ph =
    (104 +
      50 +
      34 * subtitle.length +
      34 +
      16 +
      62 * card.rows.length +
      72 +
      30 * notes.length +
      30) *
    u;
  const px0 = (w - pw) / 2;
  const py = (h - ph) / 2;
  ctx.fillStyle = PANEL;
  ctx.fillRect(px0, py, pw, ph);
  ctx.strokeStyle = 'rgba(230, 237, 243, 0.14)';
  ctx.lineWidth = 2 * u;
  ctx.strokeRect(px0, py, pw, ph);
  ctx.fillStyle = AMBER;
  ctx.fillRect(px0, py, pw, 6 * u);

  const x = px0 + 64 * u;
  let y = py + 104 * u;
  ctx.fillStyle = INK;
  ctx.font = `700 ${px(66 * u)} ${DISPLAY}`;
  ctx.fillText(card.title, x, y);
  y += 50 * u;
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${px(28 * u)} ${DISPLAY}`;
  for (const line of subtitle) {
    ctx.fillText(line, x, y);
    y += 34 * u;
  }

  // The table: label, with AI, without AI, change.
  const cols = [x, x + pw * 0.3, x + pw * 0.53, x + pw * 0.76];
  y += 34 * u;
  ctx.font = `600 ${px(24 * u)} ${DISPLAY}`;
  ctx.fillStyle = MUTED;
  ctx.fillText('COM IA', cols[1] as number, y);
  ctx.fillText('SEM IA', cols[2] as number, y);
  ctx.fillText('DIFERENÇA', cols[3] as number, y);
  y += 16 * u;
  for (const row of card.rows) {
    y += 62 * u;
    ctx.fillStyle = 'rgba(230, 237, 243, 0.08)';
    ctx.fillRect(x, y + 18 * u, pw - 128 * u, 1.5 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${px(32 * u)} ${DISPLAY}`;
    ctx.fillText(row.label, cols[0] as number, y, pw * 0.29);
    // Each value fits its column: the font shrinks for a long one.
    const column = pw * 0.22;
    const value = (text: string, color: string, at: number) => {
      let size = 40 * u;
      ctx.font = `500 ${px(size)} ${MONO}`;
      while (size > 18 * u && ctx.measureText(text).width > column) {
        size -= 2 * u;
        ctx.font = `500 ${px(size)} ${MONO}`;
      }
      ctx.fillStyle = color;
      ctx.fillText(text, at, y);
    };
    value(row.ai, CYAN, cols[1] as number);
    value(row.noAi, INK, cols[2] as number);
    value(row.change, AMBER, cols[3] as number);
  }
  y += 72 * u;
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${px(24 * u)} ${DISPLAY}`;
  for (const line of notes) {
    ctx.fillText(line, x, y);
    y += 30 * u;
  }
}
