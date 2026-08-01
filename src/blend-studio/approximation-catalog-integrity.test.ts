import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOUNDED_APPROXIMATION_NODE_TYPES } from "../gnvm/capabilities";

type CatalogAsset = { dump: string };
type Dump = {
  node_groups?: Record<string, { nodes?: Array<{ type: string }> }>;
};

const approximationTypes = [
  "GeometryNodeBake",
  "GeometryNodeGridToMesh",
  "GeometryNodeMeshToSDFGrid",
  "GeometryNodePointsToSDFGrid",
  "GeometryNodeUVPackIslands",
  "GeometryNodeUVUnwrap",
  "GeometryNodeVolumeCube",
  "GeometryNodeVolumeToMesh",
] as const;

const expectedCounts = {
  GeometryNodeBake: 3,
  GeometryNodeGridToMesh: 0,
  GeometryNodeMeshToSDFGrid: 0,
  GeometryNodePointsToSDFGrid: 0,
  GeometryNodeUVPackIslands: 0,
  GeometryNodeUVUnwrap: 3,
  GeometryNodeVolumeCube: 6,
  GeometryNodeVolumeToMesh: 13,
} as const;

test("published catalog keeps Bake, UV, and volume approximations separately inventoried", () => {
  assert.deepEqual(
    [...BOUNDED_APPROXIMATION_NODE_TYPES].sort(),
    [...approximationTypes].sort(),
    "every statically bounded handler must stay visible in this repository inventory",
  );
  const catalog = JSON.parse(readFileSync(
    "public/dojo/chrome-assets/catalog.json",
    "utf8",
  )) as CatalogAsset[];
  const dumpPaths = [...new Set(catalog.map((asset) => asset.dump))].sort();
  const counts = Object.fromEntries(approximationTypes.map((type) => [type, 0]));
  const affectedDumps = new Set<string>();

  for (const path of dumpPaths) {
    const dump = JSON.parse(readFileSync(`public/${path}`, "utf8")) as Dump;
    for (const group of Object.values(dump.node_groups ?? {})) {
      for (const node of group.nodes ?? []) {
        if (!approximationTypes.includes(node.type as typeof approximationTypes[number])) continue;
        counts[node.type] += 1;
        affectedDumps.add(path);
      }
    }
  }

  assert.deepEqual(counts, expectedCounts);
  assert.deepEqual([...affectedDumps].sort(), [
    "dojo/chrome-assets/chain-and-mace/dump.json",
    "dojo/chrome-assets/chain-link-spikey/dump.json",
    "dojo/joints/bubble-putty/dump.json",
    "dojo/joints/modern-pipe/dump.json",
    "dojo/joints/three-way-pipe/dump.json",
    "dojo/math-clay/dump.json",
    "dojo/n03d/bolt-watertight/dump.json",
    "dojo/nodes-node/dump.json",
  ]);
});
