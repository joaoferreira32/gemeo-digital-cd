import {
  AdditiveBlending,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import { PALETTE } from './palette';
import type { ResourceTracker } from './resources';

const DASHES = 10;

/**
 * Marks the bottleneck the detector points out (src/ai/bottleneck.ts): an
 * amber dashed ring turning slowly around the belt or dock, and a ring that
 * pulses outward, like a radar on the point that holds the flow back. Amber,
 * not red: it is a warning about the flow, not a failure (the failure alert
 * of a stopped belt is drawn on top). Still with reduced motion.
 */
export class BottleneckView {
  readonly dashes: InstancedMesh;
  readonly pulse: InstancedMesh;
  /** Where the marker is now (null: no bottleneck), for the camera and tests. */
  spot: { x: number; z: number } | null = null;
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };
  private readonly m = new Matrix4();
  private readonly r = new Matrix4();

  constructor(
    private readonly layout: WarehouseLayout,
    tracker: ResourceTracker,
  ) {
    const material = () =>
      tracker.track(
        new MeshBasicMaterial({
          color: new Color(PALETTE.amber).multiplyScalar(1.4),
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          toneMapped: false,
        }),
      );
    // One dash: a short arc of a ring on the floor.
    const dash = tracker.track(
      new RingGeometry(1.55, 1.8, 8, 1, 0, (Math.PI * 2) / (DASHES * 2)).rotateX(-Math.PI / 2),
    );
    this.dashes = new InstancedMesh(dash, material(), DASHES);
    this.dashes.frustumCulled = false;
    this.dashes.renderOrder = 3;
    this.dashes.visible = false;
    const ring = tracker.track(new RingGeometry(1.1, 1.25, 48).rotateX(-Math.PI / 2));
    this.pulse = new InstancedMesh(ring, material(), 1);
    this.pulse.frustumCulled = false;
    this.pulse.renderOrder = 3;
    this.pulse.visible = false;
  }

  /** The resource to mark, or null. */
  set(target: { readonly kind: 'conveyor' | 'dock'; readonly index: number } | null): void {
    if (!target) {
      this.spot = null;
    } else if (target.kind === 'conveyor') {
      const edge = this.layout.graph.edge(target.index);
      pointOnEdge(edge, edge.length / 2, this.point);
      this.spot = { x: this.point.x, z: this.point.z };
    } else {
      const a = this.layout.stagingAreas[target.index];
      this.spot = a ? { x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2 } : null;
    }
    this.dashes.visible = this.pulse.visible = this.spot !== null;
  }

  update(time: number, reducedMotion: boolean): void {
    const s = this.spot;
    if (!s) return;
    const turn = reducedMotion ? 0 : time * 0.6;
    for (let i = 0; i < DASHES; i++) {
      this.r.makeRotationY(turn + (i * Math.PI * 2) / DASHES);
      this.m.makeTranslation(s.x, 0.06, s.z).multiply(this.r);
      this.dashes.setMatrixAt(i, this.m);
    }
    this.dashes.instanceMatrix.needsUpdate = true;
    const phase = reducedMotion ? 0.3 : (time * 0.7) % 1;
    const scale = 1 + phase * 1.4;
    this.m.makeScale(scale, 1, scale).setPosition(s.x, 0.05, s.z);
    this.pulse.setMatrixAt(0, this.m);
    this.pulse.instanceMatrix.needsUpdate = true;
    (this.pulse.material as MeshBasicMaterial).opacity = reducedMotion ? 0.8 : 1 - phase;
  }

  dispose(): void {
    this.dashes.dispose();
    this.pulse.dispose();
  }
}
