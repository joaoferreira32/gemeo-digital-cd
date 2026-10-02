import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  type CanvasTexture,
  type Material,
} from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import type { WarehouseLayout } from '../sim/layout';
import type { Vec2 } from '../sim/graph';
import { BoxBatch, cylinderInstances, textPlane } from './builders';
import { BELT_TOP, ROOF_Y, WALL_HEIGHT, inboundPile, stagingPile } from './floorplan';
import { PALETTE, mix } from './palette';
import type { ResourceTracker } from './resources';
import { beltTexture, concreteTexture } from './textures';

const BELT_WIDTH = 0.82;
const FRAME_WIDTH = 1.0;
/** Belt cleat pattern length in meters (one texture repeat). */
export const BELT_PERIOD = 0.5;

export interface BeltView {
  readonly edgeId: number;
  readonly meshes: Mesh[];
}

/**
 * Static, procedurally generated building: floor, structure, conveyors,
 * docks and decorative racks. Everything is boxes, cylinders and canvas
 * textures — no external model or image.
 */
export class WarehouseView {
  readonly group = new Group();
  readonly belts: BeltView[] = [];
  readonly beltOkMaterial: MeshStandardMaterial;
  readonly beltBrokenMaterial: MeshStandardMaterial;
  readonly reflector: Reflector;
  readonly floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  /** Roof girders and light fixtures; hidden when the camera is above the roof (cutaway). */
  readonly roof = new Group();
  private readonly beltTextures: CanvasTexture[] = [];

  constructor(
    private readonly layout: WarehouseLayout,
    private readonly tracker: ResourceTracker,
  ) {
    const t = tracker;
    const okTex = beltTexture(t, 'cyan');
    const brokenTex = beltTexture(t, 'alert');
    this.beltTextures.push(okTex, brokenTex);
    this.beltOkMaterial = t.track(
      new MeshStandardMaterial({ map: okTex, roughness: 0.85, metalness: 0.05 }),
    );
    this.beltBrokenMaterial = t.track(
      new MeshStandardMaterial({
        map: brokenTex,
        roughness: 0.85,
        emissive: PALETTE.alert,
        emissiveIntensity: 0.25,
      }),
    );

    const { floor, reflector } = this.buildFloor();
    this.floor = floor;
    this.reflector = reflector;
    this.buildStructure();
    this.buildMarkings();
    this.buildConveyors();
    this.buildDocksAndInbounds();
    this.buildRacks();
  }

  /** Scrolls the belt cleats by `distance` meters (all running belts share one texture). */
  scrollBelts(distance: number): void {
    const okTex = this.beltTextures[0] as CanvasTexture;
    okTex.offset.x = (okTex.offset.x - distance / BELT_PERIOD) % 1;
  }

  setBeltBroken(edgeId: number, broken: boolean): void {
    const belt = this.belts[edgeId];
    if (!belt) return;
    for (const m of belt.meshes)
      m.material = broken ? this.beltBrokenMaterial : this.beltOkMaterial;
  }

  private std(
    color: number,
    opts: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {},
  ) {
    return this.tracker.track(new MeshStandardMaterial({ color, roughness: 0.7, ...opts }));
  }

  private add<T extends Mesh | Group>(obj: T): T {
    this.group.add(obj);
    return obj;
  }

  private buildFloor() {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    // Outside ground and truck yards, fading into the fog.
    const ground = new Mesh(
      this.tracker.track(new PlaneGeometry(400, 400)),
      this.std(mix('graphite', 'steel', 0.2).getHex(), { roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    this.add(ground);

    // Mirror under a slightly transparent concrete floor = subtle reflection.
    const reflector = new Reflector(this.tracker.track(new PlaneGeometry(w, d)), {
      textureWidth: 1024,
      textureHeight: 1024,
      color: mix('graphite', 'ice', 0.35).getHex(),
      clipBias: 0.003,
    });
    this.tracker.track(reflector);
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set(cx, -0.005, cz);
    this.add(reflector);

    const tex = concreteTexture(this.tracker);
    tex.repeat.set(w / 4, d / 4);
    const floorMat = this.std(0xffffff, {
      map: tex,
      roughness: 0.5,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
    });
    const floor = new Mesh(this.tracker.track(new PlaneGeometry(w, d)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    floor.receiveShadow = true;
    this.add(floor);
    return { floor, reflector };
  }

  private buildStructure() {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const steel = this.std(PALETTE.steel, { metalness: 0.55, roughness: 0.45 });
    const steelLight = this.std(mix('steel', 'ice', 0.18).getHex(), {
      metalness: 0.5,
      roughness: 0.5,
    });
    const amber = this.std(PALETTE.amber, { roughness: 0.6 });

    // Perimeter curb walls (cutaway building: low walls, open roof structure).
    const walls = new BoxBatch();
    const th = 0.3;
    walls.add((minX + maxX) / 2, WALL_HEIGHT / 2, minZ, maxX - minX, WALL_HEIGHT, th);
    walls.add((minX + maxX) / 2, WALL_HEIGHT / 2, maxZ, maxX - minX, WALL_HEIGHT, th);
    // Side walls are split by the doors, built in buildDocksAndInbounds.
    this.add(walls.build(this.tracker, steelLight, { cast: true, receive: true }));

    // Columns on a 12 m grid: perimeter plus two interior rows hidden inside the
    // back-to-back racks (only where there are racks: the sorter area stays clear).
    const columns = new BoxBatch();
    const guards = new BoxBatch();
    const xs: number[] = [];
    for (let x = minX; x <= maxX + 0.01; x += 12) xs.push(x);
    if ((xs[xs.length - 1] as number) < maxX) xs.push(maxX);
    const rowZ = [minZ, -9.5, 9.5, maxZ];
    for (const x of xs) {
      for (const z of rowZ) {
        const interior = z !== minZ && z !== maxZ;
        if (interior && (x <= minX || x > 2)) continue;
        columns.add(x, ROOF_Y / 2, z, 0.5, ROOF_Y, 0.5);
        if (interior) guards.add(x, 0.5, z, 0.7, 1.0, 0.7);
      }
    }
    this.add(columns.build(this.tracker, steel, { cast: true, receive: true }));
    this.add(guards.build(this.tracker, amber, { cast: true }));

    // Roof trusses: girders across z at every column line, purlins along x.
    const roof = new BoxBatch();
    for (const x of xs) roof.add(x, ROOF_Y, (minZ + maxZ) / 2, 0.35, 0.7, maxZ - minZ);
    this.roof.add(roof.build(this.tracker, steel, { cast: false }));

    // High-bay light fixtures (emissive; they glow once bloom is on in phase 2).
    const fixtures = new BoxBatch();
    for (let x = minX + 6; x < maxX - 2; x += 12) {
      for (let z = minZ + 5; z < maxZ - 2; z += 7.5)
        fixtures.add(x, ROOF_Y - 0.6, z, 3.6, 0.08, 0.22);
    }
    const lightMat = this.std(PALETTE.ice, {
      emissive: PALETTE.ice,
      emissiveIntensity: 1.0,
      roughness: 0.3,
    });
    this.roof.add(fixtures.build(this.tracker, lightMat));
    this.add(this.roof);
  }

  private buildMarkings() {
    const { minX, maxX } = this.layout.bounds;
    const amber = this.std(PALETTE.amber, {
      roughness: 0.6,
      emissive: PALETTE.amber,
      emissiveIntensity: 0.08,
    });
    const lines = new BoxBatch();
    const y = 0.012;
    const h = 0.01;
    // Pedestrian walkways along the racks.
    for (const z of [-7.6, 7.6]) lines.addSpan(minX + 9, z, maxX - 22, z, 0.12, y, y + h);
    for (const z of [-6.8, 6.8]) lines.addSpan(minX + 9, z, maxX - 22, z, 0.12, y, y + h);
    // Outline every pile area so empty staging and backlog zones still read on the floor.
    const outline = (x0: number, z0: number, x1: number, z1: number) => {
      lines.addSpan(x0, z0, x1, z0, 0.1, y, y + h);
      lines.addSpan(x0, z1, x1, z1, 0.1, y, y + h);
      lines.addSpan(x0, z0, x0, z1, 0.1, y, y + h);
      lines.addSpan(x1, z0, x1, z1, 0.1, y, y + h);
    };
    const areas = [
      ...this.layout.inboundNodes.map((_, i) => inboundPile(this.layout, i)),
      ...this.layout.dockNodes.map((_, i) => stagingPile(this.layout, i)),
    ];
    for (const a of areas) {
      const x1 = a.x0 + a.cols * a.cell;
      const z1 = a.z0 + a.zDir * a.rows * a.cell;
      outline(a.x0 - 0.15, a.z0 - a.zDir * 0.15, x1 + 0.15, z1 + a.zDir * 0.15);
    }
    this.add(lines.build(this.tracker, amber, { receive: true }));

    // Conveyor numbers stenciled on the floor, next to each belt's midpoint.
    for (const e of this.layout.graph.edges) {
      const { a, b } = longestSegment(e.points);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      // Left-hand normal of the direction of travel.
      const nx = (b.z - a.z) / len;
      const nz = -(b.x - a.x) / len;
      const label = textPlane(this.tracker, `E${e.id + 1}`, 0.75, {
        color: 'ice',
        opacity: 0.55,
      });
      label.rotation.x = -Math.PI / 2;
      label.position.set(mx + nx * 1.15, 0.02, mz + nz * 1.15);
      this.add(label);
    }
  }

  private buildConveyors() {
    const { graph } = this.layout;
    const frameMat = this.std(PALETTE.steel, { metalness: 0.6, roughness: 0.4 });
    const railMat = this.std(mix('steel', 'ice', 0.25).getHex(), {
      metalness: 0.7,
      roughness: 0.35,
    });
    const glowMat = this.std(PALETTE.cyan, {
      emissive: PALETTE.cyan,
      emissiveIntensity: 1.2,
      roughness: 0.4,
    });
    const frames = new BoxBatch();
    const rails = new BoxBatch();
    const glow = new BoxBatch();
    const legs = new BoxBatch();
    const frameY0 = BELT_TOP - 0.2;

    for (const e of graph.edges) {
      const meshes: Mesh[] = [];
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1] as Vec2;
        const b = e.points[i] as Vec2;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
        const nx = -(b.z - a.z) / len;
        const nz = (b.x - a.x) / len;
        frames.addSpan(a.x, a.z, b.x, b.z, FRAME_WIDTH, frameY0, BELT_TOP - 0.005);
        for (const side of [-1, 1]) {
          const ox = nx * side * (FRAME_WIDTH / 2 - 0.03);
          const oz = nz * side * (FRAME_WIDTH / 2 - 0.03);
          rails.addSpan(
            a.x + ox,
            a.z + oz,
            b.x + ox,
            b.z + oz,
            0.06,
            BELT_TOP - 0.05,
            BELT_TOP + 0.09,
          );
          glow.addSpan(
            a.x + ox,
            a.z + oz,
            b.x + ox,
            b.z + oz,
            0.035,
            BELT_TOP + 0.09,
            BELT_TOP + 0.105,
          );
        }
        const legCount = Math.max(2, Math.round(len / 1.8) + 1);
        for (let k = 0; k < legCount; k++) {
          const t = (k + 0.5) / legCount;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          for (const side of [-1, 1]) {
            legs.add(
              x + nx * side * 0.38,
              frameY0 / 2,
              z + nz * side * 0.38,
              0.07,
              frameY0,
              0.07,
              yaw,
            );
          }
        }
        // Belt surface: UVs stretched along the length so one shared texture tiles every BELT_PERIOD.
        const geo = this.tracker.track(new PlaneGeometry(len, BELT_WIDTH));
        const uv = geo.attributes.uv;
        if (uv) {
          for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (len / BELT_PERIOD));
          uv.needsUpdate = true;
        }
        geo.rotateX(-Math.PI / 2);
        const belt = new Mesh(geo, this.beltOkMaterial);
        belt.position.set((a.x + b.x) / 2, BELT_TOP, (a.z + b.z) / 2);
        belt.rotation.y = yaw;
        belt.receiveShadow = true;
        meshes.push(belt);
        this.add(belt);
      }
      this.belts[e.id] = { edgeId: e.id, meshes };
    }
    this.add(frames.build(this.tracker, frameMat, { cast: true, receive: true }));
    this.add(rails.build(this.tracker, railMat, { cast: true }));
    this.add(glow.build(this.tracker, glowMat));
    this.add(legs.build(this.tracker, frameMat, { cast: true }));

    // Transfer stations at nodes: a turntable with a cyan ring.
    const stations = graph.nodes.filter((n) => n.kind !== 'dock');
    this.add(
      cylinderInstances(
        this.tracker,
        frameMat,
        stations.map((n) => ({ x: n.pos.x, y: BELT_TOP - 0.11, z: n.pos.z, r: 0.48, h: 0.2 })),
        32,
      ),
    );
    const ringGeo = this.tracker.track(new RingGeometry(0.38, 0.48, 40));
    ringGeo.rotateX(-Math.PI / 2);
    const rings = new InstancedMesh(ringGeo, glowMat, stations.length);
    const m = new Matrix4();
    stations.forEach((n, i) =>
      rings.setMatrixAt(i, m.makeTranslation(n.pos.x, BELT_TOP + 0.002, n.pos.z)),
    );
    rings.computeBoundingSphere();
    this.group.add(rings);
  }

  private buildDocksAndInbounds() {
    const { graph, bounds, dockNodes, inboundNodes } = this.layout;
    const steel = this.std(PALETTE.steel, { metalness: 0.55, roughness: 0.45 });
    const steelLight = this.std(mix('steel', 'ice', 0.18).getHex(), {
      metalness: 0.5,
      roughness: 0.5,
    });
    const doorMat = this.std(mix('steel', 'graphite', 0.4).getHex(), {
      metalness: 0.4,
      roughness: 0.6,
    });
    const pallet = this.std(mix('steel', 'amber', 0.22).getHex(), { roughness: 0.8 });
    const frames = new BoxBatch();
    const rolls = new BoxBatch();
    const walls = new BoxBatch();
    const pallets = new BoxBatch();
    const DOOR_HALF = 1.9;
    const DOOR_H = 4.6;

    const sideWall = (x: number, doorZs: number[]) => {
      // Wall pieces between doors along this side.
      const zs = [...doorZs].sort((a, b) => a - b);
      let from = bounds.minZ;
      for (const z of zs) {
        walls.add(
          x,
          WALL_HEIGHT / 2,
          (from + z - DOOR_HALF) / 2,
          0.3,
          WALL_HEIGHT,
          z - DOOR_HALF - from,
        );
        from = z + DOOR_HALF;
      }
      walls.add(x, WALL_HEIGHT / 2, (from + bounds.maxZ) / 2, 0.3, WALL_HEIGHT, bounds.maxZ - from);
      for (const z of zs) {
        frames.add(x, DOOR_H / 2, z - DOOR_HALF, 0.4, DOOR_H, 0.3);
        frames.add(x, DOOR_H / 2, z + DOOR_HALF, 0.4, DOOR_H, 0.3);
        frames.add(x, DOOR_H + 0.2, z, 0.4, 0.4, DOOR_HALF * 2 + 0.3);
        rolls.add(x, DOOR_H - 0.25, z, 0.5, 0.5, DOOR_HALF * 2 - 0.1);
      }
    };
    sideWall(
      bounds.maxX,
      dockNodes.map((n) => graph.node(n).pos.z),
    );
    sideWall(
      bounds.minX,
      inboundNodes.map((n) => graph.node(n).pos.z),
    );

    // Pallets under every staging slot block (2×2 cells each).
    for (let i = 0; i < dockNodes.length; i++) {
      const a = stagingPile(this.layout, i);
      for (let c = 0; c < a.cols; c += 2) {
        for (let r = 0; r < a.rows; r += 2) {
          const x = a.x0 + (c + 1) * a.cell;
          const z = a.z0 + a.zDir * (r + 1) * a.cell;
          pallets.add(x, 0.06, z, a.cell * 2 - 0.08, 0.12, a.cell * 2 - 0.08);
        }
      }
    }
    for (let i = 0; i < inboundNodes.length; i++) {
      const a = inboundPile(this.layout, i);
      for (let c = 0; c < a.cols; c += 2) {
        for (let r = 0; r < a.rows; r += 2) {
          const x = a.x0 + (c + 1) * a.cell;
          const z = a.z0 + a.zDir * (r + 1) * a.cell;
          pallets.add(x, 0.06, z, a.cell * 2 - 0.08, 0.12, a.cell * 2 - 0.08);
        }
      }
    }
    this.add(walls.build(this.tracker, steelLight, { cast: true, receive: true }));
    this.add(frames.build(this.tracker, steel, { cast: true }));
    this.add(rolls.build(this.tracker, doorMat, { cast: true }));
    this.add(pallets.build(this.tracker, pallet, { cast: true, receive: true }));

    // Signs above the doors and floor stencils beside the dock feeders.
    dockNodes.forEach((n, i) => {
      const z = graph.node(n).pos.z;
      const sign = textPlane(this.tracker, `DOCA ${i + 1}`, 0.7, {
        color: 'graphite',
        background: 'amber',
      });
      sign.rotation.y = -Math.PI / 2;
      sign.position.set(bounds.maxX - 0.25, DOOR_H + 0.85, z);
      this.add(sign);
      const stencil = textPlane(this.tracker, `D${i + 1}`, 1.6, { color: 'amber', opacity: 0.7 });
      stencil.rotation.x = -Math.PI / 2;
      stencil.rotation.z = Math.PI / 2;
      stencil.position.set(20, 0.02, z - 2.6);
      this.add(stencil);
    });
    inboundNodes.forEach((n, i) => {
      const z = graph.node(n).pos.z;
      const sign = textPlane(this.tracker, `ENTRADA ${i + 1}`, 0.7, {
        color: 'graphite',
        background: 'cyan',
      });
      sign.rotation.y = Math.PI / 2;
      sign.position.set(bounds.minX + 0.25, DOOR_H + 0.85, z);
      this.add(sign);
    });
  }

  /** Pallet racking from the layout rows; the robots pick at their faces. */
  private buildRacks() {
    const uprightMat = this.std(mix('steel', 'cyan', 0.06).getHex(), {
      metalness: 0.6,
      roughness: 0.4,
    });
    const beamMat = this.std(PALETTE.amber, { metalness: 0.3, roughness: 0.5 });
    const toteMat = this.std(mix('steel', 'ice', 0.16).getHex(), { roughness: 0.8 });
    const uprights = new BoxBatch();
    const beams = new BoxBatch();
    const totes = new BoxBatch();
    const levels = [0.15, 1.7, 3.25, 4.8];
    const BAY = 2.8;
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (const row of this.layout.racks) {
      for (let x = row.x0; x <= row.x1 + 0.01; x += BAY) {
        uprights.add(x, 3, row.z, 0.1, 6, 0.96);
        if (x + BAY > row.x1 + 0.01) continue;
        for (const y of levels.slice(1)) beams.add(x + BAY / 2, y, row.z, BAY, 0.12, 0.98);
        for (const y of levels) {
          for (let k = 0; k < 3; k++) {
            if (rand() < 0.28) continue;
            const h = 0.6 + rand() * 0.55;
            totes.add(x + 0.5 + k * 0.9, y + 0.07 + h / 2, row.z, 0.78, h, 0.86);
          }
        }
      }
    }
    this.add(uprights.build(this.tracker, uprightMat, { cast: true }));
    this.add(beams.build(this.tracker, beamMat, { cast: true }));
    this.add(totes.build(this.tracker, toteMat, { cast: true, receive: true }));
  }

  /** Materials whose look depends on quality settings. */
  get qualityMaterials(): Material[] {
    return [this.floor.material];
  }
}

function longestSegment(points: readonly Vec2[]): { a: Vec2; b: Vec2 } {
  let best = { a: points[0] as Vec2, b: points[1] as Vec2 };
  let bestLen = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > bestLen) {
      bestLen = len;
      best = { a, b };
    }
  }
  return best;
}
