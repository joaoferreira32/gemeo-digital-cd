import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
} from 'three';
import type { Vec2 } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import { CONVEYOR, CONVEYOR_STRIDE } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { BELT_TOP } from './floorplan';
import { PALETTE } from './palette';
import type { ResourceTracker } from './resources';

/** Distance from the belt's center line to the motor, and back from the belt's end (m). */
const SIDE = 0.78;
const BACK = 0.55;

/**
 * The drive motor of every belt, beside its discharge end, with a health
 * halo: dim cyan while the readings look normal, amber as the alarm sum
 * builds up, red and pulsing when the alarm is up (src/sim/health.ts; the
 * signals are simulated). A stopped motor has no halo: the breakdown alert
 * already marks it.
 */
export class MotorView {
  readonly housings: InstancedMesh;
  readonly halos: InstancedMesh;
  /** Where each motor sits (x, z), by conveyor edge id (picking, tests). */
  readonly spots: { x: number; z: number }[] = [];
  private readonly cyan = new Color(PALETTE.cyan);
  private readonly amber = new Color(PALETTE.amber);
  private readonly red = new Color(PALETTE.alert);
  private readonly tmp = new Color();
  private readonly m = new Matrix4();

  constructor(layout: WarehouseLayout, tracker: ResourceTracker) {
    const edges = layout.graph.edges;
    for (const e of edges) {
      const pts = e.points;
      const b = pts[pts.length - 1] as Vec2;
      const a = pts[pts.length - 2] as Vec2;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      // Right-hand side of the direction of travel.
      this.spots.push({ x: b.x - dx * BACK - dz * SIDE, z: b.z - dz * BACK + dx * SIDE });
    }
    const n = edges.length;
    const housing = tracker.track(new BoxGeometry(0.36, 0.32, 0.36));
    const housingMat = tracker.track(
      new MeshStandardMaterial({ color: PALETTE.steel, metalness: 0.6, roughness: 0.45 }),
    );
    this.housings = new InstancedMesh(housing, housingMat, n);
    this.housings.castShadow = true;
    this.spots.forEach((s, i) => {
      this.housings.setMatrixAt(i, this.m.makeTranslation(s.x, BELT_TOP - 0.28, s.z));
    });
    const ring = tracker.track(new RingGeometry(0.42, 0.62, 48).rotateX(-Math.PI / 2));
    const ringMat = tracker.track(
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.halos = new InstancedMesh(ring, ringMat, n);
    this.halos.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 3;
  }

  update(frame: SimFrame, time: number, reducedMotion: boolean): void {
    const c = frame.s.conveyors;
    const colors = this.halos.instanceColor?.array as Float32Array;
    let shown = 0;
    this.spots.forEach((s, i) => {
      const o = i * CONVEYOR_STRIDE;
      if ((c[o + CONVEYOR.status] as number) > 0) return;
      const risk = c[o + CONVEYOR.risk] as number;
      const alarm = (c[o + CONVEYOR.alarm] as number) > 0;
      let glow: number;
      if (alarm) {
        this.tmp.copy(this.red);
        glow = reducedMotion ? 1.6 : 1.3 + 0.7 * Math.sin(time * 6 + i);
      } else if (risk < 0.5) {
        this.tmp.copy(this.cyan).lerp(this.amber, risk * 2);
        glow = 0.3 + risk * 1.6;
      } else {
        this.tmp.copy(this.amber).lerp(this.red, (risk - 0.5) * 2);
        glow = 1 + (risk - 0.5);
      }
      const scale = alarm && !reducedMotion ? 1 + 0.15 * (0.5 + 0.5 * Math.sin(time * 6 + i)) : 1;
      this.m.makeScale(scale, 1, scale).setPosition(s.x, BELT_TOP - 0.1, s.z);
      this.halos.setMatrixAt(shown, this.m);
      this.tmp.multiplyScalar(glow);
      colors.set([this.tmp.r, this.tmp.g, this.tmp.b], shown * 3);
      shown++;
    });
    this.halos.count = shown;
    this.halos.instanceMatrix.needsUpdate = true;
    if (this.halos.instanceColor) this.halos.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.housings.dispose();
    this.halos.dispose();
  }
}
