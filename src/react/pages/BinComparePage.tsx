import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import { appHref } from "../../base-url";
import { BIN_PARAMETERS } from "../../bin-params";
import "./bin-compare.css";

const loadBinCompare = () => import("../../bin-compare");

export default function BinComparePage(): React.JSX.Element {
  usePageRuntime("Dojo Bin Compare · Blender vs GN-VM", loadBinCompare);
  return (
    <div className="bin-compare-shell">
      <canvas id="app"></canvas>
      <StudioLink />
      <header className="compare-head">
        <div><p className="kicker">Node Dojo · parity lab</p><h1>Bin Compare</h1><p>Live Blender truth <span className="truth-key">red</span> against live browser GN-VM <span className="vm-key">blue</span>, driven by the same inputs.</p></div>
        <div id="compare-status" className="compare-status"><span></span>Loading both pipelines…</div>
      </header>
      <aside className="compare-panel">
        <section className="parameter-section">
          <div className="section-head"><span>Shared Blender + GN-VM inputs</span><span id="truth-source">live</span></div>
          <div className="parameter-grid">
            {BIN_PARAMETERS.map((parameter) => (
              <label className={parameter.boolean ? "parameter-row boolean-row" : "parameter-row"} key={parameter.name}>
                <span>{parameter.name}</span>
                {parameter.boolean ? (
                  <input data-bin-param={parameter.name} type="checkbox" defaultChecked={Boolean(parameter.defaultValue)} />
                ) : (
                  <span className="parameter-control">
                    <input data-bin-param={parameter.name} type="range" min={parameter.min} max={parameter.max} step={parameter.step} defaultValue={Number(parameter.defaultValue)} />
                    <output data-bin-output={parameter.name}>{Number(parameter.defaultValue).toFixed(parameter.step === 1 ? 0 : 3)}</output>
                  </span>
                )}
              </label>
            ))}
          </div>
          <button id="update-comparison" className="update-comparison" type="button">Update both engines</button>
        </section>
        <section>
          <span className="panel-label">Comparison mode</span>
          <div className="segmented"><button id="mode-overlay" className="active" type="button">Overlay</button><button id="mode-split" type="button">Side by side</button></div>
          <div className="segmented secondary"><button id="style-wire" className="active" type="button">Edges</button><button id="style-material" type="button">Materials</button></div>
          <div className="segmented result-filter"><button id="show-both" className="active" type="button">Both</button><button id="show-truth" type="button">Blender</button><button id="show-vm" type="button">GN-VM</button></div>
          <a className="live-blender-link" href={appHref("/bin/live")}>Open all live Blender controls →</a>
        </section>
        <section className="metrics">
          <article className="metric truth-metric"><span id="truth-metric-label">Blender truth</span><strong id="truth-tris">—</strong><small id="truth-red">—</small></article>
          <article className="metric vm-metric"><span>GN-VM</span><strong id="vm-tris">—</strong><small id="vm-red">—</small></article>
          <article className="metric delta-metric"><span>Difference</span><strong id="delta-envelope">—</strong><small id="delta-tris">—</small></article>
        </section>
        <section className="finding"><span className="panel-label">What this catches</span><p id="finding">Change the shared value to compare the same authored setting in both engines.</p></section>
      </aside>
      <div className="viewport-label truth-label">Blender</div><div className="viewport-label vm-label">GN-VM</div>
      <div className="compare-help">Drag to orbit · scroll to zoom · <b>O</b> overlay · <b>S</b> split · <b>W</b> edges/materials · <b>1/2/3</b> isolate results</div>
    </div>
  );
}
