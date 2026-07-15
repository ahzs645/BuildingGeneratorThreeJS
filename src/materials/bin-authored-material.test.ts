import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  binAuthoredHeight,
  extractBinAuthoredMaterialConfig,
  makeBinAuthoredMaterial,
} from "../bin-authored-material";
import type { Dump } from "../gnvm";

const dump = JSON.parse(readFileSync("public/dojo/dump_bin.json", "utf8")) as Dump;
const evidence = JSON.parse(readFileSync("public/dojo/bin-material-parity.json", "utf8")) as {
  scalarProbes: { object: number[]; generated: number[]; blender: number }[];
};

test("strictly extracts both authored bin Wave/Noise/Bump graphs", () => {
  const blue = extractBinAuthoredMaterialConfig(dump, "3D");
  const red = extractBinAuthoredMaterialConfig(dump, "3D.004");
  assert.ok(blue);
  assert.ok(red);
  assert.deepEqual(blue, {
    baseColor: [0, 0.030982598662376404, 1],
    metallic: 0,
    roughness: 0.5,
    ior: 1.4500000476837158,
    objectMappingRotation: [0, 1.5707963705062866, 0],
    waveScale: 236.75997924804688,
    waveDistortion: 0.05000000447034836,
    waveDetail: 4.699999809265137,
    waveDetailScale: 1,
    waveDetailRoughness: 0.5,
    wavePhaseOffset: 3.1999998092651367,
    noiseScale: 2000,
    noiseDetail: 2,
    noiseRoughness: 0.5,
    noiseLacunarity: 2,
    mixFactor: 0.9431818127632141,
    bumpStrength: 0.3588068187236786,
    bumpDistance: 1.0700000524520874,
    bumpFilterWidth: 1,
    bumpInvert: false,
  });
  assert.deepEqual(red, { ...blue, baseColor: [1, 0, 0.002402153331786394] });

  const changed = structuredClone(dump);
  const wave = (changed.materials?.["3D"] as { nodes: { name: string; inputs: { identifier: string; value: unknown }[] }[] })
    .nodes.find((node) => node.name === "Wave Texture");
  const scale = wave?.inputs.find((input) => input.identifier === "Scale");
  assert.ok(scale);
  scale.value = 236.76;
  assert.equal(extractBinAuthoredMaterialConfig(changed, "3D"), null);

  const changedPrincipled = structuredClone(dump);
  const principled = (changedPrincipled.materials?.["3D"] as { nodes: { name: string; inputs: { identifier: string; value: unknown }[] }[] })
    .nodes.find((node) => node.name === "Principled BSDF");
  const emissionStrength = principled?.inputs.find((candidate) => candidate.identifier === "Emission Strength");
  assert.ok(emissionStrength);
  emissionStrength.value = 1;
  assert.equal(extractBinAuthoredMaterialConfig(changedPrincipled, "3D"), null);
});

test("matches direct Blender scalar fixtures within the disclosed clean-room noise tolerance", () => {
  const config = extractBinAuthoredMaterialConfig(dump, "3D");
  assert.ok(config);
  const errors = evidence.scalarProbes.map((probe) =>
    Math.abs(binAuthoredHeight(probe.object, probe.generated, config) - probe.blender));
  assert.ok(Math.max(...errors) <= 0.006, `maximum scalar error ${Math.max(...errors)}`);
  assert.ok(errors.reduce((sum, value) => sum + value, 0) / errors.length <= 0.003, `mean scalar error ${errors}`);
});

test("injects the extracted coordinate branches and shared derivative Bump core", () => {
  const bounds = {
    min: [-0.6876335740089417, -0.05000000074505806, -0.255499929189682] as [number, number, number],
    max: [0.3789999783039093, 0.06300000846385956, 0.35800960659980774] as [number, number, number],
  };
  const material = makeBinAuthoredMaterial(dump, bounds, "3D");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "3D");
  assert.equal(material?.userData.authoredLabel, "3D · authored bin Wave/Noise reconstruction");
  assert.deepEqual(material?.userData.binGeneratedBounds, bounds);
  assert.match(material?.userData.rendererApproximation, /Three\.js PBR lighting plus WebGL derivatives/);
  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <normal_fragment_maps>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /vBinObjectPosition = position/);
  assert.match(shader.fragmentShader, /generated = \(objectCoordinate - vec3\(-0\.6876335740089417/);
  assert.match(shader.fragmentShader, /mapped\.x \* 236\.75997924804688 \* 20\.0/);
  assert.match(shader.fragmentShader, /\+ 3\.1999998092651367/);
  assert.match(shader.fragmentShader, /generated \* 2000\.0/);
  assert.match(shader.fragmentShader, /mix\(noise, wave, 0\.9431818127632141\)/);
  assert.match(shader.fragmentShader, /binDistance = 1\.0700000524520874/);
  assert.match(shader.fragmentShader, /binPerturbed/);
  assert.doesNotMatch(shader.fragmentShader, /binHash\(vec3|6\.2831853/);
  material?.dispose();

  const red = makeBinAuthoredMaterial(dump, bounds, "3D.004");
  assert.equal(red?.name, "3D.004");
  assert.equal(red?.userData.authoredLabel, "3D.004 · authored bin Wave/Noise reconstruction");
  red?.dispose();
});
