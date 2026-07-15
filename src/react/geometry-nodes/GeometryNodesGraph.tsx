import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  adaptDumpGraph,
  adaptGeometryNodesDump,
  refreshDumpLinkedFlags,
} from "../../geometry-nodes/adapter";
import type {
  EditorGraph,
  EditorNode,
  EditorSocket,
  GeometryNodesDump,
} from "../../geometry-nodes/model";
import { publicUrl } from "../../base-url";
import "./geometry-nodes-graph.css";

const GRAPH_SCALE = 0.62;

type GraphNodeData = {
  model: EditorNode;
  width: number;
  onSocketChange: (nodeName: string, socketId: string, value: unknown) => void;
};
type GraphFrameData = { model: EditorNode; width: number; height: number };

const SOCKET_COLORS: Record<string, string> = {
  NodeSocketGeometry: "#13d5ac",
  NodeSocketFloat: "#a9a9a9",
  NodeSocketFloatFactor: "#a9a9a9",
  NodeSocketFloatDistance: "#a9a9a9",
  NodeSocketInt: "#9acb6b",
  NodeSocketBool: "#d787b7",
  NodeSocketVector: "#6b9bd2",
  NodeSocketVectorTranslation: "#6b9bd2",
  NodeSocketRotation: "#746bd2",
  NodeSocketColor: "#d8c85e",
  NodeSocketMaterial: "#d05bce",
  NodeSocketObject: "#ef8a46",
  NodeSocketCollection: "#ef8a46",
  NodeSocketString: "#87d5be",
  NodeSocketMenu: "#8c8c8c",
};

const socketColor = (type: string): string => SOCKET_COLORS[type] ?? (type.includes("Vector") || type.includes("Rotation") ? "#6b9bd2" : "#9a9a9a");
const compactType = (type: string): string => type.replace(/^(GeometryNode|ShaderNode|FunctionNode|Node)/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
const nodeTone = (type: string): string => type === "NodeGroupInput" ? "input" : type === "NodeGroupOutput" ? "output" : type === "GeometryNodeGroup" ? "group" : type.startsWith("GeometryNode") ? "geometry" : type.startsWith("ShaderNodeTex") ? "texture" : type.startsWith("ShaderNode") ? "shader" : type.startsWith("FunctionNode") ? "function" : "utility";

function valueLabel(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
  if (typeof value === "string") return value.length > 14 ? `${value.slice(0, 13)}…` : value;
  if (Array.isArray(value)) return value.length >= 3 ? value.slice(0, 3).map((part) => Number(part).toFixed(2)).join(" · ") : value.join(" · ");
  if (value && typeof value === "object" && "name" in value) return String((value as { name: unknown }).name);
  return "";
}

function SocketValue({ socket, onChange }: { socket: EditorSocket; onChange: (value: unknown) => void }): React.JSX.Element | null {
  const value = socket.value;
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation();
  if (socket.dataType === "NodeSocketBool") return <input className="gn-socket-editor gn-socket-check nodrag" aria-label={`${socket.name} value`} type="checkbox" checked={Boolean(value)} onPointerDown={stop} onChange={(event) => onChange(event.target.checked)} />;
  if (typeof value === "number") return <input className="gn-socket-editor nodrag nowheel" aria-label={`${socket.name} value`} type="number" step={socket.dataType === "NodeSocketInt" ? 1 : "any"} value={value} onPointerDown={stop} onWheel={stop} onChange={(event) => onChange(socket.dataType === "NodeSocketInt" ? Math.round(Number(event.target.value)) : Number(event.target.value))} />;
  if (typeof value === "string") return <input className="gn-socket-editor nodrag" aria-label={`${socket.name} value`} value={value} onPointerDown={stop} onChange={(event) => onChange(event.target.value)} />;
  if (Array.isArray(value) && value.every((part) => typeof part === "number")) return <input className="gn-socket-editor gn-socket-vector nodrag" aria-label={`${socket.name} value`} defaultValue={value.join(", ")} onPointerDown={stop} onBlur={(event) => {
    const parts = event.target.value.split(",").map(Number);
    if (parts.length === value.length && parts.every(Number.isFinite)) onChange(parts);
  }} />;
  return null;
}

function SocketRow({ socket, nodeName, onSocketChange }: { socket: EditorSocket; nodeName: string; onSocketChange: GraphNodeData["onSocketChange"] }): React.JSX.Element {
  const input = socket.direction === "input";
  const color = socketColor(socket.dataType);
  const label = valueLabel(socket.value);
  return <div className={`gn-socket-row ${socket.direction}`} title={`${socket.name} · ${compactType(socket.dataType)} · ${socket.identifier}`}>
    <Handle type={input ? "target" : "source"} position={input ? Position.Left : Position.Right} id={socket.id} style={{ background: color }} />
    <span className={`gn-socket-dot shape-${socket.displayShape.toLowerCase()}`} style={{ borderColor: color, background: socket.linked ? color : "#20242a" }} />
    <span className="gn-socket-name">{socket.name || compactType(socket.dataType)}</span>
    {socket.editable ? <SocketValue socket={socket} onChange={(next) => onSocketChange(nodeName, socket.identifier, next)} /> : label && <span className="gn-socket-value">{label}</span>}
  </div>;
}

function BlenderNode({ data }: NodeProps<Node<GraphNodeData>>): React.JSX.Element {
  const model = data.model;
  if (model.kind === "reroute") return <div className="gn-reroute" title={`${model.name} · ${model.inputs[0]?.dataType ?? "socket"}`}>
    <Handle type="target" position={Position.Left} id={model.inputs[0]?.id ?? "input:Input"} />
    <Handle type="source" position={Position.Right} id={model.outputs[0]?.id ?? "output:Output"} />
  </div>;
  const inputs = model.inputs.filter((socket) => socket.visible);
  const outputs = model.outputs.filter((socket) => socket.visible);
  return <div className={`gn-blender-node tone-${nodeTone(model.nodeType)} ${model.muted ? "muted" : ""}`} style={{ width: data.width }}>
    <div className="gn-node-title" style={model.customColor ? { background: model.customColor } : undefined}><span>{model.title}</span>{model.groupDependency && <i title={`Open ${model.groupDependency}`}>▣</i>}</div>
    <div className="gn-node-type">{compactType(model.nodeType)}</div>
    {model.collapsed && <div className="gn-collapsed-handles">
      {inputs.filter((socket) => socket.linked).map((socket) => <Handle key={socket.id} type="target" position={Position.Left} id={socket.id} style={{ background: socketColor(socket.dataType) }} />)}
      {outputs.filter((socket) => socket.linked).map((socket) => <Handle key={socket.id} type="source" position={Position.Right} id={socket.id} style={{ background: socketColor(socket.dataType) }} />)}
    </div>}
    {!model.collapsed && <div className="gn-node-body">
      <div className="gn-socket-list">{inputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeName={model.name} onSocketChange={data.onSocketChange} />)}</div>
      <div className="gn-socket-list">{outputs.map((socket) => <SocketRow key={socket.id} socket={socket} nodeName={model.name} onSocketChange={data.onSocketChange} />)}</div>
    </div>}
  </div>;
}

function BlenderFrame({ data }: NodeProps<Node<GraphFrameData>>): React.JSX.Element {
  return <div className="gn-frame" style={{ width: data.width, height: data.height, backgroundColor: data.model.customColor ?? undefined }}><span>{data.model.title}</span></div>;
}

const nodeTypes = { blenderNode: BlenderNode, blenderFrame: BlenderFrame };

function toFlowNode(model: EditorNode, onSocketChange: GraphNodeData["onSocketChange"]): Node {
  const position = { x: model.position.x * GRAPH_SCALE, y: model.position.y * GRAPH_SCALE };
  if (model.kind === "frame") return {
    id: model.id,
    type: "blenderFrame",
    position,
    data: { model, width: model.size.width * GRAPH_SCALE, height: model.size.height * GRAPH_SCALE },
    draggable: false,
    selectable: true,
    zIndex: -10,
  };
  return {
    id: model.id,
    type: "blenderNode",
    position,
    data: { model, width: model.kind === "reroute" ? 12 : Math.max(92, model.size.width * GRAPH_SCALE), onSocketChange },
    zIndex: model.kind === "reroute" ? 3 : 2,
  };
}

function toFlowEdge(edge: EditorGraph["edges"][number]): Edge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    type: "default",
    animated: edge.muted,
    style: {
      stroke: socketColor(edge.dataType),
      strokeWidth: edge.dataType === "NodeSocketGeometry" ? 2.8 : 1.7,
      opacity: edge.muted ? 0.38 : 0.9,
      strokeDasharray: edge.muted ? "5 4" : undefined,
    },
  };
}

function GraphCanvas({ dumpUrl, preferredObject, changeEventName }: { dumpUrl: string; preferredObject: string; changeEventName: string }): React.JSX.Element {
  const [dump, setDump] = useState<GeometryNodesDump | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [undoStack, setUndoStack] = useState<GeometryNodesDump[]>([]);
  const [redoStack, setRedoStack] = useState<GeometryNodesDump[]>([]);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const flow = useReactFlow();
  const workspace = useMemo(() => dump ? adaptGeometryNodesDump(dump, preferredObject) : null, [dump, preferredObject]);
  const groupName = path.at(-1) ?? workspace?.rootGroup ?? "";
  const graph = workspace?.groups[groupName];

  const commit = useCallback((mutate: (next: GeometryNodesDump) => void) => {
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

  const changeSocket = useCallback((nodeName: string, socketId: string, value: unknown) => commit((next) => {
    const socket = next.node_groups[groupName]?.nodes.find((node) => node.name === nodeName)?.inputs.find((input) => input.identifier === socketId);
    if (socket) socket.value = value;
  }), [commit, groupName]);

  useEffect(() => {
    let cancelled = false;
    fetch(publicUrl(dumpUrl), { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Graph request failed (${response.status})`);
        return response.json() as Promise<GeometryNodesDump>;
      })
      .then((loaded) => {
        if (cancelled) return;
        const model = adaptGeometryNodesDump(loaded, preferredObject);
        setDump(loaded);
        setPath([model.rootGroup]);
      })
      .catch((error) => { if (!cancelled) setLoadingError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [dumpUrl, preferredObject]);

  useEffect(() => {
    if (!dump) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new CustomEvent(changeEventName, { detail: { dump } })), 180);
    if (dirty) localStorage.setItem("crayon-gnvm-draft", JSON.stringify(dump));
    return () => window.clearTimeout(timer);
  }, [changeEventName, dirty, dump]);

  useEffect(() => {
    if (!graph) return;
    // React Flow measures custom handles after the node DOM commits. Defer the
    // edge set by one frame so valid source-ordered handles are registered first.
    setEdges([]);
    setNodes((current) => {
      const selected = new Set(current.filter((node) => node.selected).map((node) => node.id));
      return graph.nodes.map((model) => ({ ...toFlowNode(model, changeSocket), selected: selected.has(model.id) }));
    });
    const frame = window.requestAnimationFrame(() => setEdges(graph.edges.map(toFlowEdge)));
    return () => window.cancelAnimationFrame(frame);
  }, [changeSocket, graph]);

  const groupNames = useMemo(() => Object.keys(workspace?.groups ?? {}).sort(), [workspace]);
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !graph) return [];
    return graph.nodes.filter((node) => `${node.title} ${node.name} ${node.nodeType}`.toLowerCase().includes(normalized)).slice(0, 8);
  }, [graph, query]);

  const focusNode = useCallback((model: EditorNode) => {
    setSelectedId(model.id);
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === model.id })));
    void flow.fitView({ nodes: [{ id: model.id }], duration: 280, padding: 1.6, maxZoom: 1.25 });
  }, [flow]);

  const openGroup = useCallback((next: string) => {
    if (!next || !workspace?.groups[next] || next === groupName) return;
    setPath((current) => [...current, next]);
    setSelectedId(null);
    setQuery("");
  }, [groupName, workspace]);

  const jumpToPath = (index: number): void => {
    setPath((current) => current.slice(0, index + 1));
    setSelectedId(null);
  };

  const connect = (connection: Connection): void => {
    if (!graph || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const sourceNode = graph.nodes.find((node) => node.id === connection.source);
    const targetNode = graph.nodes.find((node) => node.id === connection.target);
    const from = sourceNode?.outputs.find((socket) => socket.id === connection.sourceHandle);
    const to = targetNode?.inputs.find((socket) => socket.id === connection.targetHandle);
    if (!sourceNode || !targetNode || !from || !to) return;
    commit((next) => {
      const raw = next.node_groups[groupName];
      if (!raw) return;
      const existing = raw.links.filter((link) => link.to_node === targetNode.name && (link.to_socket === to.identifier || link.to_socket === to.name));
      const multiInput = existing.some((link) => link.multi_input_sort_id != null) || /JoinGeometry|GeometryToInstance/.test(targetNode.nodeType);
      if (!multiInput) raw.links = raw.links.filter((link) => link.to_node !== targetNode.name || (link.to_socket !== to.identifier && link.to_socket !== to.name));
      if (!raw.links.some((link) => link.from_node === sourceNode.name && link.from_socket === from.identifier && link.to_node === targetNode.name && link.to_socket === to.identifier)) raw.links.push({
        from_node: sourceNode.name,
        from_socket: from.identifier,
        to_node: targetNode.name,
        to_socket: to.identifier,
        from_type: from.dataType,
        to_type: to.dataType,
        ...(multiInput ? { multi_input_sort_id: Math.max(-1, ...existing.map((link) => link.multi_input_sort_id ?? -1)) + 1 } : {}),
      });
      refreshDumpLinkedFlags(raw);
    });
  };

  const deleteEdges = (removed: Edge[]): void => commit((next) => {
    const raw = next.node_groups[groupName];
    if (!raw) return;
    const ids = new Set(removed.map((edge) => edge.id));
    const adapted = adaptDumpGraph(groupName, raw);
    const removedLinks = new Set(adapted.edges.filter((edge) => ids.has(edge.id)).map((edge) => edge.sourceLink));
    raw.links = raw.links.filter((link) => !removedLinks.has(link));
    refreshDumpLinkedFlags(raw);
  });

  const persistPosition = (_event: MouseEvent | TouchEvent, flowNode: Node): void => {
    const model = graph?.nodes.find((node) => node.id === flowNode.id);
    if (!model || model.kind === "frame") return;
    commit((next) => {
      const raw = next.node_groups[groupName]?.nodes.find((node) => node.name === model.name);
      if (!raw) return;
      const absolute = [flowNode.position.x / GRAPH_SCALE, -flowNode.position.y / GRAPH_SCALE];
      raw.ui = { ...raw.ui, location_absolute: absolute };
      if (!raw.ui.parent) raw.ui.location = absolute;
    });
  };

  const undo = (): void => setUndoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], previous = next.pop()!;
    setRedoStack((redo) => [...redo, dump]);
    setDump(previous);
    setDirty(true);
    return next;
  });
  const redo = (): void => setRedoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], following = next.pop()!;
    setUndoStack((undoItems) => [...undoItems, dump]);
    setDump(following);
    setDirty(true);
    return next;
  });

  const saveJson = (): void => {
    if (!dump) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(dump, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "chrome-crayon-edited.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setDirty(false);
  };

  const importJson = async (file: File): Promise<void> => {
    const parsed = JSON.parse(await file.text()) as GeometryNodesDump;
    if (!parsed.node_groups || !parsed.objects) throw new Error("Not a portable Geometry Nodes dump");
    const model = adaptGeometryNodesDump(parsed, preferredObject);
    if (dump) setUndoStack((items) => [...items, dump]);
    setDump(parsed);
    setPath([model.rootGroup]);
    setRedoStack([]);
    setDirty(true);
  };

  if (loadingError) return <div className="gn-load-error">Unable to open graph: {loadingError}</div>;
  return <div className="gn-workspace">
    <div className="gn-toolbar">
      <nav className="gn-breadcrumbs" aria-label="Node group path">{path.map((name, index) => <span key={`${name}:${index}`}><button type="button" onClick={() => jumpToPath(index)}>{index === 0 ? "◇ " : ""}{name}</button>{index < path.length - 1 && <i>›</i>}</span>)}</nav>
      <select aria-label="All node groups" value={groupName} onChange={(event) => openGroup(event.target.value)}>{groupNames.map((name) => <option key={name}>{name}</option>)}</select>
      <label className="gn-search"><span>⌕</span><input aria-label="Search nodes" placeholder="Search nodes…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && searchResults[0]) focusNode(searchResults[0]); }} /></label>
      <div className="gn-actions"><button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">↶</button><button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">↷</button><button type="button" onClick={() => fileInput.current?.click()}>Open</button><button type="button" onClick={saveJson} disabled={!dump}>Save</button></div>
      <input ref={fileInput} className="gn-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file).catch((error) => setLoadingError(error instanceof Error ? error.message : String(error))); event.target.value = ""; }} />
    </div>
    {query && <div className="gn-search-results">{searchResults.length ? searchResults.map((result) => <button type="button" key={result.id} onClick={() => focusNode(result)}><b>{result.title}</b><span>{compactType(result.nodeType)}</span></button>) : <span>No nodes match “{query}”</span>}</div>}
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current))}
      onNodeDragStop={persistPosition}
      onConnect={connect}
      onEdgesDelete={deleteEdges}
      onNodeDoubleClick={(_event, node) => {
        const model = graph?.nodes.find((candidate) => candidate.id === node.id);
        if (model?.groupDependency) openGroup(model.groupDependency);
      }}
      onSelectionChange={({ nodes: selection }) => setSelectedId(selection.at(-1)?.id ?? null)}
      deleteKeyCode={["Backspace", "Delete"]}
      fitView
      fitViewOptions={{ padding: .1 }}
      minZoom={0.06}
      maxZoom={2.2}
      colorMode="dark"
      selectionOnDrag
      panOnScroll
      multiSelectionKeyCode="Shift"
    >
      <Background gap={22} size={1.2} color="#30343a" />
      <MiniMap pannable zoomable nodeColor={(node) => node.type === "blenderFrame" ? "#25282d" : "#53606b"} />
      <Controls />
    </ReactFlow>
    <aside className={`gn-selection ${selected ? "visible" : ""}`} aria-live="polite">{selected && <>
      <button type="button" aria-label="Clear selection" onClick={() => { setSelectedId(null); setNodes((current) => current.map((node) => ({ ...node, selected: false }))); }}>×</button>
      <small>{selected.kind === "frame" ? "Frame" : compactType(selected.nodeType)}</small>
      <strong>{selected.title}</strong>
      <span>{selected.inputs.length} inputs · {selected.outputs.length} outputs{selected.parentName ? ` · in ${selected.parentName}` : ""}</span>
      {selected.groupDependency && <button className="gn-open-group" type="button" onClick={() => openGroup(selected.groupDependency!)}>Open group ↳</button>}
    </>}</aside>
    <footer className="gn-status"><span className="gn-status-live" />{dirty ? "Edited graph · GN-VM preview queued" : "Extracted Blender graph · GN-VM authoritative"}<b>{graph ? `${graph.nodes.length} nodes · ${graph.edges.length} links` : "Loading…"}</b>{graph?.warnings.length ? <em>{graph.warnings.length} unresolved links</em> : null}</footer>
  </div>;
}

export function GeometryNodesGraph(props: { dumpUrl: string; preferredObject: string; changeEventName: string }): React.JSX.Element {
  return <ReactFlowProvider><GraphCanvas {...props} /></ReactFlowProvider>;
}
