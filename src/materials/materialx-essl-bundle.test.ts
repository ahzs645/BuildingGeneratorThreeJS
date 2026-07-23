import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { auditMaterialXDocument } from "../materialx/capabilities";
import {
  MATERIALX_ESSL_TEXTURE_SCHEMA_VERSION,
  type EsslManifest,
  type EsslTextureBinding,
  type ShaderRecord,
  validateMaterialXEsslShaderTextureManifest,
} from "../materialx/essl-adapter";
import {
  applyMaterialXTextureContract,
  loadMaterialXTextures,
  resolveMaterialXTextureUrl,
  validateMaterialXTextureBindings,
  verifyMaterialXTexturePayload,
} from "../materialx/essl-bundle";

const payload = new TextEncoder().encode("repo-authored synthetic texture");
const binding: EsslTextureBinding = {
  uniform: "synthetic_mask_file",
  path: "textures/synthetic-checker.png",
  sourceColorSpace: "srgb_texture",
  uploadColorSpace: "none",
  wrapS: "repeat",
  wrapT: "clamp",
  minFilter: "linear-mipmap-linear",
  magFilter: "linear",
  flipY: true,
  sha256: "68e4b37c1de4c6ea005bf3ffe4397898f0db9e6558c151e6049557a3fc3d4299",
  bytes: payload.byteLength,
  mimeType: "image/png",
};

const shader = {
  vertex: "synthetic.vert",
  fragment: "synthetic.frag",
  vertexInterface: { inputs: {} },
  fragmentInterface: {
    uniforms: {
      PublicUniforms: [{
        name: binding.uniform,
        type: "filename",
        value: `./${binding.path}`,
      }],
    },
  },
  textureBindings: [binding],
} satisfies ShaderRecord;

function manifestFor(
  record: ShaderRecord,
  schemaVersion?: number,
): EsslManifest {
  return {
    schemaVersion,
    generator: {
      materialx: "synthetic-test",
      specularEnvironment: "FIS",
      radianceSamples: 16,
      maxLights: 1,
      lightTypeId: 1,
    },
    licenses: {
      materialx: "synthetic-test",
      thirdPartyNotices: "synthetic-test",
    },
    shaders: { synthetic: record },
  };
}

test("repo-authored direct conductor fixture is accepted only by official ESSL", () => {
  const xml = fs.readFileSync(
    new URL("./fixtures/materialx-direct-conductor.mtlx", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    auditMaterialXDocument(xml, { implementation: "official-essl" }).unsupportedElements,
    [],
  );
  assert.deepEqual(
    auditMaterialXDocument(xml, { implementation: "three-tsl" }).unsupportedElements,
    ["conductor_bsdf", "surface"],
  );
  assert.match(xml, /colorspace="srgb_texture"/);
  assert.match(xml, /<mix name="layered_metal" type="BSDF">/);
});

test("texture binding validation rejects traversal, ambiguous URLs, duplicates, and incomplete color contracts", () => {
  assert.deepEqual(validateMaterialXTextureBindings([binding]), [binding]);
  for (const path of [
    "../secret.png",
    "textures/../secret.png",
    "textures/%2e%2e/secret.png",
    "/absolute.png",
    "https://example.com/remote.png",
    "textures\\secret.png",
    "textures/mask.png?version=1",
  ]) {
    assert.throws(
      () => validateMaterialXTextureBindings([{ ...binding, path }]),
      /relative URL|escapes|ambiguously/,
      path,
    );
  }
  assert.throws(
    () => validateMaterialXTextureBindings([binding, binding]),
    /Duplicate MaterialX texture uniform/,
  );
  assert.throws(
    () => validateMaterialXTextureBindings([{ ...binding, uploadColorSpace: undefined }]),
    /uploadColorSpace/,
  );
  assert.throws(
    () => validateMaterialXTextureBindings([{ ...binding, sha256: "abc" }]),
    /Invalid SHA-256/,
  );
});

test("texture manifests require schema v2 and a one-to-one filename uniform binding", () => {
  assert.throws(
    () => validateMaterialXEsslShaderTextureManifest(manifestFor(shader), "synthetic"),
    /schemaVersion 2/,
  );
  assert.deepEqual(
    validateMaterialXEsslShaderTextureManifest(
      manifestFor(shader, MATERIALX_ESSL_TEXTURE_SCHEMA_VERSION),
      "synthetic",
    ),
    [binding],
  );
  assert.throws(
    () => validateMaterialXEsslShaderTextureManifest(
      manifestFor({ ...shader, textureBindings: undefined }),
      "synthetic",
    ),
    /lacks a validated texture binding/,
  );
  assert.throws(
    () => validateMaterialXEsslShaderTextureManifest(
      manifestFor({
        ...shader,
        textureBindings: [
          binding,
          { ...binding, uniform: "not_a_filename_uniform" },
        ],
      }, MATERIALX_ESSL_TEXTURE_SCHEMA_VERSION),
      "synthetic",
    ),
    /does not name a filename uniform/,
  );
});

test("bundle-relative texture resolution remains confined to its HTTP origin and path", () => {
  assert.equal(
    resolveMaterialXTextureUrl(
      "https://assets.example/materialx/metal/",
      "textures/mask.png",
    ).href,
    "https://assets.example/materialx/metal/textures/mask.png",
  );
  assert.throws(
    () => resolveMaterialXTextureUrl("file:///tmp/materialx/", "textures/mask.png"),
    /Unsupported MaterialX bundle protocol/,
  );
});

test("payload verification checks both declared bytes and SHA-256", async () => {
  await verifyMaterialXTexturePayload(payload, binding);
  await assert.rejects(
    verifyMaterialXTexturePayload(payload.subarray(1), binding),
    /byte size mismatch/,
  );
  await assert.rejects(
    verifyMaterialXTexturePayload(payload, { ...binding, sha256: "0".repeat(64) }),
    /SHA-256 mismatch/,
  );
});

test("texture contract keeps source color transform separate from GPU upload color space", () => {
  const texture = applyMaterialXTextureContract(new THREE.Texture(), binding);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.flipY, true);
  texture.dispose();

  const hardwareSrgb = applyMaterialXTextureContract(
    new THREE.Texture(),
    { ...binding, uploadColorSpace: "srgb" },
  );
  assert.equal(hardwareSrgb.colorSpace, THREE.SRGBColorSpace);
  hardwareSrgb.dispose();
});

test("texture loading binds verified assets and disposes each decoded texture exactly once", async () => {
  const decoded: THREE.Texture[] = [];
  let disposeCount = 0;
  const result = await loadMaterialXTextures({
    baseUrl: "https://assets.example/materialx/synthetic/",
    shader,
    fetchImpl: async () => new Response(payload, { status: 200 }),
    decodeTexture: async () => {
      const texture = new THREE.Texture();
      texture.addEventListener("dispose", () => { disposeCount += 1; });
      decoded.push(texture);
      return texture;
    },
  });
  assert.equal(result.uniforms.synthetic_mask_file, decoded[0]);
  assert.deepEqual(result.textures, decoded);
  result.dispose();
  result.dispose();
  assert.equal(disposeCount, 1);
});

test("partial texture loads are disposed when a later verified asset fails", async () => {
  const first = { ...binding, uniform: "first_file" };
  const second = { ...binding, uniform: "second_file", path: "textures/second.png" };
  let requests = 0;
  let disposeCount = 0;
  await assert.rejects(
    loadMaterialXTextures({
      baseUrl: "https://assets.example/materialx/synthetic/",
      shader: { ...shader, textureBindings: [first, second] },
      fetchImpl: async () => {
        requests += 1;
        return new Response(requests === 1 ? payload : payload.subarray(1), { status: 200 });
      },
      decodeTexture: async () => {
        const texture = new THREE.Texture();
        texture.addEventListener("dispose", () => { disposeCount += 1; });
        return texture;
      },
    }),
    /byte size mismatch/,
  );
  assert.equal(disposeCount, 1);
});

test("an abort after decode disposes the unbound texture and stops the bundle load", async () => {
  const controller = new AbortController();
  let disposeCount = 0;
  await assert.rejects(
    loadMaterialXTextures({
      baseUrl: "https://assets.example/materialx/synthetic/",
      shader,
      signal: controller.signal,
      fetchImpl: async () => new Response(payload, { status: 200 }),
      decodeTexture: async () => {
        const texture = new THREE.Texture();
        texture.addEventListener("dispose", () => { disposeCount += 1; });
        controller.abort();
        return texture;
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(disposeCount, 1);
});
