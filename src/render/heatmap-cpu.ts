import { DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';
import type { Rect } from '../sim/layout';
import { DOCK_STRIDE, HEADER, PACKET_STRIDE, ROBOT, ROBOT_STRIDE } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import type { RobotPoses } from './poses';

const RES = 4;
const TAU = [2.5, 4, 25] as const;

/**
 * Reference implementation of the heat map on the CPU: same splats, same
 * decay, written texel by texel into a Float32Array and uploaded as a
 * texture every frame. Not used for drawing — only by the benchmark that
 * compares it with the GPU version (HeatmapView).
 */
export class CpuHeatmap {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  readonly texture: DataTexture;

  constructor(private readonly bounds: Rect) {
    this.width = Math.round((bounds.maxX - bounds.minX) * RES);
    this.height = Math.round((bounds.maxZ - bounds.minZ) * RES);
    this.data = new Float32Array(this.width * this.height * 4);
    this.texture = new DataTexture(this.data, this.width, this.height, RGBAFormat, FloatType);
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
  }

  private splat(x: number, z: number, radius: number, w0: number, w1: number, w2: number): void {
    const cx = (x - this.bounds.minX) * RES;
    const cy = (1 - (z - this.bounds.minZ) / (this.bounds.maxZ - this.bounds.minZ)) * this.height;
    const r = radius * RES;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = (xx + 0.5 - cx) / r;
        const dy = (y + 0.5 - cy) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const g = Math.exp(-d2 * 3);
        const o = (y * this.width + xx) * 4;
        this.data[o] = (this.data[o] as number) + w0 * g;
        this.data[o + 1] = (this.data[o + 1] as number) + w1 * g;
        this.data[o + 2] = (this.data[o + 2] as number) + w2 * g;
      }
    }
  }

  update(
    frame: SimFrame,
    alpha: number,
    robots: RobotPoses,
    simDt: number,
    piles: readonly { x: number; z: number; r: number }[],
  ): void {
    const d0 = Math.exp(-simDt / TAU[0]);
    const d1 = Math.exp(-simDt / TAU[1]);
    const d2 = Math.exp(-simDt / TAU[2]);
    const a = this.data;
    for (let i = 0; i < a.length; i += 4) {
      a[i] = (a[i] as number) * d0;
      a[i + 1] = (a[i + 1] as number) * d1;
      a[i + 2] = (a[i + 2] as number) * d2;
    }
    const s = frame.s;
    const count = s.header[HEADER.packets] as number;
    for (let i = 0; i < count; i++) {
      const o = i * PACKET_STRIDE;
      const x =
        (s.packets[o] as number) +
        ((s.packets[o + 3] as number) - (s.packets[o] as number)) * alpha;
      const z =
        (s.packets[o + 1] as number) +
        ((s.packets[o + 4] as number) - (s.packets[o + 1] as number)) * alpha;
      const wait = s.packets[o + 6] as number;
      this.splat(x, z, 1.4, 0.6 * simDt, (wait > 1 ? Math.min(wait / 8, 2) : 0) * simDt, 0);
    }
    piles.forEach((p, i) => {
      const inbound = i < s.inbounds.length;
      const c = inbound
        ? (s.inbounds[i] as number)
        : (s.docks[(i - s.inbounds.length) * DOCK_STRIDE] as number);
      if (c > 0)
        this.splat(
          p.x,
          p.z,
          p.r + 1.5,
          Math.min(c / 60, 6) * simDt,
          (inbound ? Math.min(c / 40, 6) : 0) * simDt,
          0,
        );
    });
    for (let r = 0; r < robots.count; r++) {
      const moving = (s.robots[r * ROBOT_STRIDE + ROBOT.speed] as number) > 0.1;
      this.splat(
        robots.x[r] as number,
        robots.z[r] as number,
        1.1,
        0.4 * simDt,
        0,
        (moving ? 1 : 0.15) * simDt,
      );
    }
    this.texture.needsUpdate = true;
  }
}
