import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { Rect, WarehouseLayout } from '../sim/layout';
import { DOCK_STRIDE, HEADER, PACKET_STRIDE, ROBOT, ROBOT_STRIDE } from '../sim/snapshot';
import type { SimFrame } from '../link/frames';
import type { RobotPoses } from './poses';
import type { ResourceTracker } from './resources';

export type HeatLayer = 'off' | 'ocupacao' | 'espera' | 'trafego';
export const HEAT_LAYERS: readonly HeatLayer[] = ['off', 'ocupacao', 'espera', 'trafego'];
export const HEAT_LABEL: Record<HeatLayer, string> = {
  off: 'Desligado',
  ocupacao: 'Ocupação',
  espera: 'Tempo de espera',
  trafego: 'Tráfego de robôs',
};

/** Texels per meter of the heat textures. */
const RES = 4;
/** Memory of each channel (seconds of simulated time): occupancy, waiting, robot traffic. */
const TAU = new Vector3(2.5, 4, 25);
/** Value that maps to the middle of the color ramp, per layer. */
const SCALE: Record<Exclude<HeatLayer, 'off'>, number> = { ocupacao: 5, espera: 2.5, trafego: 5 };
const MAX_POINTS = 16_384;

/**
 * Heat map computed on the GPU. Every frame the CPU only uploads the
 * positions of packets and robots (it already has them); two render targets
 * ping-pong on the GPU: one pass decays the previous field, another adds a
 * Gaussian splat per entity with additive blending. A floor overlay maps the
 * chosen channel through a green → amber → red ramp. Nothing is rasterized
 * pixel by pixel on the CPU.
 *
 * Channels (RGB): occupancy (everything that is on the floor or the belts),
 * waiting (packets weighted by how long they have been stuck), robot
 * traffic (moving robots, with a long memory so busy lanes show up).
 */
export class HeatmapView {
  readonly overlay: Mesh<PlaneGeometry, ShaderMaterial>;
  layer: HeatLayer = 'off';
  /** CPU milliseconds spent in the last update (filling the point buffer). */
  cpuMs = 0;
  private targets: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly decayScene = new Scene();
  private readonly splatScene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly decayMat: ShaderMaterial;
  private readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly pos: Float32Array;
  private readonly weight: Float32Array;
  private readonly size: Float32Array;
  private readonly bounds: Rect;
  readonly piles: { x: number; z: number; r: number }[];

  constructor(
    private readonly renderer: WebGLRenderer,
    layout: WarehouseLayout,
    tracker: ResourceTracker,
  ) {
    this.bounds = layout.bounds;
    const w = this.bounds.maxX - this.bounds.minX;
    const d = this.bounds.maxZ - this.bounds.minZ;
    const rt = () =>
      tracker.track(
        new WebGLRenderTarget(Math.round(w * RES), Math.round(d * RES), {
          type: HalfFloatType,
          format: RGBAFormat,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
        }),
      );
    this.targets = [rt(), rt()];

    const quad = tracker.track(new PlaneGeometry(2, 2));
    this.decayMat = tracker.track(
      new ShaderMaterial({
        uniforms: { tPrev: { value: null }, decay: { value: new Vector3(1, 1, 1) } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
          uniform sampler2D tPrev; uniform vec3 decay; varying vec2 vUv;
          void main() { gl_FragColor = vec4(texture2D(tPrev, vUv).rgb * decay, 1.0); }`,
        blending: NoBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.decayScene.add(new Mesh(quad, this.decayMat));

    this.pos = new Float32Array(MAX_POINTS * 3);
    this.weight = new Float32Array(MAX_POINTS * 3);
    this.size = new Float32Array(MAX_POINTS);
    const geo = tracker.track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('weight', new BufferAttribute(this.weight, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('radius', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    const splatMat = tracker.track(
      new ShaderMaterial({
        uniforms: {
          area: { value: [this.bounds.minX, this.bounds.minZ, w, d] },
          texelsPerMeter: { value: RES },
        },
        vertexShader: `
          uniform vec4 area; uniform float texelsPerMeter;
          attribute vec3 weight; attribute float radius;
          varying vec3 vWeight;
          void main() {
            vWeight = weight;
            // Floor (x, z) to the heat texture: u along x, v = 1 at the north wall (minZ).
            float u = (position.x - area.x) / area.z;
            float v = 1.0 - (position.z - area.y) / area.w;
            gl_Position = vec4(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
            gl_PointSize = radius * 2.0 * texelsPerMeter;
          }`,
        fragmentShader: `
          varying vec3 vWeight;
          void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            float g = exp(-dot(p, p) * 3.0);
            gl_FragColor = vec4(vWeight * g, 1.0);
          }`,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.points = new Points(geo, splatMat);
    this.points.frustumCulled = false;
    this.splatScene.add(this.points);

    const plane = tracker.track(new PlaneGeometry(w, d));
    plane.rotateX(-Math.PI / 2);
    this.overlay = new Mesh(
      plane,
      tracker.track(
        new ShaderMaterial({
          uniforms: {
            tHeat: { value: this.targets[0].texture },
            channel: { value: new Vector3(1, 0, 0) },
            scale: { value: 5 },
            opacity: { value: 0.85 },
          },
          vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: `
            uniform sampler2D tHeat; uniform vec3 channel; uniform float scale; uniform float opacity;
            varying vec2 vUv;
            void main() {
              float v = dot(texture2D(tHeat, vUv).rgb, channel);
              float t = 1.0 - exp(-v / scale);
              vec3 green = vec3(0.24, 0.80, 0.42);
              vec3 amber = vec3(0.95, 0.65, 0.25);
              vec3 red = vec3(1.0, 0.30, 0.37);
              vec3 col = t < 0.5 ? mix(green, amber, t * 2.0) : mix(amber, red, (t - 0.5) * 2.0);
              float a = smoothstep(0.02, 0.18, t) * opacity * (0.45 + 0.55 * t);
              if (a < 0.004) discard;
              gl_FragColor = vec4(col, a);
            }`,
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    this.overlay.position.set(
      (this.bounds.minX + this.bounds.maxX) / 2,
      0.02,
      (this.bounds.minZ + this.bounds.maxZ) / 2,
    );
    this.overlay.renderOrder = 1;
    this.overlay.visible = false;

    const center = (a: Rect) => ({
      x: (a.minX + a.maxX) / 2,
      z: (a.minZ + a.maxZ) / 2,
      r: Math.max(a.maxX - a.minX, a.maxZ - a.minZ) / 2,
    });
    this.piles = [...layout.inboundAreas.map(center), ...layout.stagingAreas.map(center)];
  }

  setLayer(layer: HeatLayer): void {
    this.layer = layer;
    this.overlay.visible = layer !== 'off';
    const u = this.overlay.material.uniforms;
    if (layer === 'off') return;
    (u.channel!.value as Vector3).set(
      layer === 'ocupacao' ? 1 : 0,
      layer === 'espera' ? 1 : 0,
      layer === 'trafego' ? 1 : 0,
    );
    u.scale!.value = SCALE[layer];
  }

  /** Advances the heat field by `simDt` simulated seconds. Always runs, so switching layers is instant. */
  update(frame: SimFrame, alpha: number, robots: RobotPoses, simDt: number): void {
    const t0 = performance.now();
    const s = frame.s;
    let n = 0;
    const add = (x: number, z: number, r: number, occ: number, wait: number, traffic: number) => {
      if (n >= MAX_POINTS) return;
      this.pos[n * 3] = x;
      this.pos[n * 3 + 1] = 0;
      this.pos[n * 3 + 2] = z;
      // Weights are per simulated second, so the field does not depend on the frame rate.
      this.weight[n * 3] = occ * simDt;
      this.weight[n * 3 + 1] = wait * simDt;
      this.weight[n * 3 + 2] = traffic * simDt;
      this.size[n] = r;
      n++;
    };
    if (simDt > 0) {
      const count = s.header[HEADER.packets] as number;
      for (let i = 0; i < count; i++) {
        const o = i * PACKET_STRIDE;
        const x =
          (s.packets[o] as number) +
          ((s.packets[o + 3] as number) - (s.packets[o] as number)) * alpha;
        const z =
          (s.packets[o + 1] as number) +
          ((s.packets[o + 4] as number) - (s.packets[o + 1] as number)) * alpha;
        const wait = s.packets[o + 6] as number;
        add(x, z, 1.4, 0.6, wait > 1 ? Math.min(wait / 8, 2) : 0, 0);
      }
      // Piles: one wide splat each, weighted by how many packets they hold.
      this.piles.forEach((p, i) => {
        const inbound = i < s.inbounds.length;
        const c = inbound
          ? (s.inbounds[i] as number)
          : (s.docks[(i - s.inbounds.length) * DOCK_STRIDE] as number);
        if (c > 0)
          add(p.x, p.z, p.r + 1.5, Math.min(c / 60, 6), inbound ? Math.min(c / 40, 6) : 0, 0);
      });
      for (let r = 0; r < robots.count; r++) {
        const moving = (s.robots[r * ROBOT_STRIDE + ROBOT.speed] as number) > 0.1;
        add(robots.x[r] as number, robots.z[r] as number, 1.1, 0.4, 0, moving ? 1 : 0.15);
      }
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    for (const a of ['position', 'weight', 'radius'])
      (geo.attributes[a] as BufferAttribute).needsUpdate = true;
    this.cpuMs = performance.now() - t0;

    if (simDt <= 0) return;
    // GPU: decay the old field into the other target, then add this frame's splats.
    const [read, write] = this.targets;
    const decay = this.decayMat.uniforms.decay!.value as Vector3;
    decay.set(Math.exp(-simDt / TAU.x), Math.exp(-simDt / TAU.y), Math.exp(-simDt / TAU.z));
    this.decayMat.uniforms.tPrev!.value = read.texture;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(write);
    this.renderer.render(this.decayScene, this.camera);
    if (n > 0) this.renderer.render(this.splatScene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    this.targets = [write, read];
    this.overlay.material.uniforms.tHeat!.value = write.texture;
  }
}
