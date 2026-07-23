import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; linked?: boolean; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[] };
type RawLink = {
  from_node: string;
  from_socket: string;
  from_type?: string;
  to_node: string;
  to_socket: string;
};
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type BasicBlenderMaterialConfig = {
  kind: "principled" | "emission" | "diffuse" | "glossy" | "background";
  baseColor: [number, number, number];
  metalness: number;
  roughness: number;
  emissive: [number, number, number];
  emissiveIntensity: number;
  opacity: number;
  ior: number;
  transmission: number;
  clearcoat: number;
  clearcoatRoughness: number;
  linkedInputs: string[];
};

function finite(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function color(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : fallback;
}

function socket(node: RawNode, ...names: string[]): RawSocket | undefined {
  return node.inputs?.find((candidate) => names.includes(candidate.identifier ?? "") || names.includes(candidate.name ?? ""));
}

function directSurfaceNode(tree: RawMaterial): RawNode | null {
  const nodes = tree.nodes ?? [];
  const links = tree.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  if (!output) return null;

  let link = links.find((candidate) => candidate.to_node === output.name && candidate.to_socket === "Surface"
    && (candidate.from_type === undefined || candidate.from_type === "NodeSocketShader"));
  const visited = new Set<string>();
  while (link) {
    const source = nodes.find((node) => node.name === link?.from_node);
    if (!source || visited.has(source.name)) return null;
    if (source.type !== "NodeReroute" && source.type !== "ShaderNodeReroute") return source;
    visited.add(source.name);
    link = links.find((candidate) => candidate.to_node === source.name);
  }
  return null;
}

function linkedInputs(node: RawNode): string[] {
  return (node.inputs ?? [])
    .filter((candidate) => candidate.linked)
    .map((candidate) => candidate.identifier || candidate.name || "unknown")
    .sort();
}

/**
 * Extract the constant portion of a Blender surface shader.
 *
 * This deliberately follows the active Material Output instead of choosing an
 * arbitrary Principled node from the file. Linked procedural inputs retain a
 * useful constant fallback, but are disclosed through `linkedInputs` so the
 * browser never presents that approximation as complete shader-node parity.
 */
export function extractBasicBlenderMaterialConfig(dump: Dump, materialName: string): BasicBlenderMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  if (!tree) return null;
  const node = directSurfaceNode(tree);
  if (!node) return null;

  const linked = linkedInputs(node);
  if (node.type === "ShaderNodeBackground") {
    // A Background node is formally intended for a World surface, but several
    // supplied assets connect one directly to a material output as an unlit
    // color. Only accept the literal two-node contract: linked Color/Strength
    // inputs would require evaluating the upstream shader graph.
    if (linked.length) return null;
    const backgroundColor = color(socket(node, "Color")?.value, [0.8, 0.8, 0.8]);
    return {
      kind: "background",
      baseColor: backgroundColor,
      metalness: 0,
      roughness: 1,
      emissive: backgroundColor,
      emissiveIntensity: finite(socket(node, "Strength")?.value, 1),
      opacity: 1,
      ior: 1.5,
      transmission: 0,
      clearcoat: 0,
      clearcoatRoughness: 0,
      linkedInputs: [],
    };
  }

  if (node.type === "ShaderNodeEmission") {
    return {
      kind: "emission",
      baseColor: [0, 0, 0],
      metalness: 0,
      roughness: 1,
      emissive: color(socket(node, "Color")?.value, [1, 1, 1]),
      emissiveIntensity: finite(socket(node, "Strength")?.value, 1),
      opacity: 1,
      ior: 1.5,
      transmission: 0,
      clearcoat: 0,
      clearcoatRoughness: 0,
      linkedInputs: linked,
    };
  }

  if (node.type === "ShaderNodeBsdfDiffuse" || node.type === "ShaderNodeBsdfGlossy") {
    const glossy = node.type === "ShaderNodeBsdfGlossy";
    return {
      kind: glossy ? "glossy" : "diffuse",
      baseColor: color(socket(node, "Color")?.value, [0.8, 0.8, 0.8]),
      metalness: glossy ? 1 : 0,
      roughness: finite(socket(node, "Roughness")?.value, glossy ? 0.2 : 0.5),
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      opacity: 1,
      ior: 1.5,
      transmission: 0,
      clearcoat: 0,
      clearcoatRoughness: 0,
      linkedInputs: linked,
    };
  }

  if (node.type !== "ShaderNodeBsdfPrincipled") return null;
  const emission = color(socket(node, "Emission Color", "Emission")?.value, [0, 0, 0]);
  return {
    kind: "principled",
    baseColor: color(socket(node, "Base Color")?.value, [0.8, 0.8, 0.8]),
    metalness: finite(socket(node, "Metallic")?.value, 0),
    roughness: finite(socket(node, "Roughness")?.value, 0.5),
    emissive: emission,
    emissiveIntensity: finite(socket(node, "Emission Strength")?.value, 1),
    opacity: finite(socket(node, "Alpha")?.value, 1),
    ior: finite(socket(node, "IOR")?.value, 1.5),
    transmission: finite(socket(node, "Transmission Weight", "Transmission")?.value, 0),
    clearcoat: finite(socket(node, "Coat Weight", "Clearcoat")?.value, 0),
    clearcoatRoughness: finite(socket(node, "Coat Roughness", "Clearcoat Roughness")?.value, 0.03),
    linkedInputs: linked,
  };
}

export function makeBasicBlenderMaterial(dump: Dump, materialName: string): THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial | null {
  const config = extractBasicBlenderMaterialConfig(dump, materialName);
  if (!config) return null;
  if (config.kind === "background") {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(...config.baseColor).multiplyScalar(Math.max(0, config.emissiveIntensity)),
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    material.name = `${materialName} · Blender background constants`;
    material.userData.blenderMaterialContract = config;
    return material;
  }
  const opacity = THREE.MathUtils.clamp(config.opacity, 0, 1);
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: THREE.MathUtils.clamp(config.metalness, 0, 1),
    roughness: THREE.MathUtils.clamp(config.roughness, 0, 1),
    emissive: new THREE.Color(...config.emissive),
    emissiveIntensity: Math.max(0, config.emissiveIntensity),
    opacity,
    transparent: opacity < 1 || config.transmission > 0,
    ior: THREE.MathUtils.clamp(config.ior, 1, 2.333),
    transmission: THREE.MathUtils.clamp(config.transmission, 0, 1),
    clearcoat: THREE.MathUtils.clamp(config.clearcoat, 0, 1),
    clearcoatRoughness: THREE.MathUtils.clamp(config.clearcoatRoughness, 0, 1),
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · Blender ${config.kind}${config.linkedInputs.length ? " constant approximation" : " constants"}`;
  material.userData.blenderMaterialContract = config;
  return material;
}

/** Blender's neutral surface for faces whose material slot is unassigned. */
export function makeBlenderDefaultSurfaceMaterial(): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.8, 0.8, 0.8),
    metalness: 0,
    roughness: 0.5,
    side: THREE.DoubleSide,
  });
  material.name = "Blender unassigned material surface";
  material.userData.blenderMaterialContract = {
    kind: "unassigned",
    baseColor: [0.8, 0.8, 0.8],
    metalness: 0,
    roughness: 0.5,
  };
  return material;
}
