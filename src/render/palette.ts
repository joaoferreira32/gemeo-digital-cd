import { Color } from 'three';

/**
 * The whole scene and UI are built from these six colors (mirrored as CSS
 * custom properties in styles.css). Shades are derived by mixing them, never
 * by introducing new hues.
 */
export const PALETTE = {
  /** Background, deep shadows. */
  graphite: 0x0a0e13,
  /** Structures: conveyors, racks, walls. */
  steel: 0x1c2530,
  /** Packets and safety markings. */
  amber: 0xf2a541,
  /** System / AI accents: rails, transfer nodes, highlights. */
  cyan: 0x38e1d6,
  /** Failures and alerts. */
  alert: 0xff4d5e,
  /** Light fixtures and text. */
  ice: 0xe6edf3,
} as const;

export type PaletteName = keyof typeof PALETTE;

/** Mix of two palette colors; `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: PaletteName, b: PaletteName, t: number): Color {
  return new Color(PALETTE[a]).lerp(new Color(PALETTE[b]), t);
}

/** CSS hex string of a palette color (for canvas-drawn labels). */
export function css(name: PaletteName): string {
  return `#${PALETTE[name].toString(16).padStart(6, '0')}`;
}
