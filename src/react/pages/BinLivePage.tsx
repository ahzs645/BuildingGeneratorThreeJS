import { useEffect, useState } from "react";
import { BIN_PARAMETERS } from "../../bin-params";
import type { BinLiveHandle } from "../../bin-live";
import { useToolController } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import "./bin-live.css";

const loadBinLive = () => import("../../bin-live");

/**
 * Blender-backed bin with the same dock controls as the rest of the studio.
 * The runtime owns rendering and bridge calls; React owns the interface.
 */
export default function BinLivePage(): React.JSX.Element {
  const tool = useToolController<BinLiveHandle>("Dojo Bin — Live (Blender-backed)", loadBinLive);
  const [values, setValues] = useState<Record<string, number | boolean>>(() => Object.fromEntries(
    BIN_PARAMETERS.map((parameter) => [parameter.name, parameter.defaultValue]),
  ));
  useEffect(() => { if (tool) setValues(tool.getValues()); }, [tool]);
  const controls = <>
    <StudioPanelHeader title="Live Blender controls" meta={`${BIN_PARAMETERS.length} inputs`} />
    <div className="st-section">
      <div className="st-section-title">Recursive bin</div>
      {BIN_PARAMETERS.map((parameter) => <label className="st-row" key={parameter.name}>
        <span title={parameter.name}>{parameter.name}</span>
        {parameter.boolean ? <input
          type="checkbox"
          checked={Boolean(values[parameter.name])}
          disabled={!tool}
          onChange={(event) => {
            const value = event.target.checked;
            setValues((current) => ({ ...current, [parameter.name]: value }));
            tool?.setValue(parameter.name, value);
          }}
        /> : <>
          <input
            type="range"
            min={parameter.min}
            max={parameter.max}
            step={parameter.step}
            value={Number(values[parameter.name])}
            disabled={!tool}
            onChange={(event) => {
              const value = Number(event.target.value);
              setValues((current) => ({ ...current, [parameter.name]: value }));
              tool?.setValue(parameter.name, value);
            }}
          />
          <output>{Number(values[parameter.name]).toFixed(parameter.step === 1 ? 0 : 2)}</output>
        </>}
      </label>)}
      <button type="button" className="st-btn" disabled={!tool} onClick={() => tool?.reframe()}>Reframe model</button>
    </div>
  </>;
  return <StudioShell
    className="bin-live-page"
    leftDock={controls}
    status={<>
      <span className="st-dot busy" />
      <span>Every slider re-bakes geometry in Blender</span>
      <span className="st-sep" />
      <span className="st-muted">Three.js material preview</span>
      <span className="st-spacer" />
      <span id="stat">connecting…</span>
    </>}
  >
    <canvas id="app"></canvas>
    {!tool && <div className="st-tool-state" role="status"><span className="st-tool-state-spinner" /><b>Connecting to Blender…</b><small>Checking the local bake bridge on port 7801</small></div>}
    <div id="busy">baking…</div>
  </StudioShell>;
}
