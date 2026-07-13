import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./surface-draw.css";

const loadSurfaceDraw = () => import("../../surface-draw");

export default function SurfaceDrawPage(): React.JSX.Element {
  usePageRuntime("Surface Draw Lab · browser Geometry Nodes", loadSurfaceDraw);
  return <main className="surface-shell">
    <canvas id="surface-canvas" />
    <StudioLink />
    <header className="surface-head">
      <p>Node Dojo · projected curve workflow</p>
      <h1>Draw on a Model</h1>
      <div id="surface-status"><span />Ready on the demo surface</div>
    </header>
    <aside className="surface-panel">
      <section>
        <span className="surface-label">1 · Surface</span>
        <label className="surface-upload">
          <input id="surface-file" type="file" accept=".glb,.gltf,.obj,.stl,model/gltf-binary,model/gltf+json" />
          <b>Upload GLB, OBJ, or STL</b>
          <small id="surface-file-name">Using generated demo surface</small>
        </label>
        <div className="surface-actions"><button id="surface-demo" type="button">Curved demo</button><button id="surface-flat" type="button">Flat parity</button></div>
        <button id="surface-sample" type="button">Sample GLB</button>
      </section>
      <section>
        <span className="surface-label">2 · Interaction</span>
        <div className="surface-segment">
          <button id="surface-orbit" type="button">Orbit</button>
          <button id="surface-area" type="button">Select area</button>
          <button id="surface-draw" className="active" type="button">Draw</button>
        </div>
        <p>Select an area and click the model to place a local drawing patch. Draw samples are restricted to that patch and raycast onto the mesh.</p>
        <label className="surface-range surface-area-size"><span>Area size</span><input id="surface-area-size" type="range" min="0.6" max="4" step="0.1" defaultValue="2.4" /><output id="surface-area-size-output">2.4</output></label>
        <div className="surface-actions">
          <button id="surface-undo" type="button">Undo stroke</button>
          <button id="surface-clear" type="button">Clear</button>
        </div>
        <button id="surface-clear-area" type="button">Remove drawing area</button>
        <button id="surface-area-doodle" type="button">Add demo doodle inside area</button>
        <button id="surface-parity-path" type="button">Load fixed Blender parity path</button>
        <button id="surface-curved-parity-path" type="button">Load same curved Blender test</button>
      </section>
      <section>
        <span className="surface-label">3 · Blender brush</span>
        <select id="surface-brush" className="surface-select" defaultValue="crayon"><option value="crayon">Chrome Crayon</option><option value="periodic">Periodic Brush</option></select>
        <div id="surface-periodic-controls" className="surface-controls" hidden>
          <label className="surface-range"><span>Spacing</span><input id="surface-spacing" type="range" min="0.12" max="1.2" step="0.01" defaultValue="0.38" /><output id="surface-spacing-output">0.38</output></label>
          <label className="surface-range"><span>Size</span><input id="surface-size" type="range" min="0.002" max="0.08" step="0.001" defaultValue="0.012" /><output id="surface-size-output">0.012</output></label>
        </div>
        <div id="surface-crayon-controls" className="surface-controls">
          <span className="surface-mode-label">Geometry source</span>
          <select id="surface-crayon-preset" className="surface-select surface-preset" defaultValue="adapted"><option value="adapted">Drawn line · live GN-VM</option><option value="exact">Original seven-spline stamp · not the line</option></select>
          <label className="surface-range"><span>Thickness</span><input id="surface-thickness" type="range" min="0.6" max="30" step="0.1" defaultValue="6" /><output id="surface-thickness-output">6.0</output></label>
          <label className="surface-range"><span>Peak</span><input id="surface-peak" type="range" min="0.5" max="450" step="0.1" defaultValue="10" /><output id="surface-peak-output">10.0</output></label>
          <label className="surface-range"><span>Sigilize</span><input id="surface-sigilize" type="range" min="0" max="800" step="1" defaultValue="0" /><output id="surface-sigilize-output">0</output></label>
          <label className="surface-range"><span>Soften</span><input id="surface-soften" type="range" min="0" max="10" step="1" defaultValue="0" /><output id="surface-soften-output">0</output></label>
          <label className="surface-range"><span>Resolution</span><input id="surface-resolution" type="range" min="0.2" max="1" step="0.005" defaultValue="0.8" /><output id="surface-resolution-output">0.800</output></label>
          <label className="surface-range"><span>SPIRO</span><input id="surface-spiro" type="range" min="0" max="3" step="1" defaultValue="1" /><output id="surface-spiro-output">1</output></label>
          <label className="surface-range"><span>Extrude</span><input id="surface-extrude" type="range" min="0.1" max="3" step="0.1" defaultValue="1" /><output id="surface-extrude-output">1.0</output></label>
          <label className="surface-check"><input id="surface-flatten" type="checkbox" /><span>Flatten generated stroke</span></label>
          <button id="surface-sigil" type="button">Auto-connect into a unique sigil</button>
          <p className="surface-control-note">Sigilize reconnects the stroke into a generated stamp; SPIRO changes its curve construction.</p>
        </div>
        <div className="surface-metrics"><b id="surface-points">0 projected points</b><small id="surface-runtime">Draw a stroke to evaluate GN-VM</small><small id="surface-bounds">Bounds appear after evaluation</small></div>
      </section>
      <section className="surface-reference">
        <span className="surface-label">Flat parity · Blender</span>
        <img src={`${import.meta.env.BASE_URL}dojo/references/crayon-flat-path.png`} alt="Blender render of the fixed flat Chrome Crayon path" />
        <p>Same 7-point POLY curve and controls: 1,744 verts · 1,746 faces · evaluated positions match within 0.000006 Blender units.</p>
      </section>
      <section className="surface-reference">
        <span className="surface-label">Curved parity · Blender</span>
        <img src={`${import.meta.env.BASE_URL}dojo/references/crayon-curved-path.png`} alt="Blender render of the fixed Chrome Crayon path wrapped onto the curved test surface" />
        <p>Same generated mesh, path frames, and curved target used by the browser test.</p>
      </section>
      <section className="surface-note">
        <b>Drawn line</b> evaluates your projected curve through GN-VM. The optional original seven-spline stamp is a separate Blender reference asset and does not represent the line you drew.
      </section>
    </aside>
    <div className="surface-help">Select area: click model · Draw: drag inside patch · Orbit: rotate · wheel: zoom</div>
  </main>;
}
