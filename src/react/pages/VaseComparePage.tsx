import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./vase-compare.css";

const loadVase = () => import("../../vase-compare");

export default function VaseComparePage(): React.JSX.Element {
  usePageRuntime("Bubble Vase · Blender vs GN-VM", loadVase);
  return (
    <>
      <canvas id="app"></canvas><StudioLink />
      <div id="hud"><b>Vase compare</b> · <span className="truth">red wire = Blender truth</span> · <span className="vm">blue wire = GN-VM</span> · <span id="stat">loading…</span>
        <div className="compare-controls" aria-label="Vase comparison controls">
          <button id="toggle-truth" className="truth-toggle" type="button" aria-pressed="true">Blender</button><button id="toggle-vm" type="button" aria-pressed="true">GN-VM</button><button id="view-overlay" type="button" aria-pressed="true">Overlay</button><button id="view-side-by-side" type="button" aria-pressed="false">Side by side</button><button id="toggle-vm-style" type="button" aria-pressed="false">VM solid</button><button id="reframe" type="button">Reframe</button>
        </div>
        <div style={{ opacity: .85, marginTop: 6 }}>Keys: <b>1</b> Blender · <b>2</b> GN-VM · <b>3</b> both · <b>T/V</b> toggle each · <b>O/S</b> overlay/side by side · <b>W</b> solid · <b>R</b> reframe</div>
      </div>
    </>
  );
}
