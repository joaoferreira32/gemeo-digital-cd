import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
} from 'three';
import { PALETTE } from './palette';
import type { RobotPoses } from './poses';
import type { ResourceTracker } from './resources';

const SAMPLES = 40;
/** Seconds a trail point stays visible. */
const MAX_AGE = 1.6;
const WIDTH = 0.16;
const Y = 0.03;

/**
 * Light trails behind moving robots: a ribbon through the last positions of
 * each robot, fading with age, drawn additively so it glows under bloom.
 * Positions are sampled on the render side (they are a visual memory, not
 * simulation state).
 */
export class TrailView {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly xs: Float32Array;
  private readonly zs: Float32Array;
  private readonly ages: Float32Array;
  private readonly heads: Int32Array;
  private readonly counts: Int32Array;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;

  constructor(
    tracker: ResourceTracker,
    private readonly robots = 64,
  ) {
    this.xs = new Float32Array(robots * SAMPLES);
    this.zs = new Float32Array(robots * SAMPLES);
    this.ages = new Float32Array(robots * SAMPLES);
    this.heads = new Int32Array(robots);
    this.counts = new Int32Array(robots);
    const verts = robots * (SAMPLES - 1) * 6;
    this.pos = new Float32Array(verts * 3);
    this.alpha = new Float32Array(verts);
    const geo = tracker.track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('alpha', new BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage));
    const material = tracker.track(
      new ShaderMaterial({
        uniforms: { color: { value: new Color(PALETTE.cyan).multiplyScalar(2.2) } },
        vertexShader: `
          attribute float alpha;
          varying float vAlpha;
          void main() {
            vAlpha = alpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 color;
          varying float vAlpha;
          void main() { gl_FragColor = vec4(color * vAlpha, vAlpha); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
  }

  /** Clears every trail (restart, or trails switched off). */
  reset(): void {
    this.counts.fill(0);
    this.mesh.geometry.setDrawRange(0, 0);
  }

  update(poses: RobotPoses, realDt: number): void {
    const n = Math.min(poses.count, this.robots);
    let v = 0;
    for (let r = 0; r < n; r++) {
      const base = r * SAMPLES;
      for (let k = 0; k < this.counts[r]!; k++)
        this.ages[base + ((this.heads[r]! - k + SAMPLES) % SAMPLES)]! += realDt;
      const x = poses.x[r] as number;
      const z = poses.z[r] as number;
      const last = base + this.heads[r]!;
      const moved =
        this.counts[r]! === 0 || Math.hypot(x - this.xs[last]!, z - this.zs[last]!) > 0.05;
      if (moved) {
        const head = (this.heads[r]! + 1) % SAMPLES;
        this.heads[r] = head;
        this.xs[base + head] = x;
        this.zs[base + head] = z;
        this.ages[base + head] = 0;
        this.counts[r] = Math.min(this.counts[r]! + 1, SAMPLES);
      }
      // Drop points that faded out.
      while (this.counts[r]! > 0) {
        const oldest = base + ((this.heads[r]! - this.counts[r]! + 1 + SAMPLES) % SAMPLES);
        if (this.ages[oldest]! < MAX_AGE) break;
        this.counts[r]!--;
      }
      // Segments from newest to oldest; the newest one is pinned to the robot.
      for (let k = 0; k < this.counts[r]! - 1; k++) {
        const a = base + ((this.heads[r]! - k + SAMPLES) % SAMPLES);
        const b = base + ((this.heads[r]! - k - 1 + SAMPLES) % SAMPLES);
        const ax = k === 0 ? x : this.xs[a]!;
        const az = k === 0 ? z : this.zs[a]!;
        const bx = this.xs[b]!;
        const bz = this.zs[b]!;
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / len) * (WIDTH / 2);
        const nz = ((bx - ax) / len) * (WIDTH / 2);
        const fa = Math.max(0, 1 - this.ages[a]! / MAX_AGE) ** 1.5 * 0.85;
        const fb = Math.max(0, 1 - this.ages[b]! / MAX_AGE) ** 1.5 * 0.85;
        // Two triangles: a+n, a-n, b+n / b+n, a-n, b-n.
        const quad = [
          [ax + nx, az + nz, fa],
          [ax - nx, az - nz, fa],
          [bx + nx, bz + nz, fb],
          [bx + nx, bz + nz, fb],
          [ax - nx, az - nz, fa],
          [bx - nx, bz - nz, fb],
        ] as const;
        for (const [px, pz, al] of quad) {
          this.pos[v * 3] = px;
          this.pos[v * 3 + 1] = Y;
          this.pos[v * 3 + 2] = pz;
          this.alpha[v] = al;
          v++;
        }
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, v);
    (geo.attributes.position as BufferAttribute).needsUpdate = true;
    (geo.attributes.alpha as BufferAttribute).needsUpdate = true;
  }
}
