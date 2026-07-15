/**
 * Additive extraction metadata.  The Geometry Nodes payload itself remains the
 * version-1 dump format; old dumps can omit this object entirely.
 */
export type DependencyKind = "object" | "collection" | "material" | "image" | "font" | "scene" | "node_tree";
export type DependencyAvailability = "embedded" | "referenced" | "unavailable";

export interface DependencyDescriptor {
  id: string;
  kind: DependencyKind;
  source: {
    tree?: string;
    tree_id?: string;
    node?: string;
    node_id?: string;
    socket?: string;
    socket_id?: string;
    direction?: "input" | "output" | "modifier_input" | "nested_tree";
    object?: string;
    modifier?: string;
  };
  target: { name: string; id?: string; library_path?: string | null; snapshot?: string };
  required: boolean;
  availability: DependencyAvailability;
  provenance: "node_socket" | "modifier_input" | "nested_tree" | "legacy_dependency_objects" | "derived_legacy_pointer";
}

export interface ExtractionMetadataV1 {
  schema_version: 1;
  extractor: { name: string; version: string; blender_version?: string };
  source?: { filename?: string; fingerprint_sha256?: string };
  roots?: { objects: string[]; node_groups: string[] };
  provenance?: { payload: string; dependency_policy: string };
  warnings?: { code: string; message: string; path?: string[] }[];
  ids?: {
    objects?: Record<string, string>;
    node_groups?: Record<string, {
      id: string;
      nodes?: Record<string, string>;
      interface?: { index: number; id: string; identifier?: string }[];
      sockets?: { node: string; direction: "input" | "output"; index: number; id: string; identifier?: string }[];
    }>;
  };
  dependencies?: DependencyDescriptor[];
}

interface DependencyDump {
  node_groups: Record<string, any>;
  dependency_objects?: string[];
  extraction_metadata?: ExtractionMetadataV1;
  objects?: { name: string; modifiers?: { type: string; node_group?: string; input_values?: Record<string, unknown> }[] }[];
}

function datablockPointers(value: unknown, kind: DependencyKind): string[] {
  const names: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (!Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (String(record.datablock ?? "").toLowerCase() === kind && typeof record.name === "string") names.push(record.name);
      for (const nested of Object.values(record)) visit(nested);
      return;
    }
    for (const nested of candidate) visit(nested);
  };
  visit(value);
  return names;
}

/**
 * Resolve evaluated object dependencies in dependency-first order.
 *
 * Explicit v1 metadata is authoritative when present. Legacy
 * `dependency_objects` remains supported, and reachable datablock pointers are
 * derived as a compatibility fallback. The latter fixes historic full-file
 * dumps whose dependency list was empty even though Object Info sockets were
 * serialized correctly.
 */
export function resolveObjectDependencyOrder(dump: DependencyDump, rootGroup: string, activeObject?: string): string[] {
  const objects = new Map((dump.objects ?? []).map((object) => [object.name, object]));
  const explicit = new Set<string>(dump.dependency_objects ?? []);
  const metadataByTree = new Map<string, string[]>();
  for (const descriptor of dump.extraction_metadata?.dependencies ?? []) {
    if (descriptor.kind !== "object" || !descriptor.required || descriptor.availability === "unavailable") continue;
    if (descriptor.source.tree) {
      const names = metadataByTree.get(descriptor.source.tree) ?? [];
      names.push(descriptor.target.name);
      metadataByTree.set(descriptor.source.tree, names);
    } else {
      explicit.add(descriptor.target.name);
    }
  }

  const order: string[] = [];
  const objectState = new Map<string, "visiting" | "visited">();
  const groupState = new Set<string>();

  const visitGroup = (groupName: string): void => {
    if (groupState.has(groupName)) return;
    groupState.add(groupName);
    const group = dump.node_groups[groupName];
    if (!group) return;
    for (const name of metadataByTree.get(groupName) ?? []) visitObject(name);
    for (const node of group.nodes ?? []) {
      if (typeof node.group === "string") visitGroup(node.group);
      for (const socket of [...(node.inputs ?? []), ...(node.outputs ?? [])])
        for (const name of datablockPointers(socket.value ?? socket.default, "object")) visitObject(name);
      for (const name of datablockPointers(node.props, "object")) visitObject(name);
    }
    for (const item of group.interface ?? [])
      for (const name of datablockPointers(item.default, "object")) visitObject(name);
  };

  const visitObject = (name: string): void => {
    if (!name || name === activeObject || objectState.get(name) === "visited") return;
    // Blender files can contain intentional cycles (Send Nodes Hat does). Stop
    // recursion at the back-edge and retain the reachable dependency once.
    if (objectState.get(name) === "visiting") return;
    objectState.set(name, "visiting");
    const object = objects.get(name);
    for (const modifier of object?.modifiers ?? []) {
      for (const pointer of datablockPointers(modifier.input_values, "object")) visitObject(pointer);
      if (modifier.type === "NODES" && modifier.node_group) visitGroup(modifier.node_group);
    }
    objectState.set(name, "visited");
    if (object) order.push(name);
  };

  visitGroup(rootGroup);
  // Preserve the old explicit-list behavior, including dependencies that do
  // not appear in a socket payload understood by this VM.
  for (const name of explicit) visitObject(name);
  return order;
}
