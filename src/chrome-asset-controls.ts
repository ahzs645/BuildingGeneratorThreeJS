/** Preserve Blender's exact authored float until the user moves the stepped slider. */
export function rangeOverrideValue(authored: number, rendered: string | undefined, dirty: boolean): number {
  return dirty ? Number(rendered ?? authored) : authored;
}

/** Decode one deterministic `override.<socket name>` capture URL value. */
export function captureOverrideValue(
  authored: number | boolean | string | number[],
  raw: string | null,
): number | boolean | string | number[] | undefined {
  if (raw === null) return undefined;
  if (typeof authored === "boolean") return raw === "1" || raw.toLowerCase() === "true";
  if (typeof authored === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(authored)) {
    const values = raw.split(",").map(Number);
    return values.length === authored.length && values.every(Number.isFinite) ? values : undefined;
  }
  return raw;
}

export type GuideLinePreview = "show" | "hide";

/**
 * Keep loose Geometry Nodes curves visible in the interactive viewport, while
 * matching Blender's isolated surface render in authored evidence captures.
 * The URL override keeps the viewport helper available for diagnostics.
 */
export function guideLinePreviewValue(
  authoredCapture: boolean,
  authoredHideLines: boolean,
  requested: string | null,
): GuideLinePreview {
  if (requested === "show" || requested === "hide") return requested;
  return authoredCapture && authoredHideLines ? "hide" : "show";
}
