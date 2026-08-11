import { rangeFillStyle } from "../../studio/range-fill";
import type {
  SurfacePainterStudioSnapshot,
  SurfacePainterToolHandle,
} from "../../../surface-painter/main";

export interface SurfaceProjectionPanelProps {
  controller: SurfacePainterToolHandle;
  snapshot: SurfacePainterStudioSnapshot;
}

type VectorChannel = "position" | "rotation" | "scale";

function targetValue(snapshot: SurfacePainterStudioSnapshot): string {
  return snapshot.projectionTarget.kind === "mesh"
    ? snapshot.projectionTarget.targetId
    : snapshot.projectionTarget.kind === "all" ? "__all__" : "__pick__";
}

function projectionState(snapshot: SurfacePainterStudioSnapshot): { label: string; tone: string; detail: string } {
  if (!snapshot.hasDrawingArea) {
    return { label: "Not placed", tone: "idle", detail: "Choose Place area, then click the reference surface." };
  }
  if (snapshot.contactLocked || snapshot.areaCommitted) {
    return { label: "Locked", tone: "ready", detail: "The yellow contact patch is retained while the selector moves away." };
  }
  if (snapshot.areaContact) {
    return { label: "Contact", tone: "contact", detail: "Only the grid cells touching the surface are selected in yellow." };
  }
  const distance = snapshot.areaClosestContactDistance;
  return {
    label: "Floating",
    tone: "floating",
    detail: distance === null ? "No eligible surface is below this area." : `${distance.toFixed(3)} units from contact — no yellow is shown yet.`,
  };
}

function updateVector(
  controller: SurfacePainterToolHandle,
  snapshot: SurfacePainterStudioSnapshot,
  channel: VectorChannel,
  index: number,
  value: number,
): void {
  if (!Number.isFinite(value)) return;
  const position = [...snapshot.areaPosition];
  const rotation = [...snapshot.areaRotation];
  const scale = [...snapshot.areaScale];
  if (channel === "position") position[index] = value;
  else if (channel === "rotation") rotation[index] = value;
  else scale[index] = value;
  controller.setAreaTransform(position, rotation, scale);
}

function TransformVector({
  label,
  channel,
  values,
  controller,
  snapshot,
  step,
}: {
  label: string;
  channel: VectorChannel;
  values: readonly [number, number, number];
  controller: SurfacePainterToolHandle;
  snapshot: SurfacePainterStudioSnapshot;
  step: number;
}): React.JSX.Element {
  return <label className="surface-projection-vector">
    <span>{label}</span>
    {(["X", "Y", "Z"] as const).map((axis, index) => <span className="surface-projection-vector-input" key={axis}>
      <small>{axis}</small>
      <input
        type="number"
        step={step}
        value={Number(values[index].toFixed(3))}
        onChange={(event) => updateVector(controller, snapshot, channel, index, event.currentTarget.valueAsNumber)}
      />
    </span>)}
  </label>;
}

export function SurfaceProjectionPanel({ controller, snapshot }: SurfaceProjectionPanelProps): React.JSX.Element {
  const state = projectionState(snapshot);
  const target = snapshot.projectionTargets.find((option) => option.value === targetValue(snapshot));
  const activeSelector = snapshot.selectorLayers.find((selector) => selector.id === snapshot.activeSelectorId);
  const disabled = !snapshot.hasDrawingArea;
  const transformDisabled = disabled || Boolean(activeSelector?.locked);

  return (
    <details className="surface-projection-panel" open>
      <summary>
        <span><i className="surface-projection-state-dot" data-tone={state.tone} />Projection setup</span>
        <small>SHARED</small>
      </summary>
      <div className="surface-projection-panel-body">
        <div className="surface-projection-summary">
          <div><span>Target</span><strong>{target?.label ?? "Choose a target"}</strong></div>
          <div><span>Area</span><strong>{state.label}</strong></div>
        </div>
        <p className="surface-edit-hint">{state.detail}</p>

        <fieldset className="surface-projection-layers">
          <legend>Selector layers</legend>
          <label className="surface-projection-select-row">
            <span>Active selector</span>
            <select className="st-select" value={snapshot.activeSelectorId} onChange={(event) => controller.setActiveSelector(event.currentTarget.value)}>
              {snapshot.selectorLayers.map((selector) => <option value={selector.id} key={selector.id}>{selector.name}</option>)}
            </select>
          </label>
          <label className="surface-projection-select-row">
            <span>Mask operation</span>
            <select
              className="st-select"
              value={activeSelector?.operation ?? "replace"}
              onChange={(event) => controller.setSelectorOperation(event.currentTarget.value as "replace" | "add" | "subtract" | "intersect")}
            >
              <option value="replace">Replace</option>
              <option value="add">Add</option>
              <option value="subtract">Subtract</option>
              <option value="intersect">Intersect</option>
            </select>
          </label>
          <div className="st-btn-row st-btn-row-even">
            <button className="st-btn" type="button" onClick={() => controller.createSelector()}>New selector</button>
            <button className="st-btn" type="button" disabled={snapshot.selectorLayers.length <= 1} onClick={() => controller.deleteSelector()}>Delete</button>
          </div>
          <div className="surface-projection-toggles">
            <label><input type="checkbox" checked={activeSelector?.visible ?? true} onChange={(event) => controller.setSelectorVisible(event.currentTarget.checked)} /> Visible</label>
            <label><input type="checkbox" checked={activeSelector?.locked ?? false} onChange={(event) => controller.setSelectorLocked(event.currentTarget.checked)} /> Lock transform</label>
          </div>
        </fieldset>

        <div className="st-btn-row st-btn-row-even">
          <button className="st-btn-primary" type="button" onClick={() => controller.setInteractionMode("place-area")}>{disabled ? "Place area" : "Reposition area"}</button>
          <button className="st-btn" type="button" onClick={() => controller.setInteractionMode("pick-target")}>Pick target</button>
        </div>

        <label className="st-row"><span>Area size</span><input type="range" min="0.6" max="4" step="0.1" value={snapshot.areaSize} style={rangeFillStyle(snapshot.areaSize, 0.6, 4)} disabled={transformDisabled} onChange={(event) => controller.setAreaSize(event.currentTarget.valueAsNumber)} /><output>{snapshot.areaSize.toFixed(1)}</output></label>
        <label className="st-row"><span>Projection height</span><input type="range" min="-2.5" max="2.5" step="0.05" value={snapshot.projectionHeight} style={rangeFillStyle(snapshot.projectionHeight, -2.5, 2.5)} disabled={transformDisabled} onChange={(event) => controller.setProjectionHeight(event.currentTarget.valueAsNumber)} /><output>{snapshot.projectionHeight.toFixed(2)}</output></label>

        <fieldset className="surface-projection-transform" disabled={transformDisabled}>
          <legend>Area transform</legend>
          <div className="surface-projection-gizmo-controls">
            <div className="st-segmented" role="group" aria-label="Axis gizmo space">
              <button type="button" className={snapshot.gizmoSpace === "local" ? "active" : undefined} aria-pressed={snapshot.gizmoSpace === "local"} onClick={() => controller.setGizmoSpace("local")}>Local axes</button>
              <button type="button" className={snapshot.gizmoSpace === "world" ? "active" : undefined} aria-pressed={snapshot.gizmoSpace === "world"} onClick={() => controller.setGizmoSpace("world")}>World axes</button>
            </div>
            <label><input type="checkbox" checked={snapshot.gizmoSnap} onChange={(event) => controller.setGizmoSnap(event.currentTarget.checked)} /> Snap 0.1</label>
          </div>
          <p className="surface-projection-gizmo-hint">Drag the red, green, or blue viewport arrows. In Local axes, blue moves the selector through the surface.</p>
          <TransformVector label="Position" channel="position" values={snapshot.areaPosition} controller={controller} snapshot={snapshot} step={0.1} />
          <TransformVector label="Rotation" channel="rotation" values={snapshot.areaRotation} controller={controller} snapshot={snapshot} step={1} />
          <TransformVector label="Scale" channel="scale" values={snapshot.areaScale} controller={controller} snapshot={snapshot} step={0.05} />
          <div className="surface-projection-nudges">
            <button className="st-btn" type="button" onClick={() => controller.nudgeArea("u", -0.1)}>U−</button>
            <button className="st-btn" type="button" onClick={() => controller.nudgeArea("u", 0.1)}>U+</button>
            <button className="st-btn" type="button" onClick={() => controller.nudgeArea("v", -0.1)}>V−</button>
            <button className="st-btn" type="button" onClick={() => controller.nudgeArea("v", 0.1)}>V+</button>
            <button className="st-btn" type="button" onClick={() => controller.rotateArea(-15)}>↶ 15°</button>
            <button className="st-btn" type="button" onClick={() => controller.rotateArea(15)}>↷ 15°</button>
          </div>
          <button className="st-btn surface-projection-reset" type="button" onClick={() => controller.resetAreaTransform()}>Reset transform</button>
        </fieldset>

        <fieldset className="surface-projection-quality">
          <legend>Surface contact</legend>
          <label className="st-row"><span>Contact depth</span><input type="range" min="0.01" max="0.75" step="0.01" value={snapshot.projectionContactDepth} style={rangeFillStyle(snapshot.projectionContactDepth, 0.01, 0.75)} onChange={(event) => controller.setProjectionContactDepth(event.currentTarget.valueAsNumber)} /><output>{snapshot.projectionContactDepth.toFixed(2)}</output></label>
          <label className="st-row"><span>Contact softness</span><input type="range" min="0" max="1" step="0.01" value={snapshot.projectionContactSoftness} style={rangeFillStyle(snapshot.projectionContactSoftness, 0, 1)} onChange={(event) => controller.setProjectionContactSoftness(event.currentTarget.valueAsNumber)} /><output>{snapshot.projectionContactSoftness.toFixed(2)}</output></label>
          <label className="st-row"><span>Max surface angle</span><input type="range" min="0" max="90" step="1" value={snapshot.projectionMaxAngle} style={rangeFillStyle(snapshot.projectionMaxAngle, 0, 90)} onChange={(event) => controller.setProjectionMaxAngle(event.currentTarget.valueAsNumber)} /><output>{snapshot.projectionMaxAngle.toFixed(0)}°</output></label>
          <label className="st-row"><span>Surface clearance</span><input type="range" min="0" max="0.12" step="0.002" value={snapshot.projectionSurfaceOffset} style={rangeFillStyle(snapshot.projectionSurfaceOffset, 0, 0.12)} onChange={(event) => controller.setProjectionSurfaceOffset(event.currentTarget.valueAsNumber)} /><output>{snapshot.projectionSurfaceOffset.toFixed(3)}</output></label>
          <div className="surface-projection-toggles">
            <label><input type="checkbox" checked={snapshot.contactLocked} disabled={disabled} onChange={(event) => controller.setContactLocked(event.currentTarget.checked)} /> Keep contacted area</label>
            <label><input type="checkbox" checked={snapshot.clothEnabled} disabled={disabled} onChange={(event) => controller.setClothEnabled(event.currentTarget.checked)} /> Cloth folds</label>
          </div>
          {snapshot.clothEnabled && <div className="surface-projection-cloth-controls">
            <label className="st-row"><span>Sag</span><input type="range" min="0" max="1" step="0.01" value={snapshot.clothSag} style={rangeFillStyle(snapshot.clothSag, 0, 1)} onChange={(event) => controller.setClothSag(event.currentTarget.valueAsNumber)} /><output>{snapshot.clothSag.toFixed(2)}</output></label>
            <label className="st-row"><span>Stretch</span><input type="range" min="0" max="1" step="0.01" value={snapshot.drapeStretch} style={rangeFillStyle(snapshot.drapeStretch, 0, 1)} onChange={(event) => controller.setDrapeStretch(event.currentTarget.valueAsNumber)} /><output>{snapshot.drapeStretch.toFixed(2)}</output></label>
            <label className="st-row"><span>Iterations</span><input type="range" min="1" max="32" step="1" value={snapshot.drapeIterations} style={rangeFillStyle(snapshot.drapeIterations, 1, 32)} onChange={(event) => controller.setDrapeIterations(event.currentTarget.valueAsNumber)} /><output>{snapshot.drapeIterations}</output></label>
          </div>}
        </fieldset>

        <div className="st-btn-row st-btn-row-even">
          <button className="st-btn-primary" type="button" disabled={transformDisabled} onClick={() => controller.dropAreaToFirstContact()}>Drop to first contact</button>
          <button className="st-btn-primary" type="button" disabled={transformDisabled} onClick={() => controller.pushAreaThrough()}>Push through + lock</button>
        </div>
        <div className="st-btn-row st-btn-row-even">
          <button className="st-btn" type="button" disabled={disabled} onClick={() => controller.clearContactMask()}>Clear yellow mask</button>
          <button className="st-btn" type="button" disabled={disabled} onClick={() => controller.removeArea()}>Remove area</button>
        </div>
      </div>
    </details>
  );
}

export default SurfaceProjectionPanel;
