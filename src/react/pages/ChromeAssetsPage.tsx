import { useEffect, useState } from "react";
import { StudioLink } from "../StudioLink";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import { usePageRuntime } from "../page-runtime";
import "./chrome-assets.css";
import "./crayon-compare.css";

const loadChromeAssets = () => import("../../chrome-assets");
const typePixelBrushEditorConfig = {
  dumpUrl: "dojo/chrome-assets/type-pixel-brush/dump.json",
  objectName: "Type Pixel Brush Chrome",
  rootGroupName: "soft pixel marker.001",
  events: {
    change: "type-pixel-brush-graph-change",
    nodeSelect: "type-pixel-brush-node-select",
    resize: "type-pixel-brush-graph-resize",
  },
  storageKey: "type-pixel-brush-gnvm-draft",
  downloadFileName: "type-pixel-brush-edited.json",
} as const;

export default function ChromeAssetsPage(): React.JSX.Element {
  usePageRuntime("Node Dojo Asset Library · Blender vs browser", loadChromeAssets);
  const [activeAssetId, setActiveAssetId] = useState(() => new URLSearchParams(location.search).get("asset") ?? "");
  const [graphOpen, setGraphOpen] = useState(true);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const showTypePixelBrushGraph = activeAssetId === "type-pixel-brush";

  useEffect(() => {
    const selected = (event: Event): void => {
      setActiveAssetId((event as CustomEvent<{ id?: string }>).detail?.id ?? "");
    };
    window.addEventListener("chrome-assets-selection-change", selected);
    return () => window.removeEventListener("chrome-assets-selection-change", selected);
  }, []);
  useEffect(() => {
    if (!graphMaximized) return;
    const restore = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setGraphMaximized(false);
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [graphMaximized]);
  useEffect(() => {
    if (!showTypePixelBrushGraph || !graphOpen) return;
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(typePixelBrushEditorConfig.events.resize)));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen, showTypePixelBrushGraph]);

  const closeGraph = (): void => {
    setGraphMaximized(false);
    setGraphOpen(false);
  };

  return <main className={`assets-shell ${showTypePixelBrushGraph && graphOpen ? "graph-open" : ""}`}>
    <StudioLink />
    <header className="assets-head"><p>Node Dojo coverage lab</p><h1>Live Asset Library</h1><div id="assets-status">Loading catalog…</div></header>
    <section className="assets-compare">
      <figure className="assets-pane"><figcaption><span>Blender reference</span><strong id="assets-blender-count">—</strong></figcaption><img id="assets-reference" alt="Isolated Blender reference render" /></figure>
      <figure className="assets-pane"><figcaption><span>Browser GN-VM · normalized material</span><strong id="assets-vm-count">—</strong></figcaption><canvas id="assets-canvas" /></figure>
    </section>
    <aside className="assets-panel">
      <label><span>Ported asset</span><select id="assets-select" /></label>
      <div id="assets-font-status" hidden />
      <p id="assets-note" />
      <div id="assets-controls" />
      <button id="assets-reset" type="button">Reset authored values</button>
      <small id="assets-runtime">Worker idle</small>
    </aside>
    {showTypePixelBrushGraph && !graphOpen && <button className="graph-toggle" type="button" onClick={() => setGraphOpen(true)}>Show Geometry Nodes workspace</button>}
    {showTypePixelBrushGraph && graphOpen && <section className={`crayon-graph ${graphMaximized ? "maximized" : ""}`}><header><b>Geometry Nodes · Type Pixel Brush</b><div className="graph-window-actions"><span>pan · zoom · box-select · reconnect noodles · F3 search · double-click groups</span><button type="button" onClick={() => setGraphMaximized((maximized) => !maximized)} title={graphMaximized ? "Restore workspace" : "Maximize workspace"}>{graphMaximized ? "Restore" : "Maximize"}</button><button type="button" onClick={closeGraph} title="Hide workspace">Hide</button></div></header><GeometryNodesEditor config={typePixelBrushEditorConfig} /></section>}
  </main>;
}
