import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  applyEdgeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnectEnd,
  type OnConnectStart,
  type OnReconnect,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { publicUrl } from "../../base-url";
import type { Dump, DumpLink, DumpNodeGroup, RawNode } from "../../gnvm";
import {
  areSocketTypesCompatible,
  dumpGroupToEditorGraph,
  graphNodeTemplates,
  graphWorkingSetNodeIds,
  searchEditorGraphs,
  type EditorGraph,
  type EditorGraphSearchResult,
  type GraphNode,
  type GraphNodeTemplate,
  type GraphSocket,
} from "../../geometry-nodes/graph-model";
import { nodePropertyControls, type NodePropertyControl } from "../../geometry-nodes/node-property-catalog";
import { documentBounds } from "../../geometry-nodes/annotations";
import {
  resolveEditorRootGroup,
  type GeometryNodesEditorConfig,
  type GeometryNodesEditorSelection,
  type GeometryNodesEditorSource,
} from "./editor-config";
import { GraphPresetLibrary, type GeometryNodesPreset } from "./GraphPresetLibrary";
import { AnnotationCanvas, AnnotationMiniMap } from "./AnnotationCanvas";
import { useMobileStudio } from "../studio/StudioShell";

type NodeCardData = {
  node: GraphNode;
  width: number;
  searchMatch: boolean;
  onSocketChange: (nodeId: string, socketId: string, value: unknown) => void;
  onPropChange: (nodeId: string, prop: string, value: string) => void;
  /**
   * Mobile-only: opens the node's nested group from a single tap on the ◆
   * marker. Desktop keeps double-click as the sole entry (undefined here), so
   * its DOM and behavior stay identical.
   */
  onOpenNestedGroup?: (node: GraphNode) => void;
};
type FrameData = { title: string; color?: string; labelSize: number; shrink: boolean };
type Breadcrumb = { group: string; via?: string };
export type GeometryNodesEditorProps = {
  config: GeometryNodesEditorConfig;
  source?: GeometryNodesEditorSource;
  onDumpChange?: (dump: Dump) => void;
  onPreviewChange?: (selection: { group: string; node: string; socket?: string; type: string }) => void;
  presets?: GeometryNodesPreset[];
};
type PendingConnect = { nodeId: string; handleId: string | null; handleType: "source" | "target" };
type AddMenuState = { x: number; y: number; flowX: number; flowY: number; pending?: PendingConnect };
type ContextMenuState = { x: number; y: number; nodeId?: string; edgeId?: string };
type GraphClipboard = { nodes: RawNode[]; links: DumpLink[] };
/**
 * A history entry is either a single-group snapshot (the pre-edit group object,
 * shared by reference — never mutated after capture because every mutation path
 * goes through `commit`, which clones before writing) or a full-dump snapshot
 * for mutations whose scope was not declared.
 */
type HistoryEntry =
  | { kind: "group"; groupName: string; group: DumpNodeGroup }
  | { kind: "full"; dump: Dump };
/** Declares which part of the dump a `commit` mutator writes. */
type CommitScope = { group: string };

let graphClipboard: GraphClipboard | null = null;

/** Drafts above this serialized size are not persisted — they exceed typical localStorage quotas. */
const DRAFT_PERSIST_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Popup footprints, kept in step with `.graph-add-menu` / `.graph-context-menu`
 * in crayon-compare.css — which are `box-sizing: border-box` so these are the
 * whole box. Only used to keep a menu on screen: a menu opened from the right
 * edge of a 390px phone would otherwise render 190px off it, and the
 * `position: fixed` popups have nothing to scroll them back.
 */
const ADD_MENU_BOX = { width: 280, height: 420 };
/** Taller than the desktop menu measures: its rows grow to `--st-touch` on a phone. */
const CONTEXT_MENU_BOX = { width: 200, height: 330 };
/** Both popups cap at 70vh in CSS; the clamp has to reserve the same. */
const MENU_MAX_VIEWPORT_FRACTION = .7;

/**
 * Rows the add menu draws before it stops. It used to be 60, which was under
 * the crayon dump's 114 templates: the alphabetical tail was unreachable except
 * through the search field. Grouped variants make the list shorter to read, and
 * 120 plain buttons in a 350px scroller costs nothing to render.
 */
const ADD_MENU_MAX_ROWS = 120;

/** How long a finger must rest before the press becomes a menu, and how far it may stray. */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 12;

/** `fitView` padding for the working-set framing, and the zoom band it prefers. */
const WORKING_SET_PADDING = .28;
const WORKING_SET_MIN_ZOOM = .62;
const WORKING_SET_MAX_ZOOM = .82;
/**
 * How much of the authored output chain to open on. It is a range, not a
 * number, because the stage decides: `graphWorkingSetNodeIds` walks upstream
 * from Group Output, so a smaller limit is a prefix of a larger one — always
 * the output and its nearest neighbours, never an arbitrary subset.
 */
const WORKING_SET_LIMIT = 12;
const WORKING_SET_MIN_NODES = 3;

function clampMenuToViewport(x: number, y: number, box: { width: number; height: number }): { x: number; y: number } {
  const margin = 6;
  const height = Math.min(box.height, window.innerHeight * MENU_MAX_VIEWPORT_FRACTION);
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - box.width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  };
}

/**
 * The zoom `fitView` would pick for `bounds` in a `width`x`height` stage, before
 * it clamps into [minZoom, maxZoom]. Mirrors `getViewportForBounds` in
 * @xyflow/system (padding is a fraction of the stage, halved per side) so the
 * caller can lower the floor to exactly what fits instead of guessing.
 */
function fitZoomForBounds(bounds: { width: number; height: number }, width: number, height: number, padding: number): number {
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return Number.POSITIVE_INFINITY;
  const insetX = Math.floor((width - width / (1 + padding)) * .5) * 2;
  const insetY = Math.floor((height - height / (1 + padding)) * .5) * 2;
  return Math.min((width - insetX) / bounds.width, (height - insetY) / bounds.height);
}

const SOCKET_COLORS: Record<string, string> = {
  NodeSocketGeometry: "#00d6a3",
  NodeSocketFloat: "#a7a7a7",
  NodeSocketFloatFactor: "#a7a7a7",
  NodeSocketFloatDistance: "#a7a7a7",
  NodeSocketInt: "#83bd54",
  NodeSocketBool: "#d36b9f",
  NodeSocketVector: "#6b8fd2",
  NodeSocketVectorTranslation: "#6b8fd2",
  NodeSocketVectorDirection: "#6b8fd2",
  NodeSocketRotation: "#8d73d6",
  NodeSocketColor: "#d6c94f",
  NodeSocketMaterial: "#d052ce",
  NodeSocketObject: "#ef873f",
  NodeSocketCollection: "#ef873f",
  NodeSocketString: "#79c9b4",
  NodeSocketMenu: "#8c8c8c",
};

export const socketColor = (type: string): string =>
  SOCKET_COLORS[type] ?? (type.includes("Vector") ? "#6b8fd2" : type.includes("Rotation") ? "#8d73d6" : "#999");

function nodeTone(type: string): string {
  if (type === "NodeGroupInput" || /Input[A-Z]/.test(type)) return "input";
  if (type === "NodeGroupOutput" || type === "GeometryNodeViewer") return "output";
  if (type === "GeometryNodeGroup") return "group";
  if (/Curve|Spline/.test(type)) return "curve";
  if (/Material/.test(type)) return "material";
  if (/Texture/.test(type)) return "texture";
  if (type.startsWith("GeometryNode")) return "geometry";
  if (type.startsWith("ShaderNodeMath") || type.startsWith("FunctionNode")) return "converter";
  if (type.startsWith("ShaderNode")) return "shader";
  return "utility";
}

function compactType(type: string): string {
  return type.replace(/^(GeometryNode|ShaderNode|FunctionNode|Node)/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function valueLabel(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
  if (typeof value === "string") return value.length > 13 ? `${value.slice(0, 12)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 3).map((part) => Number(part).toFixed(2)).join(" · ");
  if (value && typeof value === "object" && "name" in value) return String((value as { name: unknown }).name);
  return "";
}

function SocketValue({ socket, onChange }: { socket: GraphSocket; onChange: (value: unknown) => void }): React.JSX.Element | null {
  const value = socket.value;
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation();
  if (socket.type === "NodeSocketBool") return <input className="socket-editor socket-check nodrag" aria-label={`${socket.name} value`} type="checkbox" checked={Boolean(value)} onPointerDown={stop} onChange={(event) => onChange(event.target.checked)} />;
  if (typeof value === "number") return <input className="socket-editor socket-number nodrag nowheel" aria-label={`${socket.name} value`} type="number" step={socket.type.includes("Int") ? 1 : "any"} value={value} onPointerDown={stop} onWheel={stop} onChange={(event) => onChange(socket.type.includes("Int") ? Math.round(Number(event.target.value)) : Number(event.target.value))} />;
  if (typeof value === "string") return <input className="socket-editor socket-text nodrag" aria-label={`${socket.name} value`} value={value} onPointerDown={stop} onChange={(event) => onChange(event.target.value)} />;
  if (Array.isArray(value) && value.every((part) => typeof part === "number")) return <input className="socket-editor socket-vector nodrag" aria-label={`${socket.name} value`} defaultValue={value.join(", ")} onPointerDown={stop} onBlur={(event) => {
    const parts = event.target.value.split(",").map(Number);
    if (parts.length === value.length && parts.every(Number.isFinite)) onChange(parts);
  }} />;
  return null;
}

function SocketRow({ socket, nodeId, onSocketChange }: { socket: GraphSocket; nodeId: string; onSocketChange: NodeCardData["onSocketChange"] }): React.JSX.Element {
  const input = socket.direction === "input";
  const editable = input && !socket.linked && !socket.hideValue;
  const value = editable ? valueLabel(socket.value) : "";
  return <div className={`blender-socket-row ${socket.direction} ${socket.visible ? "" : "socket-hidden"}`} title={`${socket.name} · ${compactType(socket.type)} · ${socket.identifier}`}>
    <Handle type={input ? "target" : "source"} position={input ? Position.Left : Position.Right} id={socket.id} style={{ background: socketColor(socket.type) }} />
    <span className={`socket-dot shape-${socket.displayShape.toLowerCase()}`} style={{ borderColor: socketColor(socket.type), background: socket.linked ? socketColor(socket.type) : "#20242a" }} />
    <span className="socket-name">{socket.name || compactType(socket.type)}</span>
    {editable ? <SocketValue socket={socket} onChange={(next) => onSocketChange(nodeId, socket.id, next)} /> : value && <span className="socket-value">{value}</span>}
  </div>;
}

/**
 * Blender draws a node's enum properties as unlabelled dropdowns between the
 * output and input sockets, and the label would not fit anyway — the default
 * node is 140px wide. The property name stays reachable through the tooltip.
 */
function NodePropertyRow({ control, nodeId, onPropChange }: { control: NodePropertyControl; nodeId: string; onPropChange: NodeCardData["onPropChange"] }): React.JSX.Element {
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation();
  return <div className="blender-prop-row">
    {/* nodrag/nowheel and the pointer-down guard are load-bearing: without them
        React Flow claims the gesture and drags the node instead of opening the
        menu, and a scroll over an open menu zooms the canvas. */}
    <select
      className="node-prop nodrag nowheel"
      aria-label={`${control.label} · ${control.prop}`}
      title={`${control.label} · ${control.prop}`}
      value={control.value}
      onPointerDown={stop}
      onWheel={stop}
      onClick={stop}
      onChange={(event) => onPropChange(nodeId, control.prop, event.target.value)}
    >{control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  </div>;
}

function NodeCard({ data }: NodeProps<Node<NodeCardData>>): React.JSX.Element {
  const node = data.node;
  if (node.kind === "reroute") return <div className="blender-reroute" title={`Reroute · ${node.sourceName}`}>
    <Handle type="target" position={Position.Left} id={node.inputs[0]?.id ?? "input"} />
    <Handle type="source" position={Position.Right} id={node.outputs[0]?.id ?? "output"} />
  </div>;
  const inputs = node.inputs.filter((socket) => (socket.visible || socket.linked) && socket.identifier !== "__extend__");
  const outputs = node.outputs.filter((socket) => (socket.visible || socket.linked) && socket.identifier !== "__extend__");
  const properties = nodePropertyControls(node.sourceType, node.properties);
  return <div className={`blender-node tone-${nodeTone(node.sourceType)} ${node.muted ? "muted" : ""} ${data.searchMatch ? "search-match" : ""}`} style={{ width: data.width, ...(node.color ? { "--node-custom-color": node.color } as React.CSSProperties : {}) }}>
    <div className="blender-node-title"><span>{node.label}</span>{node.nestedGroup && (data.onOpenNestedGroup
      ? <i
          className="nodrag nested-group-open"
          role="button"
          tabIndex={0}
          title={`Open ${node.nestedGroup}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); data.onOpenNestedGroup!(node); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            data.onOpenNestedGroup!(node);
          }}
        >◆</i>
      : <i title={`Open ${node.nestedGroup}`}>◆</i>)}</div>
    {node.hidden && <div className="collapsed-handles">
      {inputs.map((socket, index) => <Handle className="collapsed-handle" key={socket.id} type="target" position={Position.Left} id={socket.id} title={socket.name} style={{ top: 10 + index * 3, background: socketColor(socket.type) }} />)}
      {outputs.map((socket, index) => <Handle className="collapsed-handle" key={socket.id} type="source" position={Position.Right} id={socket.id} title={socket.name} style={{ top: 10 + index * 3, background: socketColor(socket.type) }} />)}
    </div>}
    {!node.hidden && <div className="blender-node-body">
      <div className="socket-list outputs">{outputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeId={node.id} onSocketChange={data.onSocketChange} />)}</div>
      <div className="prop-list">{properties.map((control) => <NodePropertyRow key={control.prop} control={control} nodeId={node.id} onPropChange={data.onPropChange} />)}</div>
      <div className="socket-list inputs">{inputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeId={node.id} onSocketChange={data.onSocketChange} />)}</div>
    </div>}
  </div>;
}

function Frame({ data }: NodeProps<Node<FrameData>>): React.JSX.Element {
  const style = {
    ...(data.color ? {
      borderColor: data.color,
      background: `color-mix(in srgb, ${data.color} 13%, rgba(10,11,13,.4))`,
    } : {}),
    "--frame-label-size": `${Math.max(8, data.labelSize)}px`,
  } as React.CSSProperties;
  return <div className={`blender-frame ${data.shrink ? "shrink" : ""}`} style={style}><span>{data.title}</span></div>;
}

const nodeTypes = { blenderNode: NodeCard, blenderFrame: Frame };

function refreshLinkedFlags(graph: Dump["node_groups"][string]): void {
  for (const node of graph.nodes) {
    for (const socket of node.inputs) socket.linked = graph.links.some((link) => link.to_node === node.name && link.to_socket === socket.identifier);
    for (const socket of node.outputs) (socket as typeof socket & { linked?: boolean }).linked = graph.links.some((link) => link.from_node === node.name && link.from_socket === socket.identifier);
  }
}

function uniqueNodeName(nodes: RawNode[], preferred: string): string {
  const taken = new Set(nodes.map((node) => node.name));
  if (!taken.has(preferred)) return preferred;
  let suffix = 1;
  while (taken.has(`${preferred}.${String(suffix).padStart(3, "0")}`)) suffix += 1;
  return `${preferred}.${String(suffix).padStart(3, "0")}`;
}

function cloneTemplateNode(dump: Dump, template: GraphNodeTemplate, targetNodes: RawNode[], x: number, y: number): RawNode {
  const source = dump.node_groups[template.groupName]?.nodes.find((node) => node.name === template.nodeName);
  if (!source) throw new Error(`Node template is no longer available: ${template.label}`);
  const clone = structuredClone(source);
  clone.name = uniqueNodeName(targetNodes, template.label || source.name);
  clone.label = null;
  clone.ui = {
    ...clone.ui,
    location: [x, -y],
    location_absolute: [x, -y],
    parent: null,
    hide: false,
    mute: false,
  };
  clone.inputs = clone.inputs.map((socket) => ({ ...socket, linked: false }));
  clone.outputs = clone.outputs.map((socket) => ({ ...socket, linked: false }));
  return clone;
}

export default function GeometryNodesEditor({ config, source, onDumpChange, onPreviewChange, presets = [] }: GeometryNodesEditorProps): React.JSX.Element {
  const isMobile = useMobileStudio();
  const [dump, setDump] = useState<Dump | null>(null);
  const [sourceDump, setSourceDump] = useState<Dump | null>(null);
  const [savedDraft, setSavedDraft] = useState<Dump | null>(null);
  const [groupName, setGroupName] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [graph, setGraph] = useState<EditorGraph | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [search, setSearch] = useState("");
  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<{ groupName: string; nodeId: string } | null>(null);
  const [installedSourceIdentity, setInstalledSourceIdentity] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [inkVisible, setInkVisible] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pendingDraft = useRef<{ key: string; dump: Dump } | null>(null);
  const draftTimer = useRef<number | null>(null);
  const draftWarned = useRef({ oversize: false, failed: false });
  const framedGroup = useRef("");
  const connecting = useRef<PendingConnect | null>(null);
  const reconnectSucceeded = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  /** False until a pointer has actually been over the stage, so ⇧A can fall back to its centre. */
  const pointerSeen = useRef(false);
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** Set when a long press opened a menu, so the release that ends it does not close it again. */
  const swallowPaneClick = useRef(false);
  const dumpRef = useRef<Dump | null>(null);
  dumpRef.current = dump;
  const selection: GeometryNodesEditorSelection = source
    ? { objectName: source.objectName, rootGroupName: source.rootGroupName }
    : { objectName: config.objectName, rootGroupName: config.rootGroupName };
  const dumpUrl = source ? null : config.dumpUrl;
  const storageKey = source ? `${config.storageKey}:${source.sourceKey}` : config.storageKey;
  const sourceIdentity = JSON.stringify(source
    ? ["source", source.sourceKey, source.objectName ?? null, source.rootGroupName ?? null, storageKey]
    : ["url", dumpUrl, config.objectName ?? null, config.rootGroupName ?? null, storageKey]);

  const commit = useCallback((mutate: (next: Dump) => void, scope?: CommitScope) => {
    setDump((current) => {
      if (!current) return current;
      const scopedGroup = scope ? current.node_groups[scope.group] : undefined;
      let next: Dump;
      let entry: HistoryEntry;
      if (scope && scopedGroup) {
        // Group-scoped commit: shallow-copy the dump and its node_groups map so
        // downstream identity checks (gnvm evaluation cache keys on node_groups)
        // see a change, deep-clone only the edited group, and share every other
        // group by reference. Shared groups are never mutated afterwards — every
        // mutation path goes through commit, which clones before writing.
        next = { ...current, node_groups: { ...current.node_groups, [scope.group]: structuredClone(scopedGroup) } };
        entry = { kind: "group", groupName: scope.group, group: scopedGroup };
      } else {
        // No declared scope (or unknown group): safe-but-slow full clone.
        next = structuredClone(current);
        entry = { kind: "full", dump: current };
      }
      mutate(next);
      setUndoStack((items) => [...items.slice(-39), entry]);
      setRedoStack([]);
      setDirty(true);
      return next;
    });
  }, []);

  const changeSocket = useCallback((nodeId: string, socketId: string, value: unknown) => commit((next) => {
    const currentGraph = dumpGroupToEditorGraph(next, groupName);
    const editorNode = currentGraph.nodes.find((node) => node.id === nodeId);
    const editorSocket = editorNode?.inputs.find((socket) => socket.id === socketId);
    const rawNode = editorNode && next.node_groups[groupName]?.nodes.find((node) => node.name === editorNode.sourceName);
    const rawSocket = rawNode?.inputs.find((socket) => socket.identifier === editorSocket?.identifier && (socket.idx === editorSocket.index || socket.idx === undefined));
    if (rawSocket) rawSocket.value = value;
  }, { group: groupName }), [commit, groupName]);

  /**
   * Node properties take the same route as socket values — one `commit`, so a
   * dropdown change lands on the undo stack, marks the graph dirty, saves into
   * the draft and re-evaluates exactly like a wire or a number does. The
   * evaluator reads `node.props` at evaluation time, so nothing else is needed
   * to make the change take effect.
   */
  const changeProp = useCallback((nodeId: string, prop: string, value: string) => commit((next) => {
    const currentGraph = dumpGroupToEditorGraph(next, groupName);
    const editorNode = currentGraph.nodes.find((node) => node.id === nodeId);
    const rawNode = editorNode && next.node_groups[groupName]?.nodes.find((node) => node.name === editorNode.sourceName);
    if (!rawNode) return;
    rawNode.props = { ...rawNode.props, [prop]: value };
  }, { group: groupName }), [commit, groupName]);

  const openNestedGroup = useCallback((node: GraphNode): void => {
    // Reads the dump through a ref so the callback identity is stable and the
    // node-card data (which embeds it for the mobile ◆ tap target) never has
    // to rebuild when unrelated state changes.
    if (!node.nestedGroup || !dumpRef.current?.node_groups[node.nestedGroup]) return;
    setBreadcrumbs((items) => [...items, { group: node.nestedGroup!, via: node.label }]);
    setGroupName(node.nestedGroup);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;

    setDump(null);
    setSourceDump(null);
    setSavedDraft(null);
    setGroupName("");
    setBreadcrumbs([]);
    setGraph(null);
    setNodes([]);
    setEdges([]);
    setUndoStack([]);
    setRedoStack([]);
    setDirty(false);
    setSelected(null);
    setSearch("");
    setAddMenu(null);
    setAddQuery("");
    setContextMenu(null);
    setLibraryOpen(false);
    setPendingFocus(null);
    setInstalledSourceIdentity(null);
    setViewport({ x: 0, y: 0, zoom: 1 });
    setInkVisible(true);
    framedGroup.current = "";
    connecting.current = null;
    reconnectSucceeded.current = false;

    const install = (loaded: Dump): void => {
      if (cancelled) return;
      const root = resolveEditorRootGroup(loaded, selection);
      const pristine = structuredClone(loaded);
      setSourceDump(pristine);
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const draft = JSON.parse(stored) as Dump;
          if (draft.node_groups && draft.objects) setSavedDraft(draft);
        }
      } catch {
        // A corrupt or unavailable draft never blocks the selected source.
      }
      setDump(structuredClone(loaded));
      setGroupName(root);
      setBreadcrumbs([{ group: root }]);
      setInstalledSourceIdentity(sourceIdentity);
    };

    if (source) {
      try {
        install(source.dump);
      } catch (error) {
        console.error("GEOMETRY_NODES_EDITOR_LOAD", error);
      }
      return () => {
        cancelled = true;
      };
    }

    fetch(publicUrl(dumpUrl!), { cache: "no-store", signal: abort.signal }).then((response) => {
      if (!response.ok) throw new Error(`Failed to load Geometry Nodes dump (${response.status})`);
      return response.json();
    }).then((loaded: Dump) => {
      install(loaded);
    }).catch((error) => {
      if (!abort.signal.aborted) console.error("GEOMETRY_NODES_EDITOR_LOAD", error);
    });

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [sourceIdentity]);

  const flushDraft = useCallback(() => {
    if (draftTimer.current != null) {
      window.clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (!pending) return;
    try {
      const serialized = JSON.stringify(pending.dump);
      if (serialized.length > DRAFT_PERSIST_MAX_CHARS) {
        if (!draftWarned.current.oversize) {
          draftWarned.current.oversize = true;
          console.warn(`GEOMETRY_NODES_DRAFT_SKIPPED: serialized draft (${serialized.length} chars) exceeds the ${DRAFT_PERSIST_MAX_CHARS} character persistence limit; use Save to keep your changes.`);
        }
        return;
      }
      localStorage.setItem(pending.key, serialized);
      // Dumps are immutable after commit, so the draft can share the reference.
      setSavedDraft(pending.dump);
    } catch (error) {
      if (!draftWarned.current.failed) {
        draftWarned.current.failed = true;
        console.warn("GEOMETRY_NODES_DRAFT_PERSIST", error);
      }
    }
  }, []);

  useEffect(() => {
    if (!dump || installedSourceIdentity !== sourceIdentity) return;
    if (onDumpChange) onDumpChange(dump);
    else window.dispatchEvent(new CustomEvent(config.events.change, { detail: { dump } }));
    if (!dirty) return;
    // Persist the draft off the hot path: coalesce writes until edits pause.
    if (pendingDraft.current && pendingDraft.current.key !== storageKey) flushDraft();
    pendingDraft.current = { key: storageKey, dump };
    if (draftTimer.current != null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(flushDraft, 1_000);
  }, [config.events.change, dirty, dump, flushDraft, installedSourceIdentity, onDumpChange, sourceIdentity, storageKey]);

  useEffect(() => () => flushDraft(), [flushDraft]);

  useEffect(() => {
    if (!dump || !groupName) return;
    const nextGraph = dumpGroupToEditorGraph(dump, groupName);
    const scale = 1;
    const graphById = new Map(nextGraph.nodes.map((node) => [node.id, node]));
    const depths = new Map<string, number>();
    const depthOf = (node: GraphNode, visiting = new Set<string>()): number => {
      const cached = depths.get(node.id);
      if (cached !== undefined) return cached;
      if (!node.parentId || visiting.has(node.id)) return 0;
      visiting.add(node.id);
      const parent = graphById.get(node.parentId);
      const depth = parent ? depthOf(parent, visiting) + 1 : 0;
      visiting.delete(node.id);
      depths.set(node.id, depth);
      return depth;
    };
    // React Flow requires every parent to precede its descendants. This also
    // keeps nested frames attached instead of silently promoting them to root.
    const ordered = [...nextGraph.nodes].sort((a, b) =>
      depthOf(a) - depthOf(b) || Number(a.kind !== "frame") - Number(b.kind !== "frame"));
    const nextNodes: Node[] = ordered.map((node) => {
      if (node.kind === "frame") return {
        id: node.id,
        type: "blenderFrame",
        position: { x: node.position.x * scale, y: node.position.y * scale },
        parentId: node.parentId,
        data: {
          title: node.label,
          color: node.color,
          labelSize: Number(node.properties.label_size ?? 20),
          shrink: Boolean(node.properties.shrink),
        },
        style: { width: Math.max(1, node.width), height: Math.max(1, node.height) },
        selectable: false,
        draggable: false,
        zIndex: -10,
      };
      return {
        id: node.id,
        type: "blenderNode",
        position: { x: node.position.x * scale, y: node.position.y * scale },
        parentId: node.parentId,
        data: { node, width: Math.max(40, Math.min(1200, node.width)), searchMatch: false, onSocketChange: changeSocket, onPropChange: changeProp, onOpenNestedGroup: isMobile ? openNestedGroup : undefined },
        zIndex: 2,
      };
    });
    setGraph(nextGraph);
    setNodes(nextNodes);
    setEdges(nextGraph.links.map((link) => ({
      id: link.id,
      source: link.source,
      sourceHandle: link.sourceHandle,
      target: link.target,
      targetHandle: link.targetHandle,
      type: "default",
      data: { sourceIndex: link.sourceIndex },
      style: { stroke: socketColor(link.socketType), strokeWidth: link.socketType === "NodeSocketGeometry" ? 2.8 : 1.7, opacity: link.muted ? .35 : .9 },
    })));
    setSelected(null);
  }, [dump, groupName, changeSocket, changeProp, isMobile, openNestedGroup]);

  useEffect(() => {
    const query = search.trim().toLowerCase();
    setNodes((current) => current.map((node) => {
      const data = node.data as NodeCardData | FrameData;
      if (!("node" in data)) return node;
      const candidate = data.node;
      const match = Boolean(query && `${candidate.label} ${candidate.sourceName} ${candidate.sourceType} ${candidate.nestedGroup ?? ""}`.toLowerCase().includes(query));
      return { ...node, data: { ...data, searchMatch: match } };
    }));
  }, [search]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.key === "F3" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f")) && !event.altKey) {
        event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select();
      }
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, []);

  const groupNames = useMemo(() => Object.keys(dump?.node_groups ?? {}).sort(), [dump]);
  const graphBounds = useMemo(
    () => graph ? documentBounds(graph.nodes, inkVisible ? graph.annotationLayers : []) : { x: 0, y: 0, width: 1, height: 1 },
    [graph, inkVisible],
  );
  const matches = useMemo(() => dump ? searchEditorGraphs(dump, search, 8) : [], [dump, search]);
  const templates = useMemo(() => dump ? graphNodeTemplates(dump) : [], [dump]);
  const libraryPresets = useMemo(() => savedDraft ? [...presets, {
    id: "browser-draft",
    name: "Saved Browser Draft",
    badge: "Personal",
    description: "The latest portable workspace stored locally in this browser.",
    dump: savedDraft,
  }] : presets, [presets, savedDraft]);
  const visibleTemplates = useMemo(() => {
    const query = addQuery.trim().toLowerCase();
    const pending = addMenu?.pending;
    const anchorNode = pending && graph?.nodes.find((node) => node.id === pending.nodeId);
    const anchorSocket = pending?.handleType === "source"
      ? anchorNode?.outputs.find((socket) => socket.id === pending.handleId)
      : anchorNode?.inputs.find((socket) => socket.id === pending?.handleId);
    return templates.filter((template) => {
      if (query && !`${template.label} ${template.variant ?? ""} ${template.type}`.toLowerCase().includes(query)) return false;
      if (!pending || !anchorSocket) return true;
      return pending.handleType === "source"
        ? template.inputTypes.some((type) => areSocketTypesCompatible(anchorSocket.type, type))
        : template.outputTypes.some((type) => areSocketTypesCompatible(type, anchorSocket.type));
    }).slice(0, ADD_MENU_MAX_ROWS);
  }, [addMenu?.pending, addQuery, graph?.nodes, templates]);
  /**
   * Consecutive templates that are one Blender Add entry. `graphNodeTemplates`
   * already sorts a family contiguously, so the menu only has to notice where
   * the family key changes — no second pass over the catalog, and the grouping
   * survives filtering because the filter preserves order.
   */
  const templateFamilies = useMemo(() => {
    const families: { key: string; label: string; varied: boolean; templates: GraphNodeTemplate[] }[] = [];
    for (const template of visibleTemplates) {
      const current = families[families.length - 1];
      if (current && current.key === template.family) {
        current.templates.push(template);
        current.varied ||= Boolean(template.variant);
      } else {
        families.push({ key: template.family, label: template.label, varied: Boolean(template.variant), templates: [template] });
      }
    }
    return families;
  }, [visibleTemplates]);

  const focusNode = (node: GraphNode): void => {
    const flowNode = flow?.getNode(node.id);
    if (flowNode) void flow?.fitView({ nodes: [flowNode], duration: 320, padding: .8, maxZoom: 1.25 });
    setSelected(node);
  };
  const focusSearchResult = (match: EditorGraphSearchResult): void => {
    setSearch("");
    if (match.groupName === groupName) {
      focusNode(match.node);
      return;
    }
    setBreadcrumbs([{ group: match.groupName }]);
    setPendingFocus({ groupName: match.groupName, nodeId: match.node.id });
    setGroupName(match.groupName);
  };
  const jumpBreadcrumb = (index: number): void => {
    const target = breadcrumbs[index];
    if (!target) return;
    setBreadcrumbs((items) => items.slice(0, index + 1));
    setGroupName(target.group);
  };
  const chooseGroup = (next: string): void => {
    setGroupName(next);
    setBreadcrumbs([{ group: next }]);
  };
  const frameAll = (): void => {
    void flow?.fitBounds(graphBounds, { duration: 320, padding: .12 });
  };
  /**
   * Open on as much of the authored output chain as this stage can hold.
   *
   * The working set was a flat 12 nodes framed at a .62 zoom floor, and both
   * numbers were tuned against one box. `fitView` clamps its computed zoom into
   * [minZoom, maxZoom] and then crops whatever no longer fits, so in the
   * 390x711 mobile overlay exactly 6 of the 12 landed fully on screen — 3 cut
   * by an edge and 3 outside the viewport entirely, and Group Output, the node
   * the whole walk starts from, was one of the three cut. 844x259 measured the
   * same 6 of 12.
   *
   * Dropping the floor instead would fit all twelve, but at zoom .20 on the
   * phone and .16 in the 764x156 desktop dock, which is why the floor exists:
   * Blender opens a tree at a working scale rather than shrinking it into view,
   * and 10.5px node titles at .16 are not a working scale. So the *set* gives
   * way instead of the scale. Walking the limit down keeps the output node and
   * its nearest upstream neighbours (`graphWorkingSetNodeIds` is a BFS from
   * Group Output, so a smaller limit is a prefix of a larger one), and the
   * floor only yields at the smallest set, where cropping the last three nodes
   * would leave nothing framed at all.
   */
  const frameWorkingSet = useCallback((duration = 0): boolean => {
    if (!flow || !graph || !nodes.length) return false;
    const stage = stageRef.current?.getBoundingClientRect();
    let focusNodes: Node[] = [];
    let fitted = Number.POSITIVE_INFINITY;
    for (let limit = WORKING_SET_LIMIT; limit >= WORKING_SET_MIN_NODES; limit -= 1) {
      const workingSet = new Set(graphWorkingSetNodeIds(graph, limit));
      const candidates = nodes.filter((node) => workingSet.has(node.id));
      if (!candidates.length) break;
      focusNodes = candidates;
      if (!stage?.width || !stage.height) break;
      fitted = fitZoomForBounds(flow.getNodesBounds(candidates), stage.width, stage.height, WORKING_SET_PADDING);
      if (fitted >= WORKING_SET_MIN_ZOOM) break;
    }
    if (!focusNodes.length) return false;
    void flow.fitView({
      nodes: focusNodes,
      duration,
      padding: WORKING_SET_PADDING,
      minZoom: Math.min(WORKING_SET_MIN_ZOOM, fitted),
      maxZoom: WORKING_SET_MAX_ZOOM,
    });
    return true;
  }, [flow, graph, nodes]);
  // `frameWorkingSet` re-identifies on every node change (a drag is a node
  // change), so anything long-lived reads it through a ref instead of listing
  // it as a dependency and tearing its subscription down mid-drag.
  const frameWorkingSetRef = useRef(frameWorkingSet);
  frameWorkingSetRef.current = frameWorkingSet;
  const annotatedRef = useRef(false);
  annotatedRef.current = Boolean(graph?.annotationLayers.length);

  useEffect(() => {
    if (!flow || !graph || !nodes.length || pendingFocus || framedGroup.current === groupName) return;
    framedGroup.current = groupName;
    const frame = window.requestAnimationFrame(() => {
      if (graph.annotationLayers.length && graph.viewCenter) {
        void flow.setCenter(graph.viewCenter.x, graph.viewCenter.y, { zoom: .3 });
      } else {
        frameWorkingSet();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow, frameWorkingSet, graph, groupName, nodes, pendingFocus]);

  useEffect(() => {
    let frame = 0;
    const reframe = (): void => {
      window.cancelAnimationFrame(frame);
      if (!graph?.annotationLayers.length) frame = window.requestAnimationFrame(() => frameWorkingSet(240));
    };
    window.addEventListener(config.events.resize, reframe);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener(config.events.resize, reframe);
    };
  }, [config.events.resize, frameWorkingSet, graph?.annotationLayers.length]);

  /**
   * Re-frame whenever the stage itself changes shape.
   *
   * The host's resize event cannot cover the phone case. `CrayonComparePage`
   * does dispatch `crayon-graph-resize` when the overlay opens, but it fires it
   * in the same frame — and on mobile the editor is a `lazy()` chunk that has
   * not resolved yet, so this listener does not exist to hear it. The overlay
   * therefore kept whatever framing React Flow computed from the first box it
   * measured. Observing the stage catches that, plus device rotation and the
   * desktop dock's own maximize, without the host announcing anything.
   *
   * The 5% threshold is what separates a layout change from an on-screen
   * keyboard nudging the visual viewport while somebody is mid-pan.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !flow) return;
    let previous: { width: number; height: number } | null = null;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const reshaped = !previous
        || Math.abs(width - previous.width) > previous.width * .05
        || Math.abs(height - previous.height) > previous.height * .05;
      previous = { width, height };
      // Annotated graphs open on their authored view centre, not a fitted
      // working set; re-fitting them would throw the authored framing away.
      if (!reshaped || annotatedRef.current) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => frameWorkingSetRef.current(0));
    });
    observer.observe(stage);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [flow]);

  useEffect(() => {
    if (!pendingFocus || pendingFocus.groupName !== groupName || !graph) return;
    const node = graph.nodes.find((candidate) => candidate.id === pendingFocus.nodeId);
    const flowNode = flow?.getNode(pendingFocus.nodeId);
    if (!node || !flowNode) return;
    framedGroup.current = groupName;
    void flow?.fitView({ nodes: [flowNode], duration: 320, padding: .8, maxZoom: 1.25 });
    setSelected(node);
    setPendingFocus(null);
  }, [flow, graph, groupName, nodes, pendingFocus]);
  /** Restores a history entry onto `current`, returning the restored dump and the inverse entry for the opposite stack. */
  const applyHistoryEntry = (entry: HistoryEntry, current: Dump): { restored: Dump; inverse: HistoryEntry } => {
    if (entry.kind === "group") {
      const currentGroup = current.node_groups[entry.groupName];
      return {
        restored: { ...current, node_groups: { ...current.node_groups, [entry.groupName]: entry.group } },
        inverse: currentGroup
          ? { kind: "group", groupName: entry.groupName, group: currentGroup }
          : { kind: "full", dump: current },
      };
    }
    return { restored: entry.dump, inverse: { kind: "full", dump: current } };
  };
  const undo = (): void => setUndoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items];
    const { restored, inverse } = applyHistoryEntry(next.pop()!, dump);
    setRedoStack((redo) => [...redo, inverse]); setDump(restored); setDirty(true); return next;
  });
  const redo = (): void => setRedoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items];
    const { restored, inverse } = applyHistoryEntry(next.pop()!, dump);
    setUndoStack((undoItems) => [...undoItems, inverse]); setDump(restored); setDirty(true); return next;
  });

  const appendConnection = (next: Dump, connection: Connection): boolean => {
    if (!graph || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false;
    const currentGraph = dumpGroupToEditorGraph(next, groupName);
    const source = currentGraph.nodes.find((node) => node.id === connection.source);
    const target = currentGraph.nodes.find((node) => node.id === connection.target);
    const from = source?.outputs.find((socket) => socket.id === connection.sourceHandle);
    const to = target?.inputs.find((socket) => socket.id === connection.targetHandle);
    if (!source || !target || !from || !to || !areSocketTypesCompatible(from.type, to.type)) return false;
    const rawGraph = next.node_groups[groupName];
    const existing = rawGraph.links.filter((link) => link.to_node === target.sourceName && link.to_socket === to.identifier);
    const isMulti = existing.some((link) => link.multi_input_sort_id != null) || /JoinGeometry|GeometryToInstance/.test(target.sourceType);
    if (!isMulti) rawGraph.links = rawGraph.links.filter((link) => link.to_node !== target.sourceName || link.to_socket !== to.identifier);
    const duplicate = rawGraph.links.some((link) => link.from_node === source.sourceName && link.from_socket === from.identifier && link.to_node === target.sourceName && link.to_socket === to.identifier);
    if (!duplicate) rawGraph.links.push({
      from_node: source.sourceName,
      from_socket: from.identifier,
      to_node: target.sourceName,
      to_socket: to.identifier,
      from_type: from.type,
      to_type: to.type,
      ...(isMulti ? { multi_input_sort_id: Math.max(0, ...existing.map((link) => link.multi_input_sort_id ?? 0)) + 1 } : {}),
    });
    refreshLinkedFlags(rawGraph);
    return true;
  };
  const connect = (connection: Connection): void => {
    commit((next) => {
      appendConnection(next, connection);
    }, { group: groupName });
  };
  const isValidConnection = (connection: Connection | Edge): boolean => {
    if (!graph || !connection.source || !connection.target || connection.source === connection.target) return false;
    const source = graph.nodes.find((node) => node.id === connection.source);
    const target = graph.nodes.find((node) => node.id === connection.target);
    const from = source?.outputs.find((socket) => socket.id === connection.sourceHandle);
    const to = target?.inputs.find((socket) => socket.id === connection.targetHandle);
    return Boolean(from && to && areSocketTypesCompatible(from.type, to.type));
  };
  const onConnectStart: OnConnectStart = (_event, params) => {
    connecting.current = params.nodeId && params.handleType
      ? { nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType }
      : null;
  };
  /**
   * Every route into the add menu — right-click, ⇧A, the mobile Add button, a
   * long press, and dropping a wire on empty pane — lands here. The node is
   * created at the point the user indicated; only the popup box is clamped, so
   * a menu opened near an edge stays on screen without moving the drop target.
   */
  const openAddMenuAt = (clientX: number, clientY: number, pending?: PendingConnect): void => {
    const position = flow?.screenToFlowPosition({ x: clientX, y: clientY }) ?? { x: 0, y: 0 };
    const spot = clampMenuToViewport(clientX, clientY, ADD_MENU_BOX);
    setAddQuery("");
    setContextMenu(null);
    setAddMenu({ x: spot.x, y: spot.y, flowX: position.x, flowY: position.y, pending });
  };
  /** Where ⇧A and the Add button aim when no pointer has been over the stage. */
  const stageCentre = (): { x: number; y: number } => {
    const box = stageRef.current?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
  };
  const onConnectEnd: OnConnectEnd = (event) => {
    const pending = connecting.current;
    connecting.current = null;
    const target = event.target as HTMLElement | null;
    if (!pending || !target?.classList?.contains("react-flow__pane")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    openAddMenuAt(point.clientX, point.clientY, pending);
  };
  const openAddMenu = (event: MouseEvent | React.MouseEvent): void => {
    event.preventDefault();
    openAddMenuAt(event.clientX, event.clientY);
  };
  const addTemplate = (template: GraphNodeTemplate): void => {
    const menu = addMenu;
    if (!menu || !dump) return;
    commit((next) => {
      const rawGraph = next.node_groups[groupName];
      const clone = cloneTemplateNode(next, template, rawGraph.nodes, menu.flowX, menu.flowY);
      rawGraph.nodes.push(clone);
      const pending = menu.pending;
      if (pending && graph) {
        const anchorNode = graph.nodes.find((node) => node.id === pending.nodeId);
        const anchorSocket = pending.handleType === "source"
          ? anchorNode?.outputs.find((socket) => socket.id === pending.handleId)
          : anchorNode?.inputs.find((socket) => socket.id === pending.handleId);
        if (anchorNode && anchorSocket) {
          if (pending.handleType === "source") {
            const target = clone.inputs.find((socket) => socket.identifier !== "__extend__" && areSocketTypesCompatible(anchorSocket.type, socket.type));
            if (target) rawGraph.links.push({
              from_node: anchorNode.sourceName,
              from_socket: anchorSocket.identifier,
              to_node: clone.name,
              to_socket: target.identifier,
              from_type: anchorSocket.type,
              to_type: target.type,
            });
          } else {
            const source = clone.outputs.find((socket) => socket.identifier !== "__extend__" && areSocketTypesCompatible(socket.type ?? "NodeSocketUndefined", anchorSocket.type));
            if (source) rawGraph.links.push({
              from_node: clone.name,
              from_socket: source.identifier,
              to_node: anchorNode.sourceName,
              to_socket: anchorSocket.identifier,
              from_type: source.type,
              to_type: anchorSocket.type,
            });
          }
        }
      }
      refreshLinkedFlags(rawGraph);
    }, { group: groupName });
    setAddMenu(null);
  };
  const reconnect: OnReconnect<Edge> = (oldEdge, connection) => {
    reconnectSucceeded.current = true;
    commit((next) => {
      const rawGraph = next.node_groups[groupName];
      const sourceIndex = Number((oldEdge.data as { sourceIndex?: number } | undefined)?.sourceIndex);
      if (Number.isInteger(sourceIndex)) rawGraph.links = rawGraph.links.filter((_link, index) => index !== sourceIndex);
      appendConnection(next, connection);
    }, { group: groupName });
  };
  const deleteEdges = (removed: Edge[]): void => commit((next) => {
    const rawGraph = next.node_groups[groupName];
    const indices = new Set(removed.map((edge) => Number((edge.data as { sourceIndex?: number } | undefined)?.sourceIndex)).filter(Number.isInteger));
    rawGraph.links = rawGraph.links.filter((_link, index) => !indices.has(index));
    refreshLinkedFlags(rawGraph);
  }, { group: groupName });
  const copySelection = (ids: string[]): void => {
    if (!dump || !graph) return;
    const names = new Set(graph.nodes.filter((node) => ids.includes(node.id) && node.kind !== "frame").map((node) => node.sourceName));
    const rawGraph = dump.node_groups[groupName];
    const picked = rawGraph.nodes.filter((node) => names.has(node.name));
    if (!picked.length) return;
    graphClipboard = {
      nodes: structuredClone(picked),
      links: structuredClone(rawGraph.links.filter((link) => names.has(link.from_node) && names.has(link.to_node))),
    };
  };
  const deleteSelection = (ids: string[]): void => commit((next) => {
    const current = dumpGroupToEditorGraph(next, groupName);
    const names = new Set(current.nodes.filter((node) => ids.includes(node.id) && node.kind !== "frame").map((node) => node.sourceName));
    const rawGraph = next.node_groups[groupName];
    rawGraph.nodes = rawGraph.nodes.filter((node) => !names.has(node.name));
    rawGraph.links = rawGraph.links.filter((link) => !names.has(link.from_node) && !names.has(link.to_node));
    refreshLinkedFlags(rawGraph);
  }, { group: groupName });
  const disconnectSelection = (ids: string[]): void => commit((next) => {
    const current = dumpGroupToEditorGraph(next, groupName);
    const names = new Set(current.nodes.filter((node) => ids.includes(node.id)).map((node) => node.sourceName));
    const rawGraph = next.node_groups[groupName];
    rawGraph.links = rawGraph.links.filter((link) => !names.has(link.from_node) && !names.has(link.to_node));
    refreshLinkedFlags(rawGraph);
  }, { group: groupName });
  const pasteClipboard = (position?: { x: number; y: number }): void => {
    if (!graphClipboard?.nodes.length) return;
    const target = position ?? flow?.screenToFlowPosition(lastPointer.current) ?? { x: 0, y: 0 };
    commit((next) => {
      const rawGraph = next.node_groups[groupName];
      const sourceMinX = Math.min(...graphClipboard!.nodes.map((node) => Number(node.ui?.location_absolute?.[0] ?? node.ui?.location?.[0] ?? 0)));
      const sourceMaxY = Math.max(...graphClipboard!.nodes.map((node) => Number(node.ui?.location_absolute?.[1] ?? node.ui?.location?.[1] ?? 0)));
      const names = new Map<string, string>();
      for (const source of graphClipboard!.nodes) {
        const clone = structuredClone(source);
        clone.name = uniqueNodeName(rawGraph.nodes, source.name);
        names.set(source.name, clone.name);
        const rawX = Number(source.ui?.location_absolute?.[0] ?? source.ui?.location?.[0] ?? 0);
        const rawY = Number(source.ui?.location_absolute?.[1] ?? source.ui?.location?.[1] ?? 0);
        const x = target.x + rawX - sourceMinX;
        const y = -target.y + rawY - sourceMaxY;
        clone.ui = { ...clone.ui, location: [x, y], location_absolute: [x, y], parent: null };
        clone.inputs = clone.inputs.map((socket) => ({ ...socket, linked: false }));
        clone.outputs = clone.outputs.map((socket) => ({ ...socket, linked: false }));
        rawGraph.nodes.push(clone);
      }
      for (const link of graphClipboard!.links) rawGraph.links.push({
        ...structuredClone(link),
        from_node: names.get(link.from_node) ?? link.from_node,
        to_node: names.get(link.to_node) ?? link.to_node,
      });
      refreshLinkedFlags(rawGraph);
    }, { group: groupName });
  };
  const duplicateSelection = (ids: string[]): void => {
    copySelection(ids);
    const selectedNodes = nodes.filter((node) => ids.includes(node.id));
    if (!selectedNodes.length) return;
    const x = Math.min(...selectedNodes.map((node) => node.position.x)) + 36;
    const y = Math.min(...selectedNodes.map((node) => node.position.y)) + 36;
    pasteClipboard({ x, y });
  };
  const persistNodePosition = (flowNode: Node): void => commit((next) => {
    const current = dumpGroupToEditorGraph(next, groupName);
    const editorNode = current.nodes.find((node) => node.id === flowNode.id);
    const rawNode = editorNode && next.node_groups[groupName].nodes.find((node) => node.name === editorNode.sourceName);
    if (!editorNode || !rawNode) return;
    const parent = editorNode.parentId ? current.nodes.find((node) => node.id === editorNode.parentId) : undefined;
    const absoluteX = (parent?.absolutePosition.x ?? 0) + flowNode.position.x;
    const absoluteY = (parent?.absolutePosition.y ?? 0) + flowNode.position.y;
    rawNode.ui = {
      ...rawNode.ui,
      location: [flowNode.position.x, -flowNode.position.y],
      location_absolute: [absoluteX, -absoluteY],
    };
  }, { group: groupName });
  const previewNode = (nodeId: string): void => {
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const geometryOutput = node.outputs.find((socket) => socket.type === "NodeSocketGeometry");
    const selection = { group: groupName, node: node.sourceName, socket: geometryOutput?.identifier, type: node.sourceType };
    if (onPreviewChange) onPreviewChange(selection);
    else window.dispatchEvent(new CustomEvent(config.events.nodeSelect, { detail: selection }));
  };
  const setAsOutput = (nodeId: string): void => commit((next) => {
    const current = dumpGroupToEditorGraph(next, groupName);
    const source = current.nodes.find((node) => node.id === nodeId);
    const from = source?.outputs.find((socket) => socket.type === "NodeSocketGeometry");
    const output = current.nodes.find((node) => node.sourceType === "NodeGroupOutput");
    const to = output?.inputs.find((socket) => socket.type === "NodeSocketGeometry");
    if (!source || !from || !output || !to) return;
    const rawGraph = next.node_groups[groupName];
    rawGraph.links = rawGraph.links.filter((link) => link.to_node !== output.sourceName || link.to_socket !== to.identifier);
    rawGraph.links.push({ from_node: source.sourceName, from_socket: from.identifier, to_node: output.sourceName, to_socket: to.identifier, from_type: from.type, to_type: to.type });
    refreshLinkedFlags(rawGraph);
  }, { group: groupName });
  const selectedIds = (): string[] => nodes.filter((node) => node.selected && node.type !== "blenderFrame").map((node) => node.id);
  const openNodeMenuAt = (clientX: number, clientY: number, nodeId: string): void => {
    const spot = clampMenuToViewport(clientX, clientY, CONTEXT_MENU_BOX);
    setAddMenu(null);
    setContextMenu({ x: spot.x, y: spot.y, nodeId });
    if (!nodes.find((candidate) => candidate.id === nodeId)?.selected) {
      setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === nodeId })));
    }
  };
  const openEdgeMenuAt = (clientX: number, clientY: number, edgeId: string): void => {
    const spot = clampMenuToViewport(clientX, clientY, CONTEXT_MENU_BOX);
    setAddMenu(null);
    setContextMenu({ x: spot.x, y: spot.y, edgeId });
  };
  const openNodeMenu = (event: React.MouseEvent, node: Node): void => {
    event.preventDefault();
    openNodeMenuAt(event.clientX, event.clientY, node.id);
  };
  const openEdgeMenu = (event: React.MouseEvent, edge: Edge): void => {
    event.preventDefault();
    openEdgeMenuAt(event.clientX, event.clientY, edge.id);
  };

  /**
   * Touch entry to both menus.
   *
   * Add and delete lived behind `onPaneContextMenu` / `onNodeContextMenu`
   * alone, and a touch device has no way to raise a `contextmenu` on a canvas —
   * a real 900ms `page.touchscreen` press at 390x844 produced zero of them — so
   * the editor was read-only on a phone while every other gesture worked. A
   * press that rests long enough opens the same menu the right button does, off
   * the same handlers. Mouse presses return immediately, so the desktop path is
   * untouched.
   */
  const cancelLongPress = (): void => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  const onStagePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    lastPointer.current = { x: event.clientX, y: event.clientY };
    pointerSeen.current = true;
    swallowPaneClick.current = false;
    cancelLongPress();
    if (event.pointerType === "mouse") return;
    const target = event.target as HTMLElement | null;
    // A press that starts on a control belongs to that control: sockets and the
    // property dropdowns carry `nodrag`, and the minimap is a drag surface.
    if (target?.closest(".nodrag, .react-flow__handle, .react-flow__controls, .annotation-minimap")) return;
    const { clientX, clientY } = event;
    const nodeId = target?.closest<HTMLElement>(".react-flow__node")?.dataset.id;
    const edgeId = target?.closest<HTMLElement>(".react-flow__edge")?.dataset.id;
    const timer = window.setTimeout(() => {
      longPress.current = null;
      swallowPaneClick.current = true;
      if (nodeId) openNodeMenuAt(clientX, clientY, nodeId);
      else if (edgeId) openEdgeMenuAt(clientX, clientY, edgeId);
      else openAddMenuAt(clientX, clientY);
    }, LONG_PRESS_MS);
    longPress.current = { timer, x: clientX, y: clientY };
  };
  const onStagePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    lastPointer.current = { x: event.clientX, y: event.clientY };
    pointerSeen.current = true;
    const pending = longPress.current;
    // A pan or a pinch is not a press. The slop is what separates the two.
    if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > LONG_PRESS_SLOP_PX) cancelLongPress();
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      const ids = selectedIds();
      // Blender's Add is ⇧A, and the editor bound F3, ⇧D and ⌘C/X/V without it.
      // It opens where the pointer is, like Blender, and falls back to the
      // centre of the stage when the pointer has never been over it (a fresh
      // load, or a keyboard-only user) rather than to the screen origin.
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const spot = pointerSeen.current ? lastPointer.current : stageCentre();
        openAddMenuAt(spot.x, spot.y);
        return;
      }
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "d" && ids.length) {
        event.preventDefault();
        duplicateSelection(ids);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && ids.length) {
        event.preventDefault();
        copySelection(ids);
      } else if (key === "x" && ids.length) {
        event.preventDefault();
        copySelection(ids);
        deleteSelection(ids);
      } else if (key === "v" && graphClipboard) {
        event.preventDefault();
        pasteClipboard();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });

  useEffect(() => () => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
  }, []);

  const saveJson = (): void => {
    if (!dump) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(dump, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = config.downloadFileName; document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000); setDirty(false);
  };
  const importJson = async (file: File): Promise<void> => {
    const parsed = JSON.parse(await file.text()) as Dump;
    if (!parsed.node_groups || !parsed.objects) throw new Error("Not a portable Geometry Nodes dump");
    const root = resolveEditorRootGroup(parsed, selection);
    if (dump) setUndoStack((items) => [...items, { kind: "full", dump }]);
    setDump(parsed); setRedoStack([]); setDirty(true);
    setGroupName(root); setBreadcrumbs([{ group: root }]);
  };
  const applyPreset = (preset: GeometryNodesPreset): void => {
    if (!sourceDump) return;
    const next = structuredClone(preset.dump ?? sourceDump);
    preset.transform?.(next);
    if (dump) setUndoStack((items) => [...items.slice(-39), { kind: "full", dump }]);
    setRedoStack([]);
    setDump(next);
    setDirty(true);
    const root = resolveEditorRootGroup(next, selection);
    setGroupName(root);
    setBreadcrumbs([{ group: root }]);
    setLibraryOpen(false);
  };

  return <div className="blender-flow-wrap">
    <div className="blender-flow-toolbar">
      {/* No "Geometry Nodes" label here: every host already names the editor in
          its dock header or overlay title, and the third copy cost 93px of a
          strip that was clipping its own controls. The unsaved-edits state is
          the kit's status dot, like every other state signal in the app. */}
      {dirty && <span className="st-dot warn editor-dirty" role="img" aria-label="Unsaved graph edits" title="Unsaved graph edits" />}
      <nav className="graph-breadcrumbs" aria-label="Node group path">{breadcrumbs.map((crumb, index) => <span key={`${crumb.group}:${index}`}><button type="button" onClick={() => jumpBreadcrumb(index)} title={crumb.group}>{crumb.via ?? crumb.group}</button>{index < breadcrumbs.length - 1 && <i>›</i>}</span>)}</nav>
      <select aria-label="All node groups" value={groupName} onChange={(event) => chooseGroup(event.target.value)}>{groupNames.map((name) => <option key={name}>{name}</option>)}</select>
      <div className="graph-search"><span>⌕</span><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find nodes · F3" aria-label="Search nodes" />{matches.length > 0 && <div className="graph-search-results">{matches.map((match) => <button type="button" key={`${match.groupName}:${match.node.id}`} onClick={() => focusSearchResult(match)} title={`${match.groupName} · ${match.node.sourceName}`}><b>{match.node.label}</b><small>{compactType(match.node.sourceType)}{match.node.nestedGroup ? ` → ${match.node.nestedGroup}` : ""}</small><em>{match.groupName}</em></button>)}</div>}</div>
      <div className="graph-actions">{isMobile && <button className="graph-add-node" type="button" onClick={() => {
        // Mobile only. Desktop reaches Add through right-click and ⇧A, and this
        // strip is the one the review found clipping its own controls at 1120px
        // — a ninth button there costs a control that already exists. A phone
        // has neither of those routes, and a long press is discoverable only
        // once you know to try it, so the overlay gets the visible affordance.
        // It aims at the middle of the stage rather than the last touch, so the
        // new node lands in view instead of wherever a pan happened to end.
        const spot = stageCentre();
        openAddMenuAt(spot.x, spot.y);
      }} title="Add a node · Shift+A">+ Add</button>}<button type="button" onClick={frameAll} title="Frame nodes, frames, and annotations">Frame All</button>{Boolean(graph?.annotationLayers.length) && <button type="button" aria-pressed={inkVisible} onClick={() => setInkVisible((visible) => !visible)} title="Show or hide Blender annotations">Ink</button>}<button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">↶</button><button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">↷</button>{sourceDump && libraryPresets.length > 0 && <button type="button" onClick={() => setLibraryOpen(true)} title="Browse reusable graph presets">Library</button>}<button type="button" onClick={() => fileInput.current?.click()} title="Open portable JSON">Open</button><button type="button" onClick={saveJson} disabled={!dump} title="Save portable JSON">Save</button></div>
      <input ref={fileInput} className="graph-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file).catch((error) => window.alert(error instanceof Error ? error.message : String(error))); event.target.value = ""; }} />
    </div>
    <div
      className="blender-flow-stage"
      ref={stageRef}
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={(instance) => { setFlow(instance); setViewport(instance.getViewport()); }}
      onMove={(_event, nextViewport) => setViewport(nextViewport)}
      onNodesChange={(changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current))}
      onNodesDelete={(removed) => deleteSelection(removed.map((node) => node.id))}
      onNodeDragStop={(_event, node) => persistNodePosition(node)}
      onEdgesChange={(changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current))}
      onConnect={connect}
      onConnectStart={onConnectStart}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      onReconnectStart={() => { reconnectSucceeded.current = false; }}
      onReconnect={reconnect}
      onReconnectEnd={(_event, edge) => {
        if (!reconnectSucceeded.current) deleteEdges([edge]);
        reconnectSucceeded.current = true;
      }}
      onEdgesDelete={deleteEdges}
      onPaneContextMenu={openAddMenu}
      onNodeContextMenu={openNodeMenu}
      onEdgeContextMenu={openEdgeMenu}
      onPaneClick={() => {
        // A long press ends with a tap on the pane, so without this guard the
        // release that completed the gesture would close the menu it opened.
        if (swallowPaneClick.current) {
          swallowPaneClick.current = false;
          return;
        }
        setAddMenu(null);
        setContextMenu(null);
      }}
      onPaneMouseMove={(event) => { lastPointer.current = { x: event.clientX, y: event.clientY }; pointerSeen.current = true; }}
      deleteKeyCode={["Backspace", "Delete"]} onNodeClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if (!("node" in data)) return;
      setSelected(data.node);
      previewNode(flowNode.id);
    }} onNodeDoubleClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if ("node" in data) openNestedGroup(data.node);
      }} minZoom={.05} maxZoom={2.4} colorMode="dark" selectionOnDrag panOnScroll onlyRenderVisibleElements={isMobile} multiSelectionKeyCode={["Meta", "Control"]}>
      <Background gap={22} size={1.1} color="#30343a" />
      <Controls showInteractive={false} />
    </ReactFlow>
    {graph && <>
      <AnnotationCanvas layers={graph.annotationLayers} viewport={viewport} visible={inkVisible} />
      <AnnotationMiniMap
        bounds={graphBounds}
        nodes={graph.nodes}
        layers={graph.annotationLayers}
        viewport={viewport}
        visible={inkVisible}
        onCenter={(x, y) => { void flow?.setCenter(x, y, { zoom: viewport.zoom, duration: 220 }); }}
      />
    </>}
    </div>
    {addMenu && <div className="graph-popup graph-add-menu" style={{ left: addMenu.x, top: addMenu.y }}>
      <header><b>{addMenu.pending ? "Add compatible node" : "Add node"}</b><button type="button" onClick={() => setAddMenu(null)}>×</button></header>
      <input autoFocus value={addQuery} onChange={(event) => setAddQuery(event.target.value)} placeholder={addMenu.pending ? "Search compatible nodes…" : "Search authored nodes…"} />
      {/* One Blender Add entry is one heading. The catalog is harvested from the
          dump so socket definitions stay aligned with evaluator support, which
          means Capture Attribute arrives four times and Switch five; the four
          really are different nodes (Vector, Boolean, Integer, Float value
          sockets) and nothing recomputes sockets from a property, so they stay
          — under a heading, named by what separates them, instead of four
          identical rows reading "Capture Attribute · 2 in / 2 out". */}
      <div>{templateFamilies.length ? templateFamilies.map((family) => <section className="graph-add-family" key={family.key}>
        {family.varied && <h4>{family.label}<span>{family.templates.length}</span></h4>}
        {family.templates.map((template) => <button type="button" key={template.key} onClick={() => addTemplate(template)}>
          <b>{template.variant ?? template.label}</b><small>{compactType(template.type)} · {template.inputTypes.length} in / {template.outputTypes.length} out</small>
        </button>)}
      </section>) : <p>No compatible authored nodes.</p>}</div>
    </div>}
    {contextMenu && <div className="graph-popup graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
      {contextMenu.nodeId ? (() => {
        const ids = selectedIds().length ? selectedIds() : [contextMenu.nodeId!];
        const active = graph?.nodes.find((node) => node.id === contextMenu.nodeId);
        const canOutput = active?.outputs.some((socket) => socket.type === "NodeSocketGeometry");
        return <>
          <button type="button" disabled={!canOutput} onClick={() => { previewNode(contextMenu.nodeId!); setContextMenu(null); }}>Preview geometry</button>
          <button type="button" disabled={!canOutput} onClick={() => { setAsOutput(contextMenu.nodeId!); setContextMenu(null); }}>Set as group output</button>
          <hr />
          <button type="button" onClick={() => { copySelection(ids); setContextMenu(null); }}>Copy <kbd>⌘C</kbd></button>
          <button type="button" onClick={() => { duplicateSelection(ids); setContextMenu(null); }}>Duplicate <kbd>⇧D</kbd></button>
          <button type="button" onClick={() => { disconnectSelection(ids); setContextMenu(null); }}>Disconnect</button>
          <hr />
          <button className="danger" type="button" onClick={() => { deleteSelection(ids); setContextMenu(null); }}>Delete <kbd>⌫</kbd></button>
        </>;
      })() : <button className="danger" type="button" onClick={() => {
        const edge = edges.find((candidate) => candidate.id === contextMenu.edgeId);
        if (edge) deleteEdges([edge]);
        setContextMenu(null);
      }}>Delete link <kbd>⌫</kbd></button>}
    </div>}
    {libraryOpen && sourceDump && <GraphPresetLibrary source={sourceDump} presets={libraryPresets} onApply={applyPreset} onClose={() => setLibraryOpen(false)} />}
    {/* Three strings needing 126, 298 and 238px cannot share a 370px phone: all
        three measured truncated at 390x844 ("69 nodes · 6…", "double-cl…",
        "Identifiers …"). So a phone renders the one that changes as you work,
        and keeps the link diagnostic only when it has something to report — the
        two it drops are counts that hold still and a reassurance. The hint text
        differs too, because double-click is not the mobile route into a group;
        the ◆ marker is. */}
    <footer className={`graph-statusbar ${isMobile ? "compact" : ""}`}>
      {!isMobile && <span>{graph ? `${graph.nodes.length} nodes · ${graph.links.length} links` : "Loading graph…"}</span>}
      <span>{selected
        ? <><b>{selected.label}</b> · {compactType(selected.sourceType)} · {selected.inputs.length} in / {selected.outputs.length} out</>
        : isMobile ? "Tap a node · ◆ enters a group · press and hold to edit" : "Select a node · double-click a group to enter"}</span>
      {(!isMobile || Boolean(graph?.unresolvedLinks.length)) && <span>{graph?.unresolvedLinks.length ? `${graph.unresolvedLinks.length} unresolved links` : "Identifiers mapped deterministically"}</span>}
    </footer>
  </div>;
}
