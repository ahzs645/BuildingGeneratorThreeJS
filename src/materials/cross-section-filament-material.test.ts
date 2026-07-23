import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  extractBdsfCrossSectionConfig,
  extractCrossSectionFilamentConfig,
  makeCrossSectionFilamentMaterial,
  mathClayFilamentFieldAtGenerated,
} from "../cross-section-filament-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/three-way-pipe/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const mathDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/math-clay/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const materialName = "Filament and Cross Section 1OCT2024";

test("reconstructs the joint library's evaluated filament fields", async () => {
  assert.deepEqual(extractCrossSectionFilamentConfig(dump, materialName), {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    roughnessFallback: 0.5,
    layerAttribute: "layer",
    blackBackfaceEmission: true,
    mappingScale: 85.09765625,
    waveDistortion: 0.8557739853858948,
    bumpMin: 0.98974609375,
    bumpMax: 1.126708984375,
    mathClay: null,
  });
  const result = await runGenerator(dump, { object: "old pipe" });
  assert.deepEqual(result.soup.stats, { verts: 48708, faces: 48318, tris: 97008 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 291024, material: materialName }]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  const material = makeCrossSectionFilamentMaterial(dump, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${materialName} · joint filament reconstruction`);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.fragmentShader, /gl_FrontFacing\?max\(vJointColor/);
  assert.match(shader.fragmentShader, /if\(!gl_FrontFacing\)outgoingLight=vec3\(0\.0\)/);
  assert.match(shader.fragmentShader, /vJointRoughness/);
  assert.doesNotMatch(shader.fragmentShader, /jointBand|mix\(0\.94,1\.04/);
  material?.dispose();
  geometry.dispose();
});

test("uses a constant roughness fallback when a variant omits the rough field", () => {
  const source = dump.materials?.[materialName] as any;
  const roughNode = source.nodes.find((node: any) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === "rough");
  const variant = {
    node_groups: {},
    materials: {
      [materialName]: {
        nodes: source.nodes.filter((node: any) => node !== roughNode),
        links: source.links.filter((link: any) => link.from_node !== roughNode.name),
      },
    },
  } as Dump;
  assert.equal(extractCrossSectionFilamentConfig(variant, materialName)?.roughnessAttribute, null);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 1], 3));
  geometry.setAttribute("col", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  geometry.setAttribute("layer", new THREE.Float32BufferAttribute([1.2, 1.2, 1.2], 1));
  const material = makeCrossSectionFilamentMaterial(variant, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.doesNotMatch(shader.vertexShader, /attribute float rough/);
  assert.match(shader.vertexShader, /vJointRoughness=0.5/);
  material?.dispose();
  geometry.dispose();
});

test("reconstructs Math Clay's authored procedural filament and emission branches", async () => {
  const config = extractCrossSectionFilamentConfig(mathDump, materialName);
  assert.ok(config);
  assert.equal(config?.blackBackfaceEmission, true);
  assert.equal(config?.roughnessAttribute, null);
  assert.equal(config?.roughnessFallback, 0.5);
  assert.deepEqual(config.mathClay, {
    fieldMix: 0.8409091234207153,
    waveDetail: 2,
    waveDetailScale: 1,
    waveDetailRoughness: 0.5,
    height: { min: 0.98974609375, max: 1.126708984375 },
    roughness: { min: 1, max: 0.50048828125 },
    coatWeight: { min: -2.08837890625, max: 1.2119140625 },
    coatRoughness: { min: 0.7176513671875, max: 0.10000000149011612 },
    coatIor: 1.5900001525878906,
    bumpStrength: 1,
    bumpDistance: 1,
    bumpFilterWidth: 1,
    bumpInvert: false,
    backHue: 0.5,
    backSaturation: 0.6000000238418579,
    backValue: 0.12800000607967377,
    backWaveScale: 51.1998291015625,
    backWaveThreshold: 0.05000000074505806,
    bevelRadius: 0.5,
  });

  const probes: [number[], Partial<NonNullable<ReturnType<typeof mathClayFilamentFieldAtGenerated>>>][] = [
    [[0, 0, 0], { wave: 7.326261819429192e-11, scalar: 0.042315022404744766, height: 0.9955416815354154, roughness: 0.9788631504296612 }],
    [[0.125, 0.25, 0.5], { wave: 0.9960023196401636, scalar: 0.8716690291154361, height: 1.1091324036459373, roughness: 0.5645911050854047 }],
    [[0.5, 0.5, 0.5], { wave: 0.9994997513842865, scalar: 0.8877780442469236, coatWeight: 0.8415487309887486, coatRoughness: 0.16931404572223507 }],
    [[0.91, 0.37, 0.73], { wave: 0.43431451569488705, scalar: 0.42385004253384645, coatWeight: -0.6895495910711582, coatRoughness: 0.4558598095655755 }],
  ];
  for (const [generated, expected] of probes) {
    const actual = mathClayFilamentFieldAtGenerated(generated, 1.2000000476837158, config);
    assert.ok(actual);
    for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs(actual[key as keyof typeof actual] as number - value) < 1e-12, `${key} at ${generated}`);
  }

  const result = await runGenerator(mathDump, { object: "Math Clay Study.002" });
  assert.deepEqual(result.soup.stats, { verts: 30644, faces: 30642, tris: 61284 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 183852, material: materialName }]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  const material = makeCrossSectionFilamentMaterial(mathDump, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material.clearcoat, 1);
  const generatedBounds = material.userData.crossSectionFilamentBounds;
  assert.deepEqual(generatedBounds, {
    min: [-34.03980255126953, -33.590858459472656, -32.332298278808594],
    max: [34.8473014831543, 34.40513610839844, 33.36033248901367],
  });
  // Blender's frozen evaluated maximum is 33.36033630371094. Face-center
  // accumulation can land on either adjacent float32 value, so keep the
  // deterministic web snapshot while explicitly gating its Blender distance.
  assert.ok(Math.abs(generatedBounds.max[2] - 33.36033630371094) <= 4e-6);
  const shader = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\nvoid main() {\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <opaque_fragment>\n}" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb=gl_FrontFacing\?max\(vJointColor,vec3\(0\.0\)\):vec3\(0\.0\)/);
  assert.match(shader.fragmentShader, /mathFilamentWhiteNoise3/);
  assert.match(shader.fragmentShader, /generated\*85\.09765625/);
  assert.match(shader.fragmentShader, /mix\(white,vec3\(wave\),0\.8409091234207153\)/);
  assert.match(shader.fragmentShader, /mathFilamentHeight/);
  assert.match(shader.fragmentShader, /dFdx\(vMathFilamentGenerated\)/);
  assert.match(shader.fragmentShader, /roughnessFactor=clamp\(mix\(1\.0,0\.50048828125,mathFilamentField/);
  assert.match(shader.fragmentShader, /material\.clearcoat = clamp\(mix\(-2\.08837890625,1\.2119140625/);
  assert.match(shader.fragmentShader, /material\.clearcoatF0 = vec3\( pow2\( \(1\.5900001525878906 - 1\.0\) \/ \(1\.5900001525878906 \+ 1\.0\) \) \)/);
  assert.match(shader.fragmentShader, /outgoingLight=mathFilamentBackColor\(vJointColor\)/);
  assert.match(shader.fragmentShader, /gl_FragCoord\.xy\/max\(mathFilamentViewport/);
  assert.doesNotMatch(shader.fragmentShader, /jointBand|if\(!gl_FrontFacing\)outgoingLight=vec3\(0\.0\)/);

  const physicalShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material?.onBeforeCompile(physicalShader as never, {} as never);
  assert.equal((physicalShader.fragmentShader.match(/outgoingLight=mathFilamentBackColor\(vJointColor\)/g) ?? []).length, 1);
  assert.match(physicalShader.fragmentShader, /outgoingLight=mathFilamentBackColor\(vJointColor\);\n#include <opaque_fragment>/);
  material?.dispose();
  geometry.dispose();
});

test("reconstructs the D-surface BDSF front color and patterned backface branch", async () => {
  const bdsfName = "BDSF_Cross Section 1OCT2024.001";
  assert.deepEqual(extractBdsfCrossSectionConfig(mathDump, bdsfName), {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    alphaAttribute: "alpha",
    textureAttribute: "texture",
    bumpStrengthAttribute: "strength",
    bumpDistanceAttribute: "distance",
    rayAttribute: "ray",
    positionAttribute: "pos",
    directionAttribute: "dir",
    backSaturation: 0.48399975895881653,
    backValue: 0.5040002465248108,
    backWaveScale: 51.1998291015625,
    backWaveDistortion: 0.8557739853858948,
    backWaveDetail: 2,
    backWaveDetailScale: 1,
    backWaveDetailRoughness: 0.5,
    backWaveThreshold: 0.117919921875,
  });

  const result = await runGenerator(mathDump, { object: "Dsurface" });
  assert.deepEqual(result.soup.stats, { verts: 35054, faces: 35052, tris: 70104 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 210312, material: bdsfName }]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }

  const material = makeCrossSectionFilamentMaterial(mathDump, geometry, bdsfName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material.name, `${bdsfName} · D-surface cross-section reconstruction`);
  assert.deepEqual(material.userData.bdsfResolvedZeroControls, [
    "texture",
    "strength",
    "distance",
    "ray",
    "pos",
    "dir",
  ]);
  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>",
  };
  material.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.vertexShader, /attribute float rough/);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb=max\(vBdsfColor,vec3\(0\.0\)\)/);
  assert.match(shader.fragmentShader, /bdsfCrossSectionBackWave/);
  assert.match(shader.fragmentShader, /mix\(vec3\(value\),front,0\.48399975895881653\)\*0\.5040002465248108/);
  assert.match(shader.fragmentShader, /wave<0\.117919921875\?vec3\(0\.0\):hsv/);
  assert.match(shader.fragmentShader, /if\(!gl_FrontFacing\)outgoingLight=bdsfCrossSectionBackColor\(vBdsfColor\)/);
  material.dispose();
  geometry.dispose();
});
