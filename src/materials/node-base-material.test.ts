import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import {
  extractNodeBaseMaterialConfig,
  makeNodeBaseMaterial,
  nodeBaseHeightAtGenerated,
} from "../node-base-material";

const dump = Object.assign(
  JSON.parse(await readFile(fileURLToPath(new URL("../../public/dojo/nodes-node/dump.json", import.meta.url)), "utf8")),
  JSON.parse(await readFile(fileURLToPath(new URL("../../public/dojo/nodes-node/shader-metadata.json", import.meta.url)), "utf8")),
) as Dump;

const expectedConfig = {
  baseColor: [0, 0, 0],
  metallic: 0,
  roughness: 1,
  ior: 1.4500000476837158,
  specularIorLevel: 0.3062015771865845,
  noiseScale: 500,
  noiseDetail: 2,
  noiseRoughness: 0.5,
  noiseLacunarity: 2,
  noiseNormalize: true,
  bumpStrength: 0.10000000149011612,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
};

function materialTree(source: Dump): any {
  return source.materials?.["node base.001"];
}

test("strictly recognizes only the authored node base.001 four-node material", () => {
  assert.deepEqual(extractNodeBaseMaterialConfig(dump, "node base.001"), expectedConfig);
  assert.equal(extractNodeBaseMaterialConfig(dump, "node base"), null);

  const changedLink = structuredClone(dump) as Dump;
  materialTree(changedLink).links.pop();
  assert.equal(extractNodeBaseMaterialConfig(changedLink, "node base.001"), null);

  const changedNormalize = structuredClone(dump) as Dump;
  materialTree(changedNormalize).nodes.find((node: any) => node.name === "Noise Texture").props.normalize = false;
  assert.equal(extractNodeBaseMaterialConfig(changedNormalize, "node base.001"), null);

  const changedScale = structuredClone(dump) as Dump;
  const noise = materialTree(changedScale).nodes.find((node: any) => node.name === "Noise Texture");
  noise.inputs.find((socket: any) => socket.identifier === "Scale").value = 501;
  assert.equal(extractNodeBaseMaterialConfig(changedScale, "node base.001"), null);

  const changedBump = structuredClone(dump) as Dump;
  const bump = materialTree(changedBump).nodes.find((node: any) => node.name === "Bump");
  bump.inputs.find((socket: any) => socket.identifier === "Strength").value = 0.2;
  assert.equal(extractNodeBaseMaterialConfig(changedBump, "node base.001"), null);

  const addedNode = structuredClone(dump) as Dump;
  materialTree(addedNode).nodes.push({ name: "Value", type: "ShaderNodeValue", inputs: [], outputs: [] });
  assert.equal(extractNodeBaseMaterialConfig(addedNode, "node base.001"), null);
});

test("normalized 3D FBM scalar oracle matches Blender 5.1.2 probes", () => {
  const config = extractNodeBaseMaterialConfig(dump, "node base.001");
  assert.ok(config);
  const probes: [number[], number][] = [
    [[0, 0, 0], 0.5],
    [[0.012345, 0.06789, 0.111213], 0.32788968086242676],
    [[0.1234567, 0.2345678, 0.3456789], 0.48287317156791687],
    [[0.33333334, 0.6123457, 0.9876543], 0.4325512945652008],
    [[0.4991, 0.5007, 0.5013], 0.49292248487472534],
    [[0.73129, 0.12731, 0.87317], 0.550861656665802],
    [[0.90123, 0.10119, 0.30317], 0.46769610047340393],
    [[1, 1, 1], 0.5],
  ];
  for (const [generated, blender] of probes) {
    assert.ok(Math.abs(nodeBaseHeightAtGenerated(generated, config) - blender) <= 1e-5,
      `${generated.join(",")}: expected ${blender}, got ${nodeBaseHeightAtGenerated(generated, config)}`);
  }
});

test("injects Generated-coordinate normalized Noise and derivative Bump with honest renderer metadata", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -2, -1, -0.5,
    4, -1, -0.5,
    -2, 3, 1.5,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  const material = makeNodeBaseMaterial(dump, geometry, { start: 0, count: 3, material: "node base.001" }, "node base.001");
  assert.ok(material);
  assert.equal(material.name, "node base.001 · authored normalized Noise/Bump reconstruction");
  assert.deepEqual(material.userData.nodeBaseGeneratedBounds, { min: [-2, -1, -0.5], max: [4, 3, 1.5] });
  assert.match(material.userData.rendererApproximation, /Three\.js PBR lighting/);

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <normal_fragment_maps>",
  };
  material.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /vNodeBaseGenerated = \(position - vec3\(-2\.0, -1\.0, -0\.5\)\) \/ vec3\(6\.0, 4\.0, 2\.0\)/);
  assert.match(shader.fragmentShader, /float nodeBaseNoise/);
  assert.match(shader.fragmentShader, /float nodeBaseHeight/);
  assert.match(shader.fragmentShader, /generated \* 500\.0/);
  assert.match(shader.fragmentShader, /0\.5 \* signedFbm \/ 1\.75 \+ 0\.5/);
  assert.match(shader.fragmentShader, /dFdx\(vNodeBaseGenerated\)/);
  assert.match(shader.fragmentShader, /nodeBaseDistance = 1\.0/);
  assert.deepEqual(material.userData.nodeBaseContract, expectedConfig);

  material.dispose();
  geometry.dispose();
});
