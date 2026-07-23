export const MATERIALX_STRUCTURAL_ELEMENTS = new Set([
  "materialx", "nodegraph", "input", "output", "standard_surface", "surfacematerial",
]);

/** Elements handled by Three 0.185.1's MaterialXLoader. */
export const THREE_MATERIALX_ELEMENTS = new Set([
  "add", "subtract", "multiply", "divide", "modulo", "absval", "sign", "floor", "ceil", "round",
  "power", "sin", "cos", "tan", "asin", "acos", "atan2", "sqrt", "ln", "exp", "clamp", "min", "max",
  "normalize", "magnitude", "dotproduct", "crossproduct", "distance", "invert", "transformmatrix", "normalmap",
  "transpose", "determinant", "invertmatrix", "creatematrix", "length", "remap", "smoothstep", "luminance",
  "rgbtohsv", "hsvtorgb", "mix", "combine2", "combine3", "combine4", "ramplr", "ramptb", "ramp4",
  "splitlr", "splittb", "noise2d", "noise3d", "fractal3d", "cellnoise2d", "cellnoise3d", "worleynoise2d",
  "worleynoise3d", "unifiednoise2d", "unifiednoise3d", "place2d", "safepower", "contrast", "saturate",
  "extract", "separate2", "separate3", "separate4", "reflect", "refract", "time", "frame", "ifgreater",
  "ifgreatereq", "ifequal", "rotate2d", "rotate3d", "heighttonormal", "convert", "constant", "position",
  "normal", "tangent", "texcoord", "geomcolor", "tiledimage", "image",
]);

/** Additional node categories supported by the official MaterialX ESSL generator. */
export const OFFICIAL_ESSL_MATERIALX_ELEMENTS = new Set([
  ...THREE_MATERIALX_ELEMENTS,
  "geompropvalue",
]);

const PROCEDURAL_HEIGHT_ELEMENTS = new Set([
  "add", "subtract", "multiply", "divide", "clamp", "remap", "noise2d", "noise3d", "fractal3d",
  "position", "texcoord", "constant", "convert", "extract",
]);

export type MaterialXAudit = {
  elements: readonly string[];
  unsupportedElements: readonly string[];
  materialCount: number;
  proceduralHeightNormalCount: number;
  requiresProceduralHeightAdapter: boolean;
};

function elementNames(xml: string): string[] {
  const names = new Set<string>();
  for (const match of xml.matchAll(/<\s*([A-Za-z_][\w:.-]*)\b/g)) {
    const name = match[1].replace(/^.*:/, "");
    if (!name.startsWith("?")) names.add(name);
  }
  return [...names].sort();
}

/**
 * Preflight because MaterialXLoader warns and substitutes zero for unknown
 * nodes instead of failing the load.
 */
export function auditMaterialXDocument(
  xml: string,
  options: { implementation?: "three-tsl" | "official-essl" } = {},
): MaterialXAudit {
  const elements = elementNames(xml);
  const implementationElements = options.implementation === "official-essl"
    ? OFFICIAL_ESSL_MATERIALX_ELEMENTS
    : THREE_MATERIALX_ELEMENTS;
  const unsupportedElements = elements.filter((element) =>
    !MATERIALX_STRUCTURAL_ELEMENTS.has(element) && !implementationElements.has(element));
  const materialCount = (xml.match(/<\s*surfacematerial\b/g) ?? []).length;
  const heightNodes = [...xml.matchAll(/<\s*heighttonormal\b[\s\S]*?<\s*\/\s*heighttonormal\s*>/g)];
  const proceduralHeightNormalCount = heightNodes.filter((match) => {
    const block = match[0];
    const reference = block.match(/<\s*input\b[^>]*\bname=["']in["'][^>]*\bnodename=["']([^"']+)["']/);
    if (!reference) return false;
    const nodeName = reference[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const node = xml.match(new RegExp(`<\\s*([A-Za-z_][\\w:.-]*)\\b[^>]*\\bname=["']${nodeName}["']`));
    return node ? PROCEDURAL_HEIGHT_ELEMENTS.has(node[1].replace(/^.*:/, "")) : false;
  }).length;

  return {
    elements,
    unsupportedElements,
    materialCount,
    proceduralHeightNormalCount,
    requiresProceduralHeightAdapter: proceduralHeightNormalCount > 0,
  };
}
