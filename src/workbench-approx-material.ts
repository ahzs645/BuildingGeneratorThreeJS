import * as THREE from "three";

export type WorkbenchColor = [number, number, number];

/**
 * Restrict the normalized Workbench look to catalog assets that genuinely have
 * no authored material. A catalog color must never replace an extracted shader.
 */
export function shouldUseWorkbenchApproximation(
  workbenchColor: WorkbenchColor | undefined,
  sourceMaterials: Array<string | null | undefined> | undefined,
  groupMaterial: string | null | undefined,
): workbenchColor is WorkbenchColor {
  return Boolean(
    workbenchColor
    && !groupMaterial
    && !(sourceMaterials ?? []).some((name) => Boolean(name)),
  );
}

/**
 * A deliberately narrow, scene-light-independent approximation of Blender
 * Workbench's neutral studio view. The reference cube's top and screen-left
 * lobes average about 0.504 sRGB while its screen-right lobe averages 0.227.
 * This does not reproduce Workbench cavity/AO.
 */
export function makeWorkbenchApproximationMaterial(color: WorkbenchColor): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      workbenchColor: { value: new THREE.Color().setRGB(color[0], color[1], color[2]) },
    },
    vertexShader: `
      varying vec3 workbenchViewPosition;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        workbenchViewPosition = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 workbenchColor;
      varying vec3 workbenchViewPosition;

      vec3 workbenchSrgbToLinear(vec3 color) {
        vec3 low = color / 12.92;
        vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
        return mix(low, high, step(vec3(0.04045), color));
      }

      void main() {
        vec3 viewNormal = normalize(cross(dFdx(workbenchViewPosition), dFdy(workbenchViewPosition)));
        if (!gl_FrontFacing) viewNormal = -viewNormal;
        float screenRightLobe = smoothstep(0.05, 0.70, viewNormal.x);
        float referenceSrgb = mix(0.504, 0.227, screenRightLobe);
        vec3 tint = clamp(workbenchColor / 0.8, 0.0, 1.25);
        vec3 displaySrgb = clamp(vec3(referenceSrgb) * tint, 0.0, 1.0);
        gl_FragColor = vec4(workbenchSrgbToLinear(displaySrgb), 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
  });
  material.toneMapped = false;
  material.name = "Blender Workbench studio approximation";
  material.userData.workbenchApproximation = {
    color: [...color],
    cavityParity: false,
    sceneLightIndependent: true,
    targetSrgbLuminance: { topAndLeft: 0.504, screenRight: 0.227 },
    label: "approximation",
  };
  return material;
}
