import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { runGenerator, type Dump } from "../gnvm";
import {
  extractVtextMaterialConfig,
  makeVtextMaterial,
  vtextFbmAtGenerated,
  vtextHeightAtGenerated,
} from "../vtext-material";

const dump = Object.assign(
  JSON.parse(await readFile(fileURLToPath(new URL("../../public/dojo/nodes-node/dump.json", import.meta.url)), "utf8")),
  JSON.parse(await readFile(fileURLToPath(new URL("../../public/dojo/nodes-node/shader-metadata.json", import.meta.url)), "utf8")),
) as Dump;

const expectedConfig = {
  baseColor: [0.01800565980374813, 0.01800565980374813, 0.01800565980374813],
  metallic: 0,
  roughness: 0.7461773753166199,
  ior: 1.4500000476837158,
  specularIorLevel: 0.11926604062318802,
  bumpStrength: 0.25698322057724,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
  noiseScale: 26.03999900817871,
  waveScaleNoise: 34.19999694824219,
  noiseDetail: 5.84999942779541,
  noiseRoughness: 0.7208346724510193,
  noiseLacunarity: 1.899999976158142,
  waveDistortion: -13.269996643066406,
  waveDetail: 0,
  waveDetailScale: 1,
  waveDetailRoughness: 0.5,
  heightFromMin: 0,
  heightFromMax: 1,
  heightToMin: -0.059999942779541016,
  heightToMax: 0.8700000047683716,
};

test("strictly recognizes the authored node base / vtext.001 contract", () => {
  assert.deepEqual(extractVtextMaterialConfig(dump, "node base"), expectedConfig);
  assert.equal(extractVtextMaterialConfig(dump, "node base.001"), null);

  const changedFactor = structuredClone(dump) as Dump;
  const mix = (changedFactor.shader_node_groups?.["vtext.001"] as any).nodes.find((node: any) => node.name === "Mix (Legacy)");
  mix.inputs.find((socket: any) => socket.identifier === "Factor_Float").value = 0.5;
  assert.equal(extractVtextMaterialConfig(changedFactor, "node base"), null);

  const changedLink = structuredClone(dump) as Dump;
  const tree = changedLink.shader_node_groups?.["vtext.001"] as any;
  tree.links = tree.links.filter((link: any) => !(link.from_node === "Map Range.003" && link.to_node === "Mix (Legacy)"));
  assert.equal(extractVtextMaterialConfig(changedLink, "node base"), null);
});

test("evaluates the live non-normalized FBM, dynamic Wave, Ping-Pong height branch", () => {
  const config = extractVtextMaterialConfig(dump, "node base");
  assert.ok(config);
  const probes = [
    [0.125, 0.5, 0.125],
    [0.5, 0.5, 0.5],
    [0.875, 0.5, 0.875],
  ];
  const values = probes.map((point) => ({
    fbm: vtextFbmAtGenerated(point, config.noiseScale, config),
    height: vtextHeightAtGenerated(point, config),
  }));
  assert.deepEqual(values, [
    { fbm: -0.6291936213225311, height: 0.04498870024090193 },
    { fbm: 0.08560869864811303, height: 0.01961614247284918 },
    { fbm: -0.24236176531452075, height: -0.05638589164918132 },
  ]);
});

const consumers = [
  { object: "Cube", stats: { verts: 12743, faces: 561, tris: 13209 }, start: 0, count: 330, min: [-2.240000009536743, -0.125, -6.929998874664307], max: [2.240000009536743, 0.125, 0] },
  { object: "Cube.006", stats: { verts: 3861, faces: 80, tris: 3885 }, start: 0, count: 60, min: [-2.240000009536743, -0.125, -1.2599998712539673], max: [2.240000009536743, 0.125, 0] },
  { object: "Cube.007", stats: { verts: 3453, faces: 1127, tris: 4575 }, start: 0, count: 60, min: [-2.240000009536743, -0.125, -1.2599998712539673], max: [2.240000009536743, 0.125, 0] },
  { object: "Cube.005", stats: { verts: 4150, faces: 169, tris: 4292 }, start: 0, count: 90, min: [-2.240000009536743, -0.125, -1.8899997472763062], max: [2.240000009536743, 0.125, 0] },
  { object: "Cube.004", stats: { verts: 9134, faces: 1347, tris: 10440 }, start: 0, count: 150, min: [-1.690000057220459, -0.125, -3.1499996185302734], max: [1.690000057220459, 0.125, 0] },
  { object: "Cube.003", stats: { verts: 2691, faces: 1118, tris: 3823 }, start: 0, count: 60, min: [-2.240000009536743, -0.125, -1.2599998712539673], max: [2.240000009536743, 0.125, 0] },
] as const;

test("uses exact group-local Generated bounds without changing all six consumers", async () => {
  for (const expected of consumers) {
    const result = await runGenerator(dump, { object: expected.object });
    assert.deepEqual(result.soup.stats, expected.stats);
    const group = result.soup.groups.find((candidate) => candidate.material === "node base");
    assert.deepEqual(group, { start: expected.start, count: expected.count, material: "node base" });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.soup.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
    const material = makeVtextMaterial(dump, geometry, group, group.material);
    assert.ok(material);
    assert.equal(material.name, "node base · authored Nodes Node vtext reconstruction");
    assert.deepEqual(material.userData.vtextBounds, { min: expected.min, max: expected.max });
    assert.equal(geometry.getAttribute("position").count, expected.stats.verts);
    assert.equal(geometry.getIndex()?.count, expected.stats.tris * 3);

    const shader = {
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <normal_fragment_maps>",
    };
    material.onBeforeCompile(shader as never, {} as never);
    assert.match(shader.vertexShader, /vVtextGenerated = \(position - vec3/);
    assert.match(shader.fragmentShader, /float vtextFbm/);
    assert.match(shader.fragmentShader, /float vtextPingPong/);
    assert.match(shader.fragmentShader, /float vtextHeight/);
    assert.match(shader.fragmentShader, /dFdx\(vVtextGenerated\)/);
    material.dispose();
    geometry.dispose();
  }
});
