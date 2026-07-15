import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
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
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { publicUrl } from "../../base-url";
import type { Dump } from "../../gnvm";
import { dumpGroupToEditorGraph, graphWorkingSetNodeIds, searchEditorGraphs, type EditorGraph, type EditorGraphSearchResult, type GraphNode, type GraphSocket } from "../../geometry-nodes/graph-model";
import { resolveEditorRootGroup, type GeometryNodesEditorConfig } from "./editor-config";

type NodeCardData = {
  node: GraphNode;
  width: number;
  searchMatch: boolean;
  onSocketChange: (nodeId: string, socketId: string, value: unknown) => void;
};
type FrameData = { title: string; color?: string };
type Breadcrumb = { group: string; via?: string };

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

export default function GeometryNodesEditor({ config }: { config: GeometryNodesEditorConfig }): React.JSX.Element {
  const [dump, setDump] = useState<Dump | null>(null);
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
  const [pendingFocus, setPendingFocus] = useState<{ groupName: string; nodeId: string } | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const framedGroup = useRef("");

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
    fetch(publicUrl(config.dumpUrl), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Failed to load Geometry Nodes dump (${response.status})`);
      return response.json();
    }).then((loaded: Dump) => {
      const root = resolveEditorRootGroup(loaded, config);
      setDump(loaded);
      setGroupName(root);
      setBreadcrumbs([{ group: root }]);
    }).catch((error) => console.error("GEOMETRY_NODES_EDITOR_LOAD", error));
  }, [config]);

  useEffect(() => {
    if (!dump) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new CustomEvent(config.events.change, { detail: { dump } })), 180);
    if (dirty) localStorage.setItem(config.storageKey, JSON.stringify(dump));
    return () => window.clearTimeout(timer);
  }, [config.events.change, config.storageKey, dump, dirty]);

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
  const connect = (connection: Connection): void => {
    if (!graph || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const source = graph.nodes.find((node) => node.id === connection.source);
    const target = graph.nodes.find((node) => node.id === connection.target);
    const from = source?.outputs.find((socket) => socket.id === connection.sourceHandle);
    const to = target?.inputs.find((socket) => socket.id === connection.targetHandle);
    if (!source || !target || !from || !to) return;
    commit((next) => {
      const rawGraph = next.node_groups[groupName];
      const existing = rawGraph.links.filter((link) => link.to_node === target.sourceName && link.to_socket === to.identifier);
      const isMulti = existing.some((link) => link.multi_input_sort_id != null) || /JoinGeometry|GeometryToInstance/.test(target.sourceType);
      if (!isMulti) rawGraph.links = rawGraph.links.filter((link) => link.to_node !== target.sourceName || link.to_socket !== to.identifier);
      const duplicate = rawGraph.links.some((link) => link.from_node === source.sourceName && link.from_socket === from.identifier && link.to_node === target.sourceName && link.to_socket === to.identifier);
      if (!duplicate) rawGraph.links.push({ from_node: source.sourceName, from_socket: from.identifier, to_node: target.sourceName, to_socket: to.identifier, ...(isMulti ? { multi_input_sort_id: Math.max(0, ...existing.map((link) => link.multi_input_sort_id ?? 0)) + 1 } : {}) });
      refreshLinkedFlags(rawGraph);
    });
  };
  const deleteEdges = (removed: Edge[]): void => commit((next) => {
    const rawGraph = next.node_groups[groupName];
    const indices = new Set(removed.map((edge) => Number((edge.data as { sourceIndex?: number } | undefined)?.sourceIndex)).filter(Number.isInteger));
    rawGraph.links = rawGraph.links.filter((_link, index) => !indices.has(index));
    refreshLinkedFlags(rawGraph);
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
    const root = resolveEditorRootGroup(parsed, config);
    if (dump) setUndoStack((items) => [...items, dump]);
    setDump(parsed); setRedoStack([]); setDirty(true);
    setGroupName(root); setBreadcrumbs([{ group: root }]);
  };

  return <div className="blender-flow-wrap">
    <div className="blender-flow-toolbar">
      <span className="editor-kind">Geometry Nodes{dirty ? " •" : ""}</span>
      <nav className="graph-breadcrumbs" aria-label="Node group path">{breadcrumbs.map((crumb, index) => <span key={`${crumb.group}:${index}`}><button type="button" onClick={() => jumpBreadcrumb(index)} title={crumb.group}>{crumb.via ?? crumb.group}</button>{index < breadcrumbs.length - 1 && <i>›</i>}</span>)}</nav>
      <select aria-label="All node groups" value={groupName} onChange={(event) => chooseGroup(event.target.value)}>{groupNames.map((name) => <option key={name}>{name}</option>)}</select>
      <div className="graph-search"><span>⌕</span><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find all nodes  F3" aria-label="Search nodes" />{matches.length > 0 && <div className="graph-search-results">{matches.map((match) => <button type="button" key={`${match.groupName}:${match.node.id}`} onClick={() => focusSearchResult(match)} title={`${match.groupName} · ${match.node.sourceName}`}><b>{match.node.label}</b><small>{compactType(match.node.sourceType)}{match.node.nestedGroup ? ` → ${match.node.nestedGroup}` : ""}</small><em>{match.groupName}</em></button>)}</div>}</div>
      <div className="graph-actions"><button type="button" onClick={frameAll} title="Frame the complete node tree">Frame All</button><button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">↶</button><button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">↷</button><button type="button" onClick={() => fileInput.current?.click()} title="Open portable JSON">Open</button><button type="button" onClick={saveJson} disabled={!dump} title="Save portable JSON">Save</button></div>
      <input ref={fileInput} className="graph-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file).catch((error) => window.alert(error instanceof Error ? error.message : String(error))); event.target.value = ""; }} />
    </div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow} onNodesChange={(changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current))} onConnect={connect} onEdgesDelete={deleteEdges} deleteKeyCode={["Backspace", "Delete"]} onNodeClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if (!("node" in data)) return;
      setSelected(data.node);
      const geometryOutput = data.node.outputs.find((socket) => socket.type === "NodeSocketGeometry");
      window.dispatchEvent(new CustomEvent(config.events.nodeSelect, { detail: { group: groupName, node: data.node.sourceName, socket: geometryOutput?.identifier, type: data.node.sourceType } }));
    }} onNodeDoubleClick={(_event, flowNode) => {
      const data = flowNode.data as NodeCardData | FrameData;
      if ("node" in data) openNestedGroup(data.node);
    }} minZoom={.05} maxZoom={2.4} colorMode="dark" selectionOnDrag panOnScroll multiSelectionKeyCode={["Meta", "Control"]}>
      <Background gap={22} size={1.1} color="#30343a" />
      <MiniMap pannable zoomable nodeColor={(node) => node.type === "blenderFrame" ? "#24272b" : "#567064"} maskColor="rgba(8,9,11,.62)" />
      <Controls showInteractive={false} />
    </ReactFlow>
    <footer className="graph-statusbar"><span>{graph ? `${graph.nodes.length} nodes · ${graph.links.length} links` : "Loading graph…"}</span><span>{selected ? <><b>{selected.label}</b> · {compactType(selected.sourceType)} · {selected.inputs.length} in / {selected.outputs.length} out</> : "Select a node · double-click a group to enter"}</span><span>{graph?.unresolvedLinks.length ? `${graph.unresolvedLinks.length} unresolved links` : "Identifiers mapped deterministically"}</span></footer>
  </div>;
}
