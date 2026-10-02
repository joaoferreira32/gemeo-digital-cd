import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import type { ResourceTracker } from './resources';
import { labelTexture, type LabelOptions } from './textures';

/**
 * Collects many boxes that share a material and turns them into a single
 * InstancedMesh (one draw call). Static structures — legs, columns, racks,
 * markings — are all built this way.
 */
export class BoxBatch {
  private readonly matrices: Matrix4[] = [];
  private static readonly q = new Quaternion();
  private static readonly e = new Euler();

  /** Box centered at (x, y, z) with size (sx, sy, sz), rotated `yaw` around +y. */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0): this {
    BoxBatch.q.setFromEuler(BoxBatch.e.set(0, yaw, 0));
    this.matrices.push(
      new Matrix4().compose(new Vector3(x, y, z), BoxBatch.q, new Vector3(sx, sy, sz)),
    );
    return this;
  }

  /** Box spanning from (x1, z1) to (x2, z2) on the floor plane, with given width and height range. */
  addSpan(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    width: number,
    yBottom: number,
    yTop: number,
  ): this {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const yaw = -Math.atan2(z2 - z1, x2 - x1);
    return this.add(
      (x1 + x2) / 2,
      (yBottom + yTop) / 2,
      (z1 + z2) / 2,
      len,
      yTop - yBottom,
      width,
      yaw,
    );
  }

  get count(): number {
    return this.matrices.length;
  }

  build(
    tracker: ResourceTracker,
    material: Material,
    shadows: { cast?: boolean; receive?: boolean } = {},
  ): InstancedMesh {
    const geometry = tracker.track(new BoxGeometry(1, 1, 1));
    const mesh = new InstancedMesh(geometry, material, Math.max(1, this.matrices.length));
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = this.matrices.length;
    mesh.castShadow = shadows.cast ?? false;
    mesh.receiveShadow = shadows.receive ?? false;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

/** Same idea for vertical cylinders (wheels are rotated individually by the caller). */
export function cylinderInstances(
  tracker: ResourceTracker,
  material: Material,
  items: readonly { x: number; y: number; z: number; r: number; h: number; rotX?: number }[],
  segments = 20,
): InstancedMesh {
  const geometry = tracker.track(new CylinderGeometry(1, 1, 1, segments));
  const mesh = new InstancedMesh(geometry, material, Math.max(1, items.length));
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  items.forEach((it, i) => {
    q.setFromEuler(e.set(it.rotX ?? 0, 0, 0));
    m.compose(new Vector3(it.x, it.y, it.z), q, new Vector3(it.r, it.h, it.r));
    mesh.setMatrixAt(i, m);
  });
  mesh.count = items.length;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Text as a plane: flat on the floor (stencil) or upright (sign). `height` is
 * the plane height in meters; width follows the text.
 */
export function textPlane(
  tracker: ResourceTracker,
  text: string,
  height: number,
  opts: LabelOptions & { opacity?: number } = {},
): Mesh {
  const { texture, aspect } = labelTexture(tracker, text, opts);
  const material = tracker.track(
    new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: opts.opacity ?? 1,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
  );
  const geometry = tracker.track(new PlaneGeometry(height * aspect, height));
  return new Mesh(geometry, material);
}
