import { useState } from "react";
import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import { GeometryNodesGraph } from "../geometry-nodes/GeometryNodesGraph";
import "./crayon-compare.css";

const loadCrayonCompare = () => import("../../crayon-compare");

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
    {graphOpen && <section className="crayon-graph"><header><b>Geometry Nodes workspace</b><span>edit values · reconnect wires · search · double-click groups · GN-VM live preview</span></header><div className="crayon-graph-workspace"><GeometryNodesGraph dumpUrl="dojo/crayon/dump.json" preferredObject="CHROME CRAYON OBJECT" changeEventName="crayon-graph-change" /></div></section>}
    <div className="crayon-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
