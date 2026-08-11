import { useMemo } from "react";
import { SearchableSelect } from "../../studio/SearchableSelect";
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
}

export interface SurfaceDocumentSetupProps {
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

/**
 * The strip above the viewport, and only what a hand on the canvas reaches for
 * mid-stroke: **Mode** — whether a touch orbits the model or paints on it —
 * and **Document** — undo and clear.
 *
 * It used to carry Surface (preset · 105-object picker · Import) and
 * Projection (target · Pick) as well. Wrapping those four groups rather than
 * clipping them fixed A3's hidden controls and created a second problem: 967px
 * of groups in an 864px column is two rows at 1440×900 and four in the tablet
 * band. Measured `.st-toolbar` height was 143px at 1440 and 1280, **221px at
 * 1024×768** (28.8% of the screen) and **320px at 834×1112** — a toolbar
 * eating more of the window than the fix saved.
 *
 * Surface and Projection are 622px of that 967px and both are set-up, not
 * work: you choose a surface and a projection target when you start, then
 * paint. They live in the inspector now (SurfaceDocumentSetup below), which on
 * a phone is the sheet's Options tab. Mode and Document are 329px together and
 * fit one row at every reviewed viewport.
 */
export function SurfaceWorkspaceToolbar({
  controller,
  snapshot,
}: SurfaceWorkspaceToolbarProps): React.JSX.Element {
  const descriptor = surfaceGenerator(snapshot.activeTool);
  const modes = descriptor.capabilities.interactionModes.filter((mode) => (
    MODE_LABELS[mode]
    && (descriptor.family === "blender" || !["place-area", "select"].includes(mode))
  ));

  return (
    <div className="surface-workspace-toolbar" aria-label="Shared surface workspace">
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

      <div className="surface-workspace-group surface-workspace-history">
        <span className="surface-workspace-group-label">Document</span>
        <button className="st-btn" type="button" disabled={!controller || !snapshot.canUndo} onClick={() => controller?.undo()}>Undo</button>
        <button className="st-btn" type="button" disabled={!controller || !snapshot.canClear} onClick={() => controller?.clear()}>Clear</button>
      </div>
    </div>
  );
}

/**
 * What the toolbar handed over: the surface being painted and where strokes
 * project. Kit rows in an inspector section, so the sheet's mobile sizing and
 * the tablet band's two-line rows reach them — which the toolbar's own
 * flex groups never did.
 *
 * The Area group the strip also carried is simply gone: `usesDrawingArea` is
 * true for exactly the four Blender brushes, which are exactly the tools that
 * render SurfaceProjectionPanel, and that panel already owns Area size,
 * Projection height, Drop to first contact and Remove area. It was a second
 * copy of four controls, not a fifth group.
 */
export function SurfaceDocumentSetup({
  controller,
  snapshot,
  references,
}: SurfaceDocumentSetupProps): React.JSX.Element {
  // A stroke republishes the snapshot several times a second; the picker fills
  // its datalist from this identity, so rebuilding 105 nodes per render would
  // be the cost of drawing a line.
  const referenceOptions = useMemo(() => [
    { value: "", label: "No reference object" },
    ...references.map((reference) => ({ value: reference.id, label: reference.title })),
  ], [references]);
  const descriptor = surfaceGenerator(snapshot.activeTool);
  const projectionEnabled = descriptor.capabilities.usesProjectionTarget;

  return (
    <section className="st-section surface-document-setup">
      <div className="st-section-title">Surface<small>one shared document</small></div>
      <label className="st-row st-row-stacked st-row-full">
        <span>Preset</span>
        <select
          className="st-select"
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
      </label>
      {/* 105 options in a 170px strip control, with no way to type at them.
          The searchable picker is shared with /chrome-assets and
          /typewriter, which list this same catalogue. */}
      <SearchableSelect
        id="surface-reference-object"
        className="surface-workspace-reference"
        label="Reference object"
        placeholder="Search objects…"
        options={referenceOptions}
        value={snapshot.referenceObject}
        disabled={!controller}
        onSelect={(id) => {
          if (!id) controller?.setModelPreset(snapshot.modelPreset);
          else {
            const info = references.find((reference) => reference.id === id);
            if (info) void controller?.loadReferenceObject(info);
          }
        }}
      />
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

      <div className="st-section-title">Projection</div>
      <label className="st-row st-row-stacked st-row-full">
        <span>Target</span>
        <select
          className="st-select"
          value={projectionTargetValue(snapshot.projectionTarget)}
          disabled={!controller || !projectionEnabled}
          onChange={(event) => controller?.setProjectionTarget(projectionTargetFromValue(event.currentTarget.value))}
        >
          {snapshot.projectionTargets.map((target) => <option value={target.value} key={target.value}>{target.label}</option>)}
        </select>
      </label>
      <button
        className="st-btn"
        type="button"
        disabled={!controller || !projectionEnabled}
        onClick={() => controller?.setInteractionMode("pick-target")}
      >
        Pick target in viewport
      </button>
    </section>
  );
}

export default SurfaceWorkspaceToolbar;
