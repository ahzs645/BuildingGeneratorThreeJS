import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawNode = { name: string; type: string; props?: Record<string, unknown> };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type AttributeEmissionConfig = {
  colorAttribute: string;
  strengthAttribute: string;
};

export type AttributeEmissionColorRemap = {
  from: [number, number, number];
  to: [number, number, number];
};

/**
 * Recognize the small Blender material used by the flat sticker tools:
 * a named color attribute drives Emission Color and a named scalar attribute
 * drives Emission Strength. Unknown graphs deliberately fall back to the
 * neutral topology material instead of being approximated silently.
 */
export function extractAttributeEmissionConfig(dump: Dump, materialName: string): AttributeEmissionConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const emission = nodes.find((node) => node.type === "ShaderNodeEmission");
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  if (!emission || !output) return null;

  const surface = links.find((link) => link.from_node === emission.name && link.from_socket === "Emission"
    && link.to_node === output.name && link.to_socket === "Surface");
  const color = links.find((link) => link.to_node === emission.name && link.to_socket === "Color"
    && link.from_socket === "Color");
  const strength = links.find((link) => link.to_node === emission.name && link.to_socket === "Strength"
    && link.from_socket === "Vector");
  if (!surface || !color || !strength) return null;

  const colorNode = nodes.find((node) => node.name === color.from_node && node.type === "ShaderNodeAttribute");
  const strengthNode = nodes.find((node) => node.name === strength.from_node && node.type === "ShaderNodeAttribute");
  const colorAttribute = String(colorNode?.props?.attribute_name ?? "");
  const strengthAttribute = String(strengthNode?.props?.attribute_name ?? "");
  const validIdentifier = /^[A-Za-z_]\w*$/;
  if (!validIdentifier.test(colorAttribute) || !validIdentifier.test(strengthAttribute)) return null;
  return { colorAttribute, strengthAttribute };
}

export function makeAttributeEmissionMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
  colorRemaps: AttributeEmissionColorRemap[] = [],
): THREE.ShaderMaterial | THREE.MeshBasicMaterial | null {
  const config = extractAttributeEmissionConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  const strength = geometry.getAttribute(config.strengthAttribute);
  if (!color || !strength) {
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, toneMapped: true });
    material.name = `${materialName} · missing attribute zero emission`;
    material.userData.attributeEmissionContract = config;
    material.userData.attributeResolution = {
      color: color ? "geometry-color" : "missing-zero",
      strength: strength ? "geometry-vector" : "missing-zero",
    };
    return material;
  }
  if (color.itemSize !== 3 || strength.itemSize !== 1) return null;

  const remapShader = colorRemaps.map(({ from, to }) => `
        if (all(lessThan(abs(emissionColor - vec3(${from.map((value) => value.toPrecision(17)).join(", ")})), vec3(1e-6)))) {
          emissionColor = vec3(${to.map((value) => value.toPrecision(17)).join(", ")});
        }`).join("");
  const material = new THREE.ShaderMaterial({
    name: `${materialName} · attribute emission reconstruction`,
    vertexShader: /* glsl */`
      attribute vec3 ${config.colorAttribute};
      attribute float ${config.strengthAttribute};
      varying vec3 vEmissionColor;
      varying float vEmissionStrength;
      void main() {
        vEmissionColor = ${config.colorAttribute};
        vEmissionStrength = ${config.strengthAttribute};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vEmissionColor;
      varying float vEmissionStrength;
      void main() {
        vec3 emissionColor = vEmissionColor;
        ${remapShader}
        gl_FragColor = vec4(max(emissionColor, vec3(0.0)) * max(vEmissionStrength, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  material.userData.attributeEmissionContract = config;
  material.userData.attributeResolution = { color: "geometry-color", strength: "geometry-vector" };
  material.userData.colorRemaps = colorRemaps;
  return material;
}
