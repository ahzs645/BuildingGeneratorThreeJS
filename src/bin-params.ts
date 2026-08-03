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

export type BinClampDiagnostic = {
  name: string;
  requested: number;
  applied: number;
};

export type BinParitySurfaceEvidence = {
  p99: number;
  max: number;
  materialP99?: number;
  materialMax?: number;
};

export type BinParityEvidenceCase = {
  name: string;
  overrides?: Record<string, number | boolean>;
  surface: BinParitySurfaceEvidence;
};

export type BinParityEvidenceSweep = {
  name: string;
  parameter: string;
  values: Array<number | boolean>;
  overrides?: Record<string, number | boolean>;
  surface: BinParitySurfaceEvidence;
};

export type BinParityEvidencePayload = {
  evidenceRegistry?: {
    version: string;
    distanceTolerance: number;
    cases: BinParityEvidenceCase[];
    sweeps?: BinParityEvidenceSweep[];
  };
};

export type BinParityEvidenceRecord = BinParityEvidenceCase & {
  version: string;
  distanceTolerance: number;
  values: Record<string, number | boolean>;
};

// Values are the authored modifier values from dump_bin.json, not the node
// group's unused socket defaults. Ranges are the published Blender-parity
// contract: broader source-socket values remain available in Blender, but
// fillet >= 8 and divider endpoints enter degenerate geometry paths, gaps
// above 7 lose appearance parity, and only Bin Select 0-11 has checked-in
// truth for the static comparison.
export const BIN_PARAMETERS: readonly BinParameter[] = [
  { name: "Size X", min: 0.1, max: 3, step: 0.001, defaultValue: 0.708 },
  { name: "Size Y", min: 0.1, max: 3, step: 0.001, defaultValue: 0.511 },
  { name: "Size Z", min: 0, max: 1, step: 0.001, defaultValue: 0.113 },
  { name: "bin gap size", min: 0.2, max: 7, step: 0.01, defaultValue: 1.3 },
  { name: "bin wall thiccness", min: 0, max: 30, step: 0.001, defaultValue: 1.808 },
  { name: "fillet", min: 0, max: 7.9, step: 0.001, defaultValue: 0.811 },
  { name: "divide x", min: 0.15, max: 0.85, step: 0.001, defaultValue: 0.417 },
  { name: "divide y", min: 0.2, max: 0.9, step: 0.001, defaultValue: 0.633 },
  { name: "Bin Select", min: 0, max: 11, step: 1, defaultValue: 5 },
  { name: "print layers", min: 0, max: 5, step: 0.001, defaultValue: 0.052 },
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

export function clampBinParameter(parameter: BinParameter, value: number): number {
  return Math.min(parameter.max ?? value, Math.max(parameter.min ?? value, value));
}

export function binPresetFromSearchDetailed(search: string): {
  values: Record<string, number | boolean>;
  diagnostics: BinClampDiagnostic[];
} {
  const query = new URLSearchParams(search);
  const values: Record<string, number | boolean> = {};
  const diagnostics: BinClampDiagnostic[] = [];
  for (const parameter of BIN_PARAMETERS) {
    const raw = parameter.name === "Bin Select"
      ? query.get(parameter.name) ?? query.get("select")
      : query.get(parameter.name);
    if (raw === null) continue;
    if (parameter.boolean) {
      values[parameter.name] = raw === "1" || raw === "true" || raw === "on";
      continue;
    }
    const requested = Number(raw);
    if (!Number.isFinite(requested)) continue;
    const applied = clampBinParameter(parameter, requested);
    values[parameter.name] = applied;
    if (applied !== requested) diagnostics.push({ name: parameter.name, requested, applied });
  }
  return { values, diagnostics };
}

export function binPresetFromSearch(search: string): Record<string, number | boolean> {
  return binPresetFromSearchDetailed(search).values;
}

function normalizedNumber(parameter: BinParameter, value: number): string {
  const step = parameter.step ?? 1e-9;
  // Integer ticks avoid float spelling differences between authored Blender
  // values, range controls, URLs, and the checked-in parity registry.
  return String(Math.round(value / step));
}

export function normalizedBinValuesKey(values: Record<string, number | boolean>): string {
  return BIN_PARAMETERS.map((parameter) => {
    const value = values[parameter.name] ?? parameter.defaultValue;
    return parameter.boolean
      ? `${parameter.name}=${Boolean(value) ? 1 : 0}`
      : `${parameter.name}=${normalizedNumber(parameter, Number(value))}`;
  }).join("|");
}

export function compileBinParityEvidence(payload: BinParityEvidencePayload): Map<string, BinParityEvidenceRecord> {
  const registry = payload.evidenceRegistry;
  const records = new Map<string, BinParityEvidenceRecord>();
  if (!registry) return records;
  const add = (item: BinParityEvidenceCase, overrides: Record<string, number | boolean>): void => {
    const values = { ...BIN_DEFAULTS, ...overrides };
    records.set(normalizedBinValuesKey(values), {
      ...item,
      overrides,
      version: registry.version,
      distanceTolerance: registry.distanceTolerance,
      values,
    });
  };
  for (const sweep of registry.sweeps ?? []) for (const value of sweep.values) add({
    name: `${sweep.name} · ${sweep.parameter}=${String(value)}`,
    surface: sweep.surface,
  }, { ...sweep.overrides, [sweep.parameter]: value });
  // Explicit cases win when a sweep includes the same authored snapshot.
  for (const item of registry.cases) add(item, item.overrides ?? {});
  return records;
}

export function findBinParityEvidence(
  records: Map<string, BinParityEvidenceRecord>,
  values: Record<string, number | boolean>,
): BinParityEvidenceRecord | undefined {
  return records.get(normalizedBinValuesKey(values));
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
