import { useCallback, useEffect, useState } from "react";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import type { GeometryNodesPreset } from "../geometry-nodes/GraphPresetLibrary";
import { usePageRuntime } from "../page-runtime";
import { useCrayonRuntime } from "../crayon/useCrayonRuntime";
import { FloatingStudioPanel, StudioShell, type StudioPanelRect } from "../studio/StudioShell";
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

type CrayonUiState = {
  docksOpen: boolean;
  graphOpen: boolean;
  graphRect: StudioPanelRect;
};

function defaultGraphRect(): StudioPanelRect {
  const width = Math.min(1120, Math.max(640, window.innerWidth - 650));
  const height = Math.min(620, Math.max(420, window.innerHeight - 180));
  return {
    x: Math.max(304, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(92, window.innerHeight - height - 28),
    width,
    height,
  };
}

function loadUiState(): CrayonUiState {
  const defaults = { docksOpen: true, graphOpen: true, graphRect: defaultGraphRect() };
  try {
    const stored = localStorage.getItem(UI_STORAGE_KEY);
    return stored ? { ...defaults, ...JSON.parse(stored) as Partial<CrayonUiState> } : defaults;
  } catch {
    return defaults;
  }
}

export default function CrayonComparePage(): React.JSX.Element {
  usePageRuntime("Chrome Crayon · Blender vs browser Geometry Nodes");
  const [initialUi] = useState(loadUiState);
  const [docksOpen, setDocksOpen] = useState(initialUi.docksOpen);
  const [graphOpen, setGraphOpen] = useState(initialUi.graphOpen);
  const [graphRect, setGraphRect] = useState(initialUi.graphRect);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number>>(initialOverrides);
  const [layout, setLayoutState] = useState<"split" | "overlay">("split");
  const [shader, setShaderState] = useState<"diagnostic" | "chrome">("diagnostic");
  const runtime = useCrayonRuntime(initialOverrides);
  const persistUi = useCallback((patch: Partial<CrayonUiState>) => {
    try {
      const current = loadUiState();
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
    } catch {
      // Persistence is a convenience; authoring remains usable without storage.
    }
  }, []);
  const updateGraphRect = useCallback((rect: StudioPanelRect) => {
    setGraphRect(rect);
    persistUi({ graphRect: rect });
  }, [persistUi]);
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

  const closeGraph = (): void => {
    setGraphMaximized(false);
    setGraphOpen(false);
    persistUi({ graphOpen: false });
  };

  const leftDock = <>
    <header className="studio-dock-header"><span>Generator</span><small>GN-VM inputs</small></header>
    <section><div className="section-title"><span>Exposed group inputs</span><small>live values</small></div>
        <div className="crayon-inputs">{controls.map((control) => <label key={control.name}><span>{control.name}</span><input type="range" min={control.min} max={control.max} step={control.step} value={overrides[control.name]} onChange={(event) => setOverrides((current) => ({ ...current, [control.name]: Number(event.target.value) }))} /><output>{overrides[control.name].toFixed(control.step === 1 ? 0 : 2)}</output></label>)}</div>
        <button id="crayon-update" type="button" disabled={runtime.snapshot.state === "evaluating"} onClick={() => void runtime.evaluate(overrides)}>Evaluate now</button>
    </section>
    <section><span className="panel-label">Viewport</span><div className="crayon-segment"><button className={layout === "split" ? "active" : ""} type="button" onClick={() => { setLayoutState("split"); runtime.setLayout("split"); }}>Side by side</button><button className={layout === "overlay" ? "active" : ""} type="button" onClick={() => { setLayoutState("overlay"); runtime.setLayout("overlay"); }}>Overlay</button></div></section>
    <section><span className="panel-label">Shader</span><div className="crayon-segment shader-segment"><button className={shader === "diagnostic" ? "active" : ""} type="button" onClick={() => { setShaderState("diagnostic"); runtime.setShader("diagnostic"); }}>Diagnostic</button><button className={shader === "chrome" ? "active" : ""} type="button" onClick={() => { setShaderState("chrome"); runtime.setShader("chrome"); }}>WebGL chrome</button></div><p className="shader-caption">Shared WebGL reconstruction applied to both meshes; this does not compare Blender shader output.</p></section>
  </>;

  const rightDock = <>
    <header className="studio-dock-header"><span>Analysis</span><small>last valid result</small></header>
    <section>
      <div className={`crayon-status ${runtime.snapshot.state === "ready" ? "ready" : ""} ${runtime.snapshot.state === "error" ? "error" : ""}`}><span />{runtime.snapshot.message}</div>
      <div className="crayon-selection">{runtime.snapshot.selectionMessage}</div>
    </section>
    <section className="crayon-metrics">
        <article><span>Blender baseline</span><strong>{runtime.snapshot.truthStats ? `${runtime.snapshot.truthStats.verts.toLocaleString()} verts · ${runtime.snapshot.truthStats.faces.toLocaleString()} faces` : "—"}</strong><small>evaluated .blend export</small></article>
        <article><span>Browser GN-VM</span><strong>{runtime.snapshot.vmStats ? `${runtime.snapshot.vmStats.verts.toLocaleString()} verts · ${runtime.snapshot.vmStats.faces.toLocaleString()} faces` : "—"}</strong><small>{runtime.snapshot.runtimeSeconds ? `${runtime.snapshot.runtimeSeconds.toFixed(2)}s · Web Worker` : "Web Worker"}</small></article>
        <article><span>Gap vs baseline</span><strong>{runtime.snapshot.faceDelta == null ? "—" : `${runtime.snapshot.faceDelta >= 0 ? "+" : ""}${runtime.snapshot.faceDelta.toLocaleString()} faces`}</strong><small>{runtime.snapshot.coverageMessage ?? "checking nodes…"}</small></article>
    </section>
    <section className="crayon-note"><span className="panel-label">Semantic contract</span><p>Blender remains the behavior oracle. GN-VM commits a new viewport result only after the edited graph evaluates successfully.</p><p>Click a node with a geometry output to request an amber intermediate preview. Double-click group nodes to enter their nested tree.</p></section>
  </>;

  return <StudioShell
    eyebrow="Geometry Nodes portability lab"
    title="Chrome Crayon"
    subtitle={<>Blender truth <b className="truth-text">red</b> · GN-VM <b className="vm-text">blue</b></>}
    docksOpen={docksOpen}
    onToggleDocks={() => {
      setDocksOpen((open) => {
        persistUi({ docksOpen: !open });
        return !open;
      });
    }}
    leftDock={leftDock}
    rightDock={rightDock}
    footer={<>Three.js viewport · drag to orbit · scroll to zoom</>}
  >
    <canvas ref={runtime.canvasRef} id="crayon-canvas" />
    {!graphOpen && <button className="graph-toggle" type="button" onClick={() => {
      setGraphOpen(true);
      persistUi({ graphOpen: true });
    }}>Show Geometry Nodes workspace</button>}
    {graphOpen && <FloatingStudioPanel
      className="crayon-graph"
      rect={graphRect}
      onRectChange={updateGraphRect}
      maximized={graphMaximized}
      title="Geometry Nodes"
      actions={<>
        <span>pan · zoom · box-select · F3 search</span>
        <button type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Maximize"}</button>
        <button type="button" onClick={closeGraph}>Hide</button>
      </>}
    >
      <GeometryNodesEditor config={editorConfig} onDumpChange={runtime.setDump} onPreviewChange={runtime.setProbe} presets={crayonPresets} />
    </FloatingStudioPanel>}
  </StudioShell>;
}
