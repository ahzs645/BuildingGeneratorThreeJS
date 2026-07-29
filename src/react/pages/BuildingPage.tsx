import { useEffect, useState } from "react";
import { defaultParams, type BuildingParams } from "../../params";
import type { BuildingStatus, BuildingToolHandle } from "../../main";
import { useToolController } from "../page-runtime";
import { StudioShell } from "../studio/StudioShell";
import "./building.css";

const loadBuilding = () => import("../../main");

type BuildingControl = {
  name: keyof BuildingParams;
  label: string;
  min: number;
  max: number;
  step: number;
};

// The exposed inputs of the Blender "build system" node group, in the order the
// authored modifier lists them. Ranges match the ones lil-gui used.
const BUILDING_CONTROLS: BuildingControl[] = [
  { name: "floor", label: "Floors", min: 3, max: 40, step: 1 },
  { name: "length", label: "Length", min: 2, max: 40, step: 1 },
  { name: "width", label: "Width", min: 2, max: 40, step: 1 },
  { name: "acUnit", label: "AC unit", min: 0, max: 1, step: 0.01 },
  { name: "roofProbability", label: "Window awning", min: 0, max: 1, step: 0.01 },
  { name: "clothlineProbability", label: "Clothline", min: 0, max: 1, step: 0.01 },
  { name: "windowType", label: "Window type", min: 0, max: 1, step: 0.01 },
  { name: "windowOpenAmount", label: "Window open", min: 0, max: 1, step: 0.01 },
  { name: "curtainClose", label: "Curtain close", min: 0, max: 1, step: 0.01 },
  { name: "closedOpenStore", label: "Open store", min: 0, max: 1, step: 0.01 },
  { name: "roofOnStore", label: "Roof on store", min: 0, max: 1, step: 0.01 },
  { name: "objectOnGround", label: "Ground objects", min: 0, max: 1, step: 0.01 },
  { name: "storeSign", label: "Store sign", min: 0, max: 1, step: 0.01 },
  { name: "objectOnRoof", label: "Roof objects", min: 0, max: 1, step: 0.01 },
  { name: "randomise", label: "Seed", min: 0, max: 1000, step: 1 },
];

export default function BuildingPage(): React.JSX.Element {
  const tool = useToolController<BuildingToolHandle>("Hong Kong Building Generator", loadBuilding);
  const [params, setParams] = useState<BuildingParams>(defaultParams);
  const [emissive, setEmissive] = useState(1);
  const [status, setStatus] = useState<BuildingStatus>({ state: "loading", message: "Loading asset kit…" });

  // The runtime owns the authoritative values: the headless hook (__setParams)
  // mutates them behind the dock's back, so the dock subscribes rather than
  // treating its own state as the source of truth.
  useEffect(() => {
    if (!tool) return;
    setParams(tool.getParams());
    setEmissive(tool.getEmissive());
    const unsubscribeParams = tool.subscribe(setParams);
    const unsubscribeStatus = tool.subscribeStatus(setStatus);
    return () => {
      unsubscribeParams();
      unsubscribeStatus();
    };
  }, [tool]);

  const leftDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Build system</button></div>
    <div className="st-section">
      <div className="st-section-title">Generator<small>{BUILDING_CONTROLS.length} inputs</small></div>
      {BUILDING_CONTROLS.map((control) => (
        <label className="st-row" key={control.name}>
          <span>{control.label}</span>
          <input
            type="range"
            min={control.min}
            max={control.max}
            step={control.step}
            value={params[control.name]}
            disabled={!tool}
            onChange={(event) => {
              const value = Number(event.target.value);
              setParams((current) => ({ ...current, [control.name]: value }));
              tool?.setParam(control.name, value);
            }}
          />
          <output>{control.step === 1 ? params[control.name] : params[control.name].toFixed(2)}</output>
        </label>
      ))}
      <label className="st-row" title="Floor emissive multiplier — a material tweak, so it never rebuilds the instanced meshes">
        <span>Emissive</span>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={emissive}
          disabled={!tool}
          onChange={(event) => {
            const value = Number(event.target.value);
            setEmissive(value);
            tool?.setEmissive(value);
          }}
        />
        <output>{emissive}</output>
      </label>
    </div>
  </>;

  // The atmosphere rig (environment, snow, rain, cinematic) is still a lil-gui
  // panel; main.ts mounts it into this container so it docks with the shell
  // instead of floating over the viewport.
  const rightDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Atmosphere</button></div>
    <div id="building-gui-dock" className="building-gui-dock" />
  </>;

  return <StudioShell
    className="building-page"
    leftDock={leftDock}
    rightDock={rightDock}
    status={<>
      <span className={`st-dot ${status.state === "ready" ? "ready" : status.state === "error" ? "error" : "busy"}`} />
      <span>{status.message}</span>
      <span className="st-sep" />
      <span className="st-muted">drag to orbit · scroll to zoom</span>
      <span className="st-spacer" />
      <span className="st-muted">{params.floor} floors · {params.length} × {params.width}</span>
    </>}
  >
    <div id="app"></div>
    {/* Letterboxing is driven by the cinematic folder, so the bars stay. */}
    <div id="bar-top" className="bar top"></div>
    <div id="bar-bottom" className="bar bottom"></div>
    <div id="loading">Loading asset kit…</div>
  </StudioShell>;
}
