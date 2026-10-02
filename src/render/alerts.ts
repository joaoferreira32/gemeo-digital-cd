import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import { FAILURE_KINDS, FAILURE_STRIDE, HEADER } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { PALETTE } from './palette';
import type { RobotPoses } from './poses';
import type { ResourceTracker } from './resources';

const MAX = 16;

/**
 * Pulsing alerts where something failed: an expanding ring on the floor and a
 * column of light, red for breakdowns and amber for an order surge. With
 * reduced motion they stay lit without pulsing.
 */
export class AlertView {
  readonly rings: InstancedMesh;
  readonly beams: InstancedMesh;
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };
  private readonly red = new Color(PALETTE.alert);
  private readonly amber = new Color(PALETTE.amber);
  private readonly tmp = new Color();
  /** Positions of the alerts drawn in the last update (for the camera and tests). */
  readonly spots: { x: number; z: number; kind: string }[] = [];

  constructor(
    private readonly layout: WarehouseLayout,
    tracker: ResourceTracker,
  ) {
    const ring = tracker.track(new RingGeometry(0.75, 1, 48).rotateX(-Math.PI / 2));
    const beam = tracker.track(
      new CylinderGeometry(0.35, 0.6, 7, 24, 1, true).translate(0, 3.5, 0),
    );
    const mat = () =>
      tracker.track(
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          toneMapped: false,
        }),
      );
    const mk = (geo: RingGeometry | CylinderGeometry) => {
      const m = new InstancedMesh(geo, mat(), MAX);
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 3;
      return m;
    };
    this.rings = mk(ring);
    this.beams = mk(beam);
  }

  update(frame: SimFrame, poses: RobotPoses, time: number, reducedMotion: boolean): void {
    this.spots.length = 0;
    const s = frame.s;
    const count = s.header[HEADER.failures] as number;
    for (let i = 0; i < count; i++) {
      const kind = FAILURE_KINDS[s.failures[i * FAILURE_STRIDE] as number] ?? 'conveyor';
      const target = s.failures[i * FAILURE_STRIDE + 1] as number;
      if (kind === 'conveyor') {
        const edge = this.layout.graph.edge(target);
        pointOnEdge(edge, edge.length / 2, this.point);
        this.spots.push({ x: this.point.x, z: this.point.z, kind });
      } else if (kind === 'robot' && target < poses.count) {
        this.spots.push({ x: poses.x[target] as number, z: poses.z[target] as number, kind });
      } else if (kind === 'dock') {
        const a = this.layout.stagingAreas[target];
        if (a) this.spots.push({ x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2, kind });
      } else if (kind === 'surge') {
        for (const a of this.layout.inboundAreas) {
          this.spots.push({ x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2, kind });
        }
      }
    }
    const n = Math.min(this.spots.length, MAX);
    const rm = this.rings.instanceMatrix.array as Float32Array;
    const bm = this.beams.instanceMatrix.array as Float32Array;
    const rc = this.rings.instanceColor?.array as Float32Array;
    const bc = this.beams.instanceColor?.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const spot = this.spots[i] as { x: number; z: number; kind: string };
      const phase = reducedMotion ? 0.35 : (time * 0.8 + i * 0.37) % 1;
      const ringScale = 0.8 + phase * 1.6;
      const ringGlow = reducedMotion ? 1.2 : 1.8 * (1 - phase);
      const beamGlow = reducedMotion ? 0.5 : 0.35 + 0.25 * Math.sin(time * 5 + i);
      const base = spot.kind === 'surge' ? this.amber : this.red;
      write(rm, i, spot.x, 0.05, spot.z, ringScale);
      write(bm, i, spot.x, 0, spot.z, 1);
      this.tmp.copy(base).multiplyScalar(ringGlow);
      rc.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
      this.tmp.copy(base).multiplyScalar(beamGlow);
      bc.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
    }
    for (const m of [this.rings, this.beams]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.rings.dispose();
    this.beams.dispose();
  }
}

function write(m: Float32Array, i: number, x: number, y: number, z: number, s: number): void {
  const o = i * 16;
  m.fill(0, o, o + 16);
  m[o] = s;
  m[o + 5] = 1;
  m[o + 10] = s;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  m[o + 15] = 1;
}
