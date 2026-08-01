import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import { chromeCrayonEditorConfig } from "../geometry-nodes/chrome-crayon-editor";
import { useToolRuntime } from "../page-runtime";
import { StudioOverlay, StudioShell, useMobileStudio } from "../studio/StudioShell";
import "./crayon-compare.css";
import "./surface-painter.css";
import "./surface-draw.css";

const loadSurfacePainter = () => import("../../surface-painter/main");
const loadSurfaceDraw = () => import("../../surface-draw");

type Engine = "procedural" | "blender";

/**
 * The unified surface-painting studio. One route hosts both engines:
 *  - Procedural painter: the merged WebGPU app (ivy, banyan tree, crystals,
 *    molten fissures, aurora silk, bioluminescent reef) with shared model
 *    presets, .glb import, and studio look controls.
 *  - Blender brush lab: the GN-VM parity tool that evaluates Blender-authored
 *    brushes (Chrome Crayon, Periodic Brush) along your projected stroke.
 * Switching engines navigates the query string, which remounts the runtime
 * through the router's existing keying — the same lifecycle as a page change.
 */
export default function SurfacePaintPage(): React.JSX.Element {
  const { search } = useLocation();
  const engine: Engine = new URLSearchParams(search).get("engine") === "blender" ? "blender" : "procedural";
  useToolRuntime(
    engine === "blender"
      ? "Surface Painting Studio · Blender brush lab"
      : "Surface Painting Studio · three.js WebGPU",
    engine === "blender" ? loadSurfaceDraw : loadSurfacePainter,
  );
  return engine === "blender" ? <BlenderBrushLab /> : <ProceduralPainter />;
}

/** The engine switch is a kit segmented control living in the toolbar. */
function EngineSwitch({ engine }: { engine: Engine }): React.JSX.Element {
  return (
    <nav className="st-segmented paint-engine-switch" aria-label="Painting engine">
      <Link to="/paint" aria-current={engine === "procedural" ? "page" : undefined}>Procedural painter</Link>
      <Link to="/paint?engine=blender" aria-current={engine === "blender" ? "page" : undefined}>Blender brush lab</Link>
    </nav>
  );
}

/**
 * The WebGPU painter builds its own lil-gui panel and HUD, so the shell hands
 * it a bare viewport rather than docks it would duplicate.
 */
function ProceduralPainter(): React.JSX.Element {
  // buildGui() mounts the painter's lil-gui into this container, so the panel
  // is an inspector column instead of a sheet floating over the paint target.
  const rightDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Painter</button></div>
    <div id="surface-painter-gui-dock" className="surface-painter-gui-dock" />
  </>;
  return (
    <StudioShell
      className="surface-painter-page"
      rightDock={rightDock}
      toolbar={<><EngineSwitch engine="procedural" /><span className="st-spacer" /><span>D toggles draw / orbit</span></>}
    >
      <div id="surface-painter-app" />
      <div id="drawFrame" />
      <button id="modeBtn" type="button" aria-label="Toggle the active painting interaction mode">
        <span className="dot" />
        <span className="label">Draw mode</span>
        <span className="key">D</span>
      </button>
      <div id="hud" />
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
    <div className="st-tabs"><button type="button" aria-selected="true">Brush lab</button></div>
    <div className="st-section">
      <div className="st-section-title">1 · Surface</div>
      <label className="st-dropzone surface-upload">
        <input id="surface-file" type="file" accept=".glb,.gltf,.obj,.stl,model/gltf-binary,model/gltf+json" />
        <b>Upload GLB, OBJ, or STL</b>
        <span id="surface-file-name">Using generated demo surface</span>
      </label>
      <div className="st-btn-row st-btn-row-even">
        <button id="surface-demo" className="st-btn" type="button">Curved demo</button>
        <button id="surface-flat" className="st-btn" type="button">Flat canvas</button>
      </div>
      <button id="surface-sample" className="st-btn" type="button">Sample GLB</button>
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
      <select id="surface-brush" className="st-select" defaultValue="crayon"><option value="crayon">Chrome Crayon</option><option value="periodic">Periodic Brush</option></select>
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
    <div className="st-tabs"><button type="button" aria-selected="true">Blender parity</button></div>
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

  const nodeEditor = <GeometryNodesEditor config={chromeCrayonEditorConfig} />;

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
    status={<>
      <span id="surface-status"><span className="st-dot ready" />Ready on the demo surface</span>
    </>}
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
