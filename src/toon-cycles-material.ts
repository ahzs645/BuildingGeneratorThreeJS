import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, any>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawTree = { nodes?: RawNode[]; links?: RawLink[] };
type ShaderDump = Dump & { shader_node_groups?: Record<string, RawTree> };

export type ToonCyclesMaterialConfig = {
  rotation: [number, number, number];
  referenceNormal: [number, number, number];
  multiplier: number;
  strength: number;
  ramp: { position: number; color: [number, number, number] }[];
};

function socket(node: RawNode | undefined, identifier: string): RawSocket | undefined {
  return node?.inputs?.find((candidate) => candidate.identifier === identifier || candidate.name === identifier);
}

function linkTo(links: RawLink[], node: RawNode | undefined, socketName: string): RawLink | undefined {
  return node ? links.find((link) => link.to_node === node.name && link.to_socket === socketName) : undefined;
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : null;
}

/**
 * Recognize the extracted normal-band toon group by its complete connected graph.
 * The material and node-group datablock names are deliberately not part of the contract.
 */
export function extractToonCyclesMaterialConfig(dump: Dump, materialName: string): ToonCyclesMaterialConfig | null {
  const shaderDump = dump as ShaderDump;
  const material = dump.materials?.[materialName] as RawTree | undefined;
  const materialNodes = material?.nodes ?? [];
  const materialLinks = material?.links ?? [];
  const output = materialNodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? materialNodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = linkTo(materialLinks, output, "Surface");
  const groupNode = materialNodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeGroup");
  const groupName = String(groupNode?.props?.node_tree?.name ?? "");
  const tree = shaderDump.shader_node_groups?.[groupName];
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];

  const groupOutput = nodes.find((node) => node.type === "NodeGroupOutput");
  const outputLink = links.find((link) => link.to_node === groupOutput?.name && link.to_socket === "Output_0");
  const background = nodes.find((node) => node.name === outputLink?.from_node && node.type === "ShaderNodeBackground");
  const rampLink = linkTo(links, background, "Color");
  const ramp = nodes.find((node) => node.name === rampLink?.from_node && node.type === "ShaderNodeValToRGB");
  const finalLink = linkTo(links, ramp, "Fac");
  const finalMultiply = nodes.find((node) => node.name === finalLink?.from_node
    && node.type === "ShaderNodeMath" && node.props?.operation === "MULTIPLY");
  const firstLink = linkTo(links, finalMultiply, "Value_001");
  const firstMultiply = nodes.find((node) => node.name === firstLink?.from_node
    && node.type === "ShaderNodeMath" && node.props?.operation === "MULTIPLY");
  const mappingLink = linkTo(links, firstMultiply, "Value");
  const normalLink = linkTo(links, firstMultiply, "Value_001");
  const mapping = nodes.find((node) => node.name === mappingLink?.from_node
    && node.type === "ShaderNodeMapping" && node.props?.vector_type === "POINT");
  const normal = nodes.find((node) => node.name === normalLink?.from_node && node.type === "ShaderNodeNormal");
  const geometryLink = linkTo(links, mapping, "Vector");
  const geometry = nodes.find((node) => node.name === geometryLink?.from_node && node.type === "ShaderNodeNewGeometry");
  const elements = ramp?.props?.color_ramp?.elements;
  const rotation = vec3(socket(mapping, "Rotation")?.value);
  const referenceNormal = vec3(socket(normal, "Normal")?.value);
  const multiplier = Number(socket(finalMultiply, "Value")?.value);
  const strength = Number(socket(background, "Strength")?.value);

  if (!groupNode || !tree || outputLink?.from_socket !== "Background" || rampLink?.from_socket !== "Color"
    || finalLink?.from_socket !== "Value" || firstLink?.from_socket !== "Value"
    || mappingLink?.from_socket !== "Vector" || normalLink?.from_socket !== "Normal"
    || geometryLink?.from_socket !== "Normal" || !geometry || !rotation || !referenceNormal
    || ramp?.props?.color_ramp?.interpolation !== "CONSTANT" || !Array.isArray(elements) || elements.length < 2
    || !Number.isFinite(multiplier) || !Number.isFinite(strength)) return null;

  const parsedRamp = elements.map((element: any) => ({
    position: Number(element.position),
    color: vec3(element.color),
  }));
  if (parsedRamp.some((element) => !Number.isFinite(element.position) || !element.color)) return null;
  return {
    rotation,
    referenceNormal,
    multiplier,
    strength,
    ramp: parsedRamp as { position: number; color: [number, number, number] }[],
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function makeToonCyclesMaterial(dump: Dump, materialName: string): THREE.ShaderMaterial | null {
  const config = extractToonCyclesMaterialConfig(dump, materialName);
  if (!config) return null;
  const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(...config.rotation, "XYZ"),
  ));
  const normalScalar = (config.referenceNormal[0] + config.referenceNormal[1] + config.referenceNormal[2]) / 3;
  const rampLines = config.ramp.slice(1).map((element) =>
    `if(factor>=${glsl(element.position)}) color=vec3(${element.color.map(glsl).join(",")});`).join("\n");
  const firstColor = config.ramp[0].color.map(glsl).join(",");
  const material = new THREE.ShaderMaterial({
    name: `${materialName} · Cycles normal-band background raster reconstruction`,
    uniforms: { toonRotation: { value: rotation } },
    vertexShader: /* glsl */`
      uniform mat3 toonRotation;
      varying vec3 vToonNormal;
      void main() {
        vToonNormal = toonRotation * normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vToonNormal;
      void main() {
        float mappedNormal = (vToonNormal.x + vToonNormal.y + vToonNormal.z) / 3.0;
        float factor = mappedNormal * ${glsl(normalScalar)} * ${glsl(config.multiplier)};
        vec3 color = vec3(${firstColor});
        ${rampLines}
        gl_FragColor = vec4(color * ${glsl(Math.max(0, config.strength))}, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  material.userData.toonCyclesContract = config;
  return material;
}
