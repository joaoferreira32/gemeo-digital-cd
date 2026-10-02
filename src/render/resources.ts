import type { BufferGeometry, Material, Texture, WebGLRenderTarget } from 'three';

type Disposable = BufferGeometry | Material | Texture | WebGLRenderTarget | { dispose(): void };

/**
 * Keeps every GPU resource a view creates so it can be released in one call
 * when the simulation restarts. Without this, each restart would leak
 * geometries, materials and textures (visible in renderer.info.memory).
 */
export class ResourceTracker {
  private readonly items = new Set<Disposable>();

  track<T extends Disposable>(item: T): T {
    this.items.add(item);
    return item;
  }

  dispose(): void {
    for (const item of this.items) item.dispose();
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
