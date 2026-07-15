import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import { extractToonCyclesMaterialConfig, makeToonCyclesMaterial } from "../toon-cycles-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/math-clay/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump & { shader_node_groups: Record<string, any> };

test("recognizes the extracted toon group by graph topology", () => {
  const config = extractToonCyclesMaterialConfig(dump, "toon cycles shader");
  assert.ok(config);
  assert.deepEqual(config.rotation, [-2.923426389694214, -0.3822270631790161, 0]);
  assert.deepEqual(config.referenceNormal, [0, 0, 1]);
  assert.equal(config.multiplier, 6.110000133514404);
  assert.equal(config.strength, 2);
  assert.deepEqual(config.ramp.map(({ position }) => position), [0, 0.04629630222916603, 0.4768518805503845, 0.9490739703178406]);
});

test("does not depend on the material datablock name", () => {
  const alias = "renamed portable toon material";
  const renamed = {
    ...dump,
    materials: { ...dump.materials, [alias]: dump.materials?.["toon cycles shader"] },
  } as Dump;
  assert.ok(extractToonCyclesMaterialConfig(renamed, alias));
  assert.equal(extractToonCyclesMaterialConfig(dump, "visuals"), null);
});

test("rejects a changed group contract", () => {
  const changed = structuredClone(dump);
  const ramp = changed.shader_node_groups["_Toon Cycles ShaderA"].nodes.find((node: any) => node.type === "ShaderNodeValToRGB");
  ramp.props.color_ramp.interpolation = "LINEAR";
  assert.equal(extractToonCyclesMaterialConfig(changed, "toon cycles shader"), null);
});

test("builds an unlit normal-band raster shader with an explicit approximation label", () => {
  const material = makeToonCyclesMaterial(dump, "toon cycles shader");
  assert.ok(material?.isShaderMaterial);
  assert.match(material?.name ?? "", /Cycles normal-band background raster reconstruction/);
  assert.match(material?.fragmentShader ?? "", /mappedNormal/);
  assert.match(material?.fragmentShader ?? "", /6\.110000133514404/);
  assert.equal(material?.userData.toonCyclesContract.ramp.length, 4);
  material?.dispose();
});
