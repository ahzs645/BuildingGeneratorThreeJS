import type { Dump } from "../../gnvm";

export type GeometryNodesEditorEvents = {
  change: string;
  nodeSelect: string;
  resize: string;
};

export type GeometryNodesEditorConfig = {
  dumpUrl: string;
  objectName?: string;
  rootGroupName?: string;
  events: GeometryNodesEditorEvents;
  storageKey: string;
  downloadFileName: string;
};

/**
 * A parent-owned Geometry Nodes document.
 *
 * `sourceKey` is the document identity: change it when `dump` should replace the
 * editor's working copy. Changes to `dump` with the same key are intentionally
 * ignored so `onDumpChange` can feed a live runtime without resetting undo state.
 */
export type GeometryNodesEditorSource = {
  sourceKey: string;
  dump: Dump;
  objectName?: string;
  rootGroupName?: string;
};

export type GeometryNodesEditorSelection = Pick<
  GeometryNodesEditorConfig,
  "objectName" | "rootGroupName"
>;

export function resolveEditorRootGroup(
  dump: Dump,
  selection: GeometryNodesEditorSelection,
): string {
  const objects = dump.objects ?? [];
  const object = selection.objectName
    ? objects.find((candidate) => candidate.name === selection.objectName)
    : undefined;

  if (selection.objectName && !object) {
    throw new Error(`Geometry Nodes object not found: ${selection.objectName}`);
  }

  const objectGroups = (object?.modifiers ?? [])
    .map((modifier) => modifier.node_group)
    .filter((name): name is string => Boolean(name));

  if (selection.rootGroupName) {
    if (!dump.node_groups[selection.rootGroupName]) {
      throw new Error(`Geometry Nodes root group not found: ${selection.rootGroupName}`);
    }
    if (object && !objectGroups.includes(selection.rootGroupName)) {
      throw new Error(`${selection.rootGroupName} is not assigned to ${object.name}`);
    }
    return selection.rootGroupName;
  }

  const objectRoot = objectGroups.find((name) => Boolean(dump.node_groups[name]));
  if (objectRoot) return objectRoot;

  if (object) throw new Error(`No Geometry Nodes modifier found on ${object.name}`);

  const firstRoot = objects
    .flatMap((candidate) => candidate.modifiers ?? [])
    .map((modifier) => modifier.node_group)
    .find((name): name is string => Boolean(name && dump.node_groups[name]));
  if (firstRoot) return firstRoot;

  throw new Error("No Geometry Nodes root group found in portable dump");
}
