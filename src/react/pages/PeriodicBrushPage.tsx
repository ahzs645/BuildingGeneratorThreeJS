import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./periodic-brush.css";

const loadPeriodicBrush = () => import("../../periodic-brush");

export default function PeriodicBrushPage(): React.JSX.Element {
  usePageRuntime("Node Dojo Periodic Brush · browser Geometry Nodes", loadPeriodicBrush);
  return <main className="periodic-shell">
    <canvas id="periodic-canvas" />
    <StudioLink />
    <header className="periodic-head">
      <p>Chrome Asset Library · browser port</p>
      <h1>Periodic Brush</h1>
      <div id="periodic-status">Loading extracted graph…</div>
    </header>
    <aside className="periodic-panel">
      <label><span>Dot distance</span><div className="periodic-range"><input id="periodic-distance" type="range" min="0.75" max="5" step="0.000001" defaultValue="2.151417" /><output id="periodic-distance-output">2.151</output></div></label>
      <label><span>Dot size</span><div className="periodic-range"><input id="periodic-size" type="range" min="0.15" max="2" step="0.01" defaultValue="1" /><output id="periodic-size-output">1.00</output></div></label>
      <button id="periodic-reset" type="button">Reset authored values</button>
      <section className="periodic-stats"><span>Browser GN-VM</span><strong id="periodic-count">—</strong><small id="periodic-runtime">Web Worker</small></section>
      <p className="periodic-note">This is the original <code>dot periodic brush.002</code> graph. Collection Info loads all nine evaluated shapes from <code>period pack</code>, then Pick Instance cycles them along the resampled curves.</p>
    </aside>
    <div className="periodic-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
