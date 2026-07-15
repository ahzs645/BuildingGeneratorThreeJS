export type GnSocketDirection = "input" | "output";

export interface DumpSocket {
  name: string;
  identifier: string;
  type: string;
  linked: boolean;
  enabled?: boolean;
  hide?: boolean;
  hide_value?: boolean;
  display_shape?: string;
  idx?: number;
  value?: unknown;
  default?: unknown;
}

export interface DumpNodeUi {
  location?: number[];
  location_absolute?: number[];
  width?: number;
  height?: number;
  dimensions?: number[];
  hide?: boolean;
  mute?: boolean;
  use_custom_color?: boolean;
  color?: number[];
  parent?: string | null;
}

export interface DumpNode {
  name: string;
  type: string;
  label?: string | null;
  group?: string;
  inputs: DumpSocket[];
  outputs: DumpSocket[];
  ui?: DumpNodeUi;
  props?: Record<string, unknown>;
}

export interface DumpLink {
  from_node: string;
  from_socket: string;
  to_node: string;
  to_socket: string;
  from_idx?: number | null;
  to_idx?: number | null;
  from_type?: string;
  to_type?: string;
  multi_input_sort_id?: number | null;
  muted?: boolean;
}

export interface DumpGraph {
  name?: string;
  type?: string;
  interface?: Record<string, unknown>[];
  nodes: DumpNode[];
  links: DumpLink[];
}

export interface GeometryNodesDump {
  objects: { name?: string; modifiers?: { type?: string; node_group?: string; input_values?: Record<string, unknown> }[] }[];
  node_groups: Record<string, DumpGraph>;
  dependency_objects?: string[];
  [key: string]: unknown;
}

export interface EditorSocket {
  id: string;
  name: string;
  identifier: string;
  direction: GnSocketDirection;
  dataType: string;
  linked: boolean;
  visible: boolean;
  editable: boolean;
  displayShape: string;
  order: number;
  value: unknown;
  source: DumpSocket;
}

export type EditorNodeKind = "node" | "frame" | "reroute";

export interface EditorNode {
  id: string;
  groupName: string;
  name: string;
  title: string;
  nodeType: string;
  kind: EditorNodeKind;
  position: { x: number; y: number };
  size: { width: number; height: number };
  parentName: string | null;
  groupDependency: string | null;
  inputs: EditorSocket[];
  outputs: EditorSocket[];
  muted: boolean;
  collapsed: boolean;
  customColor: string | null;
  source: DumpNode;
}

export interface EditorEdge {
  id: string;
  groupName: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  dataType: string;
  muted: boolean;
  multiInputOrder: number | null;
  sourceSocket: EditorSocket;
  targetSocket: EditorSocket;
  sourceLink: DumpLink;
}

export interface EditorGraph {
  id: string;
  name: string;
  nodes: EditorNode[];
  edges: EditorEdge[];
  dependencies: string[];
  warnings: string[];
  source: DumpGraph;
}

export interface GeometryNodesWorkspaceModel {
  rootGroup: string;
  groups: Record<string, EditorGraph>;
  dependencies: Record<string, string[]>;
}
