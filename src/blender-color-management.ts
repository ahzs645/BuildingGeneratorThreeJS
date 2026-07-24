import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export const BLENDER_COLOR_PROFILES = [
  "standard-medium-high-contrast",
] as const;

export type BlenderColorProfileName = typeof BLENDER_COLOR_PROFILES[number];

export interface BlenderColorProfileLut {
  schemaVersion: 1;
  profile: BlenderColorProfileName;
  sourceColorSpace: "Linear Rec.709";
  display: "sRGB";
  viewTransform: "Standard";
  look: "Medium High Contrast";
  domain: [number, number];
  outputEncoding: "linear-sRGB-display";
  interpolation: "linear";
  size: number;
  configSha256: string;
  maxNeutralCrossChannelError: number;
  values: number[];
}

export function validateBlenderColorProfileLut(value: unknown): BlenderColorProfileLut {
  const lut = value as Partial<BlenderColorProfileLut>;
  if (
    lut?.schemaVersion !== 1
    || lut.profile !== "standard-medium-high-contrast"
    || lut.sourceColorSpace !== "Linear Rec.709"
    || lut.display !== "sRGB"
    || lut.viewTransform !== "Standard"
    || lut.look !== "Medium High Contrast"
    || lut.outputEncoding !== "linear-sRGB-display"
    || lut.interpolation !== "linear"
    || !Array.isArray(lut.domain)
    || lut.domain.length !== 2
    || lut.domain[0] !== 0
    || lut.domain[1] !== 1
    || !Number.isInteger(lut.size)
    || (lut.size ?? 0) < 2
    || !Array.isArray(lut.values)
    || lut.values.length !== lut.size
    || lut.values.some((sample) => !Number.isFinite(sample))
    || typeof lut.configSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(lut.configSha256)
  ) {
    throw new Error("Invalid Blender color-profile LUT");
  }
  return lut as BlenderColorProfileLut;
}

export function sampleBlenderColorProfile(lut: BlenderColorProfileLut, linearValue: number): number {
  const [minimum, maximum] = lut.domain;
  const normalized = Math.max(0, Math.min(1, (linearValue - minimum) / (maximum - minimum)));
  const scaled = normalized * (lut.size - 1);
  const index = Math.min(Math.floor(scaled), lut.size - 1);
  const next = Math.min(index + 1, lut.size - 1);
  const factor = scaled - index;
  return lut.values[index] + (lut.values[next] - lut.values[index]) * factor;
}

export interface BlenderColorProfilePass {
  pass: ShaderPass;
  dispose(): void;
}

/**
 * Applies Blender's display look in linear display space. WebGLRenderer's
 * output stage performs the final sRGB transfer after this pass.
 */
export function createBlenderColorProfilePass(lutValue: unknown): BlenderColorProfilePass {
  const lut = validateBlenderColorProfileLut(lutValue);
  const data = new Float32Array(lut.size * 4);
  for (let index = 0; index < lut.size; index++) {
    const sample = lut.values[index];
    data[index * 4] = sample;
    data[index * 4 + 1] = sample;
    data[index * 4 + 2] = sample;
    data[index * 4 + 3] = 1;
  }
  const texture = new THREE.DataTexture(data, lut.size, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.name = `Blender color profile: ${lut.profile}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const pass = new ShaderPass({
    name: "BlenderColorProfile",
    uniforms: {
      tDiffuse: { value: null },
      profileLut: { value: texture },
      profileLutSize: { value: lut.size },
      profileDomain: { value: new THREE.Vector2(lut.domain[0], lut.domain[1]) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D profileLut;
      uniform float profileLutSize;
      uniform vec2 profileDomain;
      varying vec2 vUv;

      float applyProfile(float value) {
        float normalized = clamp(
          (value - profileDomain.x) / (profileDomain.y - profileDomain.x),
          0.0,
          1.0
        );
        float halfPixel = 0.5 / profileLutSize;
        float u = halfPixel + normalized * (1.0 - 2.0 * halfPixel);
        return texture2D(profileLut, vec2(u, 0.5)).r;
      }

      void main() {
        vec4 source = texture2D(tDiffuse, vUv);
        gl_FragColor = vec4(
          applyProfile(source.r),
          applyProfile(source.g),
          applyProfile(source.b),
          source.a
        );
      }
    `,
  });
  pass.material.toneMapped = false;
  return {
    pass,
    dispose() {
      pass.dispose();
      texture.dispose();
    },
  };
}
