import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "./index";
import { resolveObjectDependencyOrder } from "./dependency-metadata";

const hatDumpPath = fileURLToPath(new URL("../../public/dojo/send-nodes-hat/dump.json", import.meta.url));
const hatDump = JSON.parse(await readFile(hatDumpPath, "utf8")) as Dump;

test("legacy Hat fixture derives its evaluated hat front dependency from Object Info", () => {
  assert.deepEqual(hatDump.dependency_objects, []);
  const root = hatDump.objects?.find((object) => object.name === "embroidery crv")?.modifiers?.[0]?.node_group;
  assert.equal(root, "embroidery");
  assert.deepEqual(resolveObjectDependencyOrder(hatDump, root!, "embroidery crv"), ["hat front"]);

  const objectInfo = (hatDump.node_groups as any).embroidery.nodes.find((node: any) => node.type === "GeometryNodeObjectInfo");
  assert.deepEqual(objectInfo.inputs.find((socket: any) => socket.identifier === "Object")?.value,
    { datablock: "Object", name: "hat front" });
  const dependency = hatDump.objects?.find((object) => object.name === "hat front");
  assert.ok(dependency?.modifiers?.some((modifier) => modifier.node_group === "fancy trick"),
    "dependency remains procedural; no final embroidery mesh is hard-coded");
});

test("typed metadata adds dependencies without changing legacy payloads", () => {
  const dump = {
    node_groups: { Root: { nodes: [], links: [], interface: [] } },
    objects: [{ name: "Root" }, { name: "Target" }],
    extraction_metadata: {
      schema_version: 1 as const,
      extractor: { name: "test", version: "1" },
      dependencies: [{
        id: "dependency:000001",
        kind: "object" as const,
        source: { tree: "Root", node: "Object Info", socket: "Object", direction: "input" as const },
        target: { name: "Target", id: "object:000002" },
        required: true,
        availability: "embedded" as const,
        provenance: "node_socket" as const,
      }],
    },
  };
  assert.deepEqual(resolveObjectDependencyOrder(dump, "Root", "Root"), ["Target"]);
});

test("legacy dependency_objects remains a supported fallback", () => {
  const dump = {
    node_groups: { Root: { nodes: [], links: [], interface: [] } },
    objects: [{ name: "Root" }, { name: "Legacy" }],
    dependency_objects: ["Legacy"],
  };
  assert.deepEqual(resolveObjectDependencyOrder(dump, "Root", "Root"), ["Legacy"]);
});

