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
 * Workbench's neutral studio view. Flat diagnostic assets retain the original
 * cube-calibrated lobe fit. Smooth assets evaluate Blender 5.1's bundled
 * `studio.sl` directions, diffuse/specular colors, and wrapped-light formula.
 * This does not reproduce Workbench cavity/AO or screen-space shadows.
 */
export function makeWorkbenchApproximationMaterial(
  color: WorkbenchColor,
  smoothShading = false,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      workbenchColor: { value: new THREE.Color().setRGB(color[0], color[1], color[2]) },
    },
    vertexShader: `
      varying vec3 workbenchViewPosition;
      varying vec3 workbenchViewNormal;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        workbenchViewPosition = viewPosition.xyz;
        workbenchViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 workbenchColor;
      varying vec3 workbenchViewPosition;
      varying vec3 workbenchViewNormal;

      vec3 workbenchSrgbToLinear(vec3 color) {
        vec3 low = color / 12.92;
        vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
        return mix(low, high, step(vec3(0.04045), color));
      }

      float workbenchWrappedLighting(float normalLight, float wrap) {
        float denominator = (wrap + 1.0) * (wrap + 1.0);
        return clamp((normalLight + wrap) / denominator, 0.0, 1.0);
      }

      vec3 workbenchBrdfApprox(vec3 specularColor, float roughness, float normalView) {
        float fresnel = exp2(-8.35 * normalView) * (1.0 - roughness);
        return mix(specularColor, vec3(1.0), fresnel);
      }

      void workbenchStudioLight(
        vec3 direction,
        float wrap,
        vec3 diffuseColor,
        vec3 specularColor,
        float roughness,
        vec3 normal,
        vec3 incident,
        vec3 reflection,
        inout vec3 diffuseLight,
        inout vec3 specularLight
      ) {
        float normalLight = dot(direction, normal);
        diffuseLight += workbenchWrappedLighting(normalLight, wrap) * diffuseColor;

        float clampedNormalLight = clamp(normalLight, 0.0, 1.0);
        vec3 halfDirection = normalize(direction + incident);
        float specularAngle = clamp(dot(halfDirection, normal), 0.0, 1.0);
        float gloss = (1.0 - roughness) * (1.0 - wrap);
        float shininess = exp2(10.0 * gloss + 1.0);
        float directSpecular = pow(specularAngle, shininess)
          * clampedNormalLight
          * (shininess * 0.125 + 1.0);
        float environmentWrap = mix(wrap, 1.0, roughness);
        float environmentSpecular = workbenchWrappedLighting(dot(direction, reflection), environmentWrap);
        float combinedSpecular = mix(directSpecular, environmentSpecular, wrap * wrap);
        specularLight += combinedSpecular * specularColor;
      }

      vec3 workbenchStudioLighting(vec3 baseColor, vec3 normal, vec3 incident) {
        const float roughness = 0.4;
        vec3 diffuseLight = vec3(0.0);
        vec3 specularLight = vec3(0.0);
        vec3 reflection = -reflect(incident, normal);

        workbenchStudioLight(
          vec3(-0.854701, 0.111111, 0.507091),
          0.2,
          vec3(0.723042),
          vec3(0.685956),
          roughness,
          normal,
          incident,
          reflection,
          diffuseLight,
          specularLight
        );
        workbenchStudioLight(
          vec3(0.058607, -0.987943, -0.143295),
          0.719626,
          vec3(0.063100, 0.069978, 0.067951),
          vec3(0.145797, 0.162642, 0.157673),
          roughness,
          normal,
          incident,
          reflection,
          diffuseLight,
          specularLight
        );
        workbenchStudioLight(
          vec3(0.972202, 0.075846, -0.221518),
          0.28125,
          vec3(0.157432, 0.163405, 0.214035),
          vec3(0.246195, 0.225308, 0.225308),
          roughness,
          normal,
          incident,
          reflection,
          diffuseLight,
          specularLight
        );

        vec3 materialSpecular = vec3(0.05);
        float normalView = clamp(dot(normal, incident), 0.0, 1.0);
        materialSpecular = workbenchBrdfApprox(materialSpecular, roughness, normalView);
        float specularEnergy = dot(materialSpecular, vec3(0.33333));
        return diffuseLight * baseColor * (1.0 - specularEnergy)
          + specularLight * materialSpecular;
      }

      void main() {
        vec3 viewNormal = ${smoothShading
    ? "normalize(workbenchViewNormal)"
    : "normalize(cross(dFdx(workbenchViewPosition), dFdy(workbenchViewPosition)))"};
        if (!gl_FrontFacing) viewNormal = -viewNormal;
        ${smoothShading
    ? `vec3 incident = normalize(-workbenchViewPosition);
        vec3 displayLinear = workbenchStudioLighting(workbenchColor, viewNormal, incident);
        gl_FragColor = vec4(displayLinear, 1.0);`
    : `float screenRightLobe = smoothstep(0.05, 0.70, viewNormal.x);
        float referenceSrgb = mix(0.504, 0.227, screenRightLobe);
        vec3 tint = clamp(workbenchColor / 0.8, 0.0, 1.25);
        vec3 displaySrgb = clamp(vec3(referenceSrgb) * tint, 0.0, 1.0);
        gl_FragColor = vec4(workbenchSrgbToLinear(displaySrgb), 1.0);`}
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
    smoothShading,
    lightingModel: smoothShading ? "Blender 5.1 studio.sl" : "cube-calibrated lobes",
    roughness: smoothShading ? 0.4 : null,
    targetSrgbLuminance: { topAndLeft: 0.504, screenRight: 0.227 },
    label: "approximation",
  };
  return material;
}
