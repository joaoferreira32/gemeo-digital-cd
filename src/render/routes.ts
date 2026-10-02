import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
} from 'three';
import { ROBOT, ROBOT_STRIDE } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { PALETTE } from './palette';
import type { RobotPoses } from './poses';
import type { ResourceTracker } from './resources';

const MAX_CELLS = 32;
const WIDTH = 0.1;
const Y = 0.04;
/** Camera distance (m) below which routes start to show, and where they are fully visible. */
const FADE_START = 46;
const FADE_FULL = 26;

/**
 * Holographic route lines: each robot's planned cells drawn as a dashed,
 * glowing ribbon on the floor. They fade in as the camera gets closer, so the
 * aerial view stays clean and close-ups explain what every robot will do.
 */
export class RouteView {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly pos: Float32Array;
  private readonly u: Float32Array;
  private readonly fade: Float32Array;
  private readonly px = new Float32Array(MAX_CELLS + 1);
  private readonly pz = new Float32Array(MAX_CELLS + 1);

  constructor(
    tracker: ResourceTracker,
    private readonly robots = 64,
  ) {
    const verts = robots * MAX_CELLS * 6;
    this.pos = new Float32Array(verts * 3);
    this.u = new Float32Array(verts);
    this.fade = new Float32Array(verts);
    const geo = tracker.track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('u', new BufferAttribute(this.u, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('fade', new BufferAttribute(this.fade, 1).setUsage(DynamicDrawUsage));
    const material = tracker.track(
      new ShaderMaterial({
        uniforms: {
          color: { value: new Color(PALETTE.cyan).multiplyScalar(1.7) },
          time: { value: 0 },
          visibility: { value: 0 },
        },
        vertexShader: `
          attribute float u;
          attribute float fade;
          varying float vU;
          varying float vFade;
          void main() {
            vU = u;
            vFade = fade;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 color;
          uniform float time;
          uniform float visibility;
          varying float vU;
          varying float vFade;
          void main() {
            // Dashes 0.35 m long flowing toward the destination.
            float dash = smoothstep(0.35, 0.5, fract(vU * 1.4 - time * 1.2));
            float a = visibility * vFade * (0.35 + 0.65 * dash);
            gl_FragColor = vec4(color * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  update(frame: SimFrame, poses: RobotPoses, cameraDistance: number, time: number): void {
    const visibility = Math.min(
      1,
      Math.max(0, (FADE_START - cameraDistance) / (FADE_START - FADE_FULL)),
    );
    this.mesh.material.uniforms.visibility!.value = visibility;
    this.mesh.material.uniforms.time!.value = time;
    this.mesh.visible = visibility > 0.01;
    if (!this.mesh.visible) return;
    const s = frame.s;
    let v = 0;
    const n = Math.min(poses.count, this.robots);
    for (let r = 0; r < n; r++) {
      const o = r * ROBOT_STRIDE;
      const off = s.robots[o + ROBOT.routeOffset] as number;
      const len = Math.min(s.robots[o + ROBOT.routeLength] as number, MAX_CELLS);
      if (len < 2) continue;
      // The line starts at the robot and skips route cells it already passed.
      let m = 0;
      this.px[m] = poses.x[r] as number;
      this.pz[m] = poses.z[r] as number;
      m++;
      for (let k = 1; k < len; k++) {
        this.px[m] = s.routes[(off + k) * 2] as number;
        this.pz[m] = s.routes[(off + k) * 2 + 1] as number;
        m++;
      }
      let dist = 0;
      let total = 0;
      for (let k = 1; k < m; k++)
        total += Math.hypot(this.px[k]! - this.px[k - 1]!, this.pz[k]! - this.pz[k - 1]!);
      for (let k = 1; k < m; k++) {
        const ax = this.px[k - 1]!;
        const az = this.pz[k - 1]!;
        const bx = this.px[k]!;
        const bz = this.pz[k]!;
        const seg = Math.hypot(bx - ax, bz - az);
        if (seg < 1e-6) continue;
        const nx = (-(bz - az) / seg) * (WIDTH / 2);
        const nz = ((bx - ax) / seg) * (WIDTH / 2);
        const ua = dist;
        const ub = dist + seg;
        // Bright near the robot, fading toward the destination.
        const fa = 1 - 0.7 * (ua / total);
        const fb = 1 - 0.7 * (ub / total);
        const quad = [
          [ax + nx, az + nz, ua, fa],
          [ax - nx, az - nz, ua, fa],
          [bx + nx, bz + nz, ub, fb],
          [bx + nx, bz + nz, ub, fb],
          [ax - nx, az - nz, ua, fa],
          [bx - nx, bz - nz, ub, fb],
        ] as const;
        for (const [qx, qz, qu, qf] of quad) {
          this.pos[v * 3] = qx;
          this.pos[v * 3 + 1] = Y;
          this.pos[v * 3 + 2] = qz;
          this.u[v] = qu;
          this.fade[v] = qf;
          v++;
        }
        dist = ub;
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, v);
    for (const name of ['position', 'u', 'fade'])
      (geo.attributes[name] as BufferAttribute).needsUpdate = true;
  }
}
