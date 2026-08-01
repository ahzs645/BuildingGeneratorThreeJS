import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import { annotationBounds } from "./annotations";
import { dumpGroupToEditorGraph } from "./graph-model";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("published lesson catalog roots are assigned and visually complete", async () => {
  const catalog = JSON.parse(await readFile(`${root}/public/dojo/chrome-assets/catalog.json`, "utf8")) as {
    id: string;
    object: string;
    dump: string;
    reference: string;
  }[];
  const asset = catalog.find((entry) => entry.id === "course-intro-possibilities");
  assert.ok(asset);
  assert.equal(asset.object, "Cube.010");
  const dumpPath = `${root}/public/${asset.dump}`;
  assert.ok((await stat(dumpPath)).size > 0);
  const reference = await readFile(`${root}/public/${asset.reference}`);
  assert.equal(reference.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual([reference.readUInt32BE(16), reference.readUInt32BE(20)], [1280, 720]);
  const dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
  const object = dump.objects?.find((candidate) => candidate.name === asset.object);
  const groupName = object?.modifiers?.find((modifier) => modifier.type === "NODES")?.node_group;
  assert.equal(groupName, "Geometry Nodes.005");
  assert.ok(groupName && dump.node_groups[groupName]);

  const graph = dumpGroupToEditorGraph(dump, groupName!);
  assert.equal(graph.nodes.length, 19);
  assert.equal(graph.links.length, 8);
  assert.equal(graph.nodes.filter((node) => node.kind === "frame").length, 6);
  assert.equal(graph.annotationLayers.length, 1);
  assert.equal(graph.annotationLayers[0].frame.number, 235);
  assert.equal(graph.annotationLayers[0].frame.strokes.length, 468);
  assert.equal(graph.annotationLayers[0].frame.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0), 11_790);

  // Visual-data regression: these coordinates define the authored composition
  // independently from canvas resolution or browser font rasterization.
  assert.deepEqual(annotationBounds(graph.annotationLayers), {
    x: -898.9501342773438,
    y: -2056.77392578125,
    width: 4752.835388183594,
    height: 6107.803466796875,
  });
  const nestedFrame = graph.nodes.find((node) => node.sourceName === "Frame.005");
  assert.deepEqual(nestedFrame?.absolutePosition, { x: 1037.9912109375, y: 172.8880615234375 });
  assert.equal(nestedFrame?.width, 68.5714111328125);
  assert.equal(nestedFrame?.parentId, "Geometry Nodes.005::Frame.003");
});
