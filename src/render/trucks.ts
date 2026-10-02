import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WarehouseLayout } from '../sim/layout';
import { DOCK_STRIDE, TRUCK_STATES } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { PALETTE, mix } from './palette';
import type { ResourceTracker } from './resources';

const TRAILER_LENGTH = 12;
/** Distance a truck drives away before it disappears in the fog. */
const DRIVE_DISTANCE = 45;
const DRIVE_TIME = 5;

/**
 * Trucks at every door. Outbound trucks follow the dock's truck state from
 * the simulation (docked → loading → away → back); inbound trucks are static.
 * Parts are merged per material once and shared by every truck, so a truck
 * costs 5 draw calls instead of one per part.
 */
export class TruckView {
  readonly group = new Group();
  private readonly outbound: Group[] = [];
  private readonly loadLights: MeshStandardMaterial[] = [];

  constructor(
    private readonly layout: WarehouseLayout,
    /** Seconds a full truck stays away (SimConfig.truckAwayTime). */
    private readonly awayTime: number,
    tracker: ResourceTracker,
  ) {
    const parts = buildTruckGeometries(tracker);
    const material = (opts: ConstructorParameters<typeof MeshStandardMaterial>[0]) =>
      tracker.track(new MeshStandardMaterial(opts));
    const shared: [BufferGeometry, MeshStandardMaterial][] = [
      [
        parts.trailer,
        material({ color: mix('steel', 'ice', 0.3), metalness: 0.45, roughness: 0.5 }),
      ],
      [parts.cab, material({ color: PALETTE.steel, metalness: 0.5, roughness: 0.35 })],
      [
        parts.stripes,
        material({ color: PALETTE.cyan, emissive: PALETTE.cyan, emissiveIntensity: 0.6 }),
      ],
      [parts.wheels, material({ color: PALETTE.graphite, roughness: 0.9 })],
    ];

    const makeTruck = (withLight: boolean): Group => {
      const g = new Group();
      for (const [geo, mat] of shared) {
        const mesh = new Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
      }
      if (withLight) {
        // Own material per truck so the loading light can pulse per dock.
        const lightMat = material({
          color: PALETTE.amber,
          emissive: PALETTE.amber,
          emissiveIntensity: 0,
        });
        g.add(new Mesh(parts.light, lightMat));
        this.loadLights.push(lightMat);
      }
      return g;
    };

    const { graph, bounds } = layout;
    for (const nodeId of layout.dockNodes) {
      const truck = makeTruck(true);
      truck.position.set(bounds.maxX + 0.4, 0, graph.node(nodeId).pos.z);
      this.group.add(truck);
      this.outbound.push(truck);
    }
    for (const nodeId of layout.inboundNodes) {
      const truck = makeTruck(false);
      truck.rotation.y = Math.PI;
      truck.position.set(bounds.minX - 0.4, 0, graph.node(nodeId).pos.z);
      this.group.add(truck);
    }
  }

  update(frame: SimFrame, time: number, reducedMotion: boolean): void {
    const homeX = this.layout.bounds.maxX + 0.4;
    const docks = frame.s.docks;
    this.outbound.forEach((g, i) => {
      const state = TRUCK_STATES[docks[i * DOCK_STRIDE + 1] as number];
      const awayLeft = docks[i * DOCK_STRIDE + 2] as number;
      let d = 0;
      if (state === 'away') {
        const out = Math.min(1, (this.awayTime - awayLeft) / DRIVE_TIME);
        const back = Math.min(1, awayLeft / DRIVE_TIME);
        // Ease out of the door, stay away, ease back in.
        d = DRIVE_DISTANCE * Math.min(out * out, back * back);
      }
      g.position.x = homeX + d;
      g.visible = d < DRIVE_DISTANCE - 0.5;
      const pulse = reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(time * 6);
      (this.loadLights[i] as MeshStandardMaterial).emissiveIntensity =
        state === 'loading' ? 2.2 * pulse : 0;
    });
  }
}

/** Truck pointing +x (cab at +x), trailer rear at local x = 0. */
function buildTruckGeometries(tracker: ResourceTracker) {
  const m = new Matrix4();
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    new BoxGeometry(sx, sy, sz).applyMatrix4(m.makeTranslation(x, y, z));
  const merge = (geos: BufferGeometry[]) => {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error('truck geometry merge failed');
    return tracker.track(merged);
  };
  const half = TRAILER_LENGTH / 2;
  const wheels: BufferGeometry[] = [];
  for (const x of [1.2, 2.4, TRAILER_LENGTH - 1.2, TRAILER_LENGTH + 2]) {
    for (const z of [-1.0, 1.0]) {
      const w = new CylinderGeometry(0.5, 0.5, 0.36, 18);
      w.rotateX(Math.PI / 2);
      wheels.push(w.applyMatrix4(m.makeTranslation(x, 0.5, z)));
    }
  }
  return {
    trailer: merge([box(half, 2.35, 0, TRAILER_LENGTH, 2.9, 2.5)]),
    cab: merge([
      box(TRAILER_LENGTH + 1.5, 1.75, 0, 2.4, 2.5, 2.4),
      box(TRAILER_LENGTH + 0.4, 0.75, 0, 2.6, 0.5, 1.8),
    ]),
    stripes: merge([
      box(half, 1.3, 1.26, TRAILER_LENGTH - 0.6, 0.12, 0.02),
      box(half, 1.3, -1.26, TRAILER_LENGTH - 0.6, 0.12, 0.02),
    ]),
    wheels: merge(wheels),
    light: merge([box(0.02, 3.7, 0, 0.06, 0.12, 1.6)]),
  };
}
