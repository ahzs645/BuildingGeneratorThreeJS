import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown };
type RawNode = { name: string; type: string; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type ToonOutlineMaterialConfig = {
  color: [number, number, number];
  strength: number;
};

function socketValue(node: RawNode | undefined, name: string): unknown {
  return node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value;
}

/** Recognize the Pipe Icon material that emits on front faces and is transparent on back faces. */
export function extractToonOutlineMaterialConfig(dump: Dump, materialName: string): ToonOutlineMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const outputLink = links.find((link) => link.to_node === output?.name && link.to_socket === "Surface");
  const mix = nodes.find((node) => node.name === outputLink?.from_node && node.type === "ShaderNodeMixShader");
  const factorLink = links.find((link) => link.to_node === mix?.name && link.to_socket === "Fac");
  const geometry = nodes.find((node) => node.name === factorLink?.from_node && node.type === "ShaderNodeNewGeometry");
  const frontLink = links.find((link) => link.to_node === mix?.name && link.to_socket === "Shader");
  const backLink = links.find((link) => link.to_node === mix?.name && link.to_socket === "Shader_001");
  const emission = nodes.find((node) => node.name === frontLink?.from_node && node.type === "ShaderNodeEmission");
  const transparent = nodes.find((node) => node.name === backLink?.from_node && node.type === "ShaderNodeBsdfTransparent");
  const rawColor = socketValue(emission, "Color");
  if (!mix || !geometry || factorLink?.from_socket !== "Backfacing" || !emission || !transparent
    || !Array.isArray(rawColor) || rawColor.length < 3) return null;
  const color = rawColor.slice(0, 3).map(Number);
  const strength = Number(socketValue(emission, "Strength") ?? 1);
  if (!color.every(Number.isFinite) || !Number.isFinite(strength)) return null;
  return { color: color as [number, number, number], strength };
}

export function makeToonOutlineMaterial(dump: Dump, materialName: string): THREE.MeshBasicMaterial | null {
  const config = extractToonOutlineMaterialConfig(dump, materialName);
  if (!config) return null;
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(...config.color).multiplyScalar(Math.max(0, config.strength)),
    side: THREE.FrontSide,
    toneMapped: false,
  });
  material.name = `${materialName} · front-emission outline reconstruction`;
  material.userData.toonOutlineContract = config;
  return material;
}
