import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, any>; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type GreyUiMaterialConfig = {
  colorAttribute: string;
  mixFactor: number;
  rotation: [number, number, number];
  ramp: { position: number; color: [number, number, number] }[];
};

function input(node: RawNode | undefined, identifier: string): unknown {
  return node?.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier)?.value;
}

/** Recognize the UI Window Generator's normal-band/geometry-color material. */
export function extractGreyUiMaterialConfig(dump: Dump, materialName: string): GreyUiMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = links.find((link) => link.to_node === output?.name && link.to_socket === "Surface");
  const mix = nodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeMix" && node.props?.data_type === "RGBA");
  const rampLink = links.find((link) => link.to_node === mix?.name && link.to_socket === "A_Color");
  const attributeLink = links.find((link) => link.to_node === mix?.name && link.to_socket === "B_Color");
  const ramp = nodes.find((node) => node.name === rampLink?.from_node && node.type === "ShaderNodeValToRGB");
  const attribute = nodes.find((node) => node.name === attributeLink?.from_node && node.type === "ShaderNodeAttribute");
  const mappingLink = links.find((link) => link.to_node === ramp?.name && link.to_socket === "Fac");
  const mapping = nodes.find((node) => node.name === mappingLink?.from_node && node.type === "ShaderNodeMapping");
  const normalLink = links.find((link) => link.to_node === mapping?.name && link.to_socket === "Vector");
  const texCoord = nodes.find((node) => node.name === normalLink?.from_node && node.type === "ShaderNodeTexCoord");
  const colorAttribute = String(attribute?.props?.attribute_name ?? "");
  const elements = ramp?.props?.color_ramp?.elements;
  const rotation = input(mapping, "Rotation");
  const mixFactor = Number(input(mix, "Factor_Float"));
  if (!mix || ramp?.props?.color_ramp?.interpolation !== "CONSTANT" || !attribute || !/^[A-Za-z_]\w*$/.test(colorAttribute)
    || normalLink?.from_socket !== "Normal" || !texCoord || !Array.isArray(elements) || elements.length < 2
    || !Array.isArray(rotation) || rotation.length < 3 || !Number.isFinite(mixFactor)) return null;
  const parsedRamp = elements.map((element: any) => ({
    position: Number(element.position),
    color: element.color?.slice(0, 3).map(Number) as [number, number, number],
  }));
  if (parsedRamp.some((element) => !Number.isFinite(element.position) || element.color?.length !== 3 || !element.color.every(Number.isFinite))) return null;
  return {
    colorAttribute,
    mixFactor,
    rotation: rotation.slice(0, 3).map(Number) as [number, number, number],
    ramp: parsedRamp,
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function makeGreyUiMaterial(dump: Dump, geometry: THREE.BufferGeometry, materialName: string): THREE.ShaderMaterial | null {
  const config = extractGreyUiMaterialConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  if (!color || color.itemSize !== 3) return null;
  const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(...config.rotation, "XYZ"),
  ));
  const rampLines = config.ramp.slice(1).map((element) =>
    `if(factor>=${glsl(element.position)}) band=vec3(${element.color.map(glsl).join(",")});`).join("\n");
  const first = config.ramp[0].color.map(glsl).join(",");
  const material = new THREE.ShaderMaterial({
    name: `${materialName} · normal-band UI reconstruction`,
    uniforms: { uiRotation: { value: rotation } },
    vertexShader: /* glsl */`
      attribute vec3 ${config.colorAttribute};
      uniform mat3 uiRotation;
      varying vec3 vUiColor;
      varying vec3 vUiNormal;
      void main() {
        vUiColor = ${config.colorAttribute};
        vUiNormal = uiRotation * normalize(normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vUiColor;
      varying vec3 vUiNormal;
      void main() {
        float factor=(vUiNormal.x+vUiNormal.y+vUiNormal.z)/3.0;
        vec3 band=vec3(${first});
        ${rampLines}
        vec3 color=mix(band,max(vUiColor,vec3(0.0)),${glsl(config.mixFactor)});
        gl_FragColor=vec4(color,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  material.userData.greyUiContract = config;
  return material;
}
