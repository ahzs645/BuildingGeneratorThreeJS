import type { MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  float,
  Fn,
  bitangentWorld,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  positionLocal,
  positionWorld,
  remap,
  tangentWorld,
  transformNormalToView,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

type NodeMaterialMap = Readonly<Record<string, MeshPhysicalNodeMaterial>>;
// The @types/three generic node union cannot express a runtime-selected
// MaterialX scalar/vector graph. The adapter still returns typed node materials
// at its public boundary; dynamic node arity is intentionally local here.
type TslNode = any;

const materialXNormalFromHeight = Fn((inputs: { height: TslNode; strength: TslNode; distance: TslNode }) => {
  // MaterialX heighttonormal 1.39 derives an encoded tangent-space normal.
  // The 1/16 Sobel factor and following normalmap stage match the standard
  // implementation and Blender's exported Strength -> Distance topology.
  const dHdS = vec2(inputs.height.dFdx(), inputs.height.dFdy()).mul(inputs.strength).mul(1 / 16);
  const coordinates = uv();
  const dUdS = vec2(coordinates.x.dFdx(), coordinates.x.dFdy());
  const dVdS = vec2(coordinates.y.dFdx(), coordinates.y.dFdy());
  const tangent = vec3(dUdS.x, dVdS.x, dHdS.x);
  const bitangent = vec3(dUdS.y, dVdS.y, dHdS.y);
  const tangentNormal = tangent.cross(bitangent).normalize();
  const orientedNormal = tangentNormal.mul(tangentNormal.z.sign());
  const encodedNormal = orientedNormal.mul(0.5).add(0.5);
  const decodedNormal = encodedNormal.mul(2).sub(1);
  const worldNormal = (tangentWorld as TslNode).mul(decodedNormal.x.mul(inputs.distance))
    .add((bitangentWorld as TslNode).mul(decodedNormal.y.mul(inputs.distance)))
    .add((normalWorld as TslNode).mul(decodedNormal.z))
    .normalize();
  return transformNormalToView(worldNormal);
});

function directChildren(element: Element, tagName?: string): Element[] {
  return [...element.children].filter((child) => !tagName || child.tagName === tagName);
}

function input(element: Element, name: string): Element | null {
  return directChildren(element, "input").find((candidate) => candidate.getAttribute("name") === name) ?? null;
}

function values(value: string | null): number[] {
  return (value ?? "0").split(/[,\s]+/).filter(Boolean).map(Number);
}

function literal(element: Element | null, fallback = 0): TslNode {
  if (!element) return float(fallback);
  const parsed = values(element.getAttribute("value"));
  const type = element.getAttribute("type") ?? "float";
  if (type === "vector2") return vec2(parsed[0] ?? fallback, parsed[1] ?? fallback);
  if (type === "vector3" || type === "color3") return vec3(parsed[0] ?? fallback, parsed[1] ?? fallback, parsed[2] ?? fallback);
  if (type === "vector4" || type === "color4") return vec4(parsed[0] ?? fallback, parsed[1] ?? fallback, parsed[2] ?? fallback, parsed[3] ?? fallback);
  return float(parsed[0] ?? fallback);
}

class HeightGraphCompiler {
  private readonly nodes = new Map<string, Element>();
  private readonly cache = new Map<string, TslNode>();

  constructor(graph: Element) {
    for (const child of directChildren(graph)) {
      const name = child.getAttribute("name");
      if (name) this.nodes.set(name, child);
    }
  }

  resolve(element: Element | null, fallback = 0): TslNode {
    if (!element) return float(fallback);
    const nodeName = element.getAttribute("nodename");
    if (nodeName) return this.compile(nodeName);
    return literal(element, fallback);
  }

  compile(name: string): TslNode {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const element = this.nodes.get(name);
    if (!element) throw new Error(`MaterialX procedural height reference not found: ${name}`);

    let node: TslNode;
    switch (element.tagName) {
      case "output":
        node = this.resolve(element);
        break;
      case "position":
        node = element.getAttribute("space") === "world" ? positionWorld : positionLocal;
        break;
      case "texcoord":
        node = uv(Number(input(element, "index")?.getAttribute("value") ?? 0));
        break;
      case "constant":
        node = this.resolve(input(element, "value"));
        break;
      case "convert": {
        const source = this.resolve(input(element, "in"));
        const type = element.getAttribute("type");
        node = type === "vector2" ? vec2(source) : type === "vector3" || type === "color3" ? vec3(source) : type === "vector4" || type === "color4" ? vec4(source) : float(source);
        break;
      }
      case "extract": {
        const source = this.resolve(input(element, "in"));
        const index = Math.max(0, Math.min(3, Number(input(element, "index")?.getAttribute("value") ?? 0)));
        node = source[["x", "y", "z", "w"][index]];
        break;
      }
      case "add":
        node = this.resolve(input(element, "in1")).add(this.resolve(input(element, "in2")));
        break;
      case "subtract":
        node = this.resolve(input(element, "in1")).sub(this.resolve(input(element, "in2")));
        break;
      case "multiply":
        node = this.resolve(input(element, "in1")).mul(this.resolve(input(element, "in2"), 1));
        break;
      case "divide":
        node = this.resolve(input(element, "in1")).div(this.resolve(input(element, "in2"), 1));
        break;
      case "clamp":
        node = this.resolve(input(element, "in")).clamp(this.resolve(input(element, "low")), this.resolve(input(element, "high"), 1));
        break;
      case "remap":
        node = remap(
          this.resolve(input(element, "in")),
          this.resolve(input(element, "inlow")),
          this.resolve(input(element, "inhigh"), 1),
          this.resolve(input(element, "outlow")),
          this.resolve(input(element, "outhigh"), 1),
        );
        break;
      case "noise2d":
      case "noise3d":
        node = mx_noise_float(
          this.resolve(input(element, "texcoord")),
          this.resolve(input(element, "amplitude"), 1),
          this.resolve(input(element, "pivot")),
        );
        break;
      case "fractal3d":
        node = mx_fractal_noise_float(
          this.resolve(input(element, "position")),
          this.resolve(input(element, "octaves"), 3),
          this.resolve(input(element, "lacunarity"), 2),
          this.resolve(input(element, "diminish"), 0.5),
          this.resolve(input(element, "amplitude"), 1),
        );
        break;
      default:
        throw new Error(`Unsupported MaterialX procedural height element: ${element.tagName}`);
    }

    this.cache.set(name, node);
    return node;
  }
}

export type ProceduralHeightResult = {
  appliedMaterials: readonly string[];
  errors: readonly string[];
};

/**
 * Replace Three r185's texture-only heighttonormal behavior when a MaterialX
 * normal input is driven by a procedural height graph. The adapter implements
 * the canonical MaterialX Sobel/tangent-frame form and never checks material names.
 */
export function applyProceduralHeightNormals(xml: string, materials: NodeMaterialMap): ProceduralHeightResult {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const root = document.documentElement;
  const graphs = new Map(directChildren(root, "nodegraph").map((graph) => [graph.getAttribute("name") ?? "", graph]));
  const surfaces = new Map(directChildren(root, "standard_surface").map((surface) => [surface.getAttribute("name") ?? "", surface]));
  const appliedMaterials: string[] = [];
  const errors: string[] = [];

  for (const surfaceMaterial of directChildren(root, "surfacematerial")) {
    const materialName = surfaceMaterial.getAttribute("name") ?? "";
    const shaderName = input(surfaceMaterial, "surfaceshader")?.getAttribute("nodename") ?? "";
    const surface = surfaces.get(shaderName);
    const normalInput = surface ? input(surface, "normal") : null;
    const graphName = normalInput?.getAttribute("nodegraph") ?? "";
    const outputName = normalInput?.getAttribute("output") ?? "";
    const graph = graphs.get(graphName);
    const material = materials[materialName];
    if (!graph || !material || !outputName) continue;

    try {
      const output = directChildren(graph, "output").find((candidate) => candidate.getAttribute("name") === outputName);
      const outputNodeName = output?.getAttribute("nodename") ?? "";
      const outputNode = directChildren(graph).find((candidate) => candidate.getAttribute("name") === outputNodeName);
      const normalMap = outputNode?.tagName === "normalmap" ? outputNode : null;
      if (!normalMap) throw new Error("procedural heighttonormal must feed normalmap before a surface normal");
      const heightToNormalName = input(normalMap, "in")?.getAttribute("nodename") ?? "";
      const heightToNormal = directChildren(graph).find((candidate) =>
        candidate.getAttribute("name") === heightToNormalName && candidate.tagName === "heighttonormal");
      if (!heightToNormal) continue;
      const compiler = new HeightGraphCompiler(graph);
      const height = compiler.resolve(input(heightToNormal, "in"));
      const strength = compiler.resolve(input(heightToNormal, "scale"), 1);
      const distance = compiler.resolve(input(normalMap, "scale"), 1);
      material.normalNode = materialXNormalFromHeight({ height, strength, distance });
      material.userData.materialXProceduralHeightAdapter = true;
      material.userData.materialXProceduralHeightTopology = "heighttonormal -> normalmap";
      appliedMaterials.push(materialName);
    } catch (error) {
      errors.push(`${materialName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { appliedMaterials, errors };
}
