import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { LibraryShapeInfo } from "../../base-shape-catalog";
import { listLibraryShapes } from "../../base-shape-catalog";
import type { SurfaceGeneratorId } from "../../surface-studio/contracts";
import { surfaceGenerator } from "../../surface-studio/generator-catalog";
import type {
  SurfacePainterStudioSnapshot,
  SurfacePainterToolHandle,
} from "../../surface-painter/main";
import { chromeCrayonEditorConfig } from "../geometry-nodes/chrome-crayon-editor";
import { useToolController, useToolRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell, useMobileStudio } from "../studio/StudioShell";
import { BlenderBrushOptions } from "./surface-studio/BlenderBrushOptions";
import { SurfaceProjectionPanel } from "./surface-studio/SurfaceProjectionPanel";
import { SurfaceToolSelector } from "./surface-studio/SurfaceToolSelector";
import { SurfaceDocumentSetup, SurfaceWorkspaceToolbar } from "./surface-studio/SurfaceWorkspaceToolbar";
import "./surface-painter.css";
import "./putty-lab.css";

const loadSurfacePainter = () => import("../../surface-painter/main");
const loadPuttyLab = () => import("../../putty-lab");
const GeometryNodesEditor = lazy(() => import("../geometry-nodes/GeometryNodesEditor"));

const EMPTY_SNAPSHOT: SurfacePainterStudioSnapshot = {
  activeTool: "ivy",
  interactionMode: "draw",
  modelPreset: "Sphere",
  referenceObject: "",
  projectionTarget: { kind: "pick" },
  projectionTargets: [
    { value: "__pick__", label: "Pick mesh in viewport" },
    { value: "__all__", label: "All visible meshes" },
  ],
  canUndo: false,
  canClear: false,
  hasDrawingArea: false,
  areaCommitted: false,
  areaContact: false,
  areaClosestContactDistance: null,
  areaSize: 2.4,
  projectionHeight: 0.85,
  projectionContactDepth: 0.18,
  projectionContactSoftness: 0.18,
  projectionMaxAngle: 72,
  projectionSurfaceOffset: 0.016,
  selectorLayers: [{ id: "selector-1", name: "Selector 1", operation: "replace", visible: true, locked: false }],
  activeSelectorId: "selector-1",
  contactLocked: false,
  clothEnabled: false,
  clothSag: 0.12,
  drapeStretch: 0.15,
  drapeIterations: 8,
  areaPosition: [0, 0, 0],
  areaRotation: [0, 0, 0],
  areaScale: [1, 1, 1],
  placementHover: null,
  gizmoSpace: "local",
  gizmoSnap: false,
  strokeCount: 0,
  surfaceRevision: 0,
};

/**
 * `/paint` now owns one persistent renderer/model/camera. Query parameters are
 * only deep-link state; changing a generator never chooses another runtime.
 */
export default function SurfacePaintPage(): React.JSX.Element {
  const { search } = useLocation();
  if (new URLSearchParams(search).get("engine") === "putty") return <BubblePuttyLab />;
  return <PersistentSurfaceStudio initialTool={toolFromSearch(search)} />;
}

function PersistentSurfaceStudio({ initialTool }: { initialTool: SurfaceGeneratorId }): React.JSX.Element {
  const navigate = useNavigate();
  const isMobile = useMobileStudio();
  const controller = useToolController<SurfacePainterToolHandle>(
    "Surface Painting Studio",
    loadSurfacePainter,
    "persistent-surface-studio",
  );
  const [snapshot, setSnapshot] = useState<SurfacePainterStudioSnapshot>(() => ({
    ...EMPTY_SNAPSHOT,
    activeTool: initialTool,
  }));
  const [references, setReferences] = useState<readonly LibraryShapeInfo[]>([]);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphMaximized, setGraphMaximized] = useState(false);

  useEffect(() => controller?.subscribe(setSnapshot), [controller]);
  useEffect(() => {
    let cancelled = false;
    void listLibraryShapes().then((items) => {
      if (!cancelled) setReferences(items);
    }).catch(() => { /* primitives and imports remain available */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!graphOpen) return;
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(chromeCrayonEditorConfig.events.resize)));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen]);

  const selectTool = (tool: SurfaceGeneratorId): void => {
    if (tool !== "chrome-crayon") {
      setGraphOpen(false);
      setGraphMaximized(false);
    }
    setSnapshot((current) => ({ ...current, activeTool: tool }));
    navigate(toolHref(tool), { replace: true });
    void controller?.setActiveTool(tool);
  };

  const activeTool = snapshot.activeTool;
  const descriptor = surfaceGenerator(activeTool);
  const blender = descriptor.family === "blender";
  const leftDock = <>
    <StudioPanelHeader title="Generators & brushes" meta="One surface document" />
    <SurfaceToolSelector activeTool={activeTool} onSelect={selectTool} ariaControls="surface-active-options" />
    {/* buildGui keeps its internal generator controller here so existing
        procedural option bindings remain live; the duplicate rail is hidden. */}
    <div id="surface-painter-generator-dock" className="surface-painter-generator-dock" hidden />
  </>;
  const rightDock = <>
    <StudioPanelHeader title="Surface & options" meta="Active settings" className="paint-node-tabs" />
    {/* Set-up, not work: the surface you paint on and where strokes land. It
        was in the toolbar, where wrapping four groups made the strip 221px tall
        at 1024×768 and 320px at 834×1112. */}
    <SurfaceDocumentSetup controller={controller} snapshot={snapshot} references={references} />
    {blender && controller && <SurfaceProjectionPanel controller={controller} snapshot={snapshot} />}
    <section className="surface-active-generator-context" aria-live="polite">
      <span aria-hidden="true">{descriptor.code}</span>
      <div><small>{descriptor.family === "blender" ? "Projected Blender brush" : "Procedural generator"}</small><strong>{descriptor.label}</strong><p>{descriptor.description}</p></div>
    </section>
    <div id="surface-active-options" className="surface-active-options">
      <div id="surface-painter-gui-dock" className="surface-painter-gui-dock" hidden={blender} />
      {blender && controller && <BlenderBrushOptions tool={activeTool} controller={controller} references={references} />}
      {blender && !controller && <div className="st-section"><span className="st-muted">Preparing shared brush runtime…</span></div>}
      {activeTool === "chrome-crayon" && !isMobile && <div className="st-section"><button className="st-btn" type="button" onClick={() => setGraphOpen((open) => !open)}>{graphOpen ? "Hide Geometry Nodes" : "Show Geometry Nodes"}</button><p className="surface-edit-hint">Graph edits re-evaluate Chrome Crayon on the same shared surface.</p></div>}
    </div>
  </>;

  const nodeDock = !isMobile && graphOpen && (
    <section className={`st-node-dock ${graphMaximized ? "maximized" : ""}`}>
      <header>
        <b>Geometry Nodes</b>
        <small>Chrome Crayon · live shared-brush graph</small>
        <div>
          <button className="st-btn" type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Full screen"}</button>
          <button className="st-btn" type="button" onClick={() => { setGraphMaximized(false); setGraphOpen(false); }}>Collapse</button>
        </div>
      </header>
      <Suspense fallback={<div className="route-loading">Loading node editor…</div>}>
        <GeometryNodesEditor config={chromeCrayonEditorConfig} onDumpChange={(dump) => { void controller?.setChromeCrayonDump(dump); }} />
      </Suspense>
    </section>
  );

  return <StudioShell
    className="surface-painter-page persistent-surface-studio"
    leftDock={leftDock}
    rightDock={rightDock}
    sheetTabs={[
      { id: "generators", label: "Generators", content: leftDock },
      { id: "options", label: "Options", content: rightDock },
    ]}
    toolbar={<SurfaceWorkspaceToolbar controller={controller} snapshot={snapshot} />}
    nodeDock={nodeDock}
    status={<>
      <span id="paint-status" className="st-state busy"><span className="st-dot" /><span data-status-text>{controller ? `${descriptor.label} ready on the shared surface` : "Starting the shared surface…"}</span></span>
      <span className="st-spacer" />
      {!isMobile && <span className="st-muted">{snapshot.strokeCount} projected stroke{snapshot.strokeCount === 1 ? "" : "s"} · surface revision {snapshot.surfaceRevision}</span>}
      <span id="paint-metrics" className="st-muted" />
    </>}
  >
    <div id="surface-painter-app" />
    <SurfaceInitialSelectorHud snapshot={snapshot} />
    <div id="drawFrame" />
    {/* App keeps these binding targets for its procedural modes. The shared
        toolbar is the only visible interaction control. */}
    <div className="paint-mode-bar" hidden aria-hidden="true">
      <button id="modeBtn" type="button"><span className="dot" /><span className="label">Draw mode</span><span className="key">D</span></button>
      <button id="flowerModeBtn" type="button" aria-pressed="false"><span className="dot" /><span className="label">Flower brush</span></button>
    </div>
    <div id="toast" role="status" aria-live="polite" />
  </StudioShell>;
}

function SurfaceInitialSelectorHud({ snapshot }: { snapshot: SurfacePainterStudioSnapshot }): React.JSX.Element {
  const visible = snapshot.interactionMode === "place-area" && !snapshot.hasDrawingArea;
  const hover = snapshot.placementHover;
  const target = snapshot.projectionTargets.find((option) => option.value === (
    snapshot.projectionTarget.kind === "mesh"
      ? snapshot.projectionTarget.targetId
      : snapshot.projectionTarget.kind === "all" ? "__all__" : "__pick__"
  ));
  return <div className="surface-initial-selector-hud" data-hit={hover?.hit ? "true" : "false"} hidden={!visible}>
    <div
      className="surface-initial-selector-reticle"
      style={{ left: hover?.x ?? "50%", top: hover?.y ?? "50%" }}
    >
      <i className="surface-initial-selector-grid" />
      <i className="surface-initial-selector-center" />
      <span>CHROME CRAYON · {hover?.hit ? hover.label : target?.label ?? "SURFACE"} · PLACE AREA</span>
    </div>
  </div>;
}

const PROCEDURAL_TOOL_MODE: Readonly<Partial<Record<SurfaceGeneratorId, string>>> = {
  ivy: "ivy",
  tree: "tree",
  crystals: "crystals",
  molten: "fissures",
  aurora: "aurora",
  reef: "reef",
};

const BLENDER_TOOL_BRUSH: Readonly<Partial<Record<SurfaceGeneratorId, string>>> = {
  "chrome-crayon": "crayon",
  "periodic-brush": "periodic",
  typewriter: "text",
  stamp: "stamp",
};

function toolHref(tool: SurfaceGeneratorId): string {
  const mode = PROCEDURAL_TOOL_MODE[tool];
  return mode ? `/paint?mode=${mode}` : `/paint?engine=blender&brush=${BLENDER_TOOL_BRUSH[tool] ?? "crayon"}`;
}

function toolFromSearch(search: string): SurfaceGeneratorId {
  const params = new URLSearchParams(search);
  if (params.get("engine") === "blender") {
    const brush = params.get("brush");
    if (brush === "periodic") return "periodic-brush";
    if (brush === "text") return "typewriter";
    if (brush === "stamp") return "stamp";
    return "chrome-crayon";
  }
  const mode = params.get("mode");
  if (mode === "tree") return "tree";
  if (mode === "crystals") return "crystals";
  if (mode === "fissures") return "molten";
  if (mode === "aurora") return "aurora";
  if (mode === "reef") return "reef";
  return "ivy";
}

function BubblePuttyLab(): React.JSX.Element {
  useToolRuntime("Bubble Putty · editable Blender Geometry Nodes", loadPuttyLab);
  const leftDock = <>
    <StudioPanelHeader title="Bubble Putty" meta="Blobs + pipe fixture" />
    <div className="st-section">
      <div className="st-section-title">Input form</div>
      <div className="st-segmented"><button id="putty-blob-fixture" className="active" type="button">Putty blobs</button><button id="putty-pipe-fixture" type="button">Three pipes</button></div>
      <button id="putty-lock-pipe" className="st-btn" type="button" disabled>Lock selected pipe as anchor</button>
      <button id="putty-move-pipes" className="st-btn" type="button" disabled>Move pipes</button>
      <div id="putty-anchor-state" className="putty-anchor-state">Blob authoring · choose Three pipes to test a locked surface</div>
    </div>
    <div className="st-section">
      <div className="st-section-title">Base object</div>
      <select id="putty-base-select" className="st-select" defaultValue=""><option value="">None · putty from blobs only</option></select>
      <div className="st-btn-row st-btn-row-even"><button id="putty-base-import" className="st-btn" type="button">Import shape…</button><button id="putty-base-clear" className="st-btn" type="button" disabled>Clear</button></div>
      <input id="putty-base-file" type="file" accept=".glb,.gltf,.obj,.stl,.ply,.fbx" hidden />
      <p id="putty-base-state" className="putty-hint">Pick a reference object or import any shape — it joins the putty body and blobs snap onto its surface.</p>
    </div>
    <div className="st-section">
      <div className="st-section-title">1 · Interaction</div>
      <div className="st-segmented"><button id="putty-orbit" type="button">Orbit</button><button id="putty-move" className="active" type="button">Move putty</button><button id="putty-add-mode" type="button">Place putty</button></div>
      <p id="putty-interaction-hint" className="putty-hint">Select and drag a blob to reshape the shared putty body.</p>
      <div className="st-btn-row st-btn-row-even"><button id="putty-add" className="st-btn-primary" type="button">Add putty</button><button id="putty-duplicate" className="st-btn" type="button">Duplicate</button></div>
      <div className="st-btn-row st-btn-row-even"><button id="putty-delete" className="st-btn" type="button">Delete selected</button><button id="putty-reset" className="st-btn" type="button">Reset</button></div>
      <label className="st-row"><span id="putty-size-label">Blob size</span><input id="putty-radius" type="range" min=".4" max="4.5" step=".05" defaultValue="2.4" /><output id="putty-radius-output">2.40</output></label>
    </div>
    <div className="st-section">
      <div className="st-section-title">2 · Authored graph</div>
      <label className="st-row"><span>Puttiness</span><input id="putty-puttiness" type="range" min="0" max="1" step=".01" defaultValue=".635" /><output id="putty-puttiness-output">0.64</output></label>
      <label className="st-row"><span>Soften</span><input id="putty-soften" type="range" min="0" max="10" step="1" defaultValue="5" /><output id="putty-soften-output">5</output></label>
      <label className="st-row"><span>Max bubble</span><input id="putty-max-bubble" type="range" min=".25" max="3" step=".01" defaultValue="1.456" /><output id="putty-max-bubble-output">1.46</output></label>
      <button id="putty-rebuild" className="st-btn-primary" type="button">Rebuild Blender putty</button><button id="putty-preview" className="st-btn" type="button">Return to interactive preview</button>
    </div>
    <div className="st-section"><div className="st-section-title">Putty document</div><div className="st-metric"><strong id="putty-count">3 putty blobs</strong><span id="putty-selection">Blob selected</span></div><small id="putty-runtime" className="putty-runtime">Interactive field preview</small></div>
  </>;
  const rightDock = <><StudioPanelHeader title="Blender source" meta="53-node root" /><div className="st-section"><img className="putty-reference" src={`${import.meta.env.BASE_URL}dojo/references/joints/bubble-putty-authored.png`} alt="Blender-authored Bubble Putty reference" /><p className="st-finding">The source group wraps one shared putty envelope around a collection of movable mesh forms.</p><Link className="st-btn putty-open-graph" to="/?asset=joint-bubble-putty">Open full node graph in Studio</Link></div></>;
  return <StudioShell className="putty-shell" leftDock={leftDock} rightDock={rightDock} toolbar={<><Link className="st-btn" to="/paint">Surface Painting Studio</Link><span className="st-spacer" /><span>move: drag blob · place: click canvas · orbit: drag canvas</span></>} status={<span id="putty-status" className="st-state busy"><span className="st-dot" /><span data-status-text>Move a blob or add more putty</span></span>}><canvas id="putty-canvas" /><div className="putty-canvas-help" aria-hidden="true"><b>BUBBLE PUTTY</b><span id="putty-canvas-help-text">editable source blobs · one shared body</span></div></StudioShell>;
}
