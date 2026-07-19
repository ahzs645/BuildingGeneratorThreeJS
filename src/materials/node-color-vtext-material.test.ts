import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { runGenerator, type Dump } from "../gnvm";
import {
  extractNodeColorVtextMaterialConfig,
  makeNodeColorVtextMaterial,
  nodeColorPcg3d,
  nodeColorVtextHeightAtGenerated,
  nodeColorVtextSmoothF1AtGenerated,
} from "../node-color-vtext-material";

const dump = Object.assign(
  JSON.parse(await readFile(fileURLToPath(new URL(
    "../../public/dojo/nodes-node/dump.json",
    import.meta.url,
  )), "utf8")),
  JSON.parse(await readFile(fileURLToPath(new URL(
    "../../public/dojo/nodes-node/shader-metadata.json",
    import.meta.url,
  )), "utf8")),
) as Dump;

const expectedConfig = {
  baseColor: [0, 0.11227122694253922, 0.06201505288481712],
  metallic: 0,
  roughness: 0.8012232780456543,
  ior: 1.4500000476837158,
  specularIorLevel: 0.377675861120224,
  mappingLocation: [0, 0, 0],
  mappingRotation: [1.5707963705062866, 0.7853981852531433, 0],
  mappingScale: [1, 1, 1.440000057220459],
  voronoiScale: 791.2999267578125,
  voronoiSmoothness: 1,
  voronoiRandomness: 0.7094972133636475,
  threshold: 0.5,
  bumpStrength: 0.3284916281700134,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
};

test("strictly recognizes node color.geometry and its seven-node vtext group", () => {
  assert.deepEqual(extractNodeColorVtextMaterialConfig(dump, "node color.geometry"), expectedConfig);
  assert.equal(extractNodeColorVtextMaterialConfig(dump, "node color.input"), null);
  assert.equal(extractNodeColorVtextMaterialConfig(dump, "node base"), null);

  const changedColor = structuredClone(dump) as Dump;
  const principled = (changedColor.materials?.["node color.geometry"] as any).nodes
    .find((node: any) => node.name === "Principled BSDF");
  principled.inputs.find((socket: any) => socket.identifier === "Base Color").value[1] = 0.2;
  assert.equal(extractNodeColorVtextMaterialConfig(changedColor, "node color.geometry"), null);

  const changedRandomness = structuredClone(dump) as Dump;
  const voronoi = (changedRandomness.shader_node_groups?.vtext as any).nodes
    .find((node: any) => node.name === "Voronoi Texture");
  voronoi.inputs.find((socket: any) => socket.identifier === "Randomness").value = 0.5;
  assert.equal(extractNodeColorVtextMaterialConfig(changedRandomness, "node color.geometry"), null);

  const changedLink = structuredClone(dump) as Dump;
  const group = changedLink.shader_node_groups?.vtext as any;
  group.links = group.links.filter((link: any) => !(link.from_node === "Map Range" && link.to_node === "Math"));
  assert.equal(extractNodeColorVtextMaterialConfig(changedLink, "node color.geometry"), null);
});

test("matches Blender 5.1.2 PCG3D and Smooth F1 scalar probes", () => {
  assert.deepEqual(nodeColorPcg3d([1, -2, 3]), [
    0.4232812821865082,
    0.21325811743736267,
    0.3690025806427002,
  ]);
  const probes = [
    [0.125, 0.5, 0.125],
    [0.5, 0.5, 0.5],
    [0.875, 0.5, 0.875],
  ];
  const blenderAov = [0.5335708260536194, 0.19630947709083557, 0.2399575561285019];
  const browser = probes.map((point) => nodeColorVtextSmoothF1AtGenerated(point));
  browser.forEach((value, index) => assert.ok(Math.abs(value - blenderAov[index]) < 1e-6));
  assert.deepEqual(probes.map((point) => nodeColorVtextHeightAtGenerated(point)), [1, 0, 0]);
});

test("builds the Noodle Pair physical material without changing its geometry", async () => {
  const result = await runGenerator(dump, { object: "Point.001" });
  assert.deepEqual(result.soup.stats, { verts: 4736, faces: 4672, tris: 9344 });
  const group = result.soup.groups.find((candidate) => candidate.material === "node color.geometry");
  assert.deepEqual(group, { start: 0, count: 28032, material: "node color.geometry" });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(result.soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  const material = makeNodeColorVtextMaterial(dump, geometry, group!, group!.material!);
  assert.ok(material);
  assert.equal(material.name, "node color.geometry · authored Nodes Node vtext reconstruction");
  assert.equal(material.roughness, expectedConfig.roughness);
  assert.equal(material.userData.nodeColorVtextRenderer.status, "Blender 5.1 Smooth F1 scalar semantics with renderer approximation");
  assert.deepEqual(material.userData.nodeColorVtextBounds, {
    min: [-1.1101469993591309, -1.6273714303970337, -1.05240797996521],
    max: [7.757761478424072, 0.040000032633543015, 8.64538860321045],
  });

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <normal_fragment_maps>",
  };
  material.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /vNodeColorGenerated = \(position - vec3/);
  assert.match(shader.fragmentShader, /float nodeColorSmoothF1/);
  assert.match(shader.fragmentShader, /ivec3 nodeColorPcg3d/);
  assert.match(shader.fragmentShader, /for \(int z = -2; z <= 2; z\+\+\)/);
  assert.match(shader.fragmentShader, /distanceValue > 0\.5/);
  assert.match(shader.fragmentShader, /dFdx\(vNodeColorGenerated\)/);
  assert.equal(geometry.getAttribute("position").count, 4736);
  assert.equal(geometry.getIndex()?.count, 28032);
  material.dispose();
  geometry.dispose();
});
