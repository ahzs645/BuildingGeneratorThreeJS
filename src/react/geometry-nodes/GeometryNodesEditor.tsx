import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  applyEdgeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { publicUrl } from "../../base-url";
import type { Dump, DumpLink, RawNode } from "../../gnvm";
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
import {
  resolveEditorRootGroup,
  type GeometryNodesEditorConfig,
  type GeometryNodesEditorSelection,
  type GeometryNodesEditorSource,
} from "./editor-config";
import { GraphPresetLibrary, type GeometryNodesPreset } from "./GraphPresetLibrary";

type NodeCardData = {
  node: GraphNode;
  width: number;
  searchMatch: boolean;
  onSocketChange: (nodeId: string, socketId: string, value: unknown) => void;
};
type FrameData = { title: string; color?: string };
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

let graphClipboard: GraphClipboard | null = null;

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

function NodeCard({ data }: NodeProps<Node<NodeCardData>>): React.JSX.Element {
  const node = data.node;
  if (node.kind === "reroute") return <div className="blender-reroute" title={`Reroute · ${node.sourceName}`}>
    <Handle type="target" position={Position.Left} id={node.inputs[0]?.id ?? "input"} />
    <Handle type="source" position={Position.Right} id={node.outputs[0]?.id ?? "output"} />
  </div>;
  const inputs = node.inputs.filter((socket) => (socket.visible || socket.linked) && socket.identifier !== "__extend__");
  const outputs = node.outputs.filter((socket) => (socket.visible || socket.linked) && socket.identifier !== "__extend__");
  return <div className={`blender-node tone-${nodeTone(node.sourceType)} ${node.muted ? "muted" : ""} ${data.searchMatch ? "search-match" : ""}`} style={{ width: data.width, ...(node.color ? { "--node-custom-color": node.color } as React.CSSProperties : {}) }}>
    <div className="blender-node-title"><span>{node.label}</span>{node.nestedGroup && <i title={`Open ${node.nestedGroup}`}>◆</i>}</div>
    {node.hidden && <div className="collapsed-handles">
      {inputs.map((socket, index) => <Handle className="collapsed-handle" key={socket.id} type="target" position={Position.Left} id={socket.id} title={socket.name} style={{ top: 10 + index * 3, background: socketColor(socket.type) }} />)}
      {outputs.map((socket, index) => <Handle className="collapsed-handle" key={socket.id} type="source" position={Position.Right} id={socket.id} title={socket.name} style={{ top: 10 + index * 3, background: socketColor(socket.type) }} />)}
    </div>}
    {!node.hidden && <div className="blender-node-body">
      <div className="socket-list outputs">{outputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeId={node.id} onSocketChange={data.onSocketChange} />)}</div>
      <div className="socket-list inputs">{inputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeId={node.id} onSocketChange={data.onSocketChange} />)}</div>
    </div>}
  </div>;
}

function Frame({ data }: NodeProps<Node<FrameData>>): React.JSX.Element {
  return <div className="blender-frame" style={data.color ? { borderColor: data.color } : undefined}><span>{data.title}</span></div>;
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
  const [dump, setDump] = useState<Dump | null>(null);
  const [sourceDump, setSourceDump] = useState<Dump | null>(null);
  const [savedDraft, setSavedDraft] = useState<Dump | null>(null);
  const [groupName, setGroupName] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [graph, setGraph] = useState<EditorGraph | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [undoStack, setUndoStack] = useState<Dump[]>([]);
  const [redoStack, setRedoStack] = useState<Dump[]>([]);
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
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const framedGroup = useRef("");
  const connecting = useRef<PendingConnect | null>(null);
  const reconnectSucceeded = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const selection: GeometryNodesEditorSelection = source
    ? { objectName: source.objectName, rootGroupName: source.rootGroupName }
    : { objectName: config.objectName, rootGroupName: config.rootGroupName };
  const dumpUrl = source ? null : config.dumpUrl;
  const storageKey = source ? `${config.storageKey}:${source.sourceKey}` : config.storageKey;
  const sourceIdentity = JSON.stringify(source
    ? ["source", source.sourceKey, source.objectName ?? null, source.rootGroupName ?? null, storageKey]
    : ["url", dumpUrl, config.objectName ?? null, config.rootGroupName ?? null, storageKey]);

  const commit = useCallback((mutate: (next: Dump) => void) => {
    setDump((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      setUndoStack((items) => [...items.slice(-39), current]);
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
  }), [commit, groupName]);

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

  useEffect(() => {
    if (!dump || installedSourceIdentity !== sourceIdentity) return;
    if (onDumpChange) onDumpChange(dump);
    else window.dispatchEvent(new CustomEvent(config.events.change, { detail: { dump } }));
    if (dirty) {
      localStorage.setItem(storageKey, JSON.stringify(dump));
      setSavedDraft(structuredClone(dump));
    }
  }, [config.events.change, dirty, dump, installedSourceIdentity, onDumpChange, sourceIdentity, storageKey]);

  useEffect(() => {
    if (!dump || !groupName) return;
    const nextGraph = dumpGroupToEditorGraph(dump, groupName);
    const scale = 1;
    const byKind = [...nextGraph.nodes].sort((a, b) => Number(a.kind !== "frame") - Number(b.kind !== "frame"));
    const nextNodes: Node[] = byKind.map((node) => {
      if (node.kind === "frame") return {
        id: node.id,
        type: "blenderFrame",
        position: { x: node.position.x * scale, y: node.position.y * scale },
        data: { title: node.label, color: node.color },
        style: { width: Math.max(120, node.width), height: Math.max(90, node.height) },
        selectable: false,
        draggable: false,
        zIndex: -10,
      };
      return {
        id: node.id,
        type: "blenderNode",
        position: { x: node.position.x * scale, y: node.position.y * scale },
        parentId: node.parentId,
        data: { node, width: Math.max(120, Math.min(360, node.width)), searchMatch: false, onSocketChange: changeSocket },
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
  }, [dump, groupName, changeSocket]);

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
      if (query && !`${template.label} ${template.type}`.toLowerCase().includes(query)) return false;
      if (!pending || !anchorSocket) return true;
      return pending.handleType === "source"
        ? template.inputTypes.some((type) => areSocketTypesCompatible(anchorSocket.type, type))
        : template.outputTypes.some((type) => areSocketTypesCompatible(type, anchorSocket.type));
    }).slice(0, 60);
  }, [addMenu?.pending, addQuery, graph?.nodes, templates]);

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
  const openNestedGroup = (node: GraphNode): void => {
    if (!node.nestedGroup || !dump?.node_groups[node.nestedGroup]) return;
    setBreadcrumbs((items) => [...items, { group: node.nestedGroup!, via: node.label }]);
    setGroupName(node.nestedGroup);
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
    void flow?.fitView({ duration: 320, padding: .12, minZoom: .05, maxZoom: 1.2 });
  };
  const frameWorkingSet = useCallback((duration = 0): boolean => {
    if (!flow || !graph || !nodes.length) return false;
    const workingSet = new Set(graphWorkingSetNodeIds(graph, 12));
    const focusNodes = nodes.filter((node) => workingSet.has(node.id));
    if (!focusNodes.length) return false;
    void flow.fitView({ nodes: focusNodes, duration, padding: .28, minZoom: .62, maxZoom: .82 });
    return true;
  }, [flow, graph, nodes]);

  useEffect(() => {
    if (!flow || !graph || !nodes.length || pendingFocus || framedGroup.current === groupName) return;
    framedGroup.current = groupName;
    const frame = window.requestAnimationFrame(() => {
      frameWorkingSet();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow, frameWorkingSet, graph, groupName, nodes, pendingFocus]);

  useEffect(() => {
    let frame = 0;
    const reframe = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => frameWorkingSet(240));
    };
    window.addEventListener(config.events.resize, reframe);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener(config.events.resize, reframe);
    };
  }, [config.events.resize, frameWorkingSet]);

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
  const undo = (): void => setUndoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], previous = next.pop()!;
    setRedoStack((redo) => [...redo, dump]); setDump(previous); setDirty(true); return next;
  });
  const redo = (): void => setRedoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], following = next.pop()!;
    setUndoStack((undoItems) => [...undoItems, dump]); setDump(following); setDirty(true); return next;
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
    });
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
  const onConnectEnd: OnConnectEnd = (event) => {
    const pending = connecting.current;
    connecting.current = null;
    const target = event.target as HTMLElement | null;
    if (!pending || !target?.classList?.contains("react-flow__pane")) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const position = flow?.screenToFlowPosition({ x: point.clientX, y: point.clientY }) ?? { x: 0, y: 0 };
    setAddQuery("");
    setContextMenu(null);
    setAddMenu({ x: point.clientX, y: point.clientY, flowX: position.x, flowY: position.y, pending });
  };
  const openAddMenu = (event: MouseEvent | React.MouseEvent): void => {
    event.preventDefault();
    const position = flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
    setAddQuery("");
    setContextMenu(null);
    setAddMenu({ x: event.clientX, y: event.clientY, flowX: position.x, flowY: position.y });
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
    });
    setAddMenu(null);
  };
  const reconnect: OnReconnect<Edge> = (oldEdge, connection) => {
    reconnectSucceeded.current = true;
    commit((next) => {
      const rawGraph = next.node_groups[groupName];
      const sourceIndex = Number((oldEdge.data as { sourceIndex?: number } | undefined)?.sourceIndex);
      if (Number.isInteger(sourceIndex)) rawGraph.links = rawGraph.links.filter((_link, index) => index !== sourceIndex);
      appendConnection(next, connection);
    });
  };
  const deleteEdges = (removed: Edge[]): void => commit((next) => {
    const rawGraph = next.node_groups[groupName];
    const indices = new Set(removed.map((edge) => Number((edge.data as { sourceIndex?: number } | undefined)?.sourceIndex)).filter(Number.isInteger));
    rawGraph.links = rawGraph.links.filter((_link, index) => !indices.has(index));
    refreshLinkedFlags(rawGraph);
  });
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
  });
  const disconnectSelection = (ids: string[]): void => commit((next) => {
    const current = dumpGroupToEditorGraph(next, groupName);
    const names = new Set(current.nodes.filter((node) => ids.includes(node.id)).map((node) => node.sourceName));
    const rawGraph = next.node_groups[groupName];
    rawGraph.links = rawGraph.links.filter((link) => !names.has(link.from_node) && !names.has(link.to_node));
    refreshLinkedFlags(rawGraph);
  });
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
    });
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
  });
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
  });
  const selectedIds = (): string[] => nodes.filter((node) => node.selected && node.type !== "blenderFrame").map((node) => node.id);
  const openNodeMenu = (event: React.MouseEvent, node: Node): void => {
    event.preventDefault();
    setAddMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
    if (!node.selected) setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
  };
  const openEdgeMenu = (event: React.MouseEvent, edge: Edge): void => {
    event.preventDefault();
    setAddMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id });
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      const ids = selectedIds();
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
    if (dump) setUndoStack((items) => [...items, dump]);
    setDump(parsed); setRedoStack([]); setDirty(true);
    setGroupName(root); setBreadcrumbs([{ group: root }]);
  };
  const applyPreset = (preset: GeometryNodesPreset): void => {
    if (!sourceDump) return;
    const next = structuredClone(preset.dump ?? sourceDump);
    preset.transform?.(next);
    if (dump) setUndoStack((items) => [...items.slice(-39), dump]);
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
      <span className="editor-kind">Geometry Nodes{dirty ? " •" : ""}</span>
      <nav className="graph-breadcrumbs" aria-label="Node group path">{breadcrumbs.map((crumb, index) => <span key={`${crumb.group}:${index}`}><button type="button" onClick={() => jumpBreadcrumb(index)} title={crumb.group}>{crumb.via ?? crumb.group}</button>{index < breadcrumbs.length - 1 && <i>›</i>}</span>)}</nav>
      <select aria-label="All node groups" value={groupName} onChange={(event) => chooseGroup(event.target.value)}>{groupNames.map((name) => <option key={name}>{name}</option>)}</select>
      <div className="graph-search"><span>⌕</span><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find all nodes  F3" aria-label="Search nodes" />{matches.length > 0 && <div className="graph-search-results">{matches.map((match) => <button type="button" key={`${match.groupName}:${match.node.id}`} onClick={() => focusSearchResult(match)} title={`${match.groupName} · ${match.node.sourceName}`}><b>{match.node.label}</b><small>{compactType(match.node.sourceType)}{match.node.nestedGroup ? ` → ${match.node.nestedGroup}` : ""}</small><em>{match.groupName}</em></button>)}</div>}</div>
      <div className="graph-actions"><button type="button" onClick={frameAll} title="Frame the complete node tree">Frame All</button><button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">↶</button><button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">↷</button>{sourceDump && libraryPresets.length > 0 && <button type="button" onClick={() => setLibraryOpen(true)} title="Browse reusable graph presets">Library</button>}<button type="button" onClick={() => fileInput.current?.click()} title="Open portable JSON">Open</button><button type="button" onClick={saveJson} disabled={!dump} title="Save portable JSON">Save</button></div>
      <input ref={fileInput} className="graph-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file).catch((error) => window.alert(error instanceof Error ? error.message : String(error))); event.target.value = ""; }} />
    </div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow}
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
      onPaneClick={() => { setAddMenu(null); setContextMenu(null); }}
      onPaneMouseMove={(event) => { lastPointer.current = { x: event.clientX, y: event.clientY }; }}
      deleteKeyCode={["Backspace", "Delete"]} onNodeClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if (!("node" in data)) return;
      setSelected(data.node);
      previewNode(flowNode.id);
    }} onNodeDoubleClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if ("node" in data) openNestedGroup(data.node);
    }} minZoom={.05} maxZoom={2.4} colorMode="dark" selectionOnDrag panOnScroll multiSelectionKeyCode={["Meta", "Control"]}>
      <Background gap={22} size={1.1} color="#30343a" />
      <MiniMap pannable zoomable nodeColor={(node) => node.type === "blenderFrame" ? "#24272b" : "#567064"} maskColor="rgba(8,9,11,.62)" />
      <Controls showInteractive={false} />
    </ReactFlow>
    {addMenu && <div className="graph-popup graph-add-menu" style={{ left: addMenu.x, top: addMenu.y }}>
      <header><b>{addMenu.pending ? "Add compatible node" : "Add node"}</b><button type="button" onClick={() => setAddMenu(null)}>×</button></header>
      <input autoFocus value={addQuery} onChange={(event) => setAddQuery(event.target.value)} placeholder={addMenu.pending ? "Search compatible nodes…" : "Search authored nodes…"} />
      <div>{visibleTemplates.length ? visibleTemplates.map((template) => <button type="button" key={template.key} onClick={() => addTemplate(template)}>
        <b>{template.label}</b><small>{compactType(template.type)} · {template.inputTypes.length} in / {template.outputTypes.length} out</small>
      </button>) : <p>No compatible authored nodes.</p>}</div>
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
    <footer className="graph-statusbar"><span>{graph ? `${graph.nodes.length} nodes · ${graph.links.length} links` : "Loading graph…"}</span><span>{selected ? <><b>{selected.label}</b> · {compactType(selected.sourceType)} · {selected.inputs.length} in / {selected.outputs.length} out</> : "Select a node · double-click a group to enter"}</span><span>{graph?.unresolvedLinks.length ? `${graph.unresolvedLinks.length} unresolved links` : "Identifiers mapped deterministically"}</span></footer>
  </div>;
}
