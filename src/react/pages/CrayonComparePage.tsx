import { useEffect, useState } from "react";
import { StudioLink } from "../StudioLink";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import { usePageRuntime } from "../page-runtime";
import "./crayon-compare.css";

const loadCrayonCompare = () => import("../../crayon-compare");

const editorConfig = {
  dumpUrl: "dojo/crayon/dump.json",
  objectName: "CHROME CRAYON OBJECT",
  rootGroupName: "CHROME CRAYON 3D _4.3_DEC2024",
  events: {
    change: "crayon-graph-change",
    nodeSelect: "crayon-node-select",
    resize: "crayon-graph-resize",
  },
  storageKey: "crayon-gnvm-draft",
  downloadFileName: "chrome-crayon-edited.json",
} as const;

const controls = [
  { name: "Sigilize", min: 3, max: 50, step: 1, value: 20 },
  { name: "Soften", min: 0, max: 8, step: 1, value: 0 },
  { name: "SPIRO", min: 0, max: 5, step: 1, value: 0 },
  { name: "resolution", min: 0.1, max: 1, step: 0.05, value: 0.2 },
];

export default function CrayonComparePage(): React.JSX.Element {
  usePageRuntime("Chrome Crayon · Blender vs browser Geometry Nodes", loadCrayonCompare);
  const [graphOpen, setGraphOpen] = useState(true);
  const [graphMaximized, setGraphMaximized] = useState(false);
  useEffect(() => {
    if (!graphMaximized) return;
    const restore = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setGraphMaximized(false);
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [graphMaximized]);
  useEffect(() => {
    if (!graphOpen) return;
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("crayon-graph-resize")));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen]);

  const closeGraph = (): void => {
    setGraphMaximized(false);
    setGraphOpen(false);
  };

  return <main className={`crayon-shell ${graphOpen ? "graph-open" : ""}`}>
    <canvas id="crayon-canvas" />
    <StudioLink />
    <header className="crayon-head">
      <p className="kicker">Geometry Nodes portability lab</p>
      <h1>Chrome Crayon</h1>
      <p>Blender 5.1 truth <b className="truth-text">red</b> vs the Web Worker GN-VM <b className="vm-text">blue</b>.</p>
      <div id="crayon-status" className="crayon-status"><span />Loading portable graph…</div>
      <div id="crayon-selection" className="crayon-selection">Output preview · final geometry</div>
    </header>
    <aside className="crayon-panel">
      <section><div className="section-title"><span>Exposed group inputs</span><small>GN-VM live values</small></div>
        <div className="crayon-inputs">{controls.map((control) => <label key={control.name}><span>{control.name}</span><input data-crayon-param={control.name} type="range" min={control.min} max={control.max} step={control.step} defaultValue={control.value} /><output data-crayon-output={control.name}>{control.value}</output></label>)}</div>
        <button id="crayon-update" type="button">Evaluate in browser</button>
      </section>
      <section><span className="panel-label">Viewport</span><div className="crayon-segment"><button id="crayon-split" className="active" type="button">Side by side</button><button id="crayon-overlay" type="button">Overlay</button></div></section>
      <section><span className="panel-label">Shader</span><div className="crayon-segment shader-segment"><button id="crayon-shader-debug" className="active" type="button">Diagnostic</button><button id="crayon-shader-chrome" type="button">WebGL chrome</button></div><p className="shader-caption">Shared WebGL reconstruction applied to both meshes; this does not compare Blender shader output.</p></section>
      <section className="crayon-metrics">
        <article><span>Blender baseline</span><strong id="crayon-truth-count">—</strong><small>evaluated .blend export</small></article>
        <article><span>Browser GN-VM</span><strong id="crayon-vm-count">—</strong><small id="crayon-runtime">Web Worker</small></article>
        <article><span>Gap vs baseline</span><strong id="crayon-gap">—</strong><small id="crayon-coverage">checking nodes…</small></article>
      </section>
      <section className="crayon-note"><span className="panel-label">Semantic contract</span><p>Blender remains the behavior oracle. The editor projects the extracted JSON while GN-VM evaluates the untouched graph payload.</p><p>Click a node with a geometry output to request an amber intermediate-geometry probe in the Three.js viewport. Double-click group nodes to navigate their nested tree.</p></section>
    </aside>
    {!graphOpen && <button className="graph-toggle" type="button" onClick={() => setGraphOpen(true)}>Show Geometry Nodes workspace</button>}
    {graphOpen && <section className={`crayon-graph ${graphMaximized ? "maximized" : ""}`}><header><b>Geometry Nodes</b><div className="graph-window-actions"><span>pan · zoom · box-select · reconnect noodles · F3 search · double-click groups</span><button type="button" onClick={() => setGraphMaximized((maximized) => !maximized)} title={graphMaximized ? "Restore workspace" : "Maximize workspace"}>{graphMaximized ? "Restore" : "Maximize"}</button><button type="button" onClick={closeGraph} title="Hide workspace">Hide</button></div></header><GeometryNodesEditor config={editorConfig} /></section>}
    <div className="crayon-help">Three.js viewport · drag to orbit · scroll to zoom</div>
  </main>;
}
