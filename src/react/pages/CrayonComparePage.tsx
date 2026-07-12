import { useEffect, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import { publicUrl } from "../../base-url";
import "./crayon-compare.css";

const loadCrayonCompare = () => import("../../crayon-compare");

type DumpNode = { name: string; type: string };
type DumpLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type Dump = { objects: { modifiers?: { node_group?: string }[] }[]; node_groups: Record<string, { nodes: DumpNode[]; links: DumpLink[] }> };

function GraphPanel(): React.JSX.Element {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => {
    fetch(publicUrl("dojo/crayon/dump.json")).then((response) => response.json()).then((dump: Dump) => {
      const rootName = dump.objects.flatMap((object) => object.modifiers ?? []).find((modifier) => modifier.node_group)?.node_group;
      const graph = rootName ? dump.node_groups[rootName] : undefined;
      if (!graph) return;
      const incoming = new Map<string, number>();
      graph.links.forEach((link) => incoming.set(link.to_node, (incoming.get(link.to_node) ?? 0) + 1));
      setNodes(graph.nodes.map((node, index) => ({
        id: node.name,
        position: { x: (index % 7) * 205, y: Math.floor(index / 7) * 92 },
        data: { label: <><strong>{node.name}</strong><small>{node.type.replace(/^(GeometryNode|ShaderNode|FunctionNode)/, "")}</small></> },
        className: node.type === "NodeGroupInput" || node.type === "NodeGroupOutput" ? "graph-terminal" : incoming.has(node.name) ? "" : "graph-source",
      })));
      setEdges(graph.links.map((link, index) => ({ id: `e${index}`, source: link.from_node, target: link.to_node, animated: false })));
    });
  }, []);
  return <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.08} maxZoom={1.4} nodesDraggable colorMode="dark"><Background gap={18} size={1} /><MiniMap pannable zoomable /><Controls /></ReactFlow>;
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
        <article><span>Current gap</span><strong id="crayon-gap">—</strong><small id="crayon-coverage">checking nodes…</small></article>
      </section>
      <section className="crayon-note"><span className="panel-label">Parity status</span><p>The graph executes end-to-end with no missing node types. At the baseline, bidirectional p99 surface error is 0.519 / 0.429 units; the remaining 36-face gap comes from tiny-threshold endpoint weld precision.</p><p>The Blender GLB flattened the attribute-driven material, so Chrome mode reconstructs <code>chrome.003</code> directly from the dumped shader graph.</p></section>
    </aside>
    <button className="graph-toggle" type="button" onClick={() => setGraphOpen((open) => !open)}>{graphOpen ? "Hide" : "Show"} Blender graph</button>
    {graphOpen && <section className="crayon-graph"><header><b>Authored Blender graph</b><span>drag · zoom · inspect connections</span></header><GraphPanel /></section>}
    <div className="crayon-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
