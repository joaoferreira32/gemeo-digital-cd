import { HEADER, ROBOT, ROBOT_STRIDE } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';

/** Interpolates between two headings along the shortest turn. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/**
 * Robot poses at the instant being drawn, computed once per frame and shared
 * by every view that needs them (bodies, carried boxes, trails, routes,
 * alerts, follow camera).
 */
export class RobotPoses {
  count = 0;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;

  constructor(readonly capacity = 256) {
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
  }

  update(frame: SimFrame, alpha: number): void {
    const r = frame.s.robots;
    this.count = Math.min(frame.s.header[HEADER.robots] as number, this.capacity);
    for (let i = 0; i < this.count; i++) {
      const o = i * ROBOT_STRIDE;
      const x0 = r[o + ROBOT.x0] as number;
      const z0 = r[o + ROBOT.z0] as number;
      this.x[i] = x0 + ((r[o + ROBOT.x1] as number) - x0) * alpha;
      this.z[i] = z0 + ((r[o + ROBOT.z1] as number) - z0) * alpha;
      this.heading[i] = lerpAngle(r[o + ROBOT.h0] as number, r[o + ROBOT.h1] as number, alpha);
    }
  }
}
