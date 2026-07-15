import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; linked?: boolean; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type AttributeColorEmissionConfig = {
  colorAttribute: string;
  attributeOutput: "Vector";
  strength: number;
};

function input(node: RawNode, name: string): RawSocket | undefined {
  return node.inputs?.find((socket) => socket.identifier === name || socket.name === name);
}

/**
 * Recognize Blender's strict three-node Attribute Vector → Emission Color graph.
 * This is separate from flat.nodes, whose second attribute drives Strength.
 */
export function extractAttributeColorEmissionConfig(dump: Dump, materialName: string): AttributeColorEmissionConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  if (nodes.length !== 3 || links.length !== 2) return null;
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true);
  const emission = nodes.find((node) => node.type === "ShaderNodeEmission");
  const attribute = nodes.find((node) => node.type === "ShaderNodeAttribute" && node.props?.attribute_type === "GEOMETRY");
  if (!output || !emission || !attribute) return null;
  const surface = links.some((link) => link.from_node === emission.name && link.from_socket === "Emission"
    && link.to_node === output.name && link.to_socket === "Surface");
  const color = links.some((link) => link.from_node === attribute.name && link.from_socket === "Vector"
    && link.to_node === emission.name && link.to_socket === "Color");
  const strengthSocket = input(emission, "Strength");
  const strength = Number(strengthSocket?.value);
  const colorAttribute = String(attribute.props?.attribute_name ?? "");
  if (!surface || !color || strengthSocket?.linked === true || !Number.isFinite(strength) || !colorAttribute) return null;
  return { colorAttribute, attributeOutput: "Vector", strength };
}

/**
 * Reconstruct Attribute Vector → Emission. Blender resolves a missing Geometry
 * Attribute to the zero vector, so the exact fallback is black rather than the
 * gallery's neutral diagnostic surface.
 */
export function makeAttributeColorEmissionMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.Material | null {
  const config = extractAttributeColorEmissionConfig(dump, materialName);
  if (!config) return null;
  const attribute = geometry.getAttribute(config.colorAttribute);
  if (!attribute) {
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, toneMapped: true });
    material.name = `${materialName} · missing attribute zero emission`;
    material.userData.attributeColorEmissionContract = config;
    material.userData.attributeResolution = "missing-zero";
    return material;
  }
  if (attribute.itemSize < 3 || !/^[A-Za-z_]\w*$/.test(config.colorAttribute)) return null;

  const material = new THREE.ShaderMaterial({
    name: `${materialName} · attribute color emission reconstruction`,
    vertexShader: /* glsl */`
      attribute vec3 ${config.colorAttribute};
      varying vec3 vAttributeEmissionColor;
      void main() {
        vAttributeEmissionColor = ${config.colorAttribute};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vAttributeEmissionColor;
      void main() {
        gl_FragColor = vec4(max(vAttributeEmissionColor, vec3(0.0)) * ${config.strength}, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  material.userData.attributeColorEmissionContract = config;
  material.userData.attributeResolution = "geometry-vector";
  return material;
}
