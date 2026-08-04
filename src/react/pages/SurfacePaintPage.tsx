import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { chromeCrayonEditorConfig } from "../geometry-nodes/chrome-crayon-editor";
import { useToolRuntime } from "../page-runtime";
import { StudioOverlay, StudioPanelHeader, StudioShell, useMobileStudio } from "../studio/StudioShell";
import "./crayon-compare.css";
import "./surface-painter.css";
import "./surface-draw.css";
import "./putty-lab.css";

const GeometryNodesEditor = lazy(() => import("../geometry-nodes/GeometryNodesEditor"));

const loadSurfacePainter = () => import("../../surface-painter/main");
const loadSurfaceDraw = () => import("../../surface-draw");
const loadPuttyLab = () => import("../../putty-lab");

type Engine = "procedural" | "blender" | "putty";

/**
 * The unified surface-painting studio. One route hosts both engines:
 *  - Procedural painter: the merged WebGPU app (ivy, banyan tree, crystals,
 *    molten fissures, aurora silk, bioluminescent reef) with shared model
 *    presets, .glb import, and studio look controls.
 *  - Blender brush lab: the GN-VM parity tool that evaluates Blender-authored
 *    brushes (Chrome Crayon, Periodic Brush) along your projected stroke.
 * Switching engines navigates the query string; useToolRuntime disposes and
 * restarts only the renderer while the shared shell stays mounted.
 */
export default function SurfacePaintPage(): React.JSX.Element {
  const { search } = useLocation();
  const requestedEngine = new URLSearchParams(search).get("engine");
  const engine: Engine = requestedEngine === "blender" || requestedEngine === "putty" ? requestedEngine : "procedural";
  useToolRuntime(
    engine === "blender" ? "Surface Painting Studio · Blender brush lab"
      : engine === "putty" ? "Bubble Putty · editable Blender Geometry Nodes"
        : "Surface Painting Studio · three.js WebGPU",
    engine === "blender" ? loadSurfaceDraw : engine === "putty" ? loadPuttyLab : loadSurfacePainter,
  );
  return engine === "blender" ? <BlenderBrushLab /> : engine === "putty" ? <BubblePuttyLab /> : <ProceduralPainter />;
}

/** The engine switch is a kit segmented control living in the toolbar. */
function EngineSwitch({ engine }: { engine: Engine }): React.JSX.Element {
  return (
    <nav className="st-segmented paint-engine-switch" aria-label="Painting engine">
      <Link to="/paint" aria-current={engine === "procedural" ? "page" : undefined}>Procedural painter</Link>
      <Link to="/paint?engine=blender" aria-current={engine === "blender" ? "page" : undefined}>Blender brush lab</Link>
      <Link to="/paint?engine=putty" aria-current={engine === "putty" ? "page" : undefined}>Bubble Putty</Link>
    </nav>
  );
}

function BubblePuttyLab(): React.JSX.Element {
  const leftDock = <>
    <StudioPanelHeader title="Bubble Putty" meta="Blobs + pipe fixture" />
    <div className="st-section">
      <div className="st-section-title">Input form</div>
      <div className="st-segmented">
        <button id="putty-blob-fixture" className="active" type="button">Putty blobs</button>
        <button id="putty-pipe-fixture" type="button">Three pipes</button>
      </div>
      <button id="putty-lock-pipe" className="st-btn" type="button" disabled>Lock selected pipe as anchor</button>
      <button id="putty-move-pipes" className="st-btn" type="button" disabled>Move pipes</button>
      <div id="putty-anchor-state" className="putty-anchor-state">Blob authoring · choose Three pipes to test a locked surface</div>
    </div>
    <div className="st-section">
      <div className="st-section-title">Base object</div>
      <select id="putty-base-select" className="st-select" defaultValue="">
        <option value="">None · putty from blobs only</option>
      </select>
      <div className="st-btn-row st-btn-row-even">
        <button id="putty-base-import" className="st-btn" type="button">Import shape…</button>
        <button id="putty-base-clear" className="st-btn" type="button" disabled>Clear</button>
      </div>
      <input id="putty-base-file" type="file" accept=".glb,.gltf,.obj,.stl,.ply,.fbx" hidden />
      <p id="putty-base-state" className="putty-hint">Pick a reference object or import any shape — it joins the putty body and blobs snap onto its surface.</p>
    </div>
    <div className="st-section">
      <div className="st-section-title">1 · Interaction</div>
      <div className="st-segmented">
        <button id="putty-orbit" type="button">Orbit</button>
        <button id="putty-move" className="active" type="button">Move putty</button>
        <button id="putty-add-mode" type="button">Place putty</button>
      </div>
      <p id="putty-interaction-hint" className="putty-hint">Select and drag a blob to reshape the shared putty body. Orbit, then return to Move putty to reposition blobs in another screen plane.</p>
      <div className="st-btn-row st-btn-row-even">
        <button id="putty-add" className="st-btn-primary" type="button">Add putty</button>
        <button id="putty-duplicate" className="st-btn" type="button">Duplicate</button>
      </div>
      <div className="st-btn-row st-btn-row-even">
        <button id="putty-delete" className="st-btn" type="button">Delete selected</button>
        <button id="putty-reset" className="st-btn" type="button">Reset</button>
      </div>
      <label className="st-row"><span id="putty-size-label">Blob size</span><input id="putty-radius" type="range" min=".4" max="4.5" step=".05" defaultValue="2.4" /><output id="putty-radius-output">2.40</output></label>
    </div>
    <div className="st-section">
      <div className="st-section-title">2 · Authored graph</div>
      <label className="st-row"><span>Puttiness</span><input id="putty-puttiness" type="range" min="0" max="1" step=".01" defaultValue=".635" /><output id="putty-puttiness-output">0.64</output></label>
      <label className="st-row"><span>Soften</span><input id="putty-soften" type="range" min="0" max="10" step="1" defaultValue="5" /><output id="putty-soften-output">5</output></label>
      <label className="st-row"><span>Max bubble</span><input id="putty-max-bubble" type="range" min=".25" max="3" step=".01" defaultValue="1.456" /><output id="putty-max-bubble-output">1.46</output></label>
      <button id="putty-rebuild" className="st-btn-primary" type="button">Rebuild Blender putty</button>
      <button id="putty-preview" className="st-btn" type="button">Return to interactive preview</button>
      <p className="putty-hint">The live metaball preview stays responsive while editing. Rebuild runs the complete extracted Bubble Putty graph when the arrangement is ready.</p>
    </div>
    <div className="st-section">
      <div className="st-section-title">Putty document</div>
      <div className="st-metric"><strong id="putty-count">3 putty blobs</strong><span id="putty-selection">Blob selected</span></div>
      <small id="putty-runtime" className="putty-runtime">Interactive field preview · exact graph not evaluated yet</small>
    </div>
  </>;

  const rightDock = <>
    <StudioPanelHeader title="Blender source" meta="53-node root" />
    <div className="st-section">
      <img className="putty-reference" src={`${import.meta.env.BASE_URL}dojo/references/joints/bubble-putty-authored.png`} alt="Blender-authored Bubble Putty reference" />
      <p className="st-finding">The source group wraps one shared putty envelope around a collection of movable mesh forms. The three-pipe fixture uses the original collection contract: lock one pipe as the reference surface, move the other two, then rebuild the molded joint.</p>
      <Link className="st-btn putty-open-graph" to="/?asset=joint-bubble-putty">Open full node graph in Studio</Link>
    </div>
    <div className="st-section">
      <div className="st-chip warn">The immediate preview is an authoring proxy. “Rebuild Blender putty” evaluates the extracted Geometry Nodes graph and replaces it with the authored result.</div>
    </div>
  </>;

  return <StudioShell
    className="putty-shell"
    leftDock={leftDock}
    rightDock={rightDock}
    toolbar={<><EngineSwitch engine="putty" /><span className="st-spacer" /><span>move: drag blob · place: click canvas · orbit: drag canvas</span></>}
    status={<span id="putty-status" className="st-state busy">
      <span className="st-dot" />
      <span data-status-text>Move a blob or add more putty</span>
    </span>}
  >
    <canvas id="putty-canvas" />
    <div className="putty-canvas-help" aria-hidden="true"><b>BUBBLE PUTTY</b><span id="putty-canvas-help-text">editable source blobs · one shared body</span></div>
  </StudioShell>;
}

/**
 * The WebGPU painter builds its own lil-gui panel, so the shell hands it a
 * bare viewport rather than docks it would duplicate. Its guidance and runtime
 * readout go in the shell's status bar like every other tool's — this engine
 * used to be the only one in the app with no status bar, carrying both in a
 * floating in-viewport panel instead.
 */
function ProceduralPainter(): React.JSX.Element {
  const isMobile = useMobileStudio();
  // buildGui() mounts the painter's lil-gui into this container, so the panel
  // is an inspector column instead of a sheet floating over the paint target.
  const rightDock = <>
    <StudioPanelHeader title="Generator nodes" meta="Live pipeline" className="paint-node-tabs" />
    <div className="paint-node-intro">
      <span className="paint-node-intro-icon" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span>
        <b>Procedural node stack</b>
        <small>Each card controls one stage of the active generator.</small>
      </span>
    </div>
    <div id="surface-painter-gui-dock" className="surface-painter-gui-dock" />
  </>;
  return (
    <StudioShell
      className="surface-painter-page"
      rightDock={rightDock}
      sheetTabs={[{ id: "nodes", label: "Nodes", content: rightDock }]}
      toolbar={<><EngineSwitch engine="procedural" />{!isMobile && <><span className="st-spacer" /><span>D toggles draw / orbit</span></>}</>}
      status={<>
        <span id="paint-status" className="st-state busy">
          <span className="st-dot" />
          <span data-status-text>Starting the procedural painter…</span>
        </span>
        <span className="st-spacer" />
        <span id="paint-metrics" className="st-muted" />
      </>}
    >
      <div id="surface-painter-app" />
      <div id="drawFrame" />
      {/* One centred row, not two absolutely-positioned pills offset by a magic
          112px: the labels are generator-dependent ("Flower brush" / "Fig
          brush", "Draw mode" / "Interact mode") and the fixed offset made them
          overlap by ~30px. A flex row also re-centres the mode pill on its own
          when the brush pill is hidden. */}
      <div className="paint-mode-bar">
        <button id="modeBtn" type="button" aria-label="Toggle the active painting interaction mode">
          <span className="dot" />
          <span className="label">Draw mode</span>
          <span className="key">D</span>
        </button>
        <button id="flowerModeBtn" type="button" aria-pressed="false" hidden>
          <span className="dot" />
          <span className="label">Flower brush</span>
        </button>
      </div>
      <div id="toast" role="status" aria-live="polite" />
    </StudioShell>
  );
}

function BlenderBrushLab(): React.JSX.Element {
  const isMobile = useMobileStudio();
  const [graphOpen, setGraphOpen] = useState(false);
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
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(chromeCrayonEditorConfig.events.resize)));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen]);

  const closeGraph = (): void => {
    setGraphMaximized(false);
    setGraphOpen(false);
  };

  const leftDock = <>
    <StudioPanelHeader title="Brush lab" />
    <div className="st-section">
      <div className="st-section-title">1 · Surface</div>
      <label className="st-dropzone surface-upload">
        <input id="surface-file" type="file" accept=".glb,.gltf,.obj,.stl,.ply,.fbx,model/gltf-binary,model/gltf+json" />
        <b>Upload GLB, GLTF, OBJ, STL, PLY, or FBX</b>
        <span id="surface-file-name">Using generated demo surface</span>
      </label>
      <div className="st-btn-row st-btn-row-even">
        <button id="surface-demo" className="st-btn" type="button">Curved demo</button>
        <button id="surface-flat" className="st-btn" type="button">Flat canvas</button>
      </div>
      <button id="surface-sample" className="st-btn" type="button">Sample GLB</button>
      <label className="surface-target-picker">
        <span>Reference object</span>
        <select id="surface-library" className="st-select" defaultValue="">
          <option value="">Choose from the ported library…</option>
        </select>
      </label>
      <label className="surface-target-picker">
        <span>Projection target</span>
        <select id="surface-target" className="st-select" defaultValue="__pick__">
          <option value="__pick__">Pick mesh when placing area</option>
          <option value="__all__">All visible meshes</option>
        </select>
        <button id="surface-target-pick" className="st-btn surface-target-pick" type="button">Pick target from viewport</button>
        <small id="surface-target-summary">Click Select area, then choose a surface</small>
      </label>
    </div>
    <div className="st-section">
      <div className="st-section-title">2 · Interaction</div>
      <div className="st-segmented" title="Select an area and click the model to place a local drawing patch. Draw samples are restricted to that patch and raycast onto the mesh.">
        <button id="surface-orbit" type="button">Orbit</button>
        <button id="surface-area" type="button">Select area</button>
        <button id="surface-draw" className="active" type="button">Draw</button>
        <button id="surface-select" type="button">Select / move</button>
      </div>
      <p className="surface-edit-hint">Draw a stroke, then select it to move the whole shape. Click a visible control point to reshape it.</p>
      <div className="surface-area-transform" aria-label="Drawing area transform">
        <span>Yellow selector</span>
        <div className="st-segmented">
          <button id="surface-gizmo-move" className="active" type="button" title="Move drawing area (G)">Move · G</button>
          <button id="surface-gizmo-rotate" type="button" title="Rotate drawing area (R)">Rotate · R</button>
          <button id="surface-gizmo-scale" type="button" title="Scale drawing area (S)">Scale · S</button>
        </div>
        <label className="st-row surface-projection-height"><span>Projection height</span><input id="surface-projection-height" type="range" min="0.1" max="2.5" step="0.05" defaultValue="0.85" /><output id="surface-projection-height-output">0.85</output></label>
        <button id="surface-drop-area" className="st-btn surface-drop-area" type="button">Drop / project to surface</button>
        <small>The white source grid stays above the mesh; the yellow result is ray-projected onto it.</small>
      </div>
      <label className="st-row"><span>Area size</span><input id="surface-area-size" type="range" min="0.6" max="4" step="0.1" defaultValue="2.4" /><output id="surface-area-size-output">2.4</output></label>
      <div className="st-btn-row st-btn-row-even">
        <button id="surface-undo" className="st-btn" type="button">Undo stroke</button>
        <button id="surface-clear" className="st-btn" type="button">Clear</button>
      </div>
      <button id="surface-clear-area" className="st-btn" type="button">Remove drawing area</button>
      <button id="surface-area-doodle" className="st-btn" type="button">Add demo doodle inside area</button>
      <button id="surface-parity-path" className="st-btn" type="button">Load fixed Blender parity path</button>
      <button id="surface-curved-parity-path" className="st-btn" type="button">Load same curved Blender test</button>
    </div>
    <div className="st-section">
      <div className="st-section-title">3 · Blender brush</div>
      <select id="surface-brush" className="st-select" defaultValue="crayon"><option value="crayon">Chrome Crayon</option><option value="periodic">Periodic Brush</option><option value="text">Typewriter text</option><option value="stamp">Library stamp</option></select>
      <div id="surface-text-controls" className="surface-controls" hidden>
        <label className="st-row"><span>Text</span><input id="surface-text" type="text" defaultValue="NODE DOJO" /></label>
        <label className="st-row"><span>Fit stroke</span><input id="surface-text-fit" type="checkbox" defaultChecked /></label>
        <label className="st-row"><span>Text size</span><input id="surface-text-size" type="range" min="0.08" max="1.2" step="0.01" defaultValue="0.35" disabled /><output id="surface-text-size-output">0.35</output></label>
        <label className="st-row"><span>Offset</span><input id="surface-text-offset" type="range" min="-1" max="1" step="0.02" defaultValue="0" /><output id="surface-text-offset-output">0.00</output></label>
        <p className="surface-edit-hint">Draw a stroke on the model — the typewriter glyphs run along it, wrapped onto the surface. Fit stroke scales the text to the stroke; otherwise Text size sets the glyph height and Offset slides the baseline sideways.</p>
      </div>
      <div id="surface-stamp-controls" className="surface-controls" hidden>
        <select id="surface-stamp-asset" className="st-select" defaultValue="">
          <option value="">Choose a reference object…</option>
        </select>
        <label className="st-row"><span>Stamp size</span><input id="surface-stamp-size" type="range" min="0.1" max="1.5" step="0.02" defaultValue="0.45" /><output id="surface-stamp-size-output">0.45</output></label>
        <label className="st-row"><span>Spacing</span><input id="surface-stamp-spacing" type="range" min="0.15" max="2" step="0.05" defaultValue="0.6" /><output id="surface-stamp-spacing-output">0.60</output></label>
        <p className="surface-edit-hint">The chosen reference object repeats along each stroke, oriented to the surface. Heavy assets are capped to keep the viewport responsive.</p>
      </div>
      <div id="surface-periodic-controls" className="surface-controls" hidden>
        <label className="st-row"><span>Spacing</span><input id="surface-spacing" type="range" min="0.12" max="1.2" step="0.01" defaultValue="0.38" /><output id="surface-spacing-output">0.38</output></label>
        <label className="st-row"><span>Size</span><input id="surface-size" type="range" min="0.002" max="0.08" step="0.001" defaultValue="0.012" /><output id="surface-size-output">0.012</output></label>
      </div>
      <div id="surface-crayon-controls" className="surface-controls">
        <select id="surface-crayon-preset" className="st-select" defaultValue="adapted"><option value="adapted">Drawn line · live GN-VM</option><option value="exact">Original seven-spline stamp · not the line</option></select>
        <label className="st-row"><span>Thickness</span><input id="surface-thickness" type="range" min="0.6" max="30" step="0.1" defaultValue="6" /><output id="surface-thickness-output">6.0</output></label>
        <label className="st-row"><span>Peak</span><input id="surface-peak" type="range" min="0.5" max="450" step="0.1" defaultValue="10" /><output id="surface-peak-output">10.0</output></label>
        <label className="st-row"><span>Sigilize</span><input id="surface-sigilize" type="range" min="0" max="800" step="1" defaultValue="0" /><output id="surface-sigilize-output">0</output></label>
        <label className="st-row" title="Smooths the generated volume boundary. Set to 0 only when comparing raw Blender parity topology."><span>Edge smoothing</span><input id="surface-soften" type="range" min="0" max="10" step="1" defaultValue="3" /><output id="surface-soften-output">3</output></label>
        <label className="st-row"><span>Resolution</span><input id="surface-resolution" type="range" min="0.2" max="1" step="0.005" defaultValue="0.835" /><output id="surface-resolution-output">0.835</output></label>
        <label className="st-row"><span>SPIRO</span><input id="surface-spiro" type="range" min="0" max="3" step="1" defaultValue="1" /><output id="surface-spiro-output">1</output></label>
        <label className="st-row"><span>Extrude</span><input id="surface-extrude" type="range" min="0.1" max="3" step="0.1" defaultValue="1" /><output id="surface-extrude-output">1.0</output></label>
        <label className="st-row st-row-wide"><span>Flatten stroke</span><input id="surface-flatten" type="checkbox" /></label>
        <button id="surface-sigil" className="st-btn" type="button" title="Sigilize reconnects the stroke into a generated stamp; SPIRO changes its curve construction.">Auto-connect into a unique sigil</button>
      </div>
    </div>
    <div className="st-section">
      <div className="st-section-title">Evaluated stroke</div>
      <div className="st-metric"><strong id="surface-points">0 projected points</strong><span id="surface-runtime">Draw a stroke to evaluate GN-VM</span></div>
      <small id="surface-bounds" className="surface-bounds">Bounds appear after evaluation</small>
    </div>
  </>;

  const rightDock = <>
    <StudioPanelHeader title="Blender parity" />
    <div className="st-section">
      <div className="st-section-title">Flat parity</div>
      <img className="surface-reference-image" src={`${import.meta.env.BASE_URL}dojo/references/crayon-flat-path.png`} alt="Blender render of the fixed flat Chrome Crayon path" />
      <p className="st-finding">Same 7-point POLY curve and controls: 1,744 verts · 1,746 faces · evaluated positions match within 0.000006 Blender units.</p>
    </div>
    <div className="st-section">
      <div className="st-section-title">Curved parity</div>
      <img className="surface-reference-image" src={`${import.meta.env.BASE_URL}dojo/references/crayon-curved-path.png`} alt="Blender render of the fixed Chrome Crayon path wrapped onto the curved test surface" />
      <p className="st-finding">Same generated mesh, path frames, and curved target used by the browser test.</p>
    </div>
    <div className="st-section">
      <div className="st-chip warn">Drawn line evaluates your projected curve through GN-VM. The optional seven-spline stamp is a separate Blender reference asset, not the line you drew.</div>
    </div>
  </>;

  const nodeEditor = <Suspense fallback={<div className="route-loading">Loading node editor…</div>}>
    <GeometryNodesEditor config={chromeCrayonEditorConfig} />
  </Suspense>;

  return <StudioShell
    className="surface-shell"
    leftDock={leftDock}
    rightDock={rightDock}
    toolbar={<>
      <EngineSwitch engine="blender" />
      <span className="st-spacer" />
      <span>drag to draw · wheel to zoom</span>
      {!isMobile && <button className="st-btn" type="button" onClick={() => setGraphOpen((open) => !open)}>{graphOpen ? "Hide node editor" : "Show node editor"}</button>}
    </>}
    status={<span id="surface-status" className="st-state busy">
      <span className="st-dot" />
      <span data-status-text>Ready on the demo surface</span>
    </span>}
    nodeDock={!isMobile && graphOpen && <section className={`st-node-dock ${graphMaximized ? "maximized" : ""}`}>
      <header>
        <b>Geometry Nodes</b>
        <small>Chrome Crayon · edits re-evaluate this canvas</small>
        <div>
          <button className="st-btn" type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Full screen"}</button>
          <button className="st-btn" type="button" onClick={closeGraph}>Collapse</button>
        </div>
      </header>
      <div className="st-node-dock-body">{nodeEditor}</div>
    </section>}
  >
    <canvas id="surface-canvas" />
    <div id="surface-selection-hud" className="surface-selection-hud" data-hit="false" hidden aria-hidden="true">
      <div id="surface-selection-reticle" className="surface-selection-reticle">
        <span className="surface-selection-grid" />
        <span className="surface-selection-center" />
        <span id="surface-selection-label" className="surface-selection-label">CHROME CRAYON · PICK SURFACE</span>
      </div>
    </div>
    <div id="surface-flat-overlay" className="surface-flat-overlay" data-empty="true" hidden aria-hidden="true">
      <div className="surface-canvas-frame">
        <i className="top-left" /><i className="top-right" />
        <i className="bottom-left" /><i className="bottom-right" />
      </div>
      <div id="surface-brush-reticle" className="surface-brush-reticle">
        <span className="surface-reticle-grid" />
        <span className="surface-reticle-ring" />
        <span id="surface-brush-label" className="surface-brush-label">Chrome Crayon · draw anywhere</span>
      </div>
      <span className="surface-canvas-empty-label">DRAW ON THE CANVAS</span>
    </div>
    {isMobile && !graphOpen && <button className="graph-toggle st-btn" type="button" onClick={() => setGraphOpen(true)}>Open node editor</button>}
    {isMobile && graphOpen && <StudioOverlay title="Chrome Crayon · Geometry Nodes" onClose={closeGraph}>{nodeEditor}</StudioOverlay>}
  </StudioShell>;
}
