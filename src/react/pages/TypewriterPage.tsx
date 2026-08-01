import { useToolRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import { ToolStateOverlay } from "../studio/ToolStateOverlay";
import "./typewriter.css";

const loadTypewriter = () => import("../../typewriter");

export default function TypewriterPage(): React.JSX.Element {
  const runtimeState = useToolRuntime("Node Dojo Typewriter · browser Geometry Nodes", loadTypewriter);
  const leftDock = <>
    <StudioPanelHeader title="Text" />
    <div className="st-section">
      <div className="st-section-title">Text input</div>
      <textarea id="typewriter-text" className="typewriter-text" rows={5} defaultValue="NODE DOJO TYPEWRITER — now running entirely in the browser." />
      <label className="st-row">
        <span>Frame</span>
        <input id="typewriter-frame" type="range" min="0" max="240" step="1" defaultValue="240" />
        <output id="typewriter-frame-output">240</output>
      </label>
      <div className="st-btn-row st-btn-row-even">
        <button id="typewriter-play" className="st-btn" type="button">Play</button>
        <button id="typewriter-evaluate" className="st-btn-primary" type="button">Evaluate</button>
      </div>
      <button id="typewriter-reframe" className="st-btn" type="button">Reframe model</button>
    </div>
    <div className="st-section">
      <div className="st-section-title">Browser GN-VM</div>
      <div className="st-metric">
        <strong id="typewriter-count">—</strong>
        <span id="typewriter-runtime">Web Worker</span>
      </div>
    </div>
    <div className="st-section">
      <div className="st-section-title">Original font preview</div>
      <input id="typewriter-font-file" className="typewriter-font-file" type="file" accept=".ttf,font/ttf" />
      <div id="typewriter-font-status" className="typewriter-font-status loading">The original Blurmed.ttf is license-restricted. Exact extracted glyph geometry is embedded; choose your local recovered TTF to match the editor preview.</div>
      <p className="st-finding" title="The commercial binary is not distributed, but the outline atlas still requires license review; the supplied Pixels preview font also has unverified license provenance.">
        Generated geometry uses a reusable Blender-extracted Blurmed outline atlas.
      </p>
    </div>
  </>;

  return <StudioShell
    className="typewriter-page"
    leftDock={leftDock}
    status={<>
      <span className="st-dot busy" />
      <span id="typewriter-status">Loading portable graph…</span>
      <span className="st-spacer" />
      <span className="st-muted">drag to orbit · scroll to zoom</span>
    </>}
  >
    <canvas id="typewriter-canvas" />
    <ToolStateOverlay state={runtimeState} />
  </StudioShell>;
}
