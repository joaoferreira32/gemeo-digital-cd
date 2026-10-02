import {
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
} from 'three';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { Packet } from '../sim/packet';
import type { World } from '../sim/world';
import {
  BELT_TOP,
  inboundPile,
  pileCapacity,
  pileSlot,
  stagingPile,
  type PileArea,
} from './floorplan';
import { PALETTE } from './palette';
import type { ResourceTracker } from './resources';
import { cardboardTexture } from './textures';

/** Upper bound of drawable packets; the HUD reports when a pile shows fewer than it holds. */
export const MAX_PACKETS = 12_000;

/** Three box formats, picked by a hash of the packet id (render-only cosmetics). */
const SIZES: readonly (readonly [number, number, number])[] = [
  [0.46, 0.3, 0.4],
  [0.38, 0.26, 0.36],
  [0.5, 0.4, 0.44],
];

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Every packet in the scene — on belts, in inbound backlogs and on dock
 * staging — is one instance of a single InstancedMesh: one draw call for
 * thousands of boxes. Matrices are written straight into the Float32Array
 * (yaw + scale + translation), skipping Object3D/Matrix4 allocations.
 */
export class PacketView {
  readonly mesh: InstancedMesh;
  /** Packets drawn in the last update. */
  visible = 0;
  /** Packets the simulation holds that did not fit the drawable pile slots. */
  hidden = 0;
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };
  private readonly slot = { x: 0, y: 0, z: 0 };
  private readonly inboundAreas: PileArea[];
  private readonly stagingAreas: PileArea[];
  private readonly palette: Color[];

  constructor(
    private readonly world: World,
    tracker: ResourceTracker,
  ) {
    const geometry = tracker.track(new BoxGeometry(1, 1, 1));
    const material = tracker.track(
      new MeshStandardMaterial({
        map: cardboardTexture(tracker),
        roughness: 0.78,
        metalness: 0,
      }),
    );
    this.mesh = new InstancedMesh(geometry, material, MAX_PACKETS);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_PACKETS * 3), 3);
    this.mesh.count = 0;
    // Instances move every frame; a stale bounding sphere would cull them.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    const amber = new Color(PALETTE.amber);
    // Slight per-box variation in tone so piles do not look like one block.
    this.palette = [0.82, 0.9, 1.0, 0.94, 0.86].map((k) => amber.clone().multiplyScalar(k));
    this.inboundAreas = world.layout.inboundNodes.map((_, i) => inboundPile(world.layout, i));
    this.stagingAreas = world.layout.dockNodes.map((_, i) => stagingPile(world.layout, i));
  }

  /** `alpha` in [0, 1) interpolates belt positions between the last two simulation steps. */
  update(alpha: number): void {
    const w = this.world;
    const graph = w.layout.graph;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor?.array as Float32Array;
    let n = 0;
    let hidden = 0;

    for (const c of w.conveyors) {
      if (c.packets.length === 0) continue;
      const edge = graph.edge(c.edgeId);
      for (const p of c.packets) {
        if (n >= MAX_PACKETS) break;
        const s = p.prevS + (p.s - p.prevS) * alpha;
        pointOnEdge(edge, s, this.point);
        n = this.write(
          m,
          colors,
          n,
          p.id,
          this.point.x,
          BELT_TOP,
          this.point.z,
          -this.point.heading,
        );
      }
    }

    w.inbounds.forEach((inbound, i) => {
      const area = this.inboundAreas[i] as PileArea;
      n = this.writePile(m, colors, n, area, inbound.backlog.length, 0x1000 * (i + 1));
      hidden += Math.max(0, inbound.backlog.length - pileCapacity(area));
    });
    w.docks.forEach((dock, i) => {
      const area = this.stagingAreas[i] as PileArea;
      n = this.writePile(m, colors, n, area, dock.staged.length, 0x8000 * (i + 1));
      hidden += Math.max(0, dock.staged.length - pileCapacity(area));
    });

    this.mesh.count = n;
    this.visible = n;
    this.hidden = hidden;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Finds a packet currently on a belt (for the follow camera), preferring `current`. */
  pickFollowTarget(current: Packet | null): Packet | null {
    if (current && current.state === 'conveyor') return current;
    // Newest packet on the first inbound conveyor: it has the whole trip ahead.
    let best: Packet | null = null;
    for (const c of this.world.conveyors) {
      for (const p of c.packets) if (!best || p.id > best.id) best = p;
    }
    return best;
  }

  private writePile(
    m: Float32Array,
    colors: Float32Array,
    n: number,
    area: PileArea,
    count: number,
    salt: number,
  ): number {
    const shown = Math.min(count, pileCapacity(area), MAX_PACKETS - n);
    for (let i = 0; i < shown; i++) {
      pileSlot(area, i, this.slot);
      // Slots are stable, so a box keeps its look while the pile grows or shrinks.
      const yaw = ((hash(salt + i) & 0xff) / 255 - 0.5) * 0.25;
      n = this.write(m, colors, n, salt + i, this.slot.x, this.slot.y, this.slot.z, yaw);
    }
    return n;
  }

  private write(
    m: Float32Array,
    colors: Float32Array,
    n: number,
    key: number,
    x: number,
    baseY: number,
    z: number,
    yaw: number,
  ): number {
    const h = hash(key);
    const size = SIZES[h % SIZES.length] as readonly [number, number, number];
    const [sx, sy, sz] = size;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const o = n * 16;
    // Column-major T * R_y(yaw) * S.
    m[o] = cos * sx;
    m[o + 1] = 0;
    m[o + 2] = -sin * sx;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = sy;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = sin * sz;
    m[o + 9] = 0;
    m[o + 10] = cos * sz;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = baseY + sy / 2;
    m[o + 14] = z;
    m[o + 15] = 1;
    const col = this.palette[(h >>> 8) % this.palette.length] as Color;
    const c = n * 3;
    colors[c] = col.r;
    colors[c + 1] = col.g;
    colors[c + 2] = col.b;
    return n + 1;
  }
}
