/**
 * Attach Blender-evaluated geometry probes to a portable graph dump.
 *
 * Usage:
 *   npx tsx tools/attach_bake_snapshots.ts INPUT_DUMP MANIFEST OUTPUT_DUMP
 *
 * The manifest contains `frame`, an optional source fingerprint, and entries
 * with `object`, `modifier`, `group`, `node`, `item`, and either a legacy
 * realized-mesh `probe` path or a typed v2 `snapshot` path. Typed items can
 * contain a geometry set, volume grid, or literal socket value. Unassigned
 * reusable groups may instead opt into the legacy node-owned form with
 * `standalone_group: true`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dump, DumpModifierBakeState, RawNode } from "../src/gnvm/index";
import { hasCompleteBakeSnapshot } from "../src/gnvm/bake-snapshot";
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
    /** Modifier-owned snapshots must identify their concrete Blender owner. */
    object?: string;
    modifier?: string;
    bake_id?: number;
    /** Legacy node-owned snapshots are allowed only for unassigned groups. */
    standalone_group?: boolean;
    group: string;
    node: string;
    item: string;
    probe?: string;
    snapshot?: string;
  }[];
};

function v2Snapshot(
  existing: BakeSnapshot | undefined,
  manifest: Manifest,
): Extract<BakeSnapshot, { schema_version: 2 }> {
  if (existing?.schema_version === 2) {
    if (manifest.frame !== undefined && existing.frame !== manifest.frame)
      throw new Error(`cannot merge Bake snapshots from frames ${existing.frame} and ${manifest.frame}`);
    if (manifest.source_fingerprint_sha256 !== undefined
      && existing.source_fingerprint_sha256 !== undefined
      && existing.source_fingerprint_sha256 !== manifest.source_fingerprint_sha256) {
      throw new Error("cannot merge Bake snapshots with different source fingerprints");
    }
    return existing;
  }
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

function groupIsReachableFromModifier(dump: Dump, targetGroup: string): boolean {
  const reaches = (groupName: string, seen: Set<string>): boolean => {
    if (groupName === targetGroup) return true;
    if (seen.has(groupName)) return false;
    seen.add(groupName);
    return (dump.node_groups[groupName]?.nodes ?? []).some((node) =>
      node.type === "GeometryNodeGroup"
      && typeof node.group === "string"
      && reaches(node.group, seen));
  };
  return (dump.objects ?? []).some((object) =>
    (object.modifiers ?? []).some((modifier) =>
      modifier.type === "NODES"
      && typeof modifier.node_group === "string"
      && reaches(modifier.node_group, new Set())));
}

function modifierBakeState(
  dump: Dump,
  entry: Manifest["snapshots"][number],
): DumpModifierBakeState | undefined {
  const hasOwnerField = entry.object !== undefined
    || entry.modifier !== undefined
    || entry.bake_id !== undefined;
  if (!hasOwnerField) return undefined;
  if (!entry.object || !entry.modifier)
    throw new Error(`modifier snapshot requires object and modifier: ${entry.group} / ${entry.node}`);
  const object = dump.objects?.find((candidate) => candidate.name === entry.object);
  if (!object) throw new Error(`object not found: ${entry.object}`);
  const modifiers = (object.modifiers ?? []).filter((candidate) =>
    candidate.name === entry.modifier);
  if (modifiers.length !== 1)
    throw new Error(`expected one modifier ${entry.object} / ${entry.modifier}, found ${modifiers.length}`);
  const matches = (modifiers[0].bake_states ?? []).filter((state) =>
    state.node_group === entry.group
    && state.node === entry.node
    && (entry.bake_id === undefined || state.bake_id === entry.bake_id));
  if (matches.length !== 1) {
    throw new Error(
      `expected one modifier Bake state ${entry.object} / ${entry.modifier} / `
      + `${entry.group} / ${entry.node}, found ${matches.length}`,
    );
  }
  return matches[0];
}

const [inputPath, manifestPath, outputPath] = process.argv.slice(2);
if (!inputPath || !manifestPath || !outputPath)
  throw new Error("expected INPUT_DUMP MANIFEST OUTPUT_DUMP");

const dump = JSON.parse(await readFile(inputPath, "utf8")) as Dump;
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const manifestDirectory = dirname(resolve(manifestPath));
const completedTargets = new Map<string, {
  node: RawNode;
  snapshot: Extract<BakeSnapshot, { schema_version: 2 }>;
  legacy: boolean;
}>();

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
  const state = modifierBakeState(dump, entry);
  const legacy = state === undefined;
  if (legacy) {
    if (!entry.standalone_group)
      throw new Error(`standalone_group: true is required for a legacy node snapshot: ${entry.group} / ${entry.node}`);
    if (groupIsReachableFromModifier(dump, entry.group)) {
      throw new Error(
        `legacy shared-node snapshot is unsafe because ${entry.group} is reachable from a modifier; `
        + "identify object and modifier instead",
      );
    }
  } else if (entry.standalone_group) {
    throw new Error(`standalone_group cannot be combined with a modifier owner: ${entry.group} / ${entry.node}`);
  }
  // A shared-node snapshot must never leak into a concrete modifier instance.
  const snapshot = v2Snapshot(state ? state.snapshot : node.bake_snapshot, manifest);
  snapshot.items[entry.item] = item;
  if (state) state.snapshot = snapshot;
  else node.bake_snapshot = snapshot;
  const targetKey = state
    ? `${entry.object}\0${entry.modifier}\0${state.bake_id}\0${entry.group}\0${entry.node}`
    : `standalone\0${entry.group}\0${entry.node}`;
  completedTargets.set(targetKey, { node, snapshot, legacy });
}

for (const [target, { node, snapshot, legacy }] of completedTargets) {
  if (!hasCompleteBakeSnapshot(node, snapshot)) {
    throw new Error(
      `incomplete or non-portable Bake snapshot for ${target.replaceAll("\0", " / ")}; `
      + "every concrete output must have a validated portable item",
    );
  }
  if (legacy) {
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
        "A versioned Blender-evaluated typed snapshot is embedded for this "
        + "standalone group. It is independent of Blender's private cache files."
      ),
    } satisfies NonNullable<RawNode["bake_contract"]>;
  }
}

await writeFile(outputPath, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
console.log(`BAKE_SNAPSHOTS_ATTACHED ${manifest.snapshots.length} -> ${outputPath}`);
