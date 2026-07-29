import { useState } from "react";
import { Link } from "react-router-dom";
import { useToolRuntime } from "../page-runtime";
import { BIN_PARAMETERS } from "../../bin-params";
import { StudioShell } from "../studio/StudioShell";
import "./bin-compare.css";

const loadBinCompare = () => import("../../bin-compare");

/**
 * Dojo Bin parity workspace. The imperative runtime in bin-compare.ts owns
 * every control by id, so the dock tabs hide their panels with `hidden`
 * instead of unmounting them: a control that left the DOM would break the
 * runtime's non-null queries the moment a tab changed.
 */
export default function BinComparePage(): React.JSX.Element {
  useToolRuntime("Dojo Bin Compare · Blender vs GN-VM", loadBinCompare);
  const [inputTab, setInputTab] = useState<"inputs" | "view">("inputs");
  const [resultTab, setResultTab] = useState<"results" | "findings">("results");

  const leftDock = <>
    <div className="st-tabs" role="tablist" aria-label="Inputs and view">
      <button type="button" role="tab" aria-selected={inputTab === "inputs"} onClick={() => setInputTab("inputs")}>Shared inputs</button>
      <button type="button" role="tab" aria-selected={inputTab === "view"} onClick={() => setInputTab("view")}>View</button>
    </div>
    <div className="st-section" hidden={inputTab !== "inputs"}>
      <div className="st-section-title">Shared Blender + GN-VM inputs<small>{BIN_PARAMETERS.length}</small></div>
      {BIN_PARAMETERS.map((parameter) => (
        <label className="st-row" key={parameter.name}>
          <span>{parameter.name}</span>
          {parameter.boolean ? (
            <input data-bin-param={parameter.name} type="checkbox" defaultChecked={Boolean(parameter.defaultValue)} />
          ) : (
            <>
              <input data-bin-param={parameter.name} type="range" min={parameter.min} max={parameter.max} step={parameter.step} defaultValue={Number(parameter.defaultValue)} />
              <output data-bin-output={parameter.name}>{Number(parameter.defaultValue).toFixed(parameter.step === 1 ? 0 : 3)}</output>
            </>
          )}
        </label>
      ))}
      <button id="update-comparison" className="st-btn-primary" type="button">Update both engines</button>
    </div>
    <div className="st-section" hidden={inputTab !== "view"}>
      <div className="st-section-title">Comparison</div>
      <div className="st-segmented"><button id="mode-overlay" className="active" type="button">Overlay</button><button id="mode-split" type="button">Side by side</button></div>
      <div className="st-segmented" title="Both meshes use the same WebGL reconstruction of the authored Principled constants and Wave/Noise bump — this is not a Blender shader comparison.">
        <button id="style-wire" className="active" type="button">Edges</button><button id="style-material" type="button">Material</button>
      </div>
      <div className="st-segmented bin-result-filter">
        <button id="show-both" className="active" type="button">Both</button>
        <button id="show-truth" type="button">Blender</button>
        <button id="show-vm" type="button">GN-VM</button>
      </div>
    </div>
    <div className="st-section" hidden={inputTab !== "view"}>
      <div className="st-section-title">Truth source</div>
      <div className="st-card">
        <span className="st-dot ready" />
        <div className="bin-card-copy">
          <b id="truth-source">live</b>
          <small>12 checked-in bakes · v0.1.1</small>
        </div>
      </div>
      <Link className="bin-live-link" to="/bin/live">Open live Blender controls →</Link>
    </div>
  </>;

  const rightDock = <>
    <div className="st-tabs" role="tablist" aria-label="Results and findings">
      <button type="button" role="tab" aria-selected={resultTab === "results"} onClick={() => setResultTab("results")}>Results</button>
      <button type="button" role="tab" aria-selected={resultTab === "findings"} onClick={() => setResultTab("findings")}>Findings</button>
    </div>
    <div className="st-section" hidden={resultTab !== "results"}>
      <div className="st-result-row truth"><span id="truth-metric-label">Blender truth</span><strong id="truth-tris">—</strong><small id="truth-red">—</small></div>
      <div className="st-result-row vm"><span>GN-VM</span><strong id="vm-tris">—</strong><small id="vm-red">—</small></div>
      <div className="st-result-row delta"><span>Difference</span><strong id="delta-envelope">—</strong><small id="delta-tris">—</small></div>
    </div>
    <div className="st-section" hidden={resultTab !== "findings"}>
      <div className="st-section-title">What this catches</div>
      <p id="finding" className="st-finding">Change the shared value to compare the same authored setting in both engines.</p>
    </div>
  </>;

  return (
    <StudioShell
      className="bin-compare-page"
      leftDock={leftDock}
      rightDock={rightDock}
      toolbar={<>
        <span className="st-swatch truth" aria-hidden="true" /><span>Blender truth</span>
        <span className="st-swatch vm" aria-hidden="true" /><span>GN-VM</span>
        <span className="st-spacer" />
        <span>drag to orbit · scroll to zoom</span>
      </>}
      status={<>
        <span id="compare-status"><span className="st-dot" />Loading both pipelines…</span>
        <span className="st-sep" />
        <span className="st-muted">O overlay · S split · W edges · 1/2/3 isolate</span>
        <span className="st-spacer" />
        <span className="st-muted">Baked truth · GN-VM live</span>
      </>}
    >
      <canvas id="app"></canvas>
      <div className="viewport-label truth-label">Blender</div>
      <div className="viewport-label vm-label">GN-VM</div>
    </StudioShell>
  );
}
