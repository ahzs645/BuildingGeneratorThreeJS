/**
 * Attach Blender-evaluated geometry probes to a portable graph dump.
 *
 * Usage:
 *   npx tsx tools/attach_bake_snapshots.ts INPUT_DUMP MANIFEST OUTPUT_DUMP
 *
 * The manifest contains `frame`, an optional source fingerprint, and entries
 * with `group`, `node`, `item`, and either a legacy realized-mesh `probe` path
 * or a typed v2 `snapshot` path. Typed items can contain a geometry set,
 * volume grid, or literal socket value.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dump, RawNode } from "../src/gnvm/index";
import type {
  BakeSnapshot,
  BakeSnapshotV2Item,
} from "../src/gnvm/dump-schema";

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
    probe?: string;
    snapshot?: string;
  }[];
};

function v2Snapshot(node: RawNode, manifest: Manifest): Extract<BakeSnapshot, { schema_version: 2 }> {
  const existing = node.bake_snapshot;
  if (existing?.schema_version === 2) return existing;
  const items: Record<string, BakeSnapshotV2Item> = {};
  if (existing?.schema_version === 1) {
    for (const [identifier, item] of Object.entries(existing.items)) {
      items[identifier] = {
        socket_type: "NodeSocketGeometry",
        value_contract: "geometry-set",
        geometry: { mesh: item.geometry },
      };
    }
  }
  return {
    schema_version: 2,
    source: "blender-evaluated",
    frame: manifest.frame ?? existing?.frame ?? 1,
    source_fingerprint_sha256:
      manifest.source_fingerprint_sha256 ?? existing?.source_fingerprint_sha256,
    items,
  };
}

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
  if (!output) throw new Error(`Bake item not found: ${entry.item}`);
  if (Boolean(entry.probe) === Boolean(entry.snapshot))
    throw new Error(`choose exactly one of probe or snapshot for ${entry.item}`);
  let item: BakeSnapshotV2Item;
  if (entry.probe) {
    if (output.type !== "NodeSocketGeometry")
      throw new Error(`realized mesh probe requires a Geometry Bake item: ${entry.item}`);
    const probePath = resolve(manifestDirectory, entry.probe);
    const probe = JSON.parse(await readFile(probePath, "utf8")) as Probe;
    if (!Array.isArray(probe.positions) || !Array.isArray(probe.faces))
      throw new Error(`invalid geometry probe: ${probePath}`);
    item = {
      socket_type: "NodeSocketGeometry",
      value_contract: "geometry-set",
      geometry: {
        mesh: {
          positions: probe.positions as [number, number, number][],
          edges: (probe.edges ?? []) as [number, number][],
          faces: probe.faces,
          ...(probe.face_material ? { face_material: probe.face_material } : {}),
          ...(probe.material_slots ? { material_slots: probe.material_slots } : {}),
          ...(probe.attributes ? { attributes: probe.attributes as never } : {}),
        },
      },
    };
  } else {
    const snapshotPath = resolve(manifestDirectory, entry.snapshot!);
    item = JSON.parse(await readFile(snapshotPath, "utf8")) as BakeSnapshotV2Item;
    if (!item || typeof item !== "object" || !("value_contract" in item))
      throw new Error(`invalid typed Bake snapshot: ${snapshotPath}`);
    if (item.socket_type !== output.type)
      throw new Error(`snapshot socket type ${item.socket_type} does not match ${output.type}`);
  }
  const snapshot = v2Snapshot(node, manifest);
  snapshot.items[entry.item] = item;
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
      "A versioned Blender-evaluated typed snapshot is embedded. "
      + "It is portable across browser sessions and independent of Blender's private cache files."
    ),
  } satisfies NonNullable<RawNode["bake_contract"]>;
}

await writeFile(outputPath, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
console.log(`BAKE_SNAPSHOTS_ATTACHED ${manifest.snapshots.length} -> ${outputPath}`);
