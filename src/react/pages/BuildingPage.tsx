import { useEffect, useState } from "react";
import { defaultParams, type BuildingParams } from "../../params";
import type { BuildingAtmosphere, BuildingStatus, BuildingToolHandle } from "../../main";
import { useToolController } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import "./building.css";
import { rangeFillStyle } from "../studio/range-fill";

// Started here rather than inside the loader callback: as a callback the import
// was only discovered once React ran the mount effect, which held the runtime
// chunk (three.js, loaders, lil-gui) back by ~1.2s. Evaluating this module is
// itself the signal that the route is live, so fetch it now and hand the same
// promise to the controller.
const buildingRuntime = import("../../main");
const loadBuilding = () => buildingRuntime;

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

const ATMOSPHERE_CONTROLS: Array<{
  name: keyof BuildingAtmosphere;
  label: string;
  group: string;
  min?: number;
  max?: number;
  step?: number;
}> = [
  { name: "exposure", label: "Exposure", group: "Lighting", min: 0, max: 3, step: .01 },
  { name: "envIntensity", label: "Environment", group: "Lighting", min: 0, max: 2, step: .01 },
  { name: "key", label: "Key light", group: "Lighting", min: 0, max: 8, step: .01 },
  { name: "fill", label: "Fill light", group: "Lighting", min: 0, max: 4, step: .01 },
  { name: "rim", label: "Rim light", group: "Lighting", min: 0, max: 400, step: 1 },
  { name: "fog", label: "Fog", group: "Weather" },
  { name: "fogDensity", label: "Fog density", group: "Weather", min: 0, max: .03, step: .0005 },
  { name: "snow", label: "Snow", group: "Weather" },
  { name: "snowDensity", label: "Snow density", group: "Weather", min: 0, max: 1, step: .01 },
  { name: "rain", label: "Rain", group: "Weather" },
  { name: "rainDensity", label: "Rain density", group: "Weather", min: 0, max: 1, step: .01 },
  { name: "autoOrbit", label: "Auto orbit", group: "Camera" },
  { name: "orbitSpeed", label: "Orbit speed", group: "Camera", min: -3, max: 3, step: .05 },
  { name: "fov", label: "Focal / FOV", group: "Camera", min: 18, max: 80, step: 1 },
  { name: "letterbox", label: "Letterbox", group: "Camera" },
  { name: "bloom", label: "Bloom", group: "Effects", min: 0, max: 2, step: .01 },
  { name: "grain", label: "Film grain", group: "Effects", min: 0, max: .25, step: .005 },
  { name: "vignette", label: "Vignette", group: "Effects", min: 0, max: 1.5, step: .01 },
];

export default function BuildingPage(): React.JSX.Element {
  const tool = useToolController<BuildingToolHandle>("Hong Kong Building Generator", loadBuilding);
  const [params, setParams] = useState<BuildingParams>(defaultParams);
  const [emissive, setEmissive] = useState(1);
  const [atmosphere, setAtmosphere] = useState<BuildingAtmosphere | null>(null);
  const [status, setStatus] = useState<BuildingStatus>({ state: "loading", message: "Loading asset kit…" });

  // The runtime owns the authoritative values: the headless hook (__setParams)
  // mutates them behind the dock's back, so the dock subscribes rather than
  // treating its own state as the source of truth.
  useEffect(() => {
    if (!tool) return;
    setParams(tool.getParams());
    setEmissive(tool.getEmissive());
    setAtmosphere(tool.getAtmosphere());
    const unsubscribeParams = tool.subscribe(setParams);
    const unsubscribeStatus = tool.subscribeStatus(setStatus);
    return () => {
      unsubscribeParams();
      unsubscribeStatus();
    };
  }, [tool]);

  const leftDock = <>
    <StudioPanelHeader title="Build system" />
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
            style={rangeFillStyle(params[control.name], control.min, control.max)}
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
          style={rangeFillStyle(emissive, 1, 50)}
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

  const rightDock = <>
    <StudioPanelHeader title="Atmosphere" />
    {(["Lighting", "Weather", "Camera", "Effects"] as const).map((group) => <div className="st-section" key={group}>
      <div className="st-section-title">{group}</div>
      {ATMOSPHERE_CONTROLS.filter((control) => control.group === group).map((control) => {
        const value = atmosphere?.[control.name];
        return <label className="st-row" key={control.name}>
          <span>{control.label}</span>
          {typeof value === "boolean" || control.min === undefined ? <input
            type="checkbox"
            checked={Boolean(value)}
            disabled={!tool || !atmosphere}
            onChange={(event) => {
              const next = event.target.checked;
              setAtmosphere((current) => current ? { ...current, [control.name]: next } : current);
              tool?.setAtmosphere(control.name, next);
            }}
          /> : <>
            <input
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={Number(value ?? 0)}
              style={rangeFillStyle(Number(value ?? 0), control.min ?? 0, control.max ?? 1)}
              disabled={!tool}
              onChange={(event) => {
                const next = Number(event.target.value);
                setAtmosphere((current) => current ? { ...current, [control.name]: next } : current);
                tool?.setAtmosphere(control.name, next);
              }}
            />
            <output>{Number(value ?? 0).toFixed((control.step ?? 1) < .01 ? 3 : (control.step ?? 1) < 1 ? 2 : 0)}</output>
          </>}
        </label>;
      })}
    </div>)}
    {/* Legacy controllers stay detached while capture hooks transition. */}
    <div id="building-gui-dock" className="building-gui-dock" hidden aria-hidden="true" />
  </>;

  return <StudioShell
    className="building-page"
    leftDock={leftDock}
    rightDock={rightDock}
    toolbar={<>
      <span>Hong Kong tower · hand-ported build system</span>
      <span className="st-spacer" />
      {/* Every other 3D route has one; this was the only tool where a camera
          driven off into a corner could not be recovered without a reload. */}
      <button type="button" className="st-btn" disabled={!tool} onClick={() => tool?.reframe()}>Reframe</button>
    </>}
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
