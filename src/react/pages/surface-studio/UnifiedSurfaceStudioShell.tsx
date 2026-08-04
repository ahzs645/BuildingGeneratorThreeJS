import { useId, type ReactNode } from "react";
import { StudioPanelHeader, StudioShell } from "../../studio/StudioShell";
import {
  surfaceGenerator,
  type SurfaceGeneratorDescriptor,
} from "../../../surface-studio/generator-catalog";
import type { SurfaceGeneratorId } from "../../../surface-studio/contracts";
import {
  SurfaceSharedControls,
  type SurfaceSharedCapabilities,
  type SurfaceSharedControlsProps,
} from "./SurfaceSharedControls";
import { SurfaceToolSelector, type SurfaceToolSelectorProps } from "./SurfaceToolSelector";
import "./unified-surface-studio-shell.css";

export type UnifiedSurfaceSharedControlsProps = Omit<SurfaceSharedControlsProps, "capabilities">;

export interface UnifiedSurfaceStudioShellProps {
  activeGenerator: SurfaceGeneratorId;
  onGeneratorSelect: (generator: SurfaceGeneratorId) => void;
  sharedControls: UnifiedSurfaceSharedControlsProps;
  /** Prevents generator changes while an adapter is committing work. */
  selectorDisabled?: boolean;
  disabledGenerators?: SurfaceToolSelectorProps["disabledTools"];
  toolbar?: ReactNode;
  status?: ReactNode;
  viewport: ReactNode;
  activeOptions: ReactNode;
  optionsMeta?: ReactNode;
  nodeDock?: ReactNode;
  className?: string;
}

/** Maps the runtime-facing catalog contract onto the presentational controls. */
export function sharedCapabilitiesForGenerator(
  generator: SurfaceGeneratorDescriptor,
): SurfaceSharedCapabilities {
  const interactionModes = new Set(generator.capabilities.interactionModes);
  return {
    surface: true,
    projection: generator.capabilities.usesProjectionTarget,
    orbit: interactionModes.has("orbit"),
    interact: interactionModes.has("interact"),
    flower: interactionModes.has("flower"),
    area: generator.capabilities.usesDrawingArea && interactionModes.has("place-area"),
    draw: interactionModes.has("draw"),
    select: interactionModes.has("select"),
    undo: generator.capabilities.supportsUndoClear,
    clear: generator.capabilities.supportsUndoClear,
  };
}

function generatorFamilyLabel(generator: SurfaceGeneratorDescriptor): string {
  if (generator.family === "blender") return "Projected Blender brush";
  if (generator.family === "vegetation") return "Procedural vegetation";
  return "Procedural surface decoration";
}

export function UnifiedSurfaceStudioShell({
  activeGenerator,
  onGeneratorSelect,
  sharedControls,
  selectorDisabled = false,
  disabledGenerators,
  toolbar,
  status,
  viewport,
  activeOptions,
  optionsMeta = "Active settings",
  nodeDock,
  className,
}: UnifiedSurfaceStudioShellProps): React.JSX.Element {
  const generator = surfaceGenerator(activeGenerator);
  const capabilities = sharedCapabilitiesForGenerator(generator);
  const optionsId = useId();

  const selectorPanel = (
    <section className="unified-surface-selector-pane" aria-label="Surface tools">
      <StudioPanelHeader title="Generators & brushes" meta="Choose a tool" />
      <SurfaceToolSelector
        activeTool={activeGenerator}
        onSelect={onGeneratorSelect}
        disabled={selectorDisabled}
        disabledTools={disabledGenerators}
        ariaControls={optionsId}
      />
    </section>
  );

  const sharedPanel = (
    <section className="unified-surface-shared-pane" aria-label="Shared surface controls">
      <StudioPanelHeader title="Shared controls" meta="Surface + document" />
      <SurfaceSharedControls {...sharedControls} capabilities={capabilities} />
    </section>
  );

  const leftDock = (
    <div className="unified-surface-left-dock">
      {selectorPanel}
      {sharedPanel}
    </div>
  );

  const optionsPanel = (
    <div className="unified-surface-options-pane" id={optionsId}>
      <StudioPanelHeader title="Generator options" meta={optionsMeta} />
      <header className="unified-surface-active-context" aria-live="polite">
        <span className="unified-surface-active-glyph" aria-hidden="true">{generator.code}</span>
        <span className="unified-surface-active-copy">
          <small>{generatorFamilyLabel(generator)}</small>
          <strong>{generator.label}</strong>
          <span>{generator.description}</span>
        </span>
      </header>
      <div className="unified-surface-active-options">{activeOptions}</div>
    </div>
  );

  const classes = ["unified-surface-studio", className].filter(Boolean).join(" ");

  return (
    <StudioShell
      className={classes}
      leftDock={leftDock}
      rightDock={optionsPanel}
      toolbar={toolbar}
      status={status}
      nodeDock={nodeDock}
      sheetTabs={[
        { id: "surface-tools", label: "Tools", content: selectorPanel },
        { id: "surface-shared", label: "Surface", content: sharedPanel },
        { id: "surface-options", label: "Options", content: optionsPanel },
      ]}
    >
      {viewport}
    </StudioShell>
  );
}

export default UnifiedSurfaceStudioShell;
