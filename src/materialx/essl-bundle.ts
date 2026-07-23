import * as THREE from "three";
import {
  createMaterialXEsslMaterial,
  type EsslTextureBinding,
  type MaterialXEsslMaterialOptions,
  type ShaderRecord,
  validateMaterialXEsslShaderTextureManifest,
} from "./essl-adapter";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UNIFORM_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_COLOR_SPACES = new Set(["srgb_texture", "lin_rec709", "raw"]);
const UPLOAD_COLOR_SPACES = new Set(["none", "srgb"]);
const WRAPS = new Set(["repeat", "clamp", "mirror"]);
const MIN_FILTERS = new Set(["nearest", "linear", "linear-mipmap-linear"]);
const MAG_FILTERS = new Set(["nearest", "linear"]);
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

export type MaterialXTextureDecoder = (
  bytes: Uint8Array,
  binding: EsslTextureBinding,
  url: URL,
) => Promise<THREE.Texture>;

export type LoadMaterialXTexturesOptions = {
  baseUrl: string;
  shader: ShaderRecord;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  decodeTexture?: MaterialXTextureDecoder;
};

export type MaterialXTextureSet = {
  readonly uniforms: Readonly<Record<string, THREE.Texture>>;
  readonly textures: readonly THREE.Texture[];
  dispose(): void;
};

export type MaterialXEsslMaterialHandle = {
  readonly material: THREE.RawShaderMaterial;
  readonly textures: readonly THREE.Texture[];
  dispose(): void;
};

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MaterialX texture binding ${key} must be a non-empty string`);
  }
  return value;
}

function safeAssetPath(value: string): string {
  if (value !== value.trim() || value.includes("\\") || value.startsWith("/")
    || value.startsWith("//") || value.includes("?") || value.includes("#")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error(`MaterialX texture path must be a plain relative URL: ${value}`);
  }
  const segments = value.split("/");
  if (!segments.length || segments.some((segment) => {
    if (!segment) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  })) {
    throw new Error(`MaterialX texture path escapes or ambiguously addresses its bundle: ${value}`);
  }
  return segments.join("/");
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): T {
  const value = requireString(record, key);
  if (!allowed.has(value)) throw new Error(`Unsupported MaterialX texture ${key}: ${value}`);
  return value as T;
}

export function validateMaterialXTextureBindings(value: unknown): readonly EsslTextureBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("MaterialX textureBindings must be an array");
  const uniforms = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`MaterialX texture binding ${index} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const uniform = requireString(record, "uniform");
    if (!UNIFORM_PATTERN.test(uniform)) {
      throw new Error(`Invalid MaterialX texture uniform: ${uniform}`);
    }
    if (uniforms.has(uniform)) throw new Error(`Duplicate MaterialX texture uniform: ${uniform}`);
    uniforms.add(uniform);
    const sha256 = requireString(record, "sha256").toLowerCase();
    if (!HASH_PATTERN.test(sha256)) throw new Error(`Invalid SHA-256 for MaterialX texture ${uniform}`);
    const bytes = record.bytes;
    if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) {
      throw new Error(`MaterialX texture ${uniform} must declare a positive byte size`);
    }
    if (typeof record.flipY !== "boolean") {
      throw new Error(`MaterialX texture ${uniform} must declare flipY`);
    }
    return Object.freeze({
      uniform,
      path: safeAssetPath(requireString(record, "path")),
      sourceColorSpace: enumValue<EsslTextureBinding["sourceColorSpace"]>(
        record, "sourceColorSpace", SOURCE_COLOR_SPACES,
      ),
      uploadColorSpace: enumValue<EsslTextureBinding["uploadColorSpace"]>(
        record, "uploadColorSpace", UPLOAD_COLOR_SPACES,
      ),
      wrapS: enumValue<EsslTextureBinding["wrapS"]>(record, "wrapS", WRAPS),
      wrapT: enumValue<EsslTextureBinding["wrapT"]>(record, "wrapT", WRAPS),
      minFilter: enumValue<EsslTextureBinding["minFilter"]>(
        record, "minFilter", MIN_FILTERS,
      ),
      magFilter: enumValue<EsslTextureBinding["magFilter"]>(
        record, "magFilter", MAG_FILTERS,
      ),
      flipY: record.flipY,
      sha256,
      bytes: bytes as number,
      mimeType: enumValue<EsslTextureBinding["mimeType"]>(record, "mimeType", MIME_TYPES),
    });
  });
}

function absoluteBundleBase(baseUrl: string): URL {
  const documentBase = typeof location === "undefined" ? undefined : location.href;
  let base: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, documentBase);
  } catch {
    throw new Error(`MaterialX bundle base URL must be absolute outside a browser: ${baseUrl}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`Unsupported MaterialX bundle protocol: ${base.protocol}`);
  }
  return base;
}

export function resolveMaterialXTextureUrl(baseUrl: string, relativePath: string): URL {
  const path = safeAssetPath(relativePath);
  const base = absoluteBundleBase(baseUrl);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new Error(`MaterialX texture path escaped its bundle: ${relativePath}`);
  }
  return resolved;
}

function textureWrap(value: EsslTextureBinding["wrapS"]): THREE.Wrapping {
  if (value === "repeat") return THREE.RepeatWrapping;
  if (value === "mirror") return THREE.MirroredRepeatWrapping;
  return THREE.ClampToEdgeWrapping;
}

function minFilter(value: EsslTextureBinding["minFilter"]): THREE.MinificationTextureFilter {
  if (value === "nearest") return THREE.NearestFilter;
  if (value === "linear-mipmap-linear") return THREE.LinearMipmapLinearFilter;
  return THREE.LinearFilter;
}

function magFilter(value: EsslTextureBinding["magFilter"]): THREE.MagnificationTextureFilter {
  return value === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
}

export function applyMaterialXTextureContract(
  texture: THREE.Texture,
  binding: EsslTextureBinding,
): THREE.Texture {
  texture.name = `${binding.uniform} · ${binding.path}`;
  // Official generated ESSL can perform the source-space transform itself.
  // This independent upload contract prevents an accidental double sRGB decode.
  texture.colorSpace = binding.uploadColorSpace === "srgb"
    ? THREE.SRGBColorSpace
    : THREE.NoColorSpace;
  texture.wrapS = textureWrap(binding.wrapS);
  texture.wrapT = textureWrap(binding.wrapT);
  texture.minFilter = minFilter(binding.minFilter);
  texture.magFilter = magFilter(binding.magFilter);
  texture.generateMipmaps = binding.minFilter === "linear-mipmap-linear";
  texture.flipY = binding.flipY;
  texture.needsUpdate = true;
  return texture;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to verify MaterialX texture assets");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyMaterialXTexturePayload(
  bytes: Uint8Array,
  binding: EsslTextureBinding,
): Promise<void> {
  if (bytes.byteLength !== binding.bytes) {
    throw new Error(
      `MaterialX texture ${binding.uniform} byte size mismatch: expected ${binding.bytes}, received ${bytes.byteLength}`,
    );
  }
  const actual = await sha256(bytes);
  if (actual !== binding.sha256) {
    throw new Error(`MaterialX texture ${binding.uniform} SHA-256 mismatch`);
  }
}

async function decodeBrowserTexture(
  bytes: Uint8Array,
  binding: EsslTextureBinding,
): Promise<THREE.Texture> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap is required to decode MaterialX textures");
  }
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const bitmap = await createImageBitmap(new Blob([body], { type: binding.mimeType }), {
    colorSpaceConversion: "none",
  });
  const texture = new THREE.Texture(bitmap);
  texture.addEventListener("dispose", () => bitmap.close());
  return texture;
}

export async function loadMaterialXTextures(
  options: LoadMaterialXTexturesOptions,
): Promise<MaterialXTextureSet> {
  const bindings = validateMaterialXTextureBindings(options.shader.textureBindings);
  const fetchImpl = options.fetchImpl ?? fetch;
  const decodeTexture = options.decodeTexture ?? decodeBrowserTexture;
  const uniforms: Record<string, THREE.Texture> = {};
  const textures: THREE.Texture[] = [];
  let disposed = false;
  try {
    for (const binding of bindings) {
      options.signal?.throwIfAborted();
      const url = resolveMaterialXTextureUrl(options.baseUrl, binding.path);
      const response = await fetchImpl(url, { signal: options.signal });
      if (!response.ok) {
        throw new Error(`MaterialX texture fetch failed for ${binding.path}: ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      options.signal?.throwIfAborted();
      await verifyMaterialXTexturePayload(bytes, binding);
      options.signal?.throwIfAborted();
      const texture = applyMaterialXTextureContract(
        await decodeTexture(bytes, binding, url),
        binding,
      );
      if (options.signal?.aborted) {
        texture.dispose();
        options.signal.throwIfAborted();
      }
      uniforms[binding.uniform] = texture;
      textures.push(texture);
    }
  } catch (error) {
    for (const texture of textures) texture.dispose();
    throw error;
  }
  return Object.freeze({
    uniforms: Object.freeze({ ...uniforms }),
    textures: Object.freeze([...textures]),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const texture of textures) texture.dispose();
    },
  });
}

export async function createMaterialXEsslBundleMaterial(
  options: MaterialXEsslMaterialOptions & Omit<LoadMaterialXTexturesOptions, "baseUrl" | "shader">,
): Promise<MaterialXEsslMaterialHandle> {
  const shader = options.manifest.shaders[options.shaderName];
  if (!shader) throw new Error(`Generated MaterialX shader is missing ${options.shaderName}`);
  validateMaterialXEsslShaderTextureManifest(options.manifest, options.shaderName);
  const textureSet = await loadMaterialXTextures({
    baseUrl: options.baseUrl,
    shader,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    decodeTexture: options.decodeTexture,
  });
  try {
    const material = await createMaterialXEsslMaterial({
      ...options,
      textures: textureSet.uniforms,
    });
    let disposed = false;
    return Object.freeze({
      material,
      textures: textureSet.textures,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        material.dispose();
        textureSet.dispose();
      },
    });
  } catch (error) {
    textureSet.dispose();
    throw error;
  }
}
