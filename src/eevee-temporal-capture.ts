import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";

const FILTER_TABLE_SIZE = 512;

function f32(value: number): number {
  return Math.fround(value);
}

function blackmanHarris(x: number): number {
  const angle = f32(2 * Math.PI * f32(x + 0.5));
  return f32(
    f32(0.35875 - f32(0.48829 * Math.cos(angle)))
    + f32(0.14128 * Math.cos(f32(2 * angle)))
    - f32(0.01168 * Math.cos(f32(3 * angle))),
  );
}

/** Rebuild Blender legacy Eevee's 512-entry inverse Blackman-Harris CDF. */
export function buildEeveeFilterTable(): Float32Array {
  const cdf = new Float32Array(FILTER_TABLE_SIZE);
  for (let u = 0; u < FILTER_TABLE_SIZE - 1; u++) {
    const x = f32(f32((u + 1) / (FILTER_TABLE_SIZE - 1)) - 0.5);
    cdf[u + 1] = f32(cdf[u] + blackmanHarris(x));
  }
  const total = cdf[FILTER_TABLE_SIZE - 1];
  for (let u = 0; u < FILTER_TABLE_SIZE - 1; u++) cdf[u] = f32(cdf[u] / total);
  cdf[FILTER_TABLE_SIZE - 1] = 1;

  const inverse = new Float32Array(FILTER_TABLE_SIZE);
  for (let u = 0; u < FILTER_TABLE_SIZE; u++) {
    const target = f32(u / (FILTER_TABLE_SIZE - 1));
    for (let index = 0; index < FILTER_TABLE_SIZE; index++) {
      if (cdf[index] < target) continue;
      if (index === FILTER_TABLE_SIZE - 1) inverse[u] = 1;
      else {
        const denominator = f32(cdf[index + 1] - cdf[index]);
        const t = denominator === 0 ? 0 : f32(f32(target - cdf[index]) / denominator);
        inverse[u] = f32(f32(index + t) / (FILTER_TABLE_SIZE - 1));
      }
      break;
    }
  }
  // eevee_temporal_sampling.c uses a two-pixel footprint, doubled for the
  // Blackman-Harris filter, before applying RenderData.filter_size.
  for (let index = 0; index < inverse.length; index++)
    inverse[index] = f32(f32(inverse[index] - 0.5) * 4);
  return inverse;
}

function evaluateTable(table: Float32Array, value: number): number {
  const x = f32(Math.min(Math.max(value, 0), 1) * (FILTER_TABLE_SIZE - 1));
  const index = Math.min(Math.floor(x), FILTER_TABLE_SIZE - 1);
  const next = Math.min(index + 1, FILTER_TABLE_SIZE - 1);
  const t = f32(x - index);
  return f32(f32(f32(1 - t) * table[index]) + f32(t * table[next]));
}

function radicalInverse(index: number, base: number): number {
  let value = 0;
  let fraction = 1 / base;
  for (let remaining = index; remaining > 0; remaining = Math.floor(remaining / base)) {
    value += (remaining % base) * fraction;
    fraction /= base;
  }
  return value;
}

/** Pixel-space offsets used by a controlled legacy-Eevee render. */
export function buildEeveeJitterOffsets(sampleCount = 64, filterSize = 1.5): ReadonlyArray<readonly [number, number]> {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  const filter = buildEeveeFilterTable();
  const offsets: Array<readonly [number, number]> = [[0, 0]];
  for (let sample = 1; sample < sampleCount; sample++) {
    offsets.push([
      f32(evaluateTable(filter, radicalInverse(sample, 2)) * filterSize),
      f32(evaluateTable(filter, radicalInverse(sample, 3)) * filterSize),
    ]);
  }
  return offsets;
}

/**
 * Capture-only equivalent of legacy Eevee's 64-sample temporal resolve.
 * Each animation frame renders one complete linear sample, accumulates it in
 * RGBA16F, and presents through an explicit sRGB output pass after completion.
 */
export class EeveeTemporalCapture {
  private readonly sampleTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  private readonly accumulationTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly copyQuad: FullScreenQuad;
  private readonly outputPass = new OutputPass();
  private readonly clearColor = new THREE.Color();
  private readonly offsets: ReadonlyArray<readonly [number, number]>;
  private sampleIndex = 0;
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    private readonly canvas: HTMLCanvasElement,
    sampleCount = 64,
    filterSize = 1.5,
  ) {
    this.offsets = buildEeveeJitterOffsets(sampleCount, filterSize);
    this.sampleTarget.texture.colorSpace = THREE.NoColorSpace;
    this.accumulationTarget.texture.colorSpace = THREE.NoColorSpace;
    this.sampleTarget.texture.name = "EeveeTemporalCapture.sample";
    this.accumulationTarget.texture.name = "EeveeTemporalCapture.accumulation";
    this.copyMaterial = new THREE.ShaderMaterial({
      name: "EeveeTemporalCapture.add",
      uniforms: {
        tDiffuse: { value: this.sampleTarget.texture },
        opacity: { value: 1 / this.offsets.length },
      },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
    this.outputPass.renderToScreen = true;
    this.canvas.dataset.captureReady = "false";
    this.canvas.dataset.captureSamples = "0";
  }

  get samplesComplete(): number {
    return this.sampleIndex;
  }

  get ready(): boolean {
    return this.sampleIndex >= this.offsets.length;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.sampleTarget.setSize(nextWidth, nextHeight);
    this.accumulationTarget.setSize(nextWidth, nextHeight);
    this.reset();
  }

  reset(): void {
    this.sampleIndex = 0;
    this.canvas.dataset.captureReady = "false";
    this.canvas.dataset.captureSamples = "0";
    const target = this.renderer.getRenderTarget();
    this.renderer.getClearColor(this.clearColor);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.accumulationTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, false);
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(this.clearColor, alpha);
  }

  render(): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousToneMapping = this.renderer.toneMapping;
    this.renderer.getClearColor(this.clearColor);
    const previousAlpha = this.renderer.getClearAlpha();
    const originalView = this.camera.view ? { ...this.camera.view } : null;
    try {
      this.renderer.autoClear = false;
      if (!this.ready) {
        const [jitterX, jitterY] = this.offsets[this.sampleIndex];
        this.camera.setViewOffset(this.width, this.height, jitterX, jitterY, this.width, this.height);
        this.renderer.setRenderTarget(this.sampleTarget);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, true, false);
        this.renderer.render(this.scene, this.camera);
        this.camera.clearViewOffset();

        this.renderer.setRenderTarget(this.accumulationTarget);
        this.copyQuad.render(this.renderer);
        this.sampleIndex++;
        this.canvas.dataset.captureSamples = String(this.sampleIndex);
        if (this.ready) this.canvas.dataset.captureReady = "true";
      }

      if (this.ready) {
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setRenderTarget(null);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, true, false);
        this.outputPass.render(this.renderer, this.sampleTarget, this.accumulationTarget, 0, false);
      }
    } finally {
      if (originalView?.enabled) {
        this.camera.setViewOffset(
          originalView.fullWidth,
          originalView.fullHeight,
          originalView.offsetX,
          originalView.offsetY,
          originalView.width,
          originalView.height,
        );
      } else this.camera.clearViewOffset();
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.toneMapping = previousToneMapping;
      this.renderer.setClearColor(this.clearColor, previousAlpha);
    }
  }

  dispose(): void {
    this.sampleTarget.dispose();
    this.accumulationTarget.dispose();
    this.copyMaterial.dispose();
    this.copyQuad.dispose();
    this.outputPass.dispose();
  }
}
