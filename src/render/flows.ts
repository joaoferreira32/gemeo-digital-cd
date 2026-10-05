import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
  Quaternion,
} from 'three';
import type { Vec2 } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import { SplitRouter } from '../sim/routing';
import type { SimFrame } from '../link/frames';
import { BELT_TOP } from './floorplan';
import { PALETTE } from './palette';
import type { ResourceTracker } from './resources';

/** Chevrons per way, how far along the belt they travel (m) and how long a lap takes (s). */
const CHEVRONS = 3;
const RUN = 3;
const PERIOD = 1.4;
const Y = BELT_TOP + 0.55;

interface Way {
  readonly x: number;
  readonly z: number;
  readonly dx: number;
  readonly dz: number;
  readonly length: number;
}

/**
 * Animated arrows over the five routing choices: at each junction, chevrons
 * glide along the static way and the alternative one, each as wide and bright
 * as the share of packets it gets (the shares come with every snapshot, so
 * the arrows show what the active policy is doing right now).
 */
export class FlowView {
  readonly mesh: InstancedMesh;
  /** Per decision: the static way, then the alternative (positions, for tests). */
  readonly ways: { primary: Way; alternative: Way }[];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly pos = new Vector3();
  private readonly scale = new Vector3();
  private readonly cyan = new Color(PALETTE.cyan);
  private readonly tmp = new Color();

  constructor(layout: WarehouseLayout, tracker: ResourceTracker) {
    const { graph } = layout;
    const router = new SplitRouter(graph, layout.dockNodes);
    const way = (edgeId: number): Way => {
      const pts = graph.edge(edgeId).points;
      const a = pts[0] as Vec2;
      const b = pts[1] as Vec2;
      const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: a.x, z: a.z, dx: (b.x - a.x) / length, dz: (b.z - a.z) / length, length };
    };
    this.ways = router.decisions.map((d) => ({
      primary: way(d.primary),
      alternative: way(d.alternative),
    }));
    // A flat chevron pointing along +x, 1 m wide (readable from the aerial view).
    const shape = new Shape();
    shape.moveTo(0.36, 0);
    shape.lineTo(-0.16, 0.5);
    shape.lineTo(-0.38, 0.5);
    shape.lineTo(0.1, 0);
    shape.lineTo(-0.38, -0.5);
    shape.lineTo(-0.16, -0.5);
    shape.closePath();
    const geo = tracker.track(new ShapeGeometry(shape).rotateX(-Math.PI / 2));
    const mat = tracker.track(
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    );
    const n = this.ways.length * 2 * CHEVRONS;
    this.mesh = new InstancedMesh(geo, mat, n);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(frame: SimFrame, time: number, reducedMotion: boolean): void {
    const shares = frame.s.shares;
    const colors = this.mesh.instanceColor?.array as Float32Array;
    let k = 0;
    this.ways.forEach((w, d) => {
      const alt = Math.min(1, Math.max(0, (shares[d] as number) ?? 0));
      for (const [way, part] of [
        [w.primary, 1 - alt],
        [w.alternative, alt],
      ] as const) {
        if (part < 0.02) continue;
        const run = Math.min(RUN, way.length - 0.2);
        const width = 0.35 + 0.75 * part;
        const glow = 0.25 + 1.1 * part;
        for (let c = 0; c < CHEVRONS; c++) {
          const phase = reducedMotion ? (c + 0.5) / CHEVRONS : (time / PERIOD + c / CHEVRONS) % 1;
          const along = 0.3 + phase * run;
          // Fade in at the start and out at the end of the run.
          const fade = reducedMotion ? 1 : Math.min(1, phase * 5, (1 - phase) * 5);
          this.pos.set(way.x + way.dx * along, Y, way.z + way.dz * along);
          this.q.setFromAxisAngle(this.up, -Math.atan2(way.dz, way.dx));
          this.scale.set(0.8 + 0.4 * part, 1, width);
          this.mesh.setMatrixAt(k, this.m.compose(this.pos, this.q, this.scale));
          this.tmp.copy(this.cyan).multiplyScalar(glow * fade);
          colors.set([this.tmp.r, this.tmp.g, this.tmp.b], k * 3);
          k++;
        }
      }
    });
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
