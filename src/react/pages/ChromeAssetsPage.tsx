import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import { useToolRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import { ToolStateOverlay } from "../studio/ToolStateOverlay";
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
  const runtimeState = useToolRuntime("Parity Catalog · Blender vs browser", loadChromeAssets);
  const query = new URLSearchParams(location.search);
  const [activeAssetId, setActiveAssetId] = useState(() => query.get("asset") ?? "");
  // The comparison is the page's purpose; the node workspace opens on demand.
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const showTypePixelBrushGraph = activeAssetId === "type-pixel-brush";
  const captureMode = query.get("capture");
  const shaderCapture = captureMode === "authored"
    || captureMode === "materialx-native"
    || captureMode === "materialx-prefilter"
    || (captureMode === "stippler-shader" && activeAssetId === "img-pixel-stippler");

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

  const rightDock = <>
    <StudioPanelHeader title="Parity asset" meta="Blender ↔ browser" />
    <div className="st-section">
      <label className="st-field assets-picker">
        <span>Ported asset</span>
        <div>
          <button id="assets-previous" className="st-btn" type="button" aria-label="Previous ported asset" title="Previous asset">←</button>
          <input id="assets-select" className="st-input" type="text" list="assets-options" autoComplete="off" aria-label="Ported asset" placeholder="Search assets…" />
          <datalist id="assets-options" />
          <button id="assets-next" className="st-btn" type="button" aria-label="Next ported asset" title="Next asset">→</button>
        </div>
      </label>
      <div id="assets-font-status" hidden />
      <p id="assets-note" className="st-finding" />
      {activeAssetId && <Link className="assets-open-studio" to={`/?asset=${activeAssetId}`}>Modulate in Procedural Studio →</Link>}
    </div>
    <div className="st-section">
      <div className="st-section-title">Authored inputs</div>
      <div id="assets-controls" />
      <button id="assets-reset" className="st-btn" type="button">Reset authored values</button>
    </div>
  </>;

  return <StudioShell
    className={`assets-shell ${shaderCapture ? "shader-capture" : ""}`}
    rightDock={rightDock}
    status={<>
      <span className="st-dot busy" />
      <span id="assets-status">Loading catalog…</span>
      <span className="st-spacer" />
      <span id="assets-runtime" className="st-muted">Worker idle</span>
    </>}
    nodeDock={showTypePixelBrushGraph && graphOpen && <section className={`st-node-dock ${graphMaximized ? "maximized" : ""}`}>
      <header>
        <b>Geometry Nodes</b>
        <small>Type Pixel Brush · double-click groups to enter</small>
        <div>
          <button className="st-btn" type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Full screen"}</button>
          <button className="st-btn" type="button" onClick={() => { setGraphMaximized(false); setGraphOpen(false); }}>Collapse</button>
        </div>
      </header>
      <div className="st-node-dock-body"><GeometryNodesEditor config={typePixelBrushEditorConfig} /></div>
    </section>}
  >
    <section className="assets-compare">
      <figure className="assets-pane"><figcaption><span>Blender reference</span><strong id="assets-blender-count">—</strong></figcaption><img id="assets-reference" alt="Isolated Blender reference render" /></figure>
      <figure className="assets-pane"><figcaption><span>Browser GN-VM · WebGL preview</span><strong id="assets-vm-count">—</strong></figcaption><canvas id="assets-canvas" /></figure>
      <ToolStateOverlay state={runtimeState} />
    </section>
    {showTypePixelBrushGraph && !graphOpen && <button className="graph-toggle st-btn" type="button" onClick={() => setGraphOpen(true)}>Show Geometry Nodes workspace</button>}
  </StudioShell>;
}
