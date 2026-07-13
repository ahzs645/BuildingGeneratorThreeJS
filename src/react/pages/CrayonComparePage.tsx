import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import { publicUrl } from "../../base-url";
import "./crayon-compare.css";

const loadCrayonCompare = () => import("../../crayon-compare");

type DumpSocket = { name: string; identifier: string; type: string; linked: boolean; enabled?: boolean; hide?: boolean; hide_value?: boolean; value?: unknown; default?: unknown };
type DumpNode = {
  name: string;
  type: string;
  label?: string | null;
  group?: string;
  inputs: DumpSocket[];
  outputs: DumpSocket[];
  ui?: { location_absolute: number[]; width: number; height: number; dimensions?: number[]; hide?: boolean; mute?: boolean; use_custom_color?: boolean; color?: number[]; parent?: string | null };
};
type DumpLink = { from_node: string; from_socket: string; to_node: string; to_socket: string; from_type?: string; to_type?: string; multi_input_sort_id?: number | null };
type DumpGraph = { nodes: DumpNode[]; links: DumpLink[] };
type Dump = { objects: { modifiers?: { node_group?: string }[] }[]; node_groups: Record<string, DumpGraph> };
type BlenderNodeData = { node: DumpNode; width: number; onSocketChange: (nodeName: string, socketId: string, value: unknown) => void };
type BlenderFrameData = { title: string; width: number; height: number };

const SOCKET_COLORS: Record<string, string> = {
  NodeSocketGeometry: "#13d5ac", NodeSocketFloat: "#a9a9a9", NodeSocketFloatFactor: "#a9a9a9", NodeSocketFloatDistance: "#a9a9a9",
  NodeSocketInt: "#9acb6b", NodeSocketBool: "#d787b7", NodeSocketVector: "#6b9bd2", NodeSocketVectorTranslation: "#6b9bd2",
  NodeSocketColor: "#d8c85e", NodeSocketMaterial: "#d05bce", NodeSocketObject: "#ef8a46", NodeSocketString: "#87d5be", NodeSocketMenu: "#8c8c8c",
};
const socketColor = (type: string) => SOCKET_COLORS[type] ?? (type.includes("Vector") || type.includes("Rotation") ? "#6b9bd2" : "#9a9a9a");
const nodeTone = (type: string) => type === "NodeGroupInput" ? "input" : type === "NodeGroupOutput" ? "output" : type === "GeometryNodeGroup" ? "group" : type.startsWith("GeometryNode") ? "geometry" : type.startsWith("ShaderNode") ? "shader" : type.startsWith("FunctionNode") ? "function" : "utility";
const compactType = (type: string) => type.replace(/^(GeometryNode|ShaderNode|FunctionNode|Node)/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
const visibleSockets = (sockets: DumpSocket[]) => sockets.filter((socket) => socket.enabled !== false && (!socket.hide || socket.linked) && socket.identifier !== "__extend__");

function valueLabel(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
  if (typeof value === "string") return value.length > 12 ? `${value.slice(0, 11)}…` : value;
  if (Array.isArray(value)) return value.length >= 3 ? value.slice(0, 3).map((part) => Number(part).toFixed(2)).join(" · ") : value.join(" · ");
  if (value && typeof value === "object" && "name" in value) return String((value as { name: unknown }).name);
  return "";
}

function SocketValue({ socket, onChange }: { socket: DumpSocket; onChange: (value: unknown) => void }): React.JSX.Element | null {
  const value = socket.value;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  if (socket.type === "NodeSocketBool") return <input className="socket-editor socket-check nodrag" aria-label={`${socket.name} value`} type="checkbox" checked={Boolean(value)} onPointerDown={stop} onChange={(event) => onChange(event.target.checked)} />;
  if (typeof value === "number") return <input className="socket-editor socket-number nodrag nowheel" aria-label={`${socket.name} value`} type="number" step={socket.type === "NodeSocketInt" ? 1 : "any"} value={value} onPointerDown={stop} onWheel={stop} onChange={(event) => onChange(socket.type === "NodeSocketInt" ? Math.round(Number(event.target.value)) : Number(event.target.value))} />;
  if (typeof value === "string") return <input className="socket-editor socket-text nodrag" aria-label={`${socket.name} value`} value={value} onPointerDown={stop} onChange={(event) => onChange(event.target.value)} />;
  if (Array.isArray(value) && value.every((part) => typeof part === "number")) return <input className="socket-editor socket-vector nodrag" aria-label={`${socket.name} value`} defaultValue={value.join(", ")} onPointerDown={stop} onBlur={(event) => {
    const parts = event.target.value.split(",").map(Number);
    if (parts.length === value.length && parts.every(Number.isFinite)) onChange(parts);
  }} />;
  return null;
}

function SocketRow({ socket, direction, nodeName, onSocketChange }: { socket: DumpSocket; direction: "input" | "output"; nodeName: string; onSocketChange: BlenderNodeData["onSocketChange"] }): React.JSX.Element {
  const editable = direction === "input" && !socket.linked && !socket.hide_value;
  const value = editable ? valueLabel(socket.value) : "";
  return <div className={`blender-socket-row ${direction}`} title={`${socket.name} · ${compactType(socket.type)}`}>
    <Handle type={direction === "input" ? "target" : "source"} position={direction === "input" ? Position.Left : Position.Right} id={socket.identifier} style={{ background: socketColor(socket.type) }} />
    <span className="socket-dot" style={{ borderColor: socketColor(socket.type), background: socket.linked ? socketColor(socket.type) : "#20242a" }} />
    <span className="socket-name">{socket.name || compactType(socket.type)}</span>
    {editable ? <SocketValue socket={socket} onChange={(next) => onSocketChange(nodeName, socket.identifier, next)} /> : value && <span className="socket-value">{value}</span>}
  </div>;
}

function BlenderNode({ data }: NodeProps<Node<BlenderNodeData>>): React.JSX.Element {
  const node = data.node;
  if (node.type === "NodeReroute") return <div className="blender-reroute"><Handle type="target" position={Position.Left} id={node.inputs[0]?.identifier ?? "Input"} /><Handle type="source" position={Position.Right} id={node.outputs[0]?.identifier ?? "Output"} /></div>;
  const inputs = visibleSockets(node.inputs), outputs = visibleSockets(node.outputs);
  return <div className={`blender-node tone-${nodeTone(node.type)} ${node.ui?.mute ? "muted" : ""}`} style={{ width: data.width }}>
    <div className="blender-node-title"><span>{node.label || node.name}</span>{node.group && <i>↳</i>}</div>
    <div className="blender-node-type">{compactType(node.type)}</div>
    {!node.ui?.hide && <div className="blender-node-body">
      <div className="socket-list inputs">{inputs.map((socket) => <SocketRow key={socket.identifier} socket={socket} direction="input" nodeName={node.name} onSocketChange={data.onSocketChange} />)}</div>
      <div className="socket-list outputs">{outputs.map((socket) => <SocketRow key={socket.identifier} socket={socket} direction="output" nodeName={node.name} onSocketChange={data.onSocketChange} />)}</div>
    </div>}
  </div>;
}

function BlenderFrame({ data }: NodeProps<Node<BlenderFrameData>>): React.JSX.Element {
  return <div className="blender-frame" style={{ width: data.width, height: data.height }}><span>{data.title}</span></div>;
}

const nodeTypes = { blenderNode: BlenderNode, blenderFrame: BlenderFrame };

function GraphPanel(): React.JSX.Element {
  const [dump, setDump] = useState<Dump | null>(null);
  const [groupName, setGroupName] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [undoStack, setUndoStack] = useState<Dump[]>([]);
  const [redoStack, setRedoStack] = useState<Dump[]>([]);
  const [dirty, setDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
  const refreshLinkedFlags = (graph: DumpGraph) => {
    for (const node of graph.nodes) {
      for (const socket of node.inputs) socket.linked = graph.links.some((link) => link.to_node === node.name && link.to_socket === socket.identifier);
      for (const socket of node.outputs) socket.linked = graph.links.some((link) => link.from_node === node.name && link.from_socket === socket.identifier);
    }
  };
  const changeSocket = useCallback((nodeName: string, socketId: string, value: unknown) => commit((next) => {
    const socket = next.node_groups[groupName]?.nodes.find((node) => node.name === nodeName)?.inputs.find((input) => input.identifier === socketId);
    if (socket) socket.value = value;
  }), [commit, groupName]);

  useEffect(() => {
    fetch(publicUrl("dojo/crayon/dump.json")).then((response) => response.json()).then((loaded: Dump) => {
      const rootName = loaded.objects.flatMap((object) => object.modifiers ?? []).find((modifier) => modifier.node_group)?.node_group;
      setDump(loaded);
      if (rootName) setGroupName(rootName);
    });
  }, []);
  useEffect(() => {
    if (!dump) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new CustomEvent("crayon-graph-change", { detail: { dump } })), 180);
    if (dirty) localStorage.setItem("crayon-gnvm-draft", JSON.stringify(dump));
    return () => window.clearTimeout(timer);
  }, [dump, dirty]);
  useEffect(() => {
    const graph = dump?.node_groups[groupName];
    if (!graph) return;
    const scale = .46;
    const nextNodes: Node[] = graph.nodes.map((node) => {
      const absolute = node.ui?.location_absolute ?? [0, 0];
      if (node.type === "NodeFrame") {
        return {
          id: node.name, type: "blenderFrame", position: { x: absolute[0] * scale, y: -absolute[1] * scale },
          data: { title: node.label || node.name, width: Math.max(120, (node.ui?.width ?? 300) * scale), height: Math.max(90, (node.ui?.height ?? 200) * scale) },
          selectable: false, draggable: false, zIndex: -10,
        };
      }
      return {
        id: node.name, type: "blenderNode", position: { x: absolute[0] * scale, y: -absolute[1] * scale },
        data: { node, width: Math.max(118, Math.min(276, (node.ui?.width ?? 140) * scale + 82)), onSocketChange: changeSocket },
        zIndex: 2,
      };
    });
    setNodes(nextNodes);
    setEdges(graph.links.map((link, index) => ({
      id: `e:${link.from_node}:${link.from_socket}:${link.to_node}:${link.to_socket}:${index}`, source: link.from_node, sourceHandle: link.from_socket, target: link.to_node, targetHandle: link.to_socket,
      type: "bezier", style: { stroke: socketColor(link.from_type ?? ""), strokeWidth: link.from_type === "NodeSocketGeometry" ? 2.6 : 1.65, opacity: .9 },
    })));
  }, [dump, groupName, changeSocket]);
  const groupNames = useMemo(() => Object.keys(dump?.node_groups ?? {}).sort(), [dump]);
  const openGroup = (next: string) => { if (!next || next === groupName) return; setHistory((items) => [...items, groupName]); setGroupName(next); };
  const goBack = () => setHistory((items) => { const next = [...items]; const previous = next.pop(); if (previous) setGroupName(previous); return next; });
  const undo = () => setUndoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], previous = next.pop()!;
    setRedoStack((redo) => [...redo, dump]); setDump(previous); setDirty(true); return next;
  });
  const redo = () => setRedoStack((items) => {
    if (!items.length || !dump) return items;
    const next = [...items], following = next.pop()!;
    setUndoStack((undoItems) => [...undoItems, dump]); setDump(following); setDirty(true); return next;
  });
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const { source, target, sourceHandle, targetHandle } = connection;
    commit((next) => {
      const graph = next.node_groups[groupName];
      if (!graph) return;
      const from = graph.nodes.find((node) => node.name === source)?.outputs.find((socket) => socket.identifier === sourceHandle);
      const toNode = graph.nodes.find((node) => node.name === target);
      const to = toNode?.inputs.find((socket) => socket.identifier === targetHandle);
      if (!from || !to) return;
      const existing = graph.links.filter((link) => link.to_node === target && link.to_socket === targetHandle);
      const isMulti = existing.some((link) => link.multi_input_sort_id != null) || /JoinGeometry|GeometryToInstance/.test(toNode?.type ?? "");
      if (!isMulti) graph.links = graph.links.filter((link) => link.to_node !== target || link.to_socket !== targetHandle);
      const duplicate = graph.links.some((link) => link.from_node === source && link.from_socket === sourceHandle && link.to_node === target && link.to_socket === targetHandle);
      if (!duplicate) graph.links.push({ from_node: source, from_socket: sourceHandle, to_node: target, to_socket: targetHandle, from_type: from.type, to_type: to.type, ...(isMulti ? { multi_input_sort_id: Math.max(0, ...existing.map((link) => link.multi_input_sort_id ?? 0)) + 1 } : {}) });
      refreshLinkedFlags(graph);
    });
  };
  const deleteEdges = (removed: Edge[]) => commit((next) => {
    const graph = next.node_groups[groupName];
    if (!graph) return;
    const keys = new Set(removed.map((edge) => `${edge.source}|${edge.sourceHandle}|${edge.target}|${edge.targetHandle}`));
    graph.links = graph.links.filter((link) => !keys.has(`${link.from_node}|${link.from_socket}|${link.to_node}|${link.to_socket}`));
    refreshLinkedFlags(graph);
  });
  const saveJson = () => {
    if (!dump) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(dump, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "chrome-crayon-edited.json"; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000); setDirty(false);
  };
  const importJson = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as Dump;
    if (!parsed.node_groups || !parsed.objects) throw new Error("Not a portable Geometry Nodes dump");
    if (dump) setUndoStack((items) => [...items, dump]);
    setDump(parsed); setRedoStack([]); setDirty(true);
    const root = parsed.objects.flatMap((object) => object.modifiers ?? []).find((modifier) => modifier.node_group)?.node_group;
    if (root) setGroupName(root);
  };
  return <div className="blender-flow-wrap">
    <div className="blender-flow-toolbar"><button type="button" disabled={!history.length} onClick={goBack} title="Back">←</button><span>Geometry Nodes{dirty ? " •" : ""}</span><select aria-label="Node group" value={groupName} onChange={(event) => openGroup(event.target.value)}>{groupNames.map((name) => <option key={name}>{name}</option>)}</select><div className="graph-actions"><button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">↶</button><button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">↷</button><button type="button" onClick={() => fileInput.current?.click()} title="Open portable JSON">Open</button><button type="button" onClick={saveJson} disabled={!dump} title="Save portable JSON">Save</button></div><input ref={fileInput} className="graph-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importJson(file).catch((error) => window.alert(error instanceof Error ? error.message : String(error))); event.target.value = ""; }} /></div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={(changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current))} onConnect={connect} onEdgesDelete={deleteEdges} deleteKeyCode={["Backspace", "Delete"]} onNodeDoubleClick={(_event, node) => { const target = (node.data as BlenderNodeData).node?.group; if (target) openGroup(target); }} fitView fitViewOptions={{ padding: .12 }} minZoom={0.06} maxZoom={2.2} colorMode="dark" selectionOnDrag panOnScroll>
      <Background gap={22} size={1.2} color="#30343a" /><MiniMap pannable zoomable nodeColor={(node) => node.type === "blenderFrame" ? "#25282d" : "#53606b"} /><Controls />
    </ReactFlow>
  </div>;
}

const controls = [
  { name: "Sigilize", min: 3, max: 50, step: 1, value: 20 },
  { name: "Soften", min: 0, max: 8, step: 1, value: 0 },
  { name: "SPIRO", min: 0, max: 5, step: 1, value: 0 },
  { name: "resolution", min: 0.1, max: 1, step: 0.05, value: 0.2 },
];

export default function CrayonComparePage(): React.JSX.Element {
  usePageRuntime("Chrome Crayon · Blender vs browser Geometry Nodes", loadCrayonCompare);
  const [graphOpen, setGraphOpen] = useState(true);
  return <main className={`crayon-shell ${graphOpen ? "graph-open" : ""}`}>
    <canvas id="crayon-canvas" />
    <StudioLink />
    <header className="crayon-head">
      <p className="kicker">Geometry Nodes portability lab</p>
      <h1>Chrome Crayon</h1>
      <p>Blender 5.1 truth <b className="truth-text">red</b> vs the Web Worker GN-VM <b className="vm-text">blue</b>.</p>
      <div id="crayon-status" className="crayon-status"><span />Loading portable graph…</div>
    </header>
    <aside className="crayon-panel">
      <section><div className="section-title"><span>Shared inputs</span><small>portable JSON</small></div>
        <div className="crayon-inputs">{controls.map((control) => <label key={control.name}><span>{control.name}</span><input data-crayon-param={control.name} type="range" min={control.min} max={control.max} step={control.step} defaultValue={control.value} /><output data-crayon-output={control.name}>{control.value}</output></label>)}</div>
        <button id="crayon-update" type="button">Evaluate in browser</button>
      </section>
      <section><span className="panel-label">View</span><div className="crayon-segment"><button id="crayon-split" className="active" type="button">Side by side</button><button id="crayon-overlay" type="button">Overlay</button></div></section>
      <section><span className="panel-label">Shader</span><div className="crayon-segment shader-segment"><button id="crayon-shader-debug" className="active" type="button">Diagnostic</button><button id="crayon-shader-chrome" type="button">Chrome</button></div><p className="shader-caption">Chrome reconstructs the authored metallic Principled surface and procedural roughness in WebGL.</p></section>
      <section className="crayon-metrics">
        <article><span>Blender baseline</span><strong id="crayon-truth-count">—</strong><small>evaluated .blend export</small></article>
        <article><span>Browser GN-VM</span><strong id="crayon-vm-count">—</strong><small id="crayon-runtime">Web Worker</small></article>
        <article><span>Gap vs baseline</span><strong id="crayon-gap">—</strong><small id="crayon-coverage">checking nodes…</small></article>
      </section>
      <section className="crayon-note"><span className="panel-label">Parity status</span><p>The graph executes end-to-end with no missing node types. At the baseline, bidirectional p99 surface error is 0.519 / 0.429 units; the remaining 36-face gap comes from tiny-threshold endpoint weld precision.</p><p>SPIRO repeat geometry now runs through the complete curve and marching-surface chain: SPIRO 2 produces 11,524 browser faces versus Blender's 11,602, with 0.191 / 0.198 p99 surface error.</p><p>The Blender GLB flattened the attribute-driven material, so Chrome mode reconstructs <code>chrome.003</code> directly from the dumped shader graph.</p></section>
    </aside>
    <button className="graph-toggle" type="button" onClick={() => setGraphOpen((open) => !open)}>{graphOpen ? "Hide" : "Show"} Blender graph</button>
    {graphOpen && <section className="crayon-graph"><header><b>Editable Blender graph</b><span>edit values · reconnect wires · Delete removes a wire · live evaluation</span></header><GraphPanel /></section>}
    <div className="crayon-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
