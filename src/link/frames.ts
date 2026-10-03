import type { SimEvent } from '../sim/failures';
import { HEADER, readSnapshot, type SnapshotSections } from '../sim/snapshot';

export interface SimFrame {
  readonly buffer: ArrayBuffer;
  readonly s: SnapshotSections;
  readonly time: number;
  readonly prevTime: number;
  readonly speed: number;
  /** This frame does not continue the previous one (seek, back to live, restart). */
  readonly cut: boolean;
  /** 0 live · 1 a past moment of the recording. */
  readonly mode: number;
  readonly events: SimEvent[];
}

export function decodeFrame(buffer: ArrayBuffer, events: SimEvent[]): SimFrame {
  const s = readSnapshot(buffer);
  return {
    buffer,
    s,
    time: s.header[HEADER.time] as number,
    prevTime: s.header[HEADER.prevTime] as number,
    speed: s.header[HEADER.speed] as number,
    cut: s.header[HEADER.cut] === 1,
    mode: s.header[HEADER.mode] as number,
    events,
  };
}

/**
 * Keeps the last few snapshots and decides which instant to draw. Each
 * snapshot covers [prevTime, time]; the renderer stays about one snapshot
 * interval behind the newest one, so it always has two poses to interpolate
 * between, and its clock is gently pulled toward that target so uneven
 * message timing never shows as jumps.
 */
export class FrameBuffer {
  private readonly frames: SimFrame[] = [];
  /** Simulated time being drawn (NaN before the first snapshot). */
  renderTime = NaN;

  constructor(
    private readonly onRelease: (buffer: ArrayBuffer) => void,
    private readonly capacity = 4,
  ) {}

  get latest(): SimFrame | undefined {
    return this.frames[this.frames.length - 1];
  }

  push(frame: SimFrame): void {
    const last = this.latest;
    if ((last && frame.time < last.time) || frame.cut) {
      // A restart or a jump in time: older frames belong to another moment.
      this.clear();
    }
    this.frames.push(frame);
    while (this.frames.length > this.capacity)
      this.onRelease((this.frames.shift() as SimFrame).buffer);
  }

  clear(): void {
    for (const f of this.frames) this.onRelease(f.buffer);
    this.frames.length = 0;
    this.renderTime = NaN;
  }

  /** Advances the render clock by `realDt` seconds at the simulation speed. */
  advance(realDt: number): void {
    const last = this.latest;
    if (!last) return;
    if (Number.isNaN(this.renderTime)) {
      this.renderTime = last.prevTime;
      return;
    }
    this.renderTime += realDt * last.speed;
    const interval = Math.max(last.time - last.prevTime, 0);
    const target = last.time - interval;
    // Pull toward the target: fast enough to absorb jitter, slow enough to be invisible.
    this.renderTime += (target - this.renderTime) * Math.min(1, realDt * 5);
    const oldest = (this.frames[0] as SimFrame).prevTime;
    this.renderTime = Math.min(Math.max(this.renderTime, oldest), last.time);
  }

  /** Snapshot whose interval contains the render time, and the position inside it (0..1). */
  sample(): { frame: SimFrame; alpha: number } | null {
    const last = this.latest;
    if (!last) return null;
    const t = this.renderTime;
    for (const f of this.frames) {
      if (t <= f.time + 1e-9) {
        const span = f.time - f.prevTime;
        const alpha = span > 1e-9 ? Math.min(1, Math.max(0, (t - f.prevTime) / span)) : 1;
        return { frame: f, alpha };
      }
    }
    return { frame: last, alpha: 1 };
  }
}
