export type BinParameter = {
  name: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue: number | boolean;
  boolean?: boolean;
};

export type BinPreset = {
  id: string;
  label: string;
  description: string;
  values: Record<string, number | boolean>;
};

// Values are the authored modifier values from dump_bin.json, not the node
// group's unused socket defaults. Ranges are the published Blender-parity
// contract: broader source-socket values remain available in Blender, but
// fillet >= 8 and divider endpoints enter degenerate geometry paths, gaps
// above 7 lose appearance parity, and only Bin Select 0-11 has checked-in
// truth for the static comparison.
export const BIN_PARAMETERS: readonly BinParameter[] = [
  { name: "Size X", min: 0.1, max: 3, step: 0.001, defaultValue: 0.7079999446868896 },
  { name: "Size Y", min: 0.1, max: 3, step: 0.001, defaultValue: 0.510999858379364 },
  { name: "Size Z", min: 0, max: 1, step: 0.001, defaultValue: 0.11300000548362732 },
  { name: "bin gap size", min: 0.2, max: 7, step: 0.01, defaultValue: 1.3000000715255737 },
  { name: "bin wall thiccness", min: 0, max: 30, step: 0.01, defaultValue: 1.8079999685287476 },
  { name: "fillet", min: 0, max: 7.9, step: 0.01, defaultValue: 0.8109987378120422 },
  { name: "divide x", min: 0.15, max: 0.85, step: 0.001, defaultValue: 0.41713136434555054 },
  { name: "divide y", min: 0.2, max: 0.9, step: 0.001, defaultValue: 0.6334825754165649 },
  { name: "Bin Select", min: 0, max: 11, step: 1, defaultValue: 5 },
  { name: "print layers", min: 0, max: 5, step: 0.001, defaultValue: 0.05199899151921272 },
  { name: "make exportable", boolean: true, defaultValue: false },
] as const;

export const BIN_DEFAULTS: Record<string, number | boolean> = Object.fromEntries(
  BIN_PARAMETERS.map((parameter) => [parameter.name, parameter.defaultValue]),
);

const preset = (
  id: string,
  label: string,
  description: string,
  overrides: Record<string, number | boolean> = {},
): BinPreset => ({ id, label, description, values: { ...BIN_DEFAULTS, ...overrides } });

export const BIN_PRESETS: readonly BinPreset[] = [
  preset("authored", "Authored default", "The modifier values saved on Procedural Drawer."),
  ...Array.from({ length: 12 }, (_, selection) => preset(
    `selection-${selection}`,
    `Bin selection ${selection}`,
    `Checked-in Blender truth for selection ${selection}.`,
    { "Bin Select": selection },
  )),
  preset("gap-boundary", "Validated gap boundary", "Largest published gap with measured surface parity.", { "bin gap size": 7 }),
  preset("fillet-boundary", "Validated fillet boundary", "Last tested fillet before Blender's degenerate path.", { fillet: 7.9 }),
  preset("divider-boundary", "Validated divider boundary", "Published divider range boundary with measured surface parity.", { "divide x": 0.15, "divide y": 0.9 }),
  preset("export-ready", "Export-ready geometry", "Enables the authored export-ready geometry branch.", { "make exportable": true }),
] as const;

export function binPresetFromSearch(search: string): Record<string, number | boolean> {
  const query = new URLSearchParams(search);
  const preset: Record<string, number | boolean> = {};
  for (const parameter of BIN_PARAMETERS) {
    const raw = parameter.name === "Bin Select"
      ? query.get(parameter.name) ?? query.get("select")
      : query.get(parameter.name);
    if (raw === null) continue;
    if (parameter.boolean) {
      preset[parameter.name] = raw === "1" || raw === "true" || raw === "on";
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    preset[parameter.name] = Math.min(
      parameter.max ?? value,
      Math.max(parameter.min ?? value, value),
    );
  }
  return preset;
}

export function binSearchFromValues(
  values: Record<string, number | boolean>,
  extras: Record<string, string> = {},
): string {
  const query = new URLSearchParams();
  for (const parameter of BIN_PARAMETERS) {
    const value = values[parameter.name] ?? parameter.defaultValue;
    query.set(parameter.name, typeof value === "boolean" ? String(value) : String(Number(value)));
  }
  for (const [name, value] of Object.entries(extras)) query.set(name, value);
  return `?${query.toString()}`;
}
