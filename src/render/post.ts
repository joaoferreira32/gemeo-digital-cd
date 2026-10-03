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
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { QualityLevel } from './quality';

/**
 * Looking at the past: the image loses its color toward a cool monochrome,
 * with faint scanlines, a slight chromatic split toward the edges and a
 * vignette. `motion` = 0 (reduced motion) keeps only the static desaturation.
 */
const REWIND_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
    time: { value: 0 },
    motion: { value: 1 },
    height: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float time;
    uniform float motion;
    uniform float height;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float split = amount * motion * 0.004;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + dir * split).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - dir * split).b
      );
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, luma * vec3(0.9, 1.0, 1.08), amount * 0.8);
      float lines = 0.5 + 0.5 * sin(vUv.y * height * 1.5708 - time * 4.0);
      col *= 1.0 - amount * motion * 0.14 * lines;
      col *= mix(1.0, 0.72 + 0.28 * smoothstep(0.9, 0.3, length(dir)), amount);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/**
 * Bloom pipeline. Only HDR-bright pixels (emissive lights, rails, trails,
 * alerts — everything above the threshold) glow. High quality renders with
 * 4× MSAA and full-resolution bloom; medium uses half-resolution bloom; low
 * skips post-processing and renders straight to the screen.
 */
export class PostFX {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private rewind: ShaderPass | null = null;
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
    this.rewind = new ShaderPass(REWIND_SHADER);
    this.rewind.enabled = false;
    this.composer.addPass(this.rewind);
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

  /** Strength of the rewind look (0 off … 1 full); false when this quality has no post-processing. */
  setRewind(amount: number, time: number, motion: boolean): boolean {
    const pass = this.rewind;
    if (!pass) return false;
    pass.enabled = amount > 0.001;
    const u = pass.uniforms as Record<string, { value: number }>;
    u.amount!.value = amount;
    u.time!.value = time;
    u.motion!.value = motion ? 1 : 0;
    u.height!.value = this.height * this.renderer.getPixelRatio();
    return true;
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
    this.rewind?.dispose();
    this.composer?.dispose();
    this.target?.dispose();
    this.bloom = null;
    this.rewind = null;
    this.composer = null;
    this.target = null;
  }

  dispose(): void {
    this.disposeComposer();
  }
}
