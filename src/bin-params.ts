export type BinParameter = {
  name: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue: number | boolean;
  boolean?: boolean;
};

// Values are the authored modifier values from dump_bin.json, not the node
// group's unused socket defaults.
export const BIN_PARAMETERS: readonly BinParameter[] = [
  { name: "Size X", min: 0.1, max: 3, step: 0.001, defaultValue: 0.7079999446868896 },
  { name: "Size Y", min: 0.1, max: 3, step: 0.001, defaultValue: 0.510999858379364 },
  { name: "Size Z", min: 0, max: 1, step: 0.001, defaultValue: 0.11300000548362732 },
  { name: "bin gap size", min: 0.2, max: 50, step: 0.01, defaultValue: 1.3000000715255737 },
  { name: "bin wall thiccness", min: 0, max: 30, step: 0.01, defaultValue: 1.8079999685287476 },
  { name: "fillet", min: 0, max: 30, step: 0.01, defaultValue: 0.8109987378120422 },
  { name: "divide x", min: 0, max: 1, step: 0.001, defaultValue: 0.41713136434555054 },
  { name: "divide y", min: 0, max: 1, step: 0.001, defaultValue: 0.6334825754165649 },
  { name: "Bin Select", min: 0, max: 20, step: 1, defaultValue: 5 },
  { name: "print layers", min: 0, max: 5, step: 0.001, defaultValue: 0.05199899151921272 },
  { name: "make exportable", boolean: true, defaultValue: false },
] as const;

export const BIN_DEFAULTS: Record<string, number | boolean> = Object.fromEntries(
  BIN_PARAMETERS.map((parameter) => [parameter.name, parameter.defaultValue]),
);
