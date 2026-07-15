import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import { extractToonOutlineMaterialConfig, makeToonOutlineMaterial } from "../toon-outline-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;

test("recognizes the Pipe Icon front-emission/back-transparency graph", () => {
  assert.deepEqual(extractToonOutlineMaterialConfig(dump, "toon outline.001"), {
    color: [1, 1, 1],
    strength: 1,
  });
  assert.equal(extractToonOutlineMaterialConfig(dump, "flat.nodes"), null);
});

test("maps transparent backfaces to equivalent raster culling", () => {
  const material = makeToonOutlineMaterial(dump, "toon outline.001");
  assert.ok(material?.isMeshBasicMaterial);
  assert.equal(material?.side, THREE.FrontSide);
  assert.equal(material?.toneMapped, false);
  assert.equal(material?.color.getHex(), 0xffffff);
  material?.dispose();
});
