import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { css, mix, type PaletteName } from './palette';
import type { ResourceTracker } from './resources';

/** All textures are drawn by code on a canvas: no image assets in the project. */
function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, tracker: ResourceTracker, repeat: boolean): CanvasTexture {
  const tex = tracker.track(new CanvasTexture(c));
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/** Concrete slab: speckle noise plus a saw-cut joint on the border (tiles every slab). */
export function concreteTexture(tracker: ResourceTracker, seed = 1): CanvasTexture {
  const size = 512;
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = mix('graphite', 'steel', 0.55).getStyle();
  ctx.fillRect(0, 0, size, size);
  // Deterministic speckle (render-only cosmetic noise).
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 9000; i++) {
    const v = rand();
    ctx.fillStyle = v > 0.5 ? 'rgba(230,237,243,0.025)' : 'rgba(10,14,19,0.05)';
    const r = 1 + rand() * 3;
    ctx.fillRect(rand() * size, rand() * size, r, r);
  }
  ctx.strokeStyle = 'rgba(10,14,19,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  return finish(c, tracker, true);
}

/** Belt surface: dark rubber with transverse cleats; scrolled along u to show motion. */
export function beltTexture(tracker: ResourceTracker, tint: PaletteName): CanvasTexture {
  const [c, ctx] = canvas(128, 64);
  ctx.fillStyle = mix('graphite', tint, 0.06).getStyle();
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = mix('steel', tint, 0.22).getStyle();
  for (let x = 0; x < 128; x += 32) ctx.fillRect(x, 0, 6, 64);
  return finish(c, tracker, true);
}

/** Cardboard box side: amber with a darker packing tape band. */
export function cardboardTexture(tracker: ResourceTracker): CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = 'rgba(10,14,19,0.28)';
  ctx.fillRect(26, 0, 12, 64);
  ctx.strokeStyle = 'rgba(10,14,19,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 62, 62);
  return finish(c, tracker, false);
}

export interface LabelOptions {
  color?: PaletteName;
  background?: PaletteName | null;
  /** Font size in canvas pixels; the canvas is sized to fit the text. */
  size?: number;
  weight?: number;
  family?: string;
}

/** Text drawn in the UI font, for floor stencils and signs. Returns texture and aspect ratio. */
export function labelTexture(
  tracker: ResourceTracker,
  text: string,
  opts: LabelOptions = {},
): { texture: CanvasTexture; aspect: number } {
  const size = opts.size ?? 96;
  const font = `${opts.weight ?? 700} ${size}px ${opts.family ?? '"Barlow Condensed", sans-serif'}`;
  const [, probe] = canvas(1, 1);
  probe.font = font;
  const pad = size * 0.35;
  const width = Math.ceil(probe.measureText(text).width + pad * 2);
  const height = Math.ceil(size * 1.35);
  const [c, ctx] = canvas(width, height);
  if (opts.background) {
    ctx.fillStyle = css(opts.background);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.font = font;
  ctx.fillStyle = css(opts.color ?? 'ice');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + size * 0.04);
  return { texture: finish(c, tracker, false), aspect: width / height };
}
