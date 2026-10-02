import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

export type CameraPreset = 'aerial' | 'ground' | 'follow';

interface Pose {
  target: Vector3;
  radius: number;
  /** Azimuth around +y, radians. */
  theta: number;
  /** Polar angle from +y, radians (0 = straight down). */
  phi: number;
}

const PRESETS: Record<Exclude<CameraPreset, 'follow'>, Pose> = {
  aerial: { target: new Vector3(-2, 0, 0), radius: 74, theta: 0.42, phi: 0.62 },
  ground: { target: new Vector3(-12, 1.2, 0), radius: 17, theta: -1.05, phi: 1.36 },
};

const LIMITS = { minRadius: 4, maxRadius: 150, minPhi: 0.05, maxPhi: 1.48 };

/**
 * Hand-written orbit camera (no OrbitControls): spherical coordinates around a
 * target, every input moves a *goal* pose and the actual pose follows it with
 * exponential damping, so mouse, keyboard and preset changes are all smooth.
 */
export class OrbitCamera {
  readonly camera: PerspectiveCamera;
  preset: CameraPreset | null = 'aerial';
  /** World position to keep centered while following; set every frame by the scene. */
  followPoint: Vector3 | null = null;

  private readonly goal: Pose;
  private readonly pose: Pose;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragMode: 'orbit' | 'pan' | null = null;
  private pinchDistance = 0;
  private readonly raycaster = new Raycaster();
  private readonly floor = new Plane(new Vector3(0, 1, 0), 0);
  private readonly abort = new AbortController();

  constructor(
    private readonly dom: HTMLElement,
    private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    private reducedMotion: boolean,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 0.1, 600);
    this.goal = clonePose(PRESETS.aerial);
    this.pose = clonePose(PRESETS.aerial);
    this.listen();
    this.apply();
  }

  /** Current distance from the camera to its target (meters). */
  get distance(): number {
    return this.pose.radius;
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  setPreset(preset: CameraPreset): void {
    this.preset = preset;
    if (preset === 'follow') {
      this.goal.radius = 10;
      this.goal.phi = 1.05;
      return;
    }
    const p = PRESETS[preset];
    this.goal.target.copy(p.target);
    // Presets are framed for a 16:9 screen; narrower (portrait) screens pull back.
    this.goal.radius = p.radius * Math.max(1, Math.sqrt(1.6 / this.camera.aspect));
    this.goal.phi = p.phi;
    // Rotate the shortest way to the preset azimuth.
    this.goal.theta = this.pose.theta + wrapAngle(p.theta - this.pose.theta);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    this.applyKeys(dt);
    if (this.preset === 'follow' && this.followPoint) this.goal.target.copy(this.followPoint);
    this.clampGoal();
    // Frame-rate independent damping; reduced motion snaps almost immediately.
    const k = 1 - Math.exp(-dt * (this.reducedMotion ? 40 : 7));
    this.pose.target.lerp(this.goal.target, k);
    this.pose.radius += (this.goal.radius - this.pose.radius) * k;
    this.pose.theta += (this.goal.theta - this.pose.theta) * k;
    this.pose.phi += (this.goal.phi - this.pose.phi) * k;
    this.apply();
  }

  dispose(): void {
    this.abort.abort();
  }

  private apply(): void {
    const { target, radius, theta, phi } = this.pose;
    this.camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    this.camera.lookAt(target);
  }

  private clampGoal(): void {
    const g = this.goal;
    g.radius = Math.min(LIMITS.maxRadius, Math.max(LIMITS.minRadius, g.radius));
    g.phi = Math.min(LIMITS.maxPhi, Math.max(LIMITS.minPhi, g.phi));
    const m = 10;
    g.target.x = Math.min(this.bounds.maxX + m, Math.max(this.bounds.minX - m, g.target.x));
    g.target.z = Math.min(this.bounds.maxZ + m, Math.max(this.bounds.minZ - m, g.target.z));
  }

  private orbit(dx: number, dy: number): void {
    this.goal.theta -= dx * 0.006;
    this.goal.phi -= dy * 0.005;
  }

  /** Pans in screen space projected on the floor; speed scales with distance. */
  private pan(dx: number, dy: number): void {
    this.preset = null;
    const scale = this.goal.radius * 0.0016;
    const t = this.goal.theta;
    // Screen right and screen "up" projected on the floor plane.
    const rx = Math.cos(t);
    const rz = -Math.sin(t);
    const fx = -Math.sin(t);
    const fz = -Math.cos(t);
    this.goal.target.x += (-dx * rx + dy * fx) * scale;
    this.goal.target.z += (-dx * rz + dy * fz) * scale;
  }

  /** Zooms toward the floor point under the cursor (or the screen center for keys). */
  private zoom(factor: number, clientX?: number, clientY?: number): void {
    const before = this.goal.radius;
    this.goal.radius = Math.min(LIMITS.maxRadius, Math.max(LIMITS.minRadius, before * factor));
    if (clientX === undefined || clientY === undefined || this.preset === 'follow') return;
    const rect = this.dom.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(this.floor, hit)) return;
    // Move the target toward the hit point by the same fraction the radius shrank.
    const k = 1 - this.goal.radius / before;
    this.goal.target.x += (hit.x - this.goal.target.x) * k;
    this.goal.target.z += (hit.z - this.goal.target.z) * k;
    this.preset = null;
  }

  private applyKeys(dt: number): void {
    if (this.keys.size === 0) return;
    const has = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const panSpeed = 520 * dt;
    if (has('KeyW', 'ArrowUp')) this.pan(0, panSpeed);
    if (has('KeyS', 'ArrowDown')) this.pan(0, -panSpeed);
    if (has('KeyA', 'ArrowLeft')) this.pan(panSpeed, 0);
    if (has('KeyD', 'ArrowRight')) this.pan(-panSpeed, 0);
    if (has('KeyQ')) this.goal.theta += 1.4 * dt;
    if (has('KeyE')) this.goal.theta -= 1.4 * dt;
    if (has('KeyR')) this.goal.phi -= 0.9 * dt;
    if (has('KeyF')) this.goal.phi += 0.9 * dt;
    if (has('Equal', 'NumpadAdd')) this.zoom(Math.exp(-1.6 * dt));
    if (has('Minus', 'NumpadSubtract')) this.zoom(Math.exp(1.6 * dt));
  }

  private listen(): void {
    const opts = { signal: this.abort.signal };
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    el.addEventListener(
      'pointerdown',
      (e) => {
        el.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.dragMode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        if (this.pointers.size === 2) this.pinchDistance = this.pointerSpread();
      },
      opts,
    );
    el.addEventListener(
      'pointermove',
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        prev.x = e.clientX;
        prev.y = e.clientY;
        if (this.pointers.size === 2) {
          // Two fingers: pinch to zoom, drag to pan.
          const spread = this.pointerSpread();
          if (this.pinchDistance > 0) this.zoom(this.pinchDistance / Math.max(1, spread));
          this.pinchDistance = spread;
          this.pan(dx / 2, dy / 2);
        } else if (this.dragMode === 'pan') {
          this.pan(dx, dy);
        } else if (this.dragMode === 'orbit') {
          this.orbit(dx, dy);
        }
      },
      opts,
    );
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.dragMode = null;
      this.pinchDistance = 0;
    };
    el.addEventListener('pointerup', end, opts);
    el.addEventListener('pointercancel', end, opts);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0012), e.clientX, e.clientY);
      },
      { ...opts, passive: false },
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
        this.keys.add(e.code);
      },
      opts,
    );
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), opts);
    window.addEventListener('blur', () => this.keys.clear(), opts);
  }

  private pointerSpread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}

function clonePose(p: Pose): Pose {
  return { target: p.target.clone(), radius: p.radius, theta: p.theta, phi: p.phi };
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
