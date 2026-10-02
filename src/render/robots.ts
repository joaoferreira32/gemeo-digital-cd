import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROBOT, ROBOT_STRIDE, STAGES } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { PALETTE, mix } from './palette';
import type { RobotPoses } from './poses';
import type { ResourceTracker } from './resources';

/** Top of the robot deck, where carried boxes sit. */
export const ROBOT_DECK_Y = 0.27;
export const ROBOT_LENGTH = 0.7;
export const ROBOT_WIDTH = 0.55;
/** Brightness of the status light (HDR, above 1 blooms). */
const LIGHT_GAIN = 3;

/**
 * Low-profile AGVs (they pass under the raised conveyor passages): a
 * chassis, a lifting deck and a light band whose color tells the state —
 * cyan working, amber charging or low battery, red defect, dim when idle.
 * Three InstancedMeshes, so 40 or 400 robots cost the same draw calls.
 */
export class RobotView {
  readonly bodies: InstancedMesh;
  readonly decks: InstancedMesh;
  readonly lights: InstancedMesh;
  private readonly colors: Record<string, Color>;
  private readonly tmp = new Color();

  constructor(
    tracker: ResourceTracker,
    readonly capacity = 64,
  ) {
    const box = (sx: number, sy: number, sz: number, y: number) =>
      new BoxGeometry(sx, sy, sz).translate(0, y, 0);
    const merge = (geos: BufferGeometry[]) => {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) throw new Error('robot geometry merge failed');
      return tracker.track(merged);
    };
    const wheels: BufferGeometry[] = [];
    for (const x of [-0.24, 0.24]) {
      for (const z of [-0.25, 0.25]) {
        wheels.push(
          new CylinderGeometry(0.06, 0.06, 0.05, 12).rotateX(Math.PI / 2).translate(x, 0.06, z),
        );
      }
    }
    const body = merge([box(ROBOT_LENGTH, 0.16, ROBOT_WIDTH, 0.13), ...wheels]);
    const deck = merge([box(ROBOT_LENGTH - 0.1, 0.05, ROBOT_WIDTH - 0.08, 0.235)]);
    // Light band around the chassis plus a front marker.
    const light = merge([
      box(ROBOT_LENGTH + 0.01, 0.025, ROBOT_WIDTH + 0.01, 0.17),
      box(0.03, 0.05, 0.3, 0.14).translate(ROBOT_LENGTH / 2, 0, 0),
    ]);

    const mk = (geo: BufferGeometry, mat: Material, colored: boolean) => {
      const mesh = new InstancedMesh(geo, mat, capacity);
      if (colored)
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      return mesh;
    };
    this.bodies = mk(
      body,
      tracker.track(
        new MeshStandardMaterial({ color: PALETTE.steel, metalness: 0.5, roughness: 0.4 }),
      ),
      false,
    );
    this.decks = mk(
      deck,
      tracker.track(
        new MeshStandardMaterial({
          color: mix('steel', 'ice', 0.35),
          metalness: 0.6,
          roughness: 0.35,
        }),
      ),
      false,
    );
    // Unlit and tinted per instance; colors above 1 are HDR, so the bloom picks them up.
    this.lights = mk(light, tracker.track(new MeshBasicMaterial({ color: 0xffffff })), true);
    this.lights.castShadow = false;
    this.colors = {
      working: new Color(PALETTE.cyan),
      charging: new Color(PALETTE.amber),
      defect: new Color(PALETTE.alert),
      idle: mix('steel', 'ice', 0.35),
    };
  }

  update(frame: SimFrame, poses: RobotPoses, time: number, reducedMotion: boolean): void {
    const n = Math.min(poses.count, this.capacity);
    const mats = [this.bodies, this.decks, this.lights].map(
      (m) => m.instanceMatrix.array as Float32Array,
    );
    const colors = this.lights.instanceColor?.array as Float32Array;
    const r = frame.s.robots;
    for (let i = 0; i < n; i++) {
      const h = poses.heading[i] as number;
      const cos = Math.cos(-h);
      const sin = Math.sin(-h);
      const x = poses.x[i] as number;
      const z = poses.z[i] as number;
      for (const m of mats) {
        const o = i * 16;
        m[o] = cos;
        m[o + 1] = 0;
        m[o + 2] = -sin;
        m[o + 3] = 0;
        m[o + 4] = 0;
        m[o + 5] = 1;
        m[o + 6] = 0;
        m[o + 7] = 0;
        m[o + 8] = sin;
        m[o + 9] = 0;
        m[o + 10] = cos;
        m[o + 11] = 0;
        m[o + 12] = x;
        m[o + 13] = 0;
        m[o + 14] = z;
        m[o + 15] = 1;
      }
      const stage = STAGES[r[i * ROBOT_STRIDE + ROBOT.stage] as number];
      const battery = r[i * ROBOT_STRIDE + ROBOT.battery] as number;
      let c: Color;
      let k = 1;
      if (stage === 'defect') {
        c = this.colors.defect as Color;
        if (!reducedMotion) k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 9 + i));
      } else if (stage === 'charging' || stage === 'toCharger' || battery < 25) {
        c = this.colors.charging as Color;
        if (stage === 'charging' && !reducedMotion)
          k = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(time * 3 + i));
      } else if (stage === 'parked') {
        c = this.colors.idle as Color;
        k = 0.5;
      } else c = this.colors.working as Color;
      this.tmp.copy(c).multiplyScalar(k * LIGHT_GAIN);
      colors[i * 3] = this.tmp.r;
      colors[i * 3 + 1] = this.tmp.g;
      colors[i * 3 + 2] = this.tmp.b;
    }
    for (const m of [this.bodies, this.decks, this.lights]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const m of [this.bodies, this.decks, this.lights]) m.dispose();
  }
}
