/** Preserve Blender's exact authored float until the user moves the stepped slider. */
export function rangeOverrideValue(authored: number, rendered: string | undefined, dirty: boolean): number {
  return dirty ? Number(rendered ?? authored) : authored;
}
