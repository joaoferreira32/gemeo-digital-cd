import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { QualityLevel } from './quality';

/**
 * Bloom pipeline. Only HDR-bright pixels (emissive lights, rails, trails,
 * alerts — everything above the threshold) glow. High quality renders with
 * 4× MSAA and full-resolution bloom; medium uses half-resolution bloom; low
 * skips post-processing and renders straight to the screen.
 */
export class PostFX {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private target: WebGLRenderTarget | null = null;
  private level: QualityLevel = 'alta';
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  setQuality(level: QualityLevel, width: number, height: number): void {
    this.level = level;
    this.width = width;
    this.height = height;
    this.disposeComposer();
    if (level === 'baixa') return;
    const pr = this.renderer.getPixelRatio();
    this.target = new WebGLRenderTarget(width * pr, height * pr, {
      type: HalfFloatType,
      samples: level === 'alta' ? 4 : 0,
    });
    this.composer = new EffectComposer(this.renderer, this.target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const scale = level === 'alta' ? 1 : 0.5;
    this.bloom = new UnrealBloomPass(new Vector2(width * scale, height * scale), 0.42, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(width, height);
    if (scale !== 1) this.bloom.setSize(width * pr * scale, height * pr * scale);
  }

  resize(width: number, height: number): void {
    this.setQuality(this.level, width, height);
  }

  get bloomEnabled(): boolean {
    return this.composer !== null;
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  private disposeComposer(): void {
    this.bloom?.dispose();
    this.composer?.dispose();
    this.target?.dispose();
    this.bloom = null;
    this.composer = null;
    this.target = null;
  }

  dispose(): void {
    this.disposeComposer();
  }
}
