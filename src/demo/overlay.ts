import type { CardRow } from './card';

/**
 * What the demo draws over the scene: the caption of the beat, a thin
 * progress line, a small brand, and the final card with big numbers. Drawn
 * on a 2D canvas, not in HTML, because the recording captures canvases only:
 * the same drawing goes over the scene on screen and into each video frame.
 * Sizes follow the height (designed at 1080 px).
 */

export interface OverlayCard {
  readonly title: string;
  readonly subtitle: string;
  readonly rows: readonly CardRow[];
  readonly note: string;
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
}

const INK = '#e6edf3';
const MUTED = 'rgba(230, 237, 243, 0.68)';
const AMBER = '#f2a541';
const CYAN = '#38e1d6';
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

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: OverlayState,
): void {
  const u = h / 1080;
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // Brand, top left, over a soft shade (the scene behind it can be busy).
  const corner = ctx.createRadialGradient(0, 0, 0, 0, 0, 620 * u);
  corner.addColorStop(0, 'rgba(10, 14, 19, 0.75)');
  corner.addColorStop(1, 'rgba(10, 14, 19, 0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = corner;
  ctx.fillRect(0, 0, 620 * u, 620 * u);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = INK;
  ctx.font = `600 ${Math.round(24 * u)}px ${DISPLAY}`;
  ctx.fillText('GÊMEO DIGITAL · CENTRO DE DISTRIBUIÇÃO', 56 * u, 70 * u);
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${Math.round(17 * u)}px ${MONO}`;
  ctx.fillText('demo determinística · a mesma em qualquer máquina', 56 * u, 100 * u);
  if (s.status) {
    ctx.fillStyle = AMBER;
    ctx.fillText(s.status, 56 * u, 132 * u);
  }

  // Caption, bottom left, over a soft shade for legibility.
  if (s.alpha > 0.001 && (s.title || s.text)) {
    ctx.globalAlpha = s.alpha;
    const shade = ctx.createLinearGradient(0, h, 0, h - 330 * u);
    shade.addColorStop(0, 'rgba(10, 14, 19, 0.82)');
    shade.addColorStop(1, 'rgba(10, 14, 19, 0)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, h - 330 * u, w, 330 * u);
    const x = 56 * u;
    const width = Math.min(w * 0.62, 1180 * u);
    ctx.font = `500 ${Math.round(30 * u)}px ${DISPLAY}`;
    const lines = wrap(ctx, s.text, width);
    let y = h - 64 * u - (lines.length - 1) * 38 * u;
    ctx.font = `700 ${Math.round(54 * u)}px ${DISPLAY}`;
    const titleY = y - 52 * u;
    ctx.fillStyle = AMBER;
    ctx.fillRect(x, titleY - 44 * u, 6 * u, 52 * u);
    ctx.fillStyle = INK;
    ctx.fillText(s.title, x + 22 * u, titleY);
    ctx.font = `500 ${Math.round(30 * u)}px ${DISPLAY}`;
    ctx.fillStyle = 'rgba(230, 237, 243, 0.86)';
    for (const line of lines) {
      ctx.fillText(line, x + 22 * u, y);
      y += 38 * u;
    }
  }

  // Progress, a thin line along the bottom.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(230, 237, 243, 0.12)';
  ctx.fillRect(0, h - 5 * u, w, 5 * u);
  ctx.fillStyle = CYAN;
  ctx.fillRect(0, h - 5 * u, w * Math.min(1, Math.max(0, s.progress)), 5 * u);

  if (s.card && s.cardAlpha > 0.001) drawCard(ctx, w, h, s.card, s.cardAlpha);
  ctx.restore();
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  card: OverlayCard,
  alpha: number,
): void {
  const u = h / 1080;
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = alpha;
  const pw = Math.min(w - 80 * u, 1420 * u);
  // The panel fits what it holds: title, subtitle, table, note.
  ctx.font = `500 ${Math.round(28 * u)}px ${DISPLAY}`;
  const subtitle = wrap(ctx, card.subtitle, pw - 128 * u);
  ctx.font = `500 ${Math.round(24 * u)}px ${DISPLAY}`;
  const note = wrap(ctx, card.note, pw - 128 * u);
  const ph =
    (104 +
      50 +
      34 * subtitle.length +
      34 +
      16 +
      62 * card.rows.length +
      72 +
      30 * note.length +
      30) *
    u;
  const px = (w - pw) / 2;
  const py = (h - ph) / 2;
  ctx.fillStyle = PANEL;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = 'rgba(230, 237, 243, 0.14)';
  ctx.lineWidth = 2 * u;
  ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle = AMBER;
  ctx.fillRect(px, py, pw, 6 * u);

  const x = px + 64 * u;
  let y = py + 104 * u;
  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(66 * u)}px ${DISPLAY}`;
  ctx.fillText(card.title, x, y);
  y += 50 * u;
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${Math.round(28 * u)}px ${DISPLAY}`;
  for (const line of subtitle) {
    ctx.fillText(line, x, y);
    y += 34 * u;
  }

  // The table: label, with AI, without AI, change.
  const cols = [x, x + pw * 0.3, x + pw * 0.53, x + pw * 0.76];
  y += 34 * u;
  ctx.font = `600 ${Math.round(24 * u)}px ${DISPLAY}`;
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
    ctx.font = `600 ${Math.round(32 * u)}px ${DISPLAY}`;
    ctx.fillText(row.label, cols[0] as number, y);
    // Each value fits its column: the font shrinks for a long one ("1, e 1 evitada").
    const column = pw * 0.22;
    const value = (text: string, color: string, at: number) => {
      let size = 40 * u;
      ctx.font = `500 ${Math.round(size)}px ${MONO}`;
      while (size > 18 * u && ctx.measureText(text).width > column) {
        size -= 2 * u;
        ctx.font = `500 ${Math.round(size)}px ${MONO}`;
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
  ctx.font = `500 ${Math.round(24 * u)}px ${DISPLAY}`;
  for (const line of note) {
    ctx.fillText(line, x, y);
    y += 30 * u;
  }
}
