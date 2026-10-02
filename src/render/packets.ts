import {
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
} from 'three';
import type { WarehouseLayout } from '../sim/layout';
import {
  DOCK_STRIDE,
  HEADER,
  LANE_STRIDE,
  PACKET_STRIDE,
  ROBOT,
  ROBOT_STRIDE,
} from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import {
  BELT_TOP,
  inboundPile,
  pileCapacity,
  pileSlot,
  stagingPile,
  type PileArea,
} from './floorplan';
import { PALETTE } from './palette';
import { lerpAngle, type RobotPoses } from './poses';
import type { ResourceTracker } from './resources';
import { cardboardTexture } from './textures';
import { ROBOT_DECK_Y } from './robots';

/** Upper bound of drawable packets; the HUD reports when a pile shows fewer than it holds. */
export const MAX_PACKETS = 12_000;

/** Three box formats, picked by a hash of the packet id (render-only cosmetics). */
const SIZES: readonly (readonly [number, number, number])[] = [
  [0.46, 0.3, 0.4],
  [0.38, 0.26, 0.36],
  [0.5, 0.4, 0.44],
];
/** Boxes carried by a robot sit in a 3 × 2 tote. */
const CARRY_SIZE: readonly [number, number, number] = [0.19, 0.14, 0.19];
/** Boxes waiting in a bypass buffer, stacked on the node turntable. */
const LANE_SIZE: readonly [number, number, number] = [0.27, 0.2, 0.27];
/** Waiting time (s) at which a queued packet is fully red. */
const RED_AFTER = 25;

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Every packet in the scene — on belts, in inbound backlogs, on dock staging,
 * in robot bypass buffers and on the robots — is one instance of a single
 * InstancedMesh: one draw call for thousands of boxes. Matrices are written
 * straight into the Float32Array (yaw + scale + translation).
 */
export class PacketView {
  readonly mesh: InstancedMesh;
  /** Packets drawn in the last update. */
  visible = 0;
  /** Packets the simulation holds that did not fit the drawable pile slots. */
  hidden = 0;
  private readonly slot = { x: 0, y: 0, z: 0 };
  private readonly inboundAreas: PileArea[];
  private readonly stagingAreas: PileArea[];
  private readonly lanePiles: { x: number; z: number }[];
  private readonly palette: Color[];
  private readonly alert = new Color(PALETTE.alert);
  private readonly tmp = new Color();

  constructor(
    layout: WarehouseLayout,
    /** Pickup and drop nodes of each bypass lane (same order as the snapshot). */
    laneNodes: readonly (readonly [number, number])[],
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
    this.inboundAreas = layout.inboundNodes.map((_, i) => inboundPile(layout, i));
    this.stagingAreas = layout.dockNodes.map((_, i) => stagingPile(layout, i));
    // Bypass buffers wait stacked on the transfer turntable of their node.
    this.lanePiles = laneNodes.flatMap(([a, b]) => [
      layout.graph.node(a).pos,
      layout.graph.node(b).pos,
    ]);
  }

  update(frame: SimFrame, alpha: number, robots: RobotPoses): void {
    const s = frame.s;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor?.array as Float32Array;
    let n = 0;
    let hidden = 0;

    // Packets on the belts: interpolated, reddening while they wait in a queue.
    const count = s.header[HEADER.packets] as number;
    const p = s.packets;
    for (let i = 0; i < count && n < MAX_PACKETS; i++) {
      const o = i * PACKET_STRIDE;
      const x0 = p[o] as number;
      const z0 = p[o + 1] as number;
      const x = x0 + ((p[o + 3] as number) - x0) * alpha;
      const z = z0 + ((p[o + 4] as number) - z0) * alpha;
      const heading = lerpAngle(p[o + 2] as number, p[o + 5] as number, alpha);
      const red = Math.min(1, (p[o + 6] as number) / RED_AFTER) * 0.75;
      n = this.write(m, colors, n, s.packetIds[i] as number, x, BELT_TOP, z, -heading, null, red);
    }

    // Piles: the simulation only counts them; slots are stable.
    this.inboundAreas.forEach((area, i) => {
      const c = s.inbounds[i] as number;
      n = this.writePile(m, colors, n, area, c, 0x1000 * (i + 1));
      hidden += Math.max(0, c - pileCapacity(area));
    });
    this.stagingAreas.forEach((area, i) => {
      const c = s.docks[i * DOCK_STRIDE] as number;
      n = this.writePile(m, colors, n, area, c, 0x8000 * (i + 1));
      hidden += Math.max(0, c - pileCapacity(area));
    });
    // Bypass buffers: pickup on the upstream turntable, drop on the downstream one.
    for (let l = 0; l * LANE_STRIDE < s.lanes.length; l++) {
      const counts = [
        s.lanes[l * LANE_STRIDE + 1] as number,
        s.lanes[l * LANE_STRIDE + 2] as number,
      ];
      counts.forEach((c, end) => {
        const at = this.lanePiles[l * 2 + end];
        if (!at) return;
        for (let k = 0; k < Math.min(c, 18) && n < MAX_PACKETS; k++) {
          const layer = Math.floor(k / 4);
          const col = k % 2;
          const row = Math.floor((k % 4) / 2);
          n = this.write(
            m,
            colors,
            n,
            0x40000 + l * 64 + end * 32 + k,
            at.x - 0.17 + col * 0.34,
            BELT_TOP + 0.08 + layer * 0.27,
            at.z - 0.17 + row * 0.34,
            0,
            LANE_SIZE,
            0.25,
          );
        }
      });
    }
    // Boxes carried by robots ride on their deck.
    for (let r = 0; r < robots.count; r++) {
      const load = s.robots[r * ROBOT_STRIDE + ROBOT.load] as number;
      if (!load) continue;
      const h = robots.heading[r] as number;
      const cos = Math.cos(h);
      const sin = Math.sin(h);
      for (let k = 0; k < Math.min(load, 6) && n < MAX_PACKETS; k++) {
        const lx = (Math.floor(k / 2) - 1) * 0.2;
        const lz = ((k % 2) - 0.5) * 0.21;
        const x = (robots.x[r] as number) + lx * cos - lz * sin;
        const z = (robots.z[r] as number) + lx * sin + lz * cos;
        n = this.write(m, colors, n, 0x80000 + r * 8 + k, x, ROBOT_DECK_Y, z, -h, CARRY_SIZE, 0);
      }
    }

    this.mesh.count = n;
    this.visible = n;
    this.hidden = hidden;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
      const yaw = ((hash(salt + i) & 0xff) / 255 - 0.5) * 0.25;
      n = this.write(m, colors, n, salt + i, this.slot.x, this.slot.y, this.slot.z, yaw, null, 0);
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
    size: readonly [number, number, number] | null,
    red: number,
  ): number {
    const h = hash(key);
    const [sx, sy, sz] = size ?? (SIZES[h % SIZES.length] as readonly [number, number, number]);
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
    const base = this.palette[(h >>> 8) % this.palette.length] as Color;
    const col = red > 0 ? this.tmp.copy(base).lerp(this.alert, red) : base;
    const c = n * 3;
    colors[c] = col.r;
    colors[c + 1] = col.g;
    colors[c + 2] = col.b;
    return n + 1;
  }
}
