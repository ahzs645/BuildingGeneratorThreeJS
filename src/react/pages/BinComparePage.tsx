import { useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { BIN_PARAMETERS, BIN_PRESETS, type BinParameter } from "../../bin-params";
import { useToolRuntime } from "../page-runtime";
import { StudioShell, useMobileStudio } from "../studio/StudioShell";
import { ToolStateOverlay } from "../studio/ToolStateOverlay";
import "./bin-compare.css";

const loadBinCompare = () => import("../../bin-compare");
type Workspace = "build" | "validate";

const groups: Array<{ title: string; names: string[] }> = [
  { title: "Dimensions", names: ["Size X", "Size Y", "Size Z"] },
  { title: "Shell", names: ["bin gap size", "bin wall thiccness", "fillet"] },
  { title: "Dividers and selection", names: ["divide x", "divide y", "Bin Select"] },
  { title: "Print and export", names: ["print layers", "make exportable"] },
];

const labels: Record<string, { label: string; help: string }> = {
  "Size X": { label: "Size X", help: "Authored Blender distance along X." },
  "Size Y": { label: "Size Y", help: "Authored Blender distance along Y." },
  "Size Z": { label: "Size Z", help: "Authored Blender distance along Z." },
  "bin gap size": { label: "Bin gap", help: "Spacing used by the recursive bin layout." },
  "bin wall thiccness": { label: "Wall thickness", help: "Authored shell thickness control." },
  fillet: { label: "Fillet", help: "Corner rounding below Blender's degenerate path." },
  "divide x": { label: "Divider X", help: "Normalized divider position along X." },
  "divide y": { label: "Divider Y", help: "Normalized divider position along Y." },
  "Bin Select": { label: "Bin selection", help: "Selects one of the twelve checked-in bin variants." },
  "print layers": { label: "Print layers", help: "Authored print-layer visualization amount." },
  "make exportable": { label: "Generate export-ready geometry", help: "Runs the authored geometry branch intended for export." },
};

function rangeText(parameter: BinParameter): string {
  if (parameter.boolean) return "Blender boolean";
  return `${parameter.min}–${parameter.max}`;
}

function moveTab(event: KeyboardEvent<HTMLButtonElement>, ids: readonly [string, string], current: 0 | 1): void {
  let next: 0 | 1;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 1;
  else if (event.key === "ArrowLeft") next = current === 0 ? 1 : 0;
  else if (event.key === "ArrowRight") next = current === 1 ? 0 : 1;
  else return;
  event.preventDefault();
  queueMicrotask(() => {
    const button = document.getElementById(ids[next]) as HTMLButtonElement | null;
    button?.focus();
    // The imperative geometry runtime also listens for the click so it can
    // persist the active workspace and comparison view across a breakpoint
    // remount. A synthetic focus-only tab change would leave it stale.
    button?.click();
  });
}

const workspaceTabIds = ["workspace-build", "workspace-validate"] as const;
const validationTabIds = ["validate-results-tab", "validate-findings-tab"] as const;

export default function BinComparePage(): React.JSX.Element {
  const { search } = useLocation();
  const isMobile = useMobileStudio();
  const initialWorkspace = new URLSearchParams(search).get("workspace") === "validate" ? "validate" : "build";
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [validateTab, setValidateTab] = useState<"results" | "findings">("results");
  const runtimeState = useToolRuntime("Recursive Bin · Build and Validate", loadBinCompare, isMobile);

  const parameterByName = new Map(BIN_PARAMETERS.map((parameter) => [parameter.name, parameter]));
  const controls = <>
    <div className="bin-preset-row">
      <label htmlFor="bin-preset">Preset</label>
      <select id="bin-preset" className="st-select" defaultValue="authored">
        {BIN_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        <option value="custom" disabled>Custom settings</option>
      </select>
      <small id="bin-preset-description">{BIN_PRESETS[0].description}</small>
    </div>
    {groups.map((group) => <section className="bin-control-group" key={group.title}>
      <div className="st-section-title">{group.title}</div>
      {group.names.map((name) => {
        const parameter = parameterByName.get(name)!;
        const label = labels[name];
        const labelId = `bin-label-${parameter.name.replace(/\s+/g, "-").toLowerCase()}`;
        return <div className={`st-row bin-param-row${parameter.boolean ? " is-boolean" : ""}`} key={parameter.name} title={label.help}>
          <span id={labelId} className="bin-control-label">
            <b>{label.label}</b>
            <small>{rangeText(parameter)}</small>
          </span>
          {parameter.boolean ? (
            <input data-bin-param={parameter.name} aria-labelledby={labelId} type="checkbox" defaultChecked={Boolean(parameter.defaultValue)} />
          ) : <>
            <input
              data-bin-param={parameter.name}
              aria-labelledby={labelId}
              aria-describedby={`${labelId}-help`}
              type="range"
              min={parameter.min}
              max={parameter.max}
              step={parameter.step}
              defaultValue={Number(parameter.defaultValue)}
            />
            <input
              className="bin-number"
              data-bin-output={parameter.name}
              aria-label={`${label.label} exact value`}
              aria-describedby={`${labelId}-help`}
              type="number"
              min={parameter.min}
              max={parameter.max}
              step={parameter.step}
              defaultValue={Number(parameter.defaultValue).toFixed(parameter.step === 1 ? 0 : 3)}
            />
          </>}
          <span id={`${labelId}-help`} className="bin-sr-only">{label.help} Validated range {rangeText(parameter)}.</span>
        </div>;
      })}
    </section>)}
    <div className="bin-workflow-actions">
      <button id="reset-bin" className="st-btn" type="button">Authored reset</button>
      <button id="revert-bin" className="st-btn" type="button" disabled>Revert preview</button>
      <button id="copy-bin-link" className="st-btn" type="button">Copy link</button>
    </div>
    <p className="bin-range-note">Validated browser ranges are shown beside each control. Values outside the published contract remain Blender-only.</p>
  </>;

  const dock = <>
    <div className="st-tabs bin-workspace-tabs" role="tablist" aria-label="Recursive Bin workspace">
      <button
        id="workspace-build"
        type="button"
        role="tab"
        aria-controls="workspace-build-panel"
        aria-selected={workspace === "build"}
        tabIndex={workspace === "build" ? 0 : -1}
        onKeyDown={(event) => moveTab(event, workspaceTabIds, 0)}
        onClick={() => setWorkspace("build")}
      >Build Bin</button>
      <button
        id="workspace-validate"
        type="button"
        role="tab"
        aria-controls="workspace-validate-panel"
        aria-selected={workspace === "validate"}
        tabIndex={workspace === "validate" ? 0 : -1}
        onKeyDown={(event) => moveTab(event, workspaceTabIds, 1)}
        onClick={() => setWorkspace("validate")}
      >Validate Engines</button>
    </div>

    <div id="workspace-build-panel" role="tabpanel" aria-labelledby="workspace-build" hidden={workspace !== "build"}>
      <div className="st-section bin-build-controls">{controls}</div>
      <div className="st-section">
        <div className="st-section-title">Preview</div>
        <div className="bin-state-card">
          <span id="preview-state-dot" className="st-dot" />
          <div><b id="preview-state">Preparing GN-VM preview…</b><small id="evaluated-params">Authored settings</small></div>
        </div>
        <div className="bin-primary-actions">
          <button id="preview-bin" className="st-btn-primary" type="button">Preview current bin</button>
          <button id="frame-bin" className="st-btn" type="button">Reframe</button>
        </div>
      </div>
      <div className="st-section">
        <div className="st-section-title">Export evaluated preview</div>
        <label className="st-field"><span>Engine</span><select id="export-engine" className="st-select" defaultValue="vm"><option value="vm">GN-VM</option><option id="export-engine-blender" value="blender" disabled>Blender truth</option></select></label>
        <div className="bin-export-actions">
          <button id="export-glb" className="st-btn" type="button" disabled>GLB</button>
          <button id="export-stl" className="st-btn" type="button" disabled>STL</button>
          <button id="export-metadata" className="st-btn" type="button" disabled>Metadata</button>
        </div>
        <small className="bin-section-help">Exports always use the last evaluated parameter snapshot, never pending edits. GLB embeds that snapshot and evidence metadata. STL stores geometry only—no materials, colors, units, or parameters—so download Metadata alongside it.</small>
      </div>
    </div>

    <div id="workspace-validate-panel" role="tabpanel" aria-labelledby="workspace-validate" hidden={workspace !== "validate"}>
      <div className="st-section">
        <div className="st-section-title">Truth capability</div>
        <div className="bin-state-card">
          <span id="truth-capability-dot" className="st-dot" />
          <div><b id="truth-capability">Checking Blender…</b><small id="truth-capability-detail">12 checked-in selection bakes available</small></div>
        </div>
        <button id="update-comparison" className="st-btn-primary" type="button">Compare with Blender</button>
        <Link className="bin-live-link" to="/bin/live">Open Blender service diagnostics →</Link>
      </div>
      <div className="st-section">
        <div className="st-section-title">Comparison view</div>
        <div className="st-segmented" role="group" aria-label="Comparison layout"><button id="mode-overlay" className="active" aria-pressed="true" type="button">Overlay</button><button id="mode-split" aria-pressed="false" type="button">Side by side</button></div>
        <div className="st-segmented" role="group" aria-label="Render style">
          <button id="style-wire" className="active" aria-pressed="true" type="button">Edges</button><button id="style-material" aria-pressed="false" type="button">Material</button>
        </div>
        <div className="st-segmented bin-result-filter" role="group" aria-label="Visible engines">
          <button id="show-both" className="active" aria-pressed="true" type="button">Both</button>
          <button id="show-truth" aria-pressed="false" type="button">Blender</button>
          <button id="show-vm" aria-pressed="false" type="button">GN-VM</button>
        </div>
        <p className="bin-section-help">Material mode reconstructs authored shaders in WebGL; it is not a Blender render comparison.</p>
      </div>
      <div className="st-tabs" role="tablist" aria-label="Validation details">
        <button id="validate-results-tab" type="button" role="tab" aria-controls="validate-results" aria-selected={validateTab === "results"} tabIndex={validateTab === "results" ? 0 : -1} onKeyDown={(event) => moveTab(event, validationTabIds, 0)} onClick={() => setValidateTab("results")}>Results</button>
        <button id="validate-findings-tab" type="button" role="tab" aria-controls="validate-findings" aria-selected={validateTab === "findings"} tabIndex={validateTab === "findings" ? 0 : -1} onKeyDown={(event) => moveTab(event, validationTabIds, 1)} onClick={() => setValidateTab("findings")}>Findings</button>
      </div>
      <div id="validate-results" role="tabpanel" aria-labelledby="validate-results-tab" className="st-section bin-results stale" hidden={validateTab !== "results"}>
        <div className="bin-result-heading"><span id="result-classification" className="bin-classification">Not validated</span><small id="result-freshness">No comparison for current inputs</small></div>
        <div className="st-result-row truth"><span id="truth-metric-label">Blender truth</span><strong id="truth-tris">—</strong><small id="truth-red">—</small></div>
        <div className="st-result-row vm"><span>GN-VM</span><strong id="vm-tris">—</strong><small id="vm-red">—</small></div>
        <div className="st-result-row delta"><span>Difference</span><strong id="delta-envelope">—</strong><small id="delta-tris">—</small></div>
        <small id="result-evidence" className="bin-evidence">Evidence will identify topology, surface, bounds, or unavailable truth.</small>
      </div>
      <div id="validate-findings" role="tabpanel" aria-labelledby="validate-findings-tab" className="st-section" hidden={validateTab !== "findings"}>
        <div className="st-section-title">Current setting</div>
        <p id="finding" className="st-finding">Compare this setting to classify its available parity evidence.</p>
        <div className="bin-contract-summary"><b>Published contract</b><span>44 exact-bounds probes · 24 exact-topology probes · Blender 5.1.2</span></div>
      </div>
    </div>
  </>;

  return <StudioShell
    className="bin-compare-page"
    leftDock={dock}
    toolbar={<>
      <strong>{workspace === "build" ? "Build Bin" : "Validate Engines"}</strong>
      <span id="toolbar-source" className="st-muted">GN-VM preview</span>
      <span className="st-spacer" />
      <button id="toolbar-frame-bin" className="bin-toolbar-button" type="button">Reframe</button>
      <span className="bin-desktop-hint">drag to orbit · scroll to zoom</span>
    </>}
    status={<>
      <span id="compare-status" role="status" aria-live="polite" aria-atomic="true"><span className="st-dot" />Loading bin workspace…</span>
      <span className="st-spacer" />
      <span className="st-muted bin-shortcut-hint">O overlay · S split · W edges · 1/2/3 isolate</span>
    </>}
  >
    <canvas
      key={isMobile ? "mobile-bin-canvas" : "desktop-bin-canvas"}
      id="app"
      role="img"
      tabIndex={0}
      aria-label="Interactive Recursive Bin geometry preview"
      aria-describedby="bin-canvas-help"
      aria-keyshortcuts="O S W 1 2 3"
    ></canvas>
    <span id="bin-canvas-help" className="bin-sr-only">Orbit and zoom the Recursive Bin preview. In Validate Engines, O selects overlay, S selects side by side, W toggles edges, and 1, 2, or 3 isolates an engine.</span>
    <ToolStateOverlay state={runtimeState} />
    <div className="viewport-label truth-label">Blender</div>
    <div className="viewport-label vm-label">GN-VM</div>
  </StudioShell>;
}
