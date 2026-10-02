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
import type { FloorGrid } from '../sim/floor';
import type { WarehouseLayout } from '../sim/layout';
import { CONVEYOR_STRIDE, HEADER, ROBOT, ROBOT_STRIDE, STAGES } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import { AlertView } from './alerts';
import { OrbitCamera, type CameraPreset } from './camera';
import { ROOF_Y } from './floorplan';
import { HeatmapView, type HeatLayer } from './heatmap';
import { PacketView } from './packets';
import { PALETTE, mix } from './palette';
import { RobotPoses } from './poses';
import { PostFX } from './post';
import { QUALITY_SETTINGS, type QualityLevel } from './quality';
import { ResourceTracker } from './resources';
import { RobotView } from './robots';
import { RouteView } from './routes';
import { TrailView } from './trails';
import { TruckView } from './trucks';
import { WarehouseView } from './warehouse';

export interface SceneOptions {
  readonly layout: WarehouseLayout;
  readonly grid: FloorGrid;
  /** [pickup node, drop node] of each robot bypass lane, in snapshot order. */
  readonly laneNodes: readonly (readonly [number, number])[];
  readonly conveyorSpeed: number;
  readonly truckAwayTime: number;
}

/**
 * Everything drawn. It only reads snapshots from the simulation; a restart
 * disposes this view (all tracked GPU resources) and builds a new one on the
 * same renderer.
 */
export class SceneView {
  readonly scene = new Scene();
  readonly orbit: OrbitCamera;
  readonly packets: PacketView;
  readonly robots: RobotView;
  readonly heat: HeatmapView;
  readonly poses = new RobotPoses();
  readonly alerts: AlertView;
  /** Robot followed by the follow camera. */
  followRobot = 0;
  private readonly tracker = new ResourceTracker();
  private readonly warehouse: WarehouseView;
  private readonly trucks: TruckView;
  private readonly trails: TrailView;
  private readonly routes: RouteView;
  private readonly post: PostFX;
  private readonly sun: DirectionalLight;
  private readonly beltBroken: boolean[];
  private readonly followPoint = new Vector3();
  private wallTime = 0;
  private trailsOn = true;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly opts: SceneOptions,
    canvas: HTMLElement,
    private reducedMotion: boolean,
  ) {
    const { layout } = opts;
    const { bounds } = layout;
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

    this.warehouse = new WarehouseView(layout, opts.grid, this.tracker);
    this.scene.add(this.warehouse.group);
    this.packets = new PacketView(layout, opts.laneNodes, this.tracker);
    this.scene.add(this.packets.mesh);
    this.trucks = new TruckView(layout, opts.truckAwayTime, this.tracker);
    this.scene.add(this.trucks.group);
    this.robots = new RobotView(this.tracker);
    this.scene.add(this.robots.bodies, this.robots.decks, this.robots.lights);
    this.trails = new TrailView(this.tracker);
    this.scene.add(this.trails.mesh);
    this.routes = new RouteView(this.tracker);
    this.scene.add(this.routes.mesh);
    this.alerts = new AlertView(layout, this.tracker);
    this.scene.add(this.alerts.rings, this.alerts.beams);
    this.heat = new HeatmapView(renderer, layout, this.tracker);
    this.scene.add(this.heat.overlay);
    this.beltBroken = layout.graph.edges.map(() => false);

    this.orbit = new OrbitCamera(canvas, bounds, reducedMotion);
    this.post = new PostFX(renderer, this.scene, this.orbit.camera);
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.orbit.setReducedMotion(v);
    if (v) this.trails.reset();
  }

  setCameraPreset(preset: CameraPreset): void {
    this.orbit.setPreset(preset);
  }

  setHeatLayer(layer: HeatLayer): void {
    this.heat.setLayer(layer);
  }

  applyQuality(level: QualityLevel, viewportWidth: number, viewportHeight: number): void {
    const q = QUALITY_SETTINGS[level];
    this.warehouse.reflector.visible = q.reflection;
    const floorMat = this.warehouse.floor.material;
    floorMat.transparent = q.reflection;
    floorMat.opacity = q.reflection ? 0.86 : 1;
    floorMat.needsUpdate = true;
    this.sun.castShadow = q.shadows;
    this.sun.shadow.radius = q.shadowRadius;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.trailsOn = q.trails;
    if (!q.trails) this.trails.reset();
    this.trails.mesh.visible = q.trails;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
    this.renderer.setSize(viewportWidth, viewportHeight, false);
    this.orbit.resize(viewportWidth, viewportHeight);
    this.post.setQuality(level, viewportWidth, viewportHeight);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.orbit.resize(width, height);
    this.post.resize(width, height);
  }

  get bloomEnabled(): boolean {
    return this.post.bloomEnabled;
  }

  /**
   * @param realDt real seconds since the last frame (camera, pulses)
   * @param frame snapshot that contains the instant being drawn
   * @param alpha position of that instant inside the snapshot interval
   * @param simDt simulated seconds drawn this frame (belts, heat map)
   */
  update(realDt: number, frame: SimFrame, alpha: number, simDt: number): void {
    this.wallTime += realDt;
    const s = frame.s;
    this.poses.update(frame, alpha);
    for (let e = 0; e < this.beltBroken.length; e++) {
      const broken = (s.conveyors[e * CONVEYOR_STRIDE] as number) > 0;
      if (this.beltBroken[e] !== broken) {
        this.beltBroken[e] = broken;
        this.warehouse.setBeltBroken(e, broken);
      }
    }
    this.warehouse.scrollBelts(simDt * this.opts.conveyorSpeed);
    this.packets.update(frame, alpha, this.poses);
    this.robots.update(frame, this.poses, this.wallTime, this.reducedMotion);
    this.trucks.update(frame, this.wallTime, this.reducedMotion);
    if (this.trailsOn && !this.reducedMotion) this.trails.update(this.poses, realDt);
    this.alerts.update(frame, this.poses, this.wallTime, this.reducedMotion);
    this.heat.update(frame, alpha, this.poses, simDt);

    if (this.orbit.preset === 'follow' && this.poses.count > 0) {
      const r = Math.min(this.followRobot, this.poses.count - 1);
      this.followPoint.set(this.poses.x[r] as number, 0.3, this.poses.z[r] as number);
      this.orbit.followPoint = this.followPoint;
    } else {
      this.orbit.followPoint = null;
    }
    this.orbit.update(realDt);
    this.routes.update(
      frame,
      this.poses,
      this.orbit.distance,
      this.reducedMotion ? 0 : this.wallTime,
    );
    // Cutaway: from above, the roof structure would only clutter the view.
    this.warehouse.roof.visible = this.orbit.camera.position.y < ROOF_Y - 0.5;
  }

  /**
   * Moves the follow camera to the next robot that is working (moving or
   * handling boxes); falls back to the next robot when all are idle.
   */
  nextFollow(frame: SimFrame | undefined, fromCurrent = true): void {
    if (!frame) return;
    const count = frame.s.header[HEADER.robots] as number;
    if (count === 0) return;
    const start = fromCurrent ? this.followRobot + 1 : 0;
    for (let k = 0; k < count; k++) {
      const i = (start + k) % count;
      const stage = STAGES[frame.s.robots[i * ROBOT_STRIDE + ROBOT.stage] as number];
      if (stage !== 'parked' && stage !== 'charging' && stage !== 'defect') {
        this.followRobot = i;
        return;
      }
    }
    this.followRobot = start % count;
  }

  render(): void {
    this.post.render();
  }

  dispose(): void {
    this.orbit.dispose();
    this.post.dispose();
    this.sun.shadow.dispose();
    this.packets.mesh.dispose();
    this.robots.dispose();
    this.alerts.dispose();
    this.scene.traverse((o) => {
      if ('isInstancedMesh' in o && o.isInstancedMesh)
        (o as unknown as { dispose(): void }).dispose();
    });
    this.tracker.dispose();
    this.scene.clear();
  }
}
