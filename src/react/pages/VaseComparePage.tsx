import { useToolRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import { ToolStateOverlay } from "../studio/ToolStateOverlay";
import "./vase-compare.css";

const loadVase = () => import("../../vase-compare");

/**
 * Bubble vase parity. vase-compare.ts drives every control by id and reflects
 * state through aria-pressed, which the kit's segmented control already
 * styles — so the buttons keep their ids and lose their bespoke pill CSS.
 */
export default function VaseComparePage(): React.JSX.Element {
  const runtimeState = useToolRuntime("Bubble Vase · Blender vs GN-VM", loadVase);
  const leftDock = <>
    <StudioPanelHeader title="Comparison" />
    <div className="st-section">
      <div className="st-section-title">Engines</div>
      <div className="st-segmented">
        <button id="toggle-truth" className="vase-truth-toggle" type="button" aria-pressed="true">Blender</button>
        <button id="toggle-vm" type="button" aria-pressed="true">GN-VM</button>
      </div>
      <div className="st-section-title">Layout</div>
      <div className="st-segmented">
        <button id="view-overlay" type="button" aria-pressed="true">Overlay</button>
        <button id="view-side-by-side" type="button" aria-pressed="false">Side by side</button>
      </div>
      <div className="st-section-title">GN-VM style</div>
      <div className="st-segmented">
        <button id="toggle-vm-style" type="button" aria-pressed="false">VM solid</button>
      </div>
      <button id="reframe" className="st-btn" type="button">Reframe</button>
    </div>
    <div className="st-section">
      <div className="st-section-title">Shortcuts</div>
      <p className="st-finding">
        <b>1</b> Blender · <b>2</b> GN-VM · <b>3</b> both · <b>T/V</b> toggle each ·
        {" "}<b>O/S</b> overlay / side by side · <b>W</b> solid · <b>R</b> reframe
      </p>
    </div>
  </>;

  return <StudioShell
    className="vase-compare-page"
    leftDock={leftDock}
    toolbar={<>
      <span className="st-swatch truth" aria-hidden="true" /><span>Blender truth · red wire</span>
      <span className="st-swatch vm" aria-hidden="true" /><span>GN-VM · blue wire</span>
      <span className="st-spacer" />
      <span>drag to orbit · scroll to zoom</span>
    </>}
    status={<span id="vase-status" className="st-state busy">
      <span className="st-dot" />
      <span data-status-text>loading…</span>
    </span>}
  >
    <canvas id="app"></canvas>
    <ToolStateOverlay state={runtimeState} />
  </StudioShell>;
}
