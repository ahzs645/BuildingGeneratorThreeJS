/**
 * Attach Blender-evaluated geometry probes to a portable graph dump.
 *
 * Usage:
 *   npx tsx tools/attach_bake_snapshots.ts INPUT_DUMP MANIFEST OUTPUT_DUMP
 *
 * The manifest contains `frame`, an optional source fingerprint, and entries
 * with `group`, `node`, `item`, and a `probe` path. Probe JSON is produced by
 * `bake_geometry_probe.py` or `bake_nested_geometry_probe.py`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dump, RawNode } from "../src/gnvm/index";

type Probe = {
  positions: number[][];
  edges?: number[][];
  faces: number[][];
  face_material?: number[];
  material_slots?: (string | null)[];
  attributes?: Record<string, {
    domain: "POINT" | "EDGE" | "FACE" | "CORNER";
    data: (number | number[])[];
  }>;
};

type Manifest = {
  frame?: number;
  source_fingerprint_sha256?: string;
  snapshots: {
    group: string;
    node: string;
    item: string;
    probe: string;
  }[];
};

const [inputPath, manifestPath, outputPath] = process.argv.slice(2);
if (!inputPath || !manifestPath || !outputPath)
  throw new Error("expected INPUT_DUMP MANIFEST OUTPUT_DUMP");

const dump = JSON.parse(await readFile(inputPath, "utf8")) as Dump;
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const manifestDirectory = dirname(resolve(manifestPath));

for (const entry of manifest.snapshots) {
  const group = dump.node_groups[entry.group];
  if (!group) throw new Error(`node group not found: ${entry.group}`);
  const node = group.nodes.find((candidate) => candidate.name === entry.node);
  if (!node || node.type !== "GeometryNodeBake")
    throw new Error(`Bake node not found: ${entry.group} / ${entry.node}`);
  const output = node.outputs.find((socket) => socket.identifier === entry.item);
  if (!output || output.type !== "NodeSocketGeometry")
    throw new Error(`geometry Bake item not found: ${entry.item}`);
  const probePath = resolve(manifestDirectory, entry.probe);
  const probe = JSON.parse(await readFile(probePath, "utf8")) as Probe;
  if (!Array.isArray(probe.positions) || !Array.isArray(probe.faces))
    throw new Error(`invalid geometry probe: ${probePath}`);
  const snapshot = node.bake_snapshot ?? {
    schema_version: 1 as const,
    source: "blender-evaluated" as const,
    frame: manifest.frame ?? 1,
    ...(manifest.source_fingerprint_sha256
      ? { source_fingerprint_sha256: manifest.source_fingerprint_sha256 }
      : {}),
    items: {},
  };
  snapshot.items[entry.item] = {
    socket_type: "NodeSocketGeometry",
    component_contract: "realized-mesh",
    geometry: {
      positions: probe.positions as [number, number, number][],
      edges: (probe.edges ?? []) as [number, number][],
      faces: probe.faces,
      ...(probe.face_material ? { face_material: probe.face_material } : {}),
      ...(probe.material_slots ? { material_slots: probe.material_slots } : {}),
      ...(probe.attributes ? { attributes: probe.attributes as never } : {}),
    },
  };
  node.bake_snapshot = snapshot;
  node.bake_contract = {
    ...(node.bake_contract ?? {
      items: [],
      live_passthrough_portable: true,
      persistent_cache_portable: false,
      persistent_cache_status: "not-exported",
      reason: "",
    }),
    persistent_cache_portable: true,
    persistent_cache_status: "portable-evaluated-snapshot",
    reason: (
      "A versioned Blender-evaluated realized-mesh snapshot is embedded. "
      + "It is portable across browser sessions and independent of Blender's private cache files."
    ),
  } satisfies NonNullable<RawNode["bake_contract"]>;
}

await writeFile(outputPath, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
console.log(`BAKE_SNAPSHOTS_ATTACHED ${manifest.snapshots.length} -> ${outputPath}`);
