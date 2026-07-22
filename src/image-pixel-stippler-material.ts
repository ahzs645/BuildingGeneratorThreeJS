import * as THREE from "three";
import type { Dump, TriSoup } from "./gnvm";

type RawInput = { name: string; identifier: string; linked: boolean; value: unknown };
type RawNode = {
  name: string;
  type: string;
  inputs?: RawInput[];
  props?: Record<string, unknown>;
};
type RawMaterial = { nodes?: RawNode[]; links?: Array<{ from_node: string; from_socket: string; to_node: string; to_socket: string }> };

export type ImagePixelStipplerConfig = {
  imageAttribute: string;
  densityAttribute: string;
  randomnessAttribute: string;
  rotation: [number, number, number];
  scale: [number, number, number];
  thresholdMin: number;
  thresholdMax: number;
  clampThreshold: boolean;
};

const input = (node: RawNode, identifier: string): unknown =>
  node.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier)?.value;

const vector = (value: unknown, fallback: [number, number, number]): [number, number, number] => {
  if (!Array.isArray(value)) return fallback;
  return [Number(value[0] ?? fallback[0]), Number(value[1] ?? fallback[1]), Number(value[2] ?? fallback[2])];
};

/**
 * Read the authored Image Pixel Stippler material contract from an extracted
 * Blender shader tree. Returning null is intentional: callers can retain the
 * neutral topology-diagnostic material when the required graph truth is not
 * present instead of silently guessing a different shader.
 */
export function extractImagePixelStipplerConfig(dump: Dump, materialName: string): ImagePixelStipplerConfig | null {
  const tree = (dump.materials?.[materialName] as RawMaterial | undefined);
  const nodes = tree?.nodes ?? [];
  const mapping = nodes.find((node) => node.type === "ShaderNodeMapping");
  const mapRange = nodes.find((node) => node.type === "ShaderNodeMapRange");
  const voronoi = nodes.find((node) => node.type === "ShaderNodeTexVoronoi");
  const maths = nodes.filter((node) => node.type === "ShaderNodeMath");
  const attributes = nodes.filter((node) => node.type === "ShaderNodeAttribute");
  const props = attributes.map((node) => String(node.props?.attribute_name ?? ""));
  const requiredLinks = [
    ["Texture Coordinate", "Generated", "Mapping.001", "Vector"],
    ["Mapping.001", "Vector", "Voronoi Texture", "Vector"],
    ["Attribute", "Color", "Map Range.001", "Value"],
    ["Attribute.001", "Fac", "Voronoi Texture", "Scale"],
    ["Attribute.002", "Fac", "Voronoi Texture", "Randomness"],
  ];
  const hasLink = (wanted: string[]) => tree?.links?.some((link) =>
    link.from_node === wanted[0] && link.from_socket === wanted[1]
    && link.to_node === wanted[2] && link.to_socket === wanted[3]);
  if (!mapping || !mapRange || !voronoi || maths.length !== 2 || !requiredLinks.every(hasLink)) return null;
  if (voronoi.props?.voronoi_dimensions !== "3D" || voronoi.props?.feature !== "F1" || voronoi.props?.distance !== "EUCLIDEAN") return null;
  if (maths.some((node) => node.props?.operation !== "GREATER_THAN")) return null;
  if (!props.includes("img") || !props.includes("dens") || !props.includes("grid")) return null;
  return {
    imageAttribute: String(attributes.find((node) => node.name === "Attribute")?.props?.attribute_name),
    densityAttribute: String(attributes.find((node) => node.name === "Attribute.001")?.props?.attribute_name),
    randomnessAttribute: String(attributes.find((node) => node.name === "Attribute.002")?.props?.attribute_name),
    rotation: vector(input(mapping, "Rotation"), [0, 0, 0]),
    scale: vector(input(mapping, "Scale"), [1, 1, 1]),
    thresholdMin: Number(input(mapRange, "To Min") ?? 0),
    thresholdMax: Number(input(mapRange, "To Max") ?? 1),
    clampThreshold: mapRange.props?.clamp === true,
  };
}

const vertexShader = /* glsl */`
  attribute vec3 img;
  attribute float dens;
  attribute float grid;
  uniform vec3 generatedMin;
  uniform vec3 generatedSize;
  varying vec3 vGenerated;
  varying vec3 vImage;
  varying float vDensity;
  varying float vRandomness;
  void main() {
    vec3 safeSize = max(generatedSize, vec3(1e-8));
    vGenerated = (position - generatedMin) / safeSize;
    // Blender centers Generated coordinates on a degenerate texspace axis.
    // This matters for planar meshes feeding 3D procedural textures: using
    // zero here selects a completely different Voronoi lattice slice.
    if (generatedSize.x < 1e-8) vGenerated.x = 0.5;
    if (generatedSize.y < 1e-8) vGenerated.y = 0.5;
    if (generatedSize.z < 1e-8) vGenerated.z = 0.5;
    vImage = img;
    vDensity = dens;
    vRandomness = grid;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const stippleFragmentShader = /* glsl */`
  uniform vec3 mappingRotation;
  uniform vec3 mappingScale;
  uniform float thresholdMin;
  uniform float thresholdMax;
  uniform float clampThreshold;
  uniform float debugMode;
  varying vec3 vGenerated;
  varying vec3 vImage;
  varying float vDensity;
  varying float vRandomness;
  out vec4 fragColor;

  // Exact signed PCG3D integer hash used by Blender's GPU shader. The signed
  // right shift is significant for negative lanes; converting to uint would
  // turn it into a logical shift and select different feature points.
  vec3 hash3(vec3 cell) {
    ivec3 v = ivec3(cell);
    v = v * 1664525 + 1013904223;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> 16);
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v & ivec3(0x7fffffff);
    return vec3(v) / 2147483647.0;
  }

  vec3 rotateXYZ(vec3 p, vec3 r) {
    vec3 c = cos(r), s = sin(r);
    p = vec3(p.x, c.x * p.y - s.x * p.z, s.x * p.y + c.x * p.z);
    p = vec3(c.y * p.x + s.y * p.z, p.y, -s.y * p.x + c.y * p.z);
    return vec3(c.z * p.x - s.z * p.y, s.z * p.x + c.z * p.y, p.z);
  }

  float voronoiF1(vec3 p, float randomness) {
    vec3 base = floor(p);
    vec3 local = fract(p);
    float nearest = 2.0;
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 cell = vec3(float(x), float(y), float(z));
          // Blender scales the hashed point offset from the cell corner; zero
          // randomness therefore lands on the corner, not the cell center.
          vec3 point = cell + hash3(base + cell) * clamp(randomness, 0.0, 1.0);
          nearest = min(nearest, length(point - local));
        }
      }
    }
    return nearest;
  }

  float authoredMask(vec3 mapped, float density, float randomness, float threshold) {
    float distanceToFeature = voronoiF1(mapped * max(density, 0.0), randomness);
    float firstGreaterThan = distanceToFeature > threshold ? 1.0 : 0.0;
    return firstGreaterThan > threshold ? 1.0 : 0.0;
  }

  void main() {
    vec3 mapped = rotateXYZ(vGenerated * mappingScale, mappingRotation);
    // Blender converts Color to Value before Map Range. Rec.709 luminance is
    // used here as an independently authored WebGL equivalent.
    float imageValue = dot(vImage, vec3(0.2126, 0.7152, 0.0722));
    float source = clampThreshold > 0.5 ? clamp(imageValue, 0.0, 1.0) : imageValue;
    float threshold = mix(thresholdMin, thresholdMax, source);
    if (debugMode > 0.5 && debugMode < 1.5) {
      fragColor = vec4(vGenerated, 1.0);
      return;
    }
    if (debugMode > 1.5 && debugMode < 2.5) {
      fragColor = vec4(vec3(threshold), 1.0);
      return;
    }
    if (debugMode > 2.5) {
      float distanceToFeature = voronoiF1(mapped * max(vDensity, 0.0), vRandomness);
      fragColor = vec4(vec3(distanceToFeature), 1.0);
      return;
    }
    // Evaluate the authored binary node graph once at this raster sample.
    // Blender's Eevee renderer filters complete jittered frames, so the
    // controlled comparison route performs that full-frame accumulation
    // outside this shader instead of smoothing the procedural node inputs.
    float mask = authoredMask(mapped, vDensity, vRandomness, threshold);
    fragColor = vec4(vec3(mask), 1.0);
  }
`;

const imageFragmentShader = /* glsl */`
  varying vec3 vImage;
  out vec4 fragColor;
  void main() { fragColor = vec4(max(vImage, vec3(0.0)), 1.0); }
`;

/**
 * Three.js normally interpolates indexed vertex attributes. Blender keeps a
 * FACE-domain color constant across every triangle corner, so retain that
 * domain by expanding the render geometry and stamping each emitted corner
 * from the source face recorded by toTriSoup().
 */
export function expandFaceDomainMaterialAttributes(
  geometry: THREE.BufferGeometry,
  soup: TriSoup,
): THREE.BufferGeometry {
  const triangleFaces = soup.triangleFaces;
  const faceAttributes = Object.entries(soup.attributes).filter(([, attribute]) =>
    attribute.domain === "FACE" && attribute.domainData);
  if (!geometry.index || !triangleFaces || !faceAttributes.length) return geometry;
  const expanded = geometry.toNonIndexed();
  const cornerCount = soup.indices.length;
  for (const [name, attribute] of faceAttributes) {
    const source = attribute.domainData!;
    const data = new Float32Array(cornerCount * attribute.itemSize);
    for (let corner = 0; corner < cornerCount; corner++) {
      const face = triangleFaces[Math.floor(corner / 3)] ?? 0;
      for (let component = 0; component < attribute.itemSize; component++) {
        data[corner * attribute.itemSize + component] = source[face * attribute.itemSize + component] ?? 0;
      }
    }
    expanded.setAttribute(name, new THREE.BufferAttribute(data, attribute.itemSize));
  }
  return expanded;
}

export function makeImagePixelStipplerMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
  debugMode = 0,
): THREE.ShaderMaterial | null {
  if (!["img", "dens", "grid"].every((name) => geometry.hasAttribute(name))) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const generatedMin = bounds.min.clone();
  const generatedSize = bounds.getSize(new THREE.Vector3());
  if (materialName === "img") {
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: imageFragmentShader,
      glslVersion: THREE.GLSL3,
      uniforms: { generatedMin: { value: generatedMin }, generatedSize: { value: generatedSize } },
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }
  const config = extractImagePixelStipplerConfig(dump, materialName);
  if (!config) return null;
  return new THREE.ShaderMaterial({
    name: "Image Pixel Stippler · WebGL reconstruction",
    vertexShader,
    fragmentShader: stippleFragmentShader,
    glslVersion: THREE.GLSL3,
    uniforms: {
      generatedMin: { value: generatedMin },
      generatedSize: { value: generatedSize },
      mappingRotation: { value: new THREE.Vector3(...config.rotation) },
      mappingScale: { value: new THREE.Vector3(...config.scale) },
      thresholdMin: { value: config.thresholdMin },
      thresholdMax: { value: config.thresholdMax },
      clampThreshold: { value: config.clampThreshold ? 1 : 0 },
      debugMode: { value: debugMode },
    },
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
