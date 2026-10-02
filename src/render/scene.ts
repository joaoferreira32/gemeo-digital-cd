import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  PMREMGenerator,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { Packet } from '../sim/packet';
import type { World } from '../sim/world';
import { OrbitCamera, type CameraPreset } from './camera';
import { BELT_TOP, ROOF_Y } from './floorplan';
import { PALETTE, mix } from './palette';
import { PacketView } from './packets';
import { QUALITY_SETTINGS, type QualityLevel } from './quality';
import { ResourceTracker } from './resources';
import { TruckView } from './trucks';
import { WarehouseView } from './warehouse';

/**
 * Everything drawn for one World. It only *reads* the simulation state; a
 * restart disposes this view (all tracked GPU resources) and builds a new one
 * on the same renderer.
 */
export class SceneView {
  readonly scene = new Scene();
  readonly orbit: OrbitCamera;
  readonly packets: PacketView;
  private readonly tracker = new ResourceTracker();
  private readonly warehouse: WarehouseView;
  private readonly trucks: TruckView;
  private readonly sun: DirectionalLight;
  private readonly beltStatus: boolean[];
  private followed: Packet | null = null;
  private readonly followPoint = new Vector3();
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };
  private wallTime = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly world: World,
    canvas: HTMLElement,
    private reducedMotion: boolean,
  ) {
    const { bounds } = world.layout;
    this.scene.background = new Color(PALETTE.graphite);
    this.scene.fog = new FogExp2(PALETTE.graphite, 0.0095);

    // Soft image-based ambient so metals and the floor pick up highlights.
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    // Track the render target, not just its texture: disposing only the texture
    // left one GPU texture behind on every restart (caught by the memory check).
    this.scene.environment = this.tracker.track(pmrem.fromScene(room, 0.04)).texture;
    this.scene.environmentIntensity = 0.32;
    room.dispose();
    pmrem.dispose();

    this.scene.add(new HemisphereLight(mix('ice', 'cyan', 0.15), PALETTE.graphite, 0.55));
    this.sun = new DirectionalLight(mix('ice', 'amber', 0.08), 2.1);
    this.sun.position.set(-18, 46, 22);
    this.sun.target.position.set(-2, 0, 0);
    const sc = this.sun.shadow.camera;
    sc.left = bounds.minX - 6;
    sc.right = bounds.maxX + 18;
    sc.top = bounds.maxZ + 8;
    sc.bottom = bounds.minZ - 8;
    sc.near = 5;
    sc.far = 110;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const rim = new DirectionalLight(PALETTE.cyan, 0.35);
    rim.position.set(40, 18, -30);
    this.scene.add(rim);

    this.warehouse = new WarehouseView(world.layout, this.tracker);
    this.scene.add(this.warehouse.group);
    this.packets = new PacketView(world, this.tracker);
    this.scene.add(this.packets.mesh);
    this.trucks = new TruckView(world, this.tracker);
    this.scene.add(this.trucks.group);
    this.beltStatus = world.conveyors.map(() => true);

    this.orbit = new OrbitCamera(canvas, bounds, reducedMotion);
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.orbit.setReducedMotion(v);
  }

  setCameraPreset(preset: CameraPreset): void {
    if (preset === 'follow') this.followed = this.packets.pickFollowTarget(null);
    this.orbit.setPreset(preset);
  }

  applyQuality(level: QualityLevel, viewportWidth: number, viewportHeight: number): void {
    const q = QUALITY_SETTINGS[level];
    this.warehouse.reflector.visible = q.reflection;
    const floorMat = this.warehouse.floor.material;
    floorMat.transparent = q.reflection;
    floorMat.opacity = q.reflection ? 0.86 : 1;
    floorMat.needsUpdate = true;
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
    this.resize(viewportWidth, viewportHeight);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.orbit.resize(width, height);
  }

  /**
   * @param frameDt real seconds since the last frame (camera, effects)
   * @param simDt simulated seconds that elapsed this frame (belt scrolling)
   * @param alpha interpolation factor between the last two simulation steps
   */
  update(frameDt: number, simDt: number, alpha: number): void {
    this.wallTime += frameDt;
    this.world.conveyors.forEach((c, i) => {
      const ok = c.status === 'ok';
      if (this.beltStatus[i] !== ok) {
        this.beltStatus[i] = ok;
        this.warehouse.setBeltBroken(c.edgeId, !ok);
      }
    });
    this.warehouse.scrollBelts(simDt * this.world.config.conveyorSpeed);
    this.packets.update(alpha);
    this.trucks.update(this.wallTime, this.reducedMotion);

    if (this.orbit.preset === 'follow') {
      this.followed = this.packets.pickFollowTarget(this.followed);
      const p = this.followed;
      if (p && p.edge >= 0) {
        const s = p.prevS + (p.s - p.prevS) * alpha;
        pointOnEdge(this.world.layout.graph.edge(p.edge), s, this.point);
        this.followPoint.set(this.point.x, BELT_TOP, this.point.z);
        this.orbit.followPoint = this.followPoint;
      }
    } else {
      this.followed = null;
      this.orbit.followPoint = null;
    }
    this.orbit.update(frameDt);
    // Cutaway: from above, the roof structure would only clutter the view.
    this.warehouse.roof.visible = this.orbit.camera.position.y < ROOF_Y - 0.5;
  }

  /** Id of the packet the follow camera is tracking (shown in the HUD). */
  get followedPacketId(): number | null {
    return this.orbit.preset === 'follow' ? (this.followed?.id ?? null) : null;
  }

  render(): void {
    this.renderer.render(this.scene, this.orbit.camera);
  }

  dispose(): void {
    this.orbit.dispose();
    this.sun.shadow.dispose();
    this.packets.mesh.dispose();
    this.scene.traverse((o) => {
      if ('isInstancedMesh' in o && o.isInstancedMesh)
        (o as unknown as { dispose(): void }).dispose();
    });
    this.tracker.dispose();
    this.scene.clear();
  }
}
