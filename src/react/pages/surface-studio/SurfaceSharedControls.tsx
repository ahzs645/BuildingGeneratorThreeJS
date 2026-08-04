import { useId } from "react";
import type { SurfaceInteractionMode } from "../../../surface-studio/contracts";
import "./surface-shared-controls.css";

export type { SurfaceInteractionMode } from "../../../surface-studio/contracts";
export type SurfaceAreaTransformMode = "move" | "rotate" | "scale";

export interface SurfaceControlOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SurfaceSharedCapabilities {
  readonly surface: boolean;
  readonly projection: boolean;
  readonly orbit: boolean;
  readonly interact: boolean;
  readonly flower: boolean;
  readonly area: boolean;
  readonly draw: boolean;
  readonly select: boolean;
  readonly undo: boolean;
  readonly clear: boolean;
}

export const DEFAULT_SURFACE_SHARED_CAPABILITIES: SurfaceSharedCapabilities = {
  surface: true,
  projection: true,
  orbit: true,
  interact: true,
  flower: true,
  area: true,
  draw: true,
  select: true,
  undo: true,
  clear: true,
};

/** Tree is ground-authored rather than projected, but keeps its direct tools. */
export const TREE_SURFACE_SHARED_CAPABILITIES: SurfaceSharedCapabilities = {
  ...DEFAULT_SURFACE_SHARED_CAPABILITIES,
  projection: false,
  area: false,
  draw: false,
  select: false,
  undo: false,
  clear: false,
};

export interface SurfaceSharedControlsProps {
  capabilities?: Partial<SurfaceSharedCapabilities>;

  referenceOptions: readonly SurfaceControlOption[];
  referenceObject: string;
  referenceSummary?: string;
  onReferenceObjectChange: (value: string) => void;
  onImportSurface: (file: File) => void;

  projectionTargetOptions: readonly SurfaceControlOption[];
  projectionTarget: string;
  projectionSummary?: string;
  onProjectionTargetChange: (value: string) => void;
  onPickProjectionTarget: () => void;

  interactionMode: SurfaceInteractionMode;
  onInteractionModeChange: (mode: SurfaceInteractionMode) => void;

  areaTransformMode: SurfaceAreaTransformMode;
  projectionHeight: number;
  areaSize: number;
  onAreaTransformModeChange: (mode: SurfaceAreaTransformMode) => void;
  onProjectionHeightChange: (value: number) => void;
  onAreaSizeChange: (value: number) => void;
  onProjectArea: () => void;
  onRemoveArea: () => void;

  canUndo?: boolean;
  canClear?: boolean;
  hasDrawingArea?: boolean;
  onUndo: () => void;
  onClear: () => void;
  className?: string;
}

const INTERACTION_MODES: readonly { id: SurfaceInteractionMode; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "interact", label: "Interact" },
  { id: "flower", label: "Flower brush" },
  { id: "place-area", label: "Select area" },
  { id: "draw", label: "Draw" },
  { id: "select", label: "Select / move" },
];

const TRANSFORM_MODES: readonly { id: SurfaceAreaTransformMode; label: string; key: string }[] = [
  { id: "move", label: "Move", key: "G" },
  { id: "rotate", label: "Rotate", key: "R" },
  { id: "scale", label: "Scale", key: "S" },
];

export function SurfaceSharedControls({
  capabilities,
  referenceOptions,
  referenceObject,
  referenceSummary = "Choose a reference object or import a surface.",
  onReferenceObjectChange,
  onImportSurface,
  projectionTargetOptions,
  projectionTarget,
  projectionSummary = "Choose a mesh or pick one from the viewport.",
  onProjectionTargetChange,
  onPickProjectionTarget,
  interactionMode,
  onInteractionModeChange,
  areaTransformMode,
  projectionHeight,
  areaSize,
  onAreaTransformModeChange,
  onProjectionHeightChange,
  onAreaSizeChange,
  onProjectArea,
  onRemoveArea,
  canUndo = true,
  canClear = true,
  hasDrawingArea = true,
  onUndo,
  onClear,
  className,
}: SurfaceSharedControlsProps): React.JSX.Element {
  const enabled: SurfaceSharedCapabilities = {
    ...DEFAULT_SURFACE_SHARED_CAPABILITIES,
    ...capabilities,
  };
  const classes = ["surface-shared-controls", className].filter(Boolean).join(" ");
  const headingId = useId();

  const modeEnabled = (mode: SurfaceInteractionMode): boolean => {
    if (mode === "pick-target") return enabled.projection;
    if (mode === "place-area") return enabled.area;
    return enabled[mode];
  };

  return (
    <div className={classes}>
      <section className="st-section surface-shared-section" aria-labelledby={`${headingId}-source`}>
        <h2 className="st-section-title" id={`${headingId}-source`}>1 · Surface</h2>
        <label className="surface-shared-field">
          <span>Reference object</span>
          <select
            className="st-select"
            value={referenceObject}
            disabled={!enabled.surface}
            onChange={(event) => onReferenceObjectChange(event.currentTarget.value)}
          >
            {referenceOptions.map((option) => (
              <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className={`st-btn surface-shared-import${enabled.surface ? "" : " is-disabled"}`}>
          Import surface…
          <input
            type="file"
            accept=".glb,.gltf,.obj,.stl,.ply,.fbx,model/gltf-binary,model/gltf+json"
            disabled={!enabled.surface}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onImportSurface(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <small className="surface-shared-summary">{referenceSummary}</small>
      </section>

      <section className="st-section surface-shared-section" aria-labelledby={`${headingId}-projection`}>
        <h2 className="st-section-title" id={`${headingId}-projection`}>2 · Projection target</h2>
        <fieldset className="surface-shared-fieldset" disabled={!enabled.projection}>
          <label className="surface-shared-field">
            <span>Target mesh</span>
            <select
              className="st-select"
              value={projectionTarget}
              onChange={(event) => onProjectionTargetChange(event.currentTarget.value)}
            >
              {projectionTargetOptions.map((option) => (
                <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button className="st-btn surface-shared-pick" type="button" onClick={onPickProjectionTarget}>
            Pick target from viewport
          </button>
        </fieldset>
        <small className="surface-shared-summary" aria-live="polite">
          {enabled.projection ? projectionSummary : "This generator does not project onto a surface."}
        </small>
      </section>

      <section className="st-section surface-shared-section" aria-labelledby={`${headingId}-interaction`}>
        <h2 className="st-section-title" id={`${headingId}-interaction`}>3 · Interaction</h2>
        <div className="st-segmented surface-shared-modes" role="group" aria-label="Viewport interaction mode">
          {INTERACTION_MODES.map((mode) => (
            <button
              type="button"
              className={interactionMode === mode.id ? "active" : undefined}
              aria-pressed={interactionMode === mode.id}
              disabled={!modeEnabled(mode.id)}
              key={mode.id}
              onClick={() => onInteractionModeChange(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <fieldset className="surface-shared-area" disabled={!enabled.area} aria-label="Drawing area transform">
          <legend>Drawing area</legend>
          <div className="st-segmented surface-shared-transform" role="group" aria-label="Transform mode">
            {TRANSFORM_MODES.map((mode) => (
              <button
                type="button"
                className={areaTransformMode === mode.id ? "active" : undefined}
                aria-pressed={areaTransformMode === mode.id}
                title={`${mode.label} drawing area (${mode.key})`}
                key={mode.id}
                onClick={() => onAreaTransformModeChange(mode.id)}
              >
                {mode.label} · {mode.key}
              </button>
            ))}
          </div>
          <label className="st-row surface-shared-range">
            <span>Projection height</span>
            <input
              type="range"
              min="0.1"
              max="2.5"
              step="0.05"
              value={projectionHeight}
              onChange={(event) => onProjectionHeightChange(event.currentTarget.valueAsNumber)}
            />
            <output>{projectionHeight.toFixed(2)}</output>
          </label>
          <label className="st-row surface-shared-range">
            <span>Area size</span>
            <input
              type="range"
              min="0.6"
              max="4"
              step="0.1"
              value={areaSize}
              onChange={(event) => onAreaSizeChange(event.currentTarget.valueAsNumber)}
            />
            <output>{areaSize.toFixed(1)}</output>
          </label>
          <button className="st-btn surface-shared-project" type="button" onClick={onProjectArea}>
            Drop / project to surface
          </button>
          <button className="st-btn" type="button" disabled={!hasDrawingArea} onClick={onRemoveArea}>
            Remove drawing area
          </button>
        </fieldset>

        <div className="st-btn-row st-btn-row-even surface-shared-history">
          <button className="st-btn" type="button" disabled={!enabled.undo || !canUndo} onClick={onUndo}>Undo</button>
          <button className="st-btn" type="button" disabled={!enabled.clear || !canClear} onClick={onClear}>Clear</button>
        </div>
      </section>
    </div>
  );
}

export default SurfaceSharedControls;
