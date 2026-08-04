import { useId } from "react";
import { SURFACE_GENERATORS } from "../../../surface-studio/generator-catalog";
import type { SurfaceGeneratorDescriptor } from "../../../surface-studio/generator-catalog";
import type { SurfaceGeneratorId } from "../../../surface-studio/contracts";
import "./surface-tool-selector.css";

export type { SurfaceGeneratorId } from "../../../surface-studio/contracts";
/** Compatibility alias for callers created before the shared studio contract. */
export type SurfaceToolId = SurfaceGeneratorId;
export type SurfaceToolFamily = "generator" | "brush";
export type SurfaceToolDefinition = SurfaceGeneratorDescriptor;
/** Compatibility export backed directly by the canonical generator catalog. */
export { SURFACE_GENERATORS as SURFACE_TOOLS };

export interface SurfaceToolSelectorProps {
  activeTool: SurfaceToolId;
  onSelect: (tool: SurfaceToolId) => void;
  /** Disables the complete selector while the shared studio is busy. */
  disabled?: boolean;
  /** Disables individual tools whose runtime adapter is unavailable. */
  disabledTools?: ReadonlySet<SurfaceToolId> | readonly SurfaceToolId[];
  ariaControls?: string;
  ariaLabel?: string;
  className?: string;
}

const FAMILY_LABELS: Readonly<Record<SurfaceToolFamily, string>> = {
  generator: "Procedural generators",
  brush: "Projected brushes",
};

function toolFamily(tool: SurfaceGeneratorDescriptor): SurfaceToolFamily {
  return tool.family === "blender" ? "brush" : "generator";
}

function isToolDisabled(
  tool: SurfaceToolId,
  disabled: boolean,
  disabledTools: SurfaceToolSelectorProps["disabledTools"],
): boolean {
  if (disabled || !disabledTools) return disabled;
  return "has" in disabledTools
    ? disabledTools.has(tool)
    : disabledTools.includes(tool);
}

export function SurfaceToolSelector({
  activeTool,
  onSelect,
  disabled = false,
  disabledTools,
  ariaControls,
  ariaLabel = "Surface generator or brush",
  className,
}: SurfaceToolSelectorProps): React.JSX.Element {
  const classes = ["surface-tool-selector", className].filter(Boolean).join(" ");
  const selectorId = useId();

  return (
    <nav className={classes} aria-label={ariaLabel}>
      {(["generator", "brush"] as const).map((family) => {
        const familyLabelId = `${selectorId}-${family}-label`;
        return (
          <section className="surface-tool-family" aria-labelledby={familyLabelId} key={family}>
            <h2 className="surface-tool-family-label" id={familyLabelId}>
              {FAMILY_LABELS[family]}
            </h2>
            <div className="surface-tool-list">
              {SURFACE_GENERATORS.filter((tool) => toolFamily(tool) === family).map((tool) => {
                const active = tool.id === activeTool;
                const toolDisabled = isToolDisabled(tool.id, disabled, disabledTools);
                const selectorLabel = tool.family === "blender" ? tool.label : tool.shortLabel;

                return (
                  <button
                    type="button"
                    className="surface-tool-option"
                    data-tool={tool.id}
                    aria-label={tool.label}
                    aria-pressed={active}
                    aria-controls={ariaControls}
                    disabled={toolDisabled}
                    key={tool.id}
                    onClick={() => onSelect(tool.id)}
                  >
                    <span className="surface-tool-glyph" aria-hidden="true">{tool.code}</span>
                    <span className="surface-tool-label">{selectorLabel}</span>
                    {toolDisabled && <span className="surface-tool-disabled-label">Unavailable</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </nav>
  );
}

export default SurfaceToolSelector;
