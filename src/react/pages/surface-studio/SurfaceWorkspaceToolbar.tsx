import type { LibraryShapeInfo } from "../../../base-shape-catalog";
import { surfaceGenerator } from "../../../surface-studio/generator-catalog";
import type { SurfaceInteractionMode } from "../../../surface-studio/contracts";
import type {
  SurfacePainterStudioSnapshot,
  SurfacePainterToolHandle,
} from "../../../surface-painter/main";
import "./surface-workspace-toolbar.css";

export interface SurfaceWorkspaceToolbarProps {
  controller: SurfacePainterToolHandle | null;
  snapshot: SurfacePainterStudioSnapshot;
  references: readonly LibraryShapeInfo[];
}

const MODE_LABELS: Readonly<Partial<Record<SurfaceInteractionMode, string>>> = {
  orbit: "Orbit",
  interact: "Interact",
  flower: "Flower",
  "place-area": "Area",
  draw: "Draw",
  select: "Select",
};

function projectionTargetValue(target: SurfacePainterStudioSnapshot["projectionTarget"]): string {
  return target.kind === "mesh" ? target.targetId : target.kind === "all" ? "__all__" : "__pick__";
}

function projectionTargetFromValue(value: string): SurfacePainterStudioSnapshot["projectionTarget"] {
  if (value === "__pick__") return { kind: "pick" };
  if (value === "__all__") return { kind: "all" };
  return { kind: "mesh", targetId: value };
}

export function SurfaceWorkspaceToolbar({
  controller,
  snapshot,
  references,
}: SurfaceWorkspaceToolbarProps): React.JSX.Element {
  const descriptor = surfaceGenerator(snapshot.activeTool);
  const modes = descriptor.capabilities.interactionModes.filter((mode) => (
    MODE_LABELS[mode]
    && (descriptor.family === "blender" || !["place-area", "select"].includes(mode))
  ));
  const projectionEnabled = descriptor.capabilities.usesProjectionTarget;
  const areaEnabled = descriptor.family === "blender" && descriptor.capabilities.usesDrawingArea;

  return (
    <div className="surface-workspace-toolbar" aria-label="Shared surface workspace">
      <div className="surface-workspace-group surface-workspace-source">
        <span className="surface-workspace-group-label">Surface</span>
        <select
          className="st-select"
          aria-label="Surface preset"
          value={snapshot.referenceObject ? "__reference__" : snapshot.modelPreset}
          disabled={!controller}
          onChange={(event) => {
            if (event.currentTarget.value === "__reference__") return;
            controller?.setModelPreset(event.currentTarget.value as SurfacePainterStudioSnapshot["modelPreset"]);
          }}
        >
          {snapshot.referenceObject && <option value="__reference__">Reference object</option>}
          <option value="Sphere">Sphere</option>
          <option value="Torus Knot">Torus knot</option>
          <option value="Box">Box</option>
          <option value="Cylinder">Cylinder</option>
        </select>
        <select
          className="st-select surface-workspace-reference"
          aria-label="Reference object"
          value={snapshot.referenceObject}
          disabled={!controller}
          onChange={(event) => {
            const id = event.currentTarget.value;
            if (!id) controller?.setModelPreset(snapshot.modelPreset);
            else {
              const info = references.find((reference) => reference.id === id);
              if (info) void controller?.loadReferenceObject(info);
            }
          }}
        >
          <option value="">No reference object</option>
          {references.map((reference) => <option value={reference.id} key={reference.id}>{reference.title}</option>)}
        </select>
        <label className={`st-btn surface-workspace-import${controller ? "" : " is-disabled"}`}>
          Import…
          <input
            type="file"
            accept=".glb,.gltf"
            disabled={!controller}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void controller?.importSurface(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      <div className="surface-workspace-group surface-workspace-target">
        <span className="surface-workspace-group-label">Projection</span>
        <select
          className="st-select"
          aria-label="Projection target"
          value={projectionTargetValue(snapshot.projectionTarget)}
          disabled={!controller || !projectionEnabled}
          onChange={(event) => controller?.setProjectionTarget(projectionTargetFromValue(event.currentTarget.value))}
        >
          {snapshot.projectionTargets.map((target) => <option value={target.value} key={target.value}>{target.label}</option>)}
        </select>
        <button
          className="st-btn"
          type="button"
          disabled={!controller || !projectionEnabled}
          onClick={() => controller?.setInteractionMode("pick-target")}
        >
          Pick
        </button>
      </div>

      <div className="surface-workspace-group surface-workspace-modes">
        <span className="surface-workspace-group-label">Mode</span>
        <div className="st-segmented" role="group" aria-label="Interaction mode">
          {modes.map((mode) => (
            <button
              type="button"
              className={snapshot.interactionMode === mode ? "active" : undefined}
              aria-pressed={snapshot.interactionMode === mode}
              disabled={!controller}
              key={mode}
              onClick={() => controller?.setInteractionMode(mode)}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      {areaEnabled && (
        <div className="surface-workspace-group surface-workspace-area">
          <span className="surface-workspace-group-label">Area</span>
          <label title="Drawing area size">
            <span>Size</span>
            <input
              type="range"
              min="0.6"
              max="4"
              step="0.1"
              value={snapshot.areaSize}
              disabled={!controller}
              onChange={(event) => controller?.setAreaSize(event.currentTarget.valueAsNumber)}
            />
          </label>
          <label title="Projection height">
            <span>Height</span>
            <input
              type="range"
              min="-2.5"
              max="2.5"
              step="0.05"
              value={snapshot.projectionHeight}
              disabled={!controller}
              onChange={(event) => controller?.setProjectionHeight(event.currentTarget.valueAsNumber)}
            />
          </label>
          <button className="st-btn" type="button" disabled={!controller || !snapshot.hasDrawingArea} onClick={() => controller?.dropAreaToFirstContact()}>Contact</button>
          <button className="st-btn" type="button" disabled={!controller || !snapshot.hasDrawingArea} onClick={() => controller?.removeArea()}>Remove</button>
        </div>
      )}

      <div className="surface-workspace-group surface-workspace-history">
        <span className="surface-workspace-group-label">Document</span>
        <button className="st-btn" type="button" disabled={!controller || !snapshot.canUndo} onClick={() => controller?.undo()}>Undo</button>
        <button className="st-btn" type="button" disabled={!controller || !snapshot.canClear} onClick={() => controller?.clear()}>Clear</button>
      </div>
    </div>
  );
}

export default SurfaceWorkspaceToolbar;
