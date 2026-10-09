export type QualityLevel = 'alta' | 'media' | 'baixa';

export const QUALITY_LABEL: Record<QualityLevel, string> = {
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};

export interface QualitySettings {
  reflection: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** PCF filter radius in texels: larger = softer shadow edges. */
  shadowRadius: number;
  maxPixelRatio: number;
  /** Light trails behind the robots. */
  trails: boolean;
}

/** Bloom: full resolution with MSAA on alta, half resolution on média, off on baixa (see post.ts). */
export const QUALITY_SETTINGS: Record<QualityLevel, QualitySettings> = {
  alta: {
    reflection: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 4,
    maxPixelRatio: 2,
    trails: true,
  },
  media: {
    reflection: false,
    shadows: true,
    shadowMapSize: 1024,
    shadowRadius: 2.5,
    maxPixelRatio: 1.5,
    trails: true,
  },
  baixa: {
    reflection: false,
    shadows: false,
    shadowMapSize: 512,
    shadowRadius: 1,
    maxPixelRatio: 1,
    trails: false,
  },
};

const ORDER: QualityLevel[] = ['alta', 'media', 'baixa'];

/**
 * Watches the frame rate and steps quality down when it stays below target.
 * Only steps *down* automatically (stepping back up would oscillate); the user
 * can still pick a level by hand, which turns automatic mode off.
 */
export class QualityGovernor {
  level: QualityLevel;
  auto = true;
  /** Average FPS of the last full window. */
  fps = 0;
  private frames = 0;
  private elapsed = 0;
  private slowWindows = 0;
  private warmup = 2;

  constructor(
    initial: QualityLevel,
    private readonly onChange: (level: QualityLevel) => void,
    private readonly targetFps = 55,
    private readonly windowSeconds = 1.5,
  ) {
    this.level = initial;
  }

  /** Call once per rendered frame with the real frame duration. */
  frame(dt: number): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < this.windowSeconds) return;
    this.fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    // The first windows include shader compilation and texture uploads.
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    if (!this.auto) return;
    this.slowWindows = this.fps < this.targetFps ? this.slowWindows + 1 : 0;
    const idx = ORDER.indexOf(this.level);
    if (this.slowWindows >= 2 && idx < ORDER.length - 1) {
      this.set(ORDER[idx + 1] as QualityLevel);
      this.slowWindows = 0;
      this.warmup = 1;
    }
  }

  private held: { level: QualityLevel; auto: boolean } | null = null;

  /** Fixes a level for a while (the recording of the demo); null gives back what was there. */
  hold(level: QualityLevel | null): void {
    if (level) {
      this.held ??= { level: this.level, auto: this.auto };
      this.auto = false;
      if (this.level !== level) this.set(level);
      return;
    }
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.auto = held.auto;
    if (this.level !== held.level) this.set(held.level);
  }

  /** Manual choice: cycles alta → média → baixa → alta and disables auto mode. */
  cycle(): void {
    this.auto = false;
    const idx = ORDER.indexOf(this.level);
    this.set(ORDER[(idx + 1) % ORDER.length] as QualityLevel);
  }

  private set(level: QualityLevel): void {
    this.level = level;
    this.onChange(level);
  }
}
