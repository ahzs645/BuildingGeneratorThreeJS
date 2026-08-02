import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";

const optimizedAsset = fileURLToPath(new URL("../../public/assets/kit.glb", import.meta.url));

test("building kit excludes runtime-unused embedded textures", async () => {
  const [assetStat, document] = await Promise.all([
    stat(optimizedAsset),
    new NodeIO().read(optimizedAsset),
  ]);

  assert.ok(assetStat.size < 4_000_000, `expected kit.glb below 4 MB, got ${assetStat.size}`);
  assert.equal(document.getRoot().listTextures().length, 0);

  const nodeNames = new Set(document.getRoot().listNodes().map((node) => node.getName()));
  for (const marker of ["COL[lightsground][0]", "COL[lightsground][1]"]) {
    assert.ok(nodeNames.has(marker), `missing required generator marker: ${marker}`);
  }

  const materials = new Set(
    document.getRoot().listMaterials().map((material) => material.getName()),
  );
  for (const material of ["floor", "building", "glass"]) {
    assert.ok(materials.has(material), `missing required material: ${material}`);
  }
});
