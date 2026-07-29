import { useCallback, useEffect, useState } from "react";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import type { GeometryNodesPreset } from "../geometry-nodes/GraphPresetLibrary";
import { usePageRuntime } from "../page-runtime";
import { useCrayonRuntime } from "../crayon/useCrayonRuntime";
import { useStudioStatusChips } from "../studio/StudioChrome";
import { StudioOverlay, StudioShell, useMobileStudio } from "../studio/StudioShell";
import "./crayon-compare.css";

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
const initialOverrides = Object.fromEntries(controls.map((control) => [control.name, control.value]));

const crayonPresets: GeometryNodesPreset[] = [
  {
    id: "authored-source",
    name: "Authored Chrome Crayon",
    badge: "Source",
    description: "A clean fork of the checked-in Blender extraction, including every nested group and the authored layout.",
  },
  {
    id: "fast-topology",
    name: "Fast Topology Study",
    badge: "Performance",
    description: "Increases the final curve resample length for quicker topology experiments while retaining the graph structure.",
    transform(dump) {
      const resample = dump.node_groups[editorConfig.rootGroupName]?.nodes.find((node) => node.name === "Resample Curve");
      const length = resample?.inputs.find((socket) => socket.name === "Length");
      if (length) length.value = .24;
    },
  },
  {
    id: "dense-topology",
    name: "Dense Topology Study",
    badge: "Detail",
    description: "Uses a tighter final curve resample length for close-up surface and intermediate-output inspection.",
    transform(dump) {
      const resample = dump.node_groups[editorConfig.rootGroupName]?.nodes.find((node) => node.name === "Resample Curve");
      const length = resample?.inputs.find((socket) => socket.name === "Length");
      if (length) length.value = .05;
    },
  },
];

const UI_STORAGE_KEY = "procedural-studio.crayon.ui";

type CrayonUiState = { graphOpen: boolean };

function loadUiState(): CrayonUiState {
  const defaults = { graphOpen: true };
  try {
    const stored = localStorage.getItem(UI_STORAGE_KEY);
    return stored ? { ...defaults, ...JSON.parse(stored) as Partial<CrayonUiState> } : defaults;
  } catch {
    return defaults;
  }
}

export default function CrayonComparePage(): React.JSX.Element {
  usePageRuntime("Chrome Crayon · Blender vs browser Geometry Nodes");
  const isMobile = useMobileStudio();
  const [initialUi] = useState(loadUiState);
  // Mobile starts with the graph overlay closed regardless of the persisted
  // desktop preference; the FAB is its entry point.
  const [graphOpen, setGraphOpen] = useState(!isMobile && initialUi.graphOpen);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number>>(initialOverrides);
  const [layout, setLayoutState] = useState<"split" | "overlay">("split");
  const [shader, setShaderState] = useState<"diagnostic" | "chrome">("diagnostic");
  const runtime = useCrayonRuntime(initialOverrides);
  const persistUi = useCallback((patch: Partial<CrayonUiState>) => {
    try {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ ...loadUiState(), ...patch }));
    } catch {
      // Persistence is a convenience; authoring remains usable without storage.
    }
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
    if (!graphOpen) return;
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("crayon-graph-resize")));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen]);
  useEffect(() => {
    const timer = window.setTimeout(() => void runtime.evaluate(overrides), 300);
    return () => window.clearTimeout(timer);
  }, [overrides, runtime.evaluate]);

  useStudioStatusChips([{
    id: "gnvm",
    label: `GN-VM ${runtime.snapshot.state}`,
    tone: runtime.snapshot.state === "ready" ? "ready" : runtime.snapshot.state === "error" ? "error" : "busy",
  }]);

  const closeGraph = (): void => {
    setGraphMaximized(false);
    setGraphOpen(false);
    // Mobile open/close is transient inspection; only desktop persists it.
    if (!isMobile) persistUi({ graphOpen: false });
  };

  const leftDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Generator</button></div>
    <div className="st-section">
      <div className="st-section-title">Exposed group inputs<small>live</small></div>
      {controls.map((control) => <label className="st-row" key={control.name}>
        <span>{control.name}</span>
        <input type="range" min={control.min} max={control.max} step={control.step} value={overrides[control.name]} onChange={(event) => setOverrides((current) => ({ ...current, [control.name]: Number(event.target.value) }))} />
        <output>{overrides[control.name].toFixed(control.step === 1 ? 0 : 2)}</output>
      </label>)}
      <button className="st-btn-primary" type="button" disabled={runtime.snapshot.state === "evaluating"} onClick={() => void runtime.evaluate(overrides)}>Evaluate now</button>
    </div>
    <div className="st-section">
      <div className="st-section-title">Viewport</div>
      <div className="st-segmented">
        <button className={layout === "split" ? "active" : ""} type="button" onClick={() => { setLayoutState("split"); runtime.setLayout("split"); }}>Side by side</button>
        <button className={layout === "overlay" ? "active" : ""} type="button" onClick={() => { setLayoutState("overlay"); runtime.setLayout("overlay"); }}>Overlay</button>
      </div>
      <div className="st-section-title">Shader</div>
      <div className="st-segmented" title="Shared WebGL reconstruction applied to both meshes; this does not compare Blender shader output.">
        <button className={shader === "diagnostic" ? "active" : ""} type="button" onClick={() => { setShaderState("diagnostic"); runtime.setShader("diagnostic"); }}>Diagnostic</button>
        <button className={shader === "chrome" ? "active" : ""} type="button" onClick={() => { setShaderState("chrome"); runtime.setShader("chrome"); }}>WebGL chrome</button>
      </div>
    </div>
  </>;

  const rightDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Results</button></div>
    <div className="st-section">
      <div className="st-result-row truth">
        <span>Blender baseline</span>
        <strong>{runtime.snapshot.truthStats ? runtime.snapshot.truthStats.faces.toLocaleString() : "—"}</strong>
        <small>faces · {runtime.snapshot.truthStats ? `${runtime.snapshot.truthStats.verts.toLocaleString()} verts` : "evaluated .blend export"}</small>
      </div>
      <div className="st-result-row vm">
        <span>Browser GN-VM</span>
        <strong>{runtime.snapshot.vmStats ? runtime.snapshot.vmStats.faces.toLocaleString() : "—"}</strong>
        <small>faces · {runtime.snapshot.runtimeSeconds ? `${runtime.snapshot.runtimeSeconds.toFixed(2)}s in worker` : "Web Worker"}</small>
      </div>
      <div className="st-result-row delta">
        <span>Gap vs baseline</span>
        <strong>{runtime.snapshot.faceDelta == null ? "—" : `${runtime.snapshot.faceDelta >= 0 ? "+" : ""}${runtime.snapshot.faceDelta.toLocaleString()}`}</strong>
        <small>{runtime.snapshot.coverageMessage ?? "checking nodes…"}</small>
      </div>
    </div>
    <div className="st-section">
      <div className="st-section-title">Semantic contract</div>
      <p className="st-finding">Blender remains the behaviour oracle. GN-VM commits a new viewport result only after the edited graph evaluates successfully. Click a node with a geometry output to request an amber intermediate preview; double-click group nodes to enter their nested tree.</p>
    </div>
  </>;

  const nodeEditor = <GeometryNodesEditor config={editorConfig} onDumpChange={runtime.setDump} onPreviewChange={runtime.setProbe} presets={crayonPresets} />;

  return <StudioShell
    className="crayon-page"
    leftDock={leftDock}
    rightDock={rightDock}
    toolbar={<>
      <span className="st-swatch truth" aria-hidden="true" /><span>Blender truth</span>
      <span className="st-swatch vm" aria-hidden="true" /><span>GN-VM</span>
      <span className="st-spacer" />
      <span>{runtime.snapshot.selectionMessage}</span>
      {!isMobile && <button className="st-btn" type="button" onClick={() => {
        const next = !graphOpen;
        setGraphOpen(next);
        persistUi({ graphOpen: next });
      }}>{graphOpen ? "Hide node editor" : "Show node editor"}</button>}
    </>}
    status={<>
      <span className={`st-dot ${runtime.snapshot.state === "ready" ? "ready" : runtime.snapshot.state === "error" ? "error" : "busy"}`} />
      <span>{runtime.snapshot.message}</span>
      <span className="st-sep" />
      <span className="st-muted">drag to orbit · scroll to zoom · F3 search in the graph</span>
    </>}
    nodeDock={!isMobile && graphOpen && <section className={`st-node-dock ${graphMaximized ? "maximized" : ""}`}>
      <header>
        <b>Geometry Nodes</b>
        <small>pan · zoom · box-select · F3 search</small>
        <div>
          <button className="st-btn" type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Full screen"}</button>
          <button className="st-btn" type="button" onClick={closeGraph}>Collapse</button>
        </div>
      </header>
      <div className="st-node-dock-body">{nodeEditor}</div>
    </section>}
  >
    <canvas ref={runtime.canvasRef} id="crayon-canvas" />
    {isMobile && !graphOpen && <button className="graph-toggle" type="button" onClick={() => setGraphOpen(true)}>Open node editor</button>}
    {isMobile && graphOpen && <StudioOverlay title="Geometry Nodes" onClose={closeGraph}>{nodeEditor}</StudioOverlay>}
  </StudioShell>;
}
