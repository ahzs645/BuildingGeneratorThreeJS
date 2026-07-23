import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import { ensureStickerQuadUv, extractPackedStickerMaterialConfig, makePackedStickerMaterial } from "../packed-sticker-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;

test("maps packed images and records Blender's missing image state", () => {
  assert.deepEqual(extractPackedStickerMaterialConfig(dump, "10pt spoke stickie"), {
    imageName: "sticky1@2x.png",
    url: "dojo/chrome-assets/textures/sticky1-2x.png",
    shader: "spoke-control",
    secondaryTextureCount: 0,
  });
  assert.deepEqual(extractPackedStickerMaterialConfig(dump, "tree sticky"), {
    imageName: "tree sticky.png",
    shader: "missing-image",
    secondaryTextureCount: 0,
    sourceMissing: true,
  });
  assert.deepEqual(extractPackedStickerMaterialConfig(dump, "ryu electrify1"), {
    imageName: "ryu electrify1.png",
    shader: "missing-image",
    secondaryTextureCount: 0,
    sourceMissing: true,
  });
  assert.deepEqual(extractPackedStickerMaterialConfig(dump, "8pt soft star stickie"), {
    imageName: "stickie2.png",
    url: "dojo/chrome-assets/textures/stickie2.png",
    shader: "soft-star-wear",
    secondaryImageName: "sticker texture.png",
    secondaryUrl: "dojo/chrome-assets/textures/sticker-texture.png",
    secondaryTextureCount: 1,
  });
});

test("matches Blender's magenta diagnostic for images missing from the supplied blend", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0,0,0, 2,0,0, 0,3,0, 2,3,0,
  ], 3));
  geometry.setIndex([0,1,3, 0,3,2]);

  const material = makePackedStickerMaterial(dump, geometry, { start: 0, count: 6 }, "tree sticky");
  assert.ok(material);
  assert.equal(material.color.getHex(), 0xff00ff);
  assert.equal(material.toneMapped, false);
  assert.equal(material.userData.packedStickerContract.sourceMissing, true);
  assert.match(material.userData.sourceDiagnostic, /supplied Blender file/);
  material.dispose();
  geometry.dispose();
});

test("restores Blender quad UV corner order from two soup triangles", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0,0,0, 2,0,0, 0,3,0, 2,3,0,
  ], 3));
  geometry.setIndex([0,1,3, 0,3,2]);
  assert.equal(ensureStickerQuadUv(geometry, { start: 0, count: 6 }), true);
  assert.deepEqual(Array.from(geometry.getAttribute("uv").array), [0,0, 1,0, 0,1, 1,1]);
  geometry.dispose();
});

test("reconstructs the spoke tint and soft-star wear shader branches", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0,0,0, 2,0,0, 0,3,0, 2,3,0,
  ], 3));
  geometry.setAttribute("col", new THREE.Float32BufferAttribute([
    0.4,0.8,0, 0.4,0.8,0, 0.4,0.8,0, 0.4,0.8,0,
  ], 3));
  geometry.setIndex([0,1,3, 0,3,2]);

  try {
    for (const [name, expected] of [
      ["10pt spoke stickie", /0\.7042236328125/],
      ["8pt soft star stickie", /packedStickerSecondaryMap/],
    ] as const) {
      const material = makePackedStickerMaterial(dump, geometry, { start: 0, count: 6 }, name);
      assert.ok(material);
      const shader = {
        vertexShader: "#include <common>\n#include <begin_vertex>",
        fragmentShader: "#include <common>\n#include <map_fragment>",
        uniforms: {} as Record<string, unknown>,
      };
      material.onBeforeCompile(shader as never, {} as never);
      assert.match(shader.vertexShader, /attribute vec3 col/);
      assert.match(shader.vertexShader, /vPackedStickerCol = col/);
      assert.match(shader.fragmentShader, expected);
      assert.doesNotMatch(shader.fragmentShader, /#include <map_fragment>/);
      material.dispose();
    }
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
  geometry.dispose();
});
