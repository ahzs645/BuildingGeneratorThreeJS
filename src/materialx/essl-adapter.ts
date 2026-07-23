import * as THREE from "three";

export const MATERIALX_COORDINATE_ROTATION_Y = Math.PI / 2;
export const MATERIALX_DIRECTION_TRANSFORM = new THREE.Matrix4().makeRotationY(MATERIALX_COORDINATE_ROTATION_Y);

type ManifestPort = {
  name: string;
  type: string;
  value: unknown;
};

export type ShaderRecord = {
  vertex: string;
  fragment: string;
  vertexInterface: { inputs: Record<string, ManifestPort[]> };
  fragmentInterface: { uniforms: Record<string, ManifestPort[]> };
  geometryBindings?: {
    generatedCoordinates?: {
      space: "object";
      boundsMinUniforms: string[];
      boundsMaxUniforms: string[];
    };
    properties?: Array<{
      name: string;
      type: string;
      attribute: string;
      default?: string;
      required: boolean;
    }>;
  };
};

export type EsslManifest = {
  generator: {
    materialx: string;
    specularEnvironment: "FIS";
    radianceSamples: number;
    maxLights: number;
    lightTypeId: number;
  };
  licenses: { materialx: string; thirdPartyNotices: string };
  shaders: Record<string, ShaderRecord>;
};

export type MaterialXLight = {
  type: number;
  direction: THREE.Vector3;
  color: THREE.Vector3;
  intensity: number;
};

export type BlenderSceneContract = {
  schemaVersion: number;
  camera: {
    matrixWorldRows: number[][];
    verticalFovDegrees: number;
  };
  lights: Array<{
    name: string;
    matrixWorldRows: number[][];
    propagationDirection: number[];
    toLightDirection: number[];
    color: number[];
    intensity: number;
    angleDegrees: number;
  }>;
  probe: MaterialXGeometryContract;
};

export type MaterialXGeometryContract = {
  bounds: { space: "object"; min: number[]; max: number[] };
  geometryProperties: Array<{ name: string; type: string; domain: "point" }>;
};

export function materialXDirection(
  direction: THREE.Vector3,
  transform: THREE.Matrix4 = MATERIALX_DIRECTION_TRANSFORM,
): THREE.Vector3 {
  return direction.clone().transformDirection(transform);
}

export function materialXDirectionalLight(
  light: THREE.DirectionalLight,
  type = 1,
  transform: THREE.Matrix4 = MATERIALX_DIRECTION_TRANSFORM,
): MaterialXLight {
  light.updateWorldMatrix(true, false);
  light.target.updateWorldMatrix(true, false);
  const direction = light.target.getWorldPosition(new THREE.Vector3())
    .sub(light.getWorldPosition(new THREE.Vector3()))
    .normalize();
  return {
    type,
    direction: materialXDirection(direction, transform),
    color: new THREE.Vector3(light.color.r, light.color.g, light.color.b),
    intensity: light.intensity,
  };
}

export function materialXLightFromBlenderContract(
  light: BlenderSceneContract["lights"][number],
  type = 1,
): MaterialXLight {
  return {
    type,
    // MaterialX LightData stores the direction that rays propagate. The
    // generated directional-light node negates it to obtain surface-to-light L.
    direction: new THREE.Vector3().fromArray(light.propagationDirection),
    color: new THREE.Vector3().fromArray(light.color),
    intensity: light.intensity,
  };
}

export function matrixFromRows(rows: number[][]): THREE.Matrix4 {
  if (rows.length !== 4 || rows.some((row) => row.length !== 4)) {
    throw new Error("Blender scene contract matrix must contain four rows of four values");
  }
  return new THREE.Matrix4().set(...rows.flat() as [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
  ]);
}

export function prepareMaterialXRadiance(source: THREE.DataTexture, maxAnisotropy: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    source.image.data,
    source.image.width,
    source.image.height,
    source.format as THREE.PixelFormat,
    source.type,
  );
  texture.name = "MaterialX FIS radiance";
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = maxAnisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export function prepareMaterialXIrradiance(source: THREE.DataTexture): THREE.DataTexture {
  source.name = "MaterialX SH irradiance";
  source.colorSpace = THREE.NoColorSpace;
  source.wrapS = THREE.RepeatWrapping;
  source.wrapT = THREE.ClampToEdgeWrapping;
  source.minFilter = THREE.LinearFilter;
  source.magFilter = THREE.LinearFilter;
  source.generateMipmaps = false;
  source.needsUpdate = true;
  return source;
}

function uniformValue(port: ManifestPort): unknown {
  if (port.value === null) {
    if (port.type === "boolean") return false;
    if (port.type === "vector2") return new THREE.Vector2();
    if (port.type === "vector3" || port.type === "color3") return new THREE.Vector3();
    if (port.type === "vector4" || port.type === "color4") return new THREE.Vector4();
    return 0;
  }
  if (port.type === "vector2" && Array.isArray(port.value)) return new THREE.Vector2().fromArray(port.value as number[]);
  if ((port.type === "vector3" || port.type === "color3") && Array.isArray(port.value)) {
    return new THREE.Vector3().fromArray(port.value as number[]);
  }
  if ((port.type === "vector4" || port.type === "color4") && Array.isArray(port.value)) {
    return new THREE.Vector4().fromArray(port.value as number[]);
  }
  return port.value;
}

function generatedUniforms(shader: ShaderRecord): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const block of Object.values(shader.fragmentInterface.uniforms)) {
    for (const port of block) {
      if (port.type === "surfaceshader" || port.type === "displacementshader" || port.type === "filename") continue;
      // LightData describes a struct layout; its values are uploaded through u_lightData.
      if (["type", "direction", "color", "intensity"].includes(port.name)) continue;
      uniforms[port.name] = { value: uniformValue(port) };
    }
  }
  return uniforms;
}

const GEOMETRY_PROPERTY_ITEM_SIZES: Record<string, number> = {
  boolean: 1,
  integer: 1,
  float: 1,
  vector2: 2,
  vector3: 3,
  color3: 3,
  vector4: 4,
  color4: 4,
};

/** Bind manifest-declared geometry semantics without material-name matching. */
export function bindMaterialXGeometry(
  geometry: THREE.BufferGeometry,
  shader: ShaderRecord,
  contract: MaterialXGeometryContract,
  uniforms: Record<string, THREE.IUniform>,
): void {
  const baseAttributes: Record<string, string> = {
    i_position: "position",
    i_normal: "normal",
    i_tangent: "tangent",
    i_texcoord_0: "uv",
  };
  for (const block of Object.values(shader.vertexInterface.inputs)) {
    for (const port of block) {
      const sourceName = baseAttributes[port.name];
      if (!sourceName) continue;
      const attribute = geometry.getAttribute(sourceName);
      if (!attribute) throw new Error(`MaterialX shader requires geometry attribute ${sourceName}`);
      geometry.setAttribute(port.name, attribute);
    }
  }
  const generated = shader.geometryBindings?.generatedCoordinates;
  if (generated) {
    if (generated.space !== "object" || contract.bounds.space !== "object") {
      throw new Error("MaterialX Generated coordinates require object-space exported bounds");
    }
    if (contract.bounds.min.length !== 3 || contract.bounds.max.length !== 3
      || ![...contract.bounds.min, ...contract.bounds.max].every(Number.isFinite)) {
      throw new Error("MaterialX Generated-coordinate bounds must be finite vector3 values");
    }
    const minimum = new THREE.Vector3().fromArray(contract.bounds.min);
    const maximum = new THREE.Vector3().fromArray(contract.bounds.max);
    for (const name of generated.boundsMinUniforms) {
      if (!uniforms[name]) throw new Error(`Generated-coordinate minimum uniform ${name} is missing`);
      uniforms[name].value = minimum.clone();
    }
    for (const name of generated.boundsMaxUniforms) {
      if (!uniforms[name]) throw new Error(`Generated-coordinate maximum uniform ${name} is missing`);
      uniforms[name].value = maximum.clone();
    }
  }
  for (const property of shader.geometryBindings?.properties ?? []) {
    const declaration = contract.geometryProperties.find((candidate) => candidate.name === property.name);
    if (!declaration || declaration.type !== property.type || declaration.domain !== "point") {
      throw new Error(`MaterialX geometry property ${property.name}:${property.type} is absent from the scene contract`);
    }
    const attribute = geometry.getAttribute(property.name);
    const expectedSize = GEOMETRY_PROPERTY_ITEM_SIZES[property.type];
    if (!attribute || !expectedSize || attribute.itemSize !== expectedSize) {
      throw new Error(`MaterialX geometry property ${property.name}:${property.type} requires itemSize ${expectedSize ?? "unknown"}`);
    }
    geometry.setAttribute(property.attribute, attribute);
  }
}

function stripVersion(source: string): string {
  return source.replace(/^#version 300 es\s*/, "");
}

export async function createMaterialXEsslMaterial(options: {
  baseUrl: string;
  manifest: EsslManifest;
  shaderName: string;
  radiance: THREE.DataTexture;
  irradiance: THREE.DataTexture;
  lights: MaterialXLight[];
  environmentIntensity: number;
  geometry: THREE.BufferGeometry;
  geometryContract: MaterialXGeometryContract;
}): Promise<THREE.RawShaderMaterial> {
  const shader = options.manifest.shaders[options.shaderName];
  if (!shader) throw new Error(`Generated MaterialX shader is missing ${options.shaderName}`);
  const [vertexShader, fragmentShader] = await Promise.all([
    fetch(`${options.baseUrl}/${shader.vertex}`).then((response) => {
      if (!response.ok) throw new Error(`MaterialX vertex shader fetch failed: ${response.status}`);
      return response.text();
    }),
    fetch(`${options.baseUrl}/${shader.fragment}`).then((response) => {
      if (!response.ok) throw new Error(`MaterialX fragment shader fetch failed: ${response.status}`);
      return response.text();
    }),
  ]);
  const uniforms = generatedUniforms(shader);
  bindMaterialXGeometry(options.geometry, shader, options.geometryContract, uniforms);
  Object.assign(uniforms, {
    u_worldMatrix: { value: new THREE.Matrix4() },
    u_viewProjectionMatrix: { value: new THREE.Matrix4() },
    u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
    u_viewPosition: { value: new THREE.Vector3() },
    u_envMatrix: { value: MATERIALX_DIRECTION_TRANSFORM.clone() },
    u_envRadiance: { value: options.radiance },
    u_envRadianceMips: { value: Math.trunc(Math.log2(Math.max(options.radiance.image.width, options.radiance.image.height))) + 1 },
    u_envRadianceSamples: { value: options.manifest.generator.radianceSamples },
    u_envIrradiance: { value: options.irradiance },
    u_envLightIntensity: { value: options.environmentIntensity },
    u_refractionTwoSided: { value: false },
    u_numActiveLightSources: { value: Math.min(options.lights.length, options.manifest.generator.maxLights) },
    u_lightData: { value: options.lights.slice(0, options.manifest.generator.maxLights) },
  });
  const material = new THREE.RawShaderMaterial({
    name: `${options.shaderName} · official MaterialX ESSL/FIS`,
    vertexShader: stripVersion(vertexShader),
    fragmentShader: stripVersion(fragmentShader),
    glslVersion: THREE.GLSL3,
    uniforms,
    toneMapped: false,
  });
  material.userData.materialBackend = "materialx";
  material.userData.materialXImplementation = "official-essl-fis";
  material.onBeforeRender = (_renderer, _scene, camera, _geometry, object) => {
    const perspective = camera as THREE.PerspectiveCamera;
    uniforms.u_worldMatrix.value.copy(object.matrixWorld);
    uniforms.u_viewProjectionMatrix.value.multiplyMatrices(perspective.projectionMatrix, perspective.matrixWorldInverse);
    uniforms.u_worldInverseTransposeMatrix.value.copy(object.matrixWorld).invert().transpose();
    uniforms.u_viewPosition.value.setFromMatrixPosition(camera.matrixWorld);
  };
  return material;
}

export function addMaterialXAttributeAliases(geometry: THREE.BufferGeometry): void {
  for (const [alias, source] of [
    ["i_position", "position"],
    ["i_normal", "normal"],
    ["i_tangent", "tangent"],
    ["i_texcoord_0", "uv"],
  ]) {
    const attribute = geometry.getAttribute(source);
    if (attribute) geometry.setAttribute(alias, attribute);
  }
}

export function createCoordinateDiagnosticMaterial(
  radiance: THREE.DataTexture,
  lights: MaterialXLight[],
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    name: "MaterialX environment/light cardinal diagnostic",
    glslVersion: THREE.GLSL3,
    toneMapped: false,
    uniforms: {
      u_envRadiance: { value: radiance },
      u_envMatrix: { value: MATERIALX_DIRECTION_TRANSFORM.clone() },
      u_lightData: { value: lights },
    },
    vertexShader: `
      in vec3 position;
      out vec2 screenUv;
      void main() {
        screenUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      struct LightData { int type; vec3 direction; vec3 color; float intensity; };
      uniform sampler2D u_envRadiance;
      uniform mat4 u_envMatrix;
      uniform LightData u_lightData[3];
      in vec2 screenUv;
      out vec4 outColor;
      const float PI = 3.141592653589793;
      vec2 latlong(vec3 inputDirection) {
        vec3 direction = normalize((u_envMatrix * vec4(inputDirection, 0.0)).xyz);
        return vec2(atan(direction.x, -direction.z) / (2.0 * PI) + 0.5, -asin(direction.y) / PI + 0.5);
      }
      vec3 cardinal(int index) {
        if (index == 0) return vec3(1.0, 0.0, 0.0);
        if (index == 1) return vec3(0.0, 0.0, 1.0);
        if (index == 2) return vec3(-1.0, 0.0, 0.0);
        return vec3(0.0, 0.0, -1.0);
      }
      void main() {
        int column = min(int(screenUv.x * 4.0), 3);
        vec3 direction = cardinal(column);
        vec3 color;
        if (screenUv.y >= 0.5) {
          color = texture(u_envRadiance, latlong(direction)).rgb * 0.18;
        } else {
          color = vec3(0.0);
          for (int index = 0; index < 3; index++) {
            color += u_lightData[index].color * u_lightData[index].intensity * max(dot(direction, -u_lightData[index].direction), 0.0) * 0.14;
          }
        }
        float grid = step(0.012, min(fract(screenUv.x * 4.0), 1.0 - fract(screenUv.x * 4.0))) * step(0.012, abs(screenUv.y - 0.5));
        outColor = vec4(pow(max(color, vec3(0.0)), vec3(1.0 / 2.2)) * grid, 1.0);
      }
    `,
  });
}
