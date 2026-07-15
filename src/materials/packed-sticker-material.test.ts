import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import { ensureStickerQuadUv, extractPackedStickerMaterialConfig } from "../packed-sticker-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;

test("maps only images actually packed in the supplied Chrome Asset blend", () => {
  assert.deepEqual(extractPackedStickerMaterialConfig(dump, "10pt spoke stickie"), {
    imageName: "sticky1@2x.png",
    url: "dojo/chrome-assets/textures/sticky1-2x.png",
    secondaryTextureCount: 0,
  });
  assert.equal(extractPackedStickerMaterialConfig(dump, "tree sticky"), null);
  assert.equal(extractPackedStickerMaterialConfig(dump, "ryu electrify1"), null);
  assert.equal(extractPackedStickerMaterialConfig(dump, "8pt soft star stickie")?.secondaryTextureCount, 1);
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
