import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Node = {
  type: string;
  outputs?: Array<{ linked?: boolean }>;
  props?: { node_tree?: { name?: string } };
};

type Dump = {
  node_groups: Record<string, { nodes?: Node[] }>;
  objects: Array<{
    name: string;
    modifiers?: Array<{ type: string; node_group?: string }>;
  }>;
};

type CatalogEntry = { id: string; object: string; dump: string };

const dumpPaths = [
  "dojo/nodes-node/dump.json",
  "dojo/math-clay/dump.json",
] as const;

function loadDump(path: string): Dump {
  return JSON.parse(readFileSync(`public/${path}`, "utf8")) as Dump;
}

function groupReachesUV(
  dump: Dump,
  groupName: string | undefined,
  seen = new Set<string>(),
): boolean {
  if (!groupName || seen.has(groupName)) return false;
  seen.add(groupName);
  const group = dump.node_groups[groupName];
  if (!group) return false;
  if (group.nodes?.some((node) =>
    node.type === "GeometryNodeUVUnwrap"
    || node.type === "GeometryNodeUVPackIslands")) return true;
  return group.nodes?.some((node) =>
    groupReachesUV(dump, node.props?.node_tree?.name, seen)) ?? false;
}

test("checked-in UV approximations stay limited to three library nodes", () => {
  const inventory = dumpPaths.flatMap((path) => {
    const dump = loadDump(path);
    return Object.entries(dump.node_groups).flatMap(([group, tree]) =>
      (tree.nodes ?? [])
        .filter((node) =>
          node.type === "GeometryNodeUVUnwrap"
          || node.type === "GeometryNodeUVPackIslands")
        .map((node) => ({
          path,
          group,
          type: node.type,
          outputLinked: node.outputs?.some((output) => output.linked) ?? false,
        })));
  });

  assert.deepEqual(inventory, [
    {
      path: "dojo/nodes-node/dump.json",
      group: "_GLYPH PLAYER",
      type: "GeometryNodeUVUnwrap",
      outputLinked: true,
    },
    {
      path: "dojo/nodes-node/dump.json",
      group: "_PATCH.Chenille.from image plane",
      type: "GeometryNodeUVUnwrap",
      outputLinked: false,
    },
    {
      path: "dojo/math-clay/dump.json",
      group: "_GLYPH PLAYER",
      type: "GeometryNodeUVUnwrap",
      outputLinked: true,
    },
  ]);
});

test("no published catalog modifier root reaches a checked-in UV approximation", () => {
  const catalog = JSON.parse(readFileSync(
    "public/dojo/chrome-assets/catalog.json",
    "utf8",
  )) as CatalogEntry[];
  const reachable: string[] = [];

  for (const path of dumpPaths) {
    const dump = loadDump(path);
    for (const asset of catalog.filter((entry) => entry.dump === path)) {
      const object = dump.objects.find((candidate) => candidate.name === asset.object);
      const roots = (object?.modifiers ?? [])
        .filter((modifier) => modifier.type === "NODES")
        .map((modifier) => modifier.node_group);
      if (roots.some((root) => groupReachesUV(dump, root))) reachable.push(asset.id);
    }
  }

  assert.deepEqual(reachable, []);
});
