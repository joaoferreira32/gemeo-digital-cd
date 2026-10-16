import { BackSide, BoxGeometry, Color, Mesh, MeshBasicMaterial } from 'three';

/**
 * A thin glowing outline around one box (the cinema tour's packet): a slightly
 * larger box drawn from the inside, so only its rim shows around the box, in
 * a color bright enough for the bloom to catch it.
 */
export class BoxOutline {
  readonly mesh: Mesh<BoxGeometry, MeshBasicMaterial>;

  constructor(color: number, glow = 1.8) {
    const material = new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(glow),
      side: BackSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
    this.mesh.visible = false;
  }

  /** Around a box standing at `y` (its base), turned by `yaw`, `grow` meters larger. */
  place(
    x: number,
    y: number,
    z: number,
    yaw: number,
    size: readonly [number, number, number],
    grow = 0.06,
  ): void {
    const [sx, sy, sz] = size;
    this.mesh.position.set(x, y + sy / 2, z);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(sx + grow, sy + grow, sz + grow);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
