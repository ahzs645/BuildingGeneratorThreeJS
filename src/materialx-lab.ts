import * as THREE from "three";
import { WebGPURenderer, type MeshPhysicalNodeMaterial } from "three/webgpu";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { MaterialXLoader } from "three/addons/loaders/MaterialXLoader.js";
import { publicUrl } from "./base-url";
import { resolveMaterialBackend, type MaterialBackend } from "./material-backend";
import { auditMaterialXDocument } from "./materialx/capabilities";
import { createMaterialXPrefilteredEnvironment } from "./materialx/environment-prefilter";
import { loadMaterialXTextures } from "./materialx/essl-bundle";
import { applyProceduralHeightNormals } from "./materialx/procedural-height";
import {
  type BlenderSceneContract,
  createCoordinateDiagnosticMaterial,
  createMaterialXEsslMaterial,
  materialXLightFromBlenderContract,
  matrixFromRows,
  prepareMaterialXIrradiance,
  prepareMaterialXRadiance,
  type EsslManifest,
} from "./materialx/essl-adapter";
import { makeProbeGeometry } from "./materialx/probe-geometry";

type Variant = "source" | "bump";
type LabMaterial = THREE.Material & { userData: Record<string, unknown> };
type MetalPresetProbeIndex = {
  schemaVersion: number;
  probeContract: {
    blenderPerceptualRoughness: number;
    materialxMicrofacetAlpha: number;
    roughnessMapping: string;
  };
  f82Probe: {
    id: string;
    label: string;
    shader: string;
    baseColor: number[];
    edgeTint: number[];
    color90: number[];
    exponent: number;
  };
  anisotropyProbe: {
    baseProbe: string;
    shaderRotation0: string;
    shaderRotationQuarterTurn: string;
    blenderPerceptualRoughness: number;
    blenderAnisotropy: number;
    blenderRotationQuarterTurns: number[];
    mapping: {
      aspect: number;
      alphaX: number;
      alphaY: number;
      formula: string;
    };
  };
  thinFilmProbe: {
    baseProbe: string;
    shader: string;
    anodizationVoltage: number;
    nanometersPerVolt: number;
    thinFilmThicknessNanometers: number;
    thinFilmIor: number;
    mapping: string;
  };
  layeredRoughnessProbe: {
    baseProbe: string;
    shader: string;
    blenderPerceptualRoughness: number;
    layeredRoughnessFactor: number;
    layers: Array<{ roughnessScale: number; microfacetAlpha: number }>;
    mixFactors: number[];
    effectiveWeights: number[];
    mapping: string;
  };
  roughnessFresnelProbe: {
    baseProbe: string;
    scalarShader: string;
    beautyShader: string;
    sourceGroup: string;
    layerWeightBlend: number;
    frontFaceEta: number;
    blenderPerceptualRoughness: number;
    lut: {
      report: string;
      image: string;
      samples: number;
      sha256: string;
      coordinate: string;
    };
    mapping: string;
  };
  brushedRoughnessProbe: {
    scalarShader: string;
    beautyShader: string;
    blenderPerceptualRoughness: number;
    roughnessFresnelFactor: number;
    anisotropy: number;
    brushedMetalFactor: number;
    vectorLength: number;
    mappingScale: number[];
    mappingRotation: number[];
    noise: {
      dimensions: number;
      normalized: boolean;
      scale: number;
      detail: number;
      octaves: number;
      roughness: number;
      lacunarity: number;
      distortion: number;
    };
    mapRange: {
      fromMin: number;
      fromMax: number;
      toMin: number;
      toMax: number;
      clamp: boolean;
    };
    semanticAdapter: string;
  };
  thinFilmStreakProbe: {
    scalarShader: string;
    beautyShader: string;
    activeSourceResultNanometers: number;
    activeSourceReason: string;
    diagnosticOverride: string;
    thinFilmIor: number;
    thicknessScaleNanometers: number;
    thinFilmNoise: {
      dimensions: number;
      normalized: boolean;
      scale: number;
      detail: number;
      octaves: number;
      roughness: number;
      lacunarity: number;
      distortion: number;
    };
    rampLut: {
      report: string;
      image: string;
      samples: number;
      sha256: string;
      coordinate: string;
    };
    semanticAdapters: string[];
  };
  activeGoldNonImageCore: {
    baseProbe: string;
    scalarShader: string;
    beautyShader: string;
    sourceGroup: string;
    sourceMaterial: string;
    sourceObject: string;
    renderingType: string;
    ior: number[];
    extinction: number[];
    blenderPerceptualRoughness: number;
    roughnessFresnelFactor: number;
    brushedMetalFactor: number;
    layeredRoughnessFactor: number;
    anisotropy: number;
    anisotropicRotation: number;
    thinFilmThicknessNanometers: number;
    thinFilmIor: number;
    layerScales: number[];
    mixFactors: number[];
    effectiveWeights: number[];
    semanticAdapters: string[];
    omittedActiveScratchMaps: Array<{
      role: string;
      imageNode: string;
      filename: string;
      factorSocket: string;
      factor: number;
      vectorSocket: string;
      coordinate: string;
      mappingScale: number[];
      mappingRotation: number[];
      width: number;
      height: number;
      bytes: number;
      sourceColorSpace: string;
      sha256: string;
      omissionReason: string;
    }>;
    mapping: string;
    scope: string;
  };
  presets: Array<{
    id: string;
    label: string;
    shader: string;
    ior: number[];
    extinction: number[];
  }>;
};

export interface MaterialXLabOptions {
  search?: string;
}

export type MaterialXLabDisposer = () => void;

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`MaterialX lab DOM is missing ${selector}`);
  return element;
}

export function mountMaterialXLab(root: ParentNode, options: MaterialXLabOptions = {}): MaterialXLabDisposer {
  const canvas = required<HTMLCanvasElement>(root, "#materialx-canvas");
  const backendSelect = required<HTMLSelectElement>(root, "#materialx-backend");
  const variantSelect = required<HTMLSelectElement>(root, "#materialx-variant");
  const status = required<HTMLElement>(root, "#materialx-status");
  const rendererStatus = required<HTMLElement>(root, "#materialx-renderer");
  const graphStatus = required<HTMLElement>(root, "#materialx-graph");
  const fallbackStatus = required<HTMLElement>(root, "#materialx-fallback");
  const sourceFinding = required<HTMLElement>(root, "#materialx-source-finding");

  const query = new URLSearchParams(options.search ?? location.search);
  const capture = query.get("capture") === "1";
  const requestedDiagnostic = query.get("diagnostic");
  const metalPresetDiagnostic = requestedDiagnostic === "metal-preset";
  const metalF82Diagnostic = requestedDiagnostic === "metal-f82";
  const metalAnisotropyDiagnostic = requestedDiagnostic === "metal-anisotropy";
  const metalThinFilmDiagnostic = requestedDiagnostic === "metal-thin-film";
  const metalLayeredRoughnessDiagnostic = requestedDiagnostic === "metal-layered-roughness";
  const metalRoughnessFresnelScalarDiagnostic = requestedDiagnostic === "metal-roughness-fresnel-scalar";
  const metalRoughnessFresnelDiagnostic = requestedDiagnostic === "metal-roughness-fresnel";
  const metalBrushedRoughnessScalarDiagnostic = requestedDiagnostic === "metal-brushed-roughness-scalar";
  const metalBrushedRoughnessDiagnostic = requestedDiagnostic === "metal-brushed-roughness";
  const metalThinFilmStreakScalarDiagnostic = requestedDiagnostic === "metal-thin-film-streak-scalar";
  const metalThinFilmStreakDiagnostic = requestedDiagnostic === "metal-thin-film-streak";
  const metalActiveNonImageScalarDiagnostic = requestedDiagnostic === "metal-active-gold-core-scalar";
  const metalActiveNonImageDiagnostic = requestedDiagnostic === "metal-active-gold-core";
  const metalProbeDiagnostic = metalPresetDiagnostic
    || metalF82Diagnostic
    || metalAnisotropyDiagnostic
    || metalThinFilmDiagnostic
    || metalLayeredRoughnessDiagnostic
    || metalRoughnessFresnelScalarDiagnostic
    || metalRoughnessFresnelDiagnostic
    || metalBrushedRoughnessScalarDiagnostic
    || metalBrushedRoughnessDiagnostic
    || metalThinFilmStreakScalarDiagnostic
    || metalThinFilmStreakDiagnostic
    || metalActiveNonImageScalarDiagnostic
    || metalActiveNonImageDiagnostic;
  if (metalThinFilmStreakScalarDiagnostic || metalThinFilmStreakDiagnostic) {
    sourceFinding.textContent = "Material.011 leaves Gold Socket_27 unlinked, so the supplied active material evaluates this branch to exactly 0 nm. This diagnostic explicitly binds that socket to Generated coordinates to exercise the otherwise-zero procedural streak.";
  } else if (metalActiveNonImageScalarDiagnostic || metalActiveNonImageDiagnostic) {
    sourceFinding.textContent = "Material.011 actively uses the Physical Conductor Gold core, but its packed dense and sparse scratch images are not redistributed. This diagnostic preserves the active non-image roughness-Fresnel, brushed, layered-roughness, and zero-thin-film semantics; it is not the complete saved material.";
  } else if (metalProbeDiagnostic) {
    sourceFinding.textContent = "Metallic_BSDF+.blend is used only as a local Blender oracle. This page reconstructs an isolated, rights-safe material branch and does not claim parity for the complete source add-on graph or its unlicensed texture assets.";
  }
  const dependencyImplementation = import.meta.env.VITE_MATERIALX_THREE_IMPLEMENTATION || "r185";
  const environmentMode = metalProbeDiagnostic || query.get("environment") === "prefilter"
    ? "prefilter"
    : "fis";
  const implementation = query.get("implementation") === "tsl" || dependencyImplementation !== "r185"
    ? dependencyImplementation
    : `official-essl-${environmentMode}`;
  const officialEssl = implementation.startsWith("official-essl-");
  const coordinateDiagnostic = requestedDiagnostic === "coordinates";
  const geompropColorDiagnostic = requestedDiagnostic === "geomprop-col";
  const uiNormalBandDiagnostic = requestedDiagnostic === "ui-normal-band";
  const lightDiagnostic = requestedDiagnostic?.match(/^light-(key|fill|rim)$/)?.[1] ?? null;
  const threeLightDiagnostic = requestedDiagnostic?.match(/^three-light-(key|fill|rim)$/)?.[1] ?? null;
  const roughnessDiagnostic = requestedDiagnostic === "roughness-sweep";
  const requestedMetalPreset = query.get("preset") ?? "aluminum";
  const requestedMetalRotation = Number(query.get("rotation") ?? "0");
  const requestedThinFilmThickness = Number(query.get("thickness") ?? "243");
  if (metalAnisotropyDiagnostic && ![0, 0.25].includes(requestedMetalRotation)) {
    throw new Error(`MaterialX anisotropy diagnostic supports rotation 0 or 0.25; received ${query.get("rotation")}`);
  }
  if (
    metalThinFilmDiagnostic
    && (!Number.isFinite(requestedThinFilmThickness)
      || requestedThinFilmThickness < 0
      || requestedThinFilmThickness > 10_000)
  ) {
    throw new Error(`MaterialX thin-film diagnostic requires 0–10000 nm; received ${query.get("thickness")}`);
  }
  const requestedRoughness = Number(query.get("roughness") ?? "0.32");
  if (roughnessDiagnostic && (!Number.isFinite(requestedRoughness) || requestedRoughness < 0 || requestedRoughness > 1)) {
    throw new Error(`MaterialX roughness diagnostic requires a finite value from 0 to 1; received ${query.get("roughness")}`);
  }
  const requestedVariant = query.get("variant");
  if (requestedVariant === "source" || requestedVariant === "bump") variantSelect.value = requestedVariant;
  const requestedBackend = query.get("backend") as MaterialBackend | null;
  if (requestedBackend && [...backendSelect.options].some((option) => option.value === requestedBackend)) backendSelect.value = requestedBackend;

  let active = true;
  const ownedMaterials = new Set<THREE.Material>();
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedTextures = new Set<THREE.Texture>();
  const abortController = new AbortController();
  const ownerDocument = canvas.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const previousDataset = {
    ready: ownerDocument.documentElement.dataset.materialxReady,
    backend: ownerDocument.documentElement.dataset.materialBackend,
    implementation: ownerDocument.documentElement.dataset.materialxImplementation,
    roughness: ownerDocument.documentElement.dataset.materialxRoughness,
    preset: ownerDocument.documentElement.dataset.materialxPreset,
    rotation: ownerDocument.documentElement.dataset.materialxRotation,
    thinFilm: ownerDocument.documentElement.dataset.materialxThinFilm,
  };

  function ownMaterial<T extends THREE.Material>(material: T): T {
    if (active) ownedMaterials.add(material);
    else material.dispose();
    return material;
  }

  function ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    if (active) ownedGeometries.add(geometry);
    else geometry.dispose();
    return geometry;
  }

  function ownTexture<T extends THREE.Texture>(texture: T): T {
    if (active) ownedTextures.add(texture);
    else texture.dispose();
    return texture;
  }

  function legacyMaterial(): LabMaterial {
    const material = new THREE.MeshPhysicalMaterial({ color: 0xcccccc, metalness: 1, roughness: 0.32 });
    material.name = "Existing authored fallback proxy";
    material.userData.materialBackend = "legacy-authored";
    return ownMaterial(material);
  }

  function normalizedMaterial(): LabMaterial {
    const material = new THREE.MeshPhysicalMaterial({ color: 0x6aaa78, metalness: 0, roughness: 0.55 });
    material.name = "Normalized diagnostic";
    material.userData.materialBackend = "normalized";
    return ownMaterial(material);
  }

  const renderer = officialEssl
    ? new THREE.WebGLRenderer({ canvas, antialias: true })
    : new WebGPURenderer({ canvas, antialias: true, forceWebGL: query.get("forceWebGL") === "1" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111417);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
  camera.position.set(3.2, 2.2, 3.4);
  camera.lookAt(0, 0, 0);
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 5, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8db8ff, 1.4);
  fill.position.set(-4, 2, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffc899, 1.8);
  rim.position.set(1, 1, -4);
  scene.add(rim);

  const normalizedFallback = normalizedMaterial();
  const legacyFallback = legacyMaterial();
  const probe = new THREE.Mesh(ownGeometry(makeProbeGeometry()), normalizedFallback);
  probe.rotation.y = -0.38;
  scene.add(probe);
  const floor = new THREE.Mesh(
    ownGeometry(new THREE.CircleGeometry(3.4, 96)),
    ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x252a2d, roughness: 0.82, metalness: 0 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.12;
  scene.add(floor);

  let materialXMaterials: Record<string, LabMaterial> = {};
  let materialXReady = false;
  let bakedPbrMaterial: LabMaterial | null = null;

  function variant(): Variant {
    return variantSelect.value === "bump" ? "bump" : "source";
  }

  function resize(): void {
    if (!active) return;
    const width = capture ? 768 : Math.max(320, canvas.clientWidth);
    const height = capture ? 768 : Math.max(320, canvas.clientHeight);
    renderer.setPixelRatio(capture ? 1 : Math.min(ownerWindow.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function applySelection(): void {
    if (!active) return;
    const requested = backendSelect.value as MaterialBackend;
    const resolution = resolveMaterialBackend(requested, {
      materialx: materialXReady,
      "baked-pbr": variant() === "bump" && Boolean(bakedPbrMaterial),
      "legacy-authored": true,
      normalized: true,
    });
    let material: LabMaterial;
    if (resolution.resolved === "materialx") {
      const key = variant() === "bump" ? "ChromeCrayonNoiseBumpProbe" : "ChromeCrayonSourceLowering";
      material = materialXMaterials[key];
    } else if (resolution.resolved === "baked-pbr" && bakedPbrMaterial) {
      material = bakedPbrMaterial;
    } else if (resolution.resolved === "legacy-authored") {
      material = legacyFallback;
    } else {
      material = normalizedFallback;
    }
    probe.material = material;
    fallbackStatus.textContent = resolution.fallbackReason ?? `No fallback: ${resolution.resolved} selected`;
    status.textContent = `${resolution.resolved} · ${variant() === "bump" ? "Noise bump probe" : "Blender native source lowering"}`;
    ownerDocument.documentElement.dataset.materialxReady = "true";
    ownerDocument.documentElement.dataset.materialBackend = resolution.resolved;
  }

  async function start(): Promise<void> {
    resize();
    if (renderer instanceof WebGPURenderer) await renderer.init();
    if (!active) return;
    const [environment, irradianceSource, sceneContract] = await Promise.all([
      new EXRLoader().loadAsync(publicUrl("materialx/references/studio-environment.exr")).then(ownTexture),
      new EXRLoader().loadAsync(publicUrl("materialx/references/studio-irradiance.exr")).then(ownTexture),
      fetch(publicUrl("materialx/references/scene-contract.json"), {
        cache: "no-store",
        signal: abortController.signal,
      }).then((response) => {
        if (!response.ok) throw new Error(`Blender scene contract fetch failed: ${response.status}`);
        return response.json() as Promise<BlenderSceneContract>;
      }),
    ]);
    if (!active) return;
    camera.fov = sceneContract.camera.verticalFovDegrees;
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    camera.matrix.copy(matrixFromRows(sceneContract.camera.matrixWorldRows));
    camera.matrixWorld.copy(camera.matrix);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
    camera.updateProjectionMatrix();
    environment.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = environment;
    scene.environmentIntensity = 0.18;
    // Blender and Three use different equirectangular zero-longitude conventions.
    scene.environmentRotation.y = Math.PI * 1.5;
    const backendName = officialEssl
      ? "WebGLRenderer · RawShaderMaterial"
      : (renderer as unknown as { backend?: { constructor?: { name?: string } } }).backend?.constructor?.name ?? "initialized node backend";
    rendererStatus.textContent = officialEssl
      ? `${backendName} · official ESSL/${environmentMode.toUpperCase()}`
      : `${backendName}${query.get("forceWebGL") === "1" ? " · forced WebGL2" : " · WebGPU with automatic WebGL2 fallback"}`;

    const sourceRadiance = ownTexture(prepareMaterialXRadiance(
      environment as THREE.DataTexture,
      renderer instanceof THREE.WebGLRenderer ? renderer.capabilities.getMaxAnisotropy() : 1,
    ));
    let radiance = sourceRadiance;
    if (officialEssl && environmentMode === "prefilter") {
      const prefilterBase = publicUrl("materialx/generated/environment-prefilter").replace(/\/$/, "");
      const prefilterManifest = await fetch(`${prefilterBase}/manifest.json`, {
        cache: "no-store",
        signal: abortController.signal,
      }).then((response) => {
        if (!response.ok) throw new Error(`MaterialX environment-prefilter manifest fetch failed: ${response.status}`);
        return response.json() as Promise<EsslManifest>;
      });
      const prefiltered = await createMaterialXPrefilteredEnvironment(renderer as THREE.WebGLRenderer, {
        baseUrl: prefilterBase,
        manifest: prefilterManifest,
        shaderName: "MaterialXEnvironmentPrefilter",
        source: sourceRadiance,
        signal: abortController.signal,
        onProgress: (completed, total) => {
          status.textContent = `Prefiltering studio environment · mip ${completed}/${total}`;
        },
      });
      radiance = ownTexture(prefiltered.radiance);
      rendererStatus.textContent += ` · ${prefiltered.mipCount} GGX mips`;
    }
    const irradiance = prepareMaterialXIrradiance(irradianceSource as THREE.DataTexture);
    const lightData = sceneContract.lights.map((light) => materialXLightFromBlenderContract(light));

    if (coordinateDiagnostic && officialEssl) {
      const diagnosticScene = new THREE.Scene();
      diagnosticScene.background = new THREE.Color(0x000000);
      const diagnosticCamera = new THREE.Camera();
      const card = new THREE.Mesh(
        ownGeometry(new THREE.PlaneGeometry(2, 2)),
        ownMaterial(createCoordinateDiagnosticMaterial(radiance, lightData)),
      );
      diagnosticScene.add(card);
      rendererStatus.textContent = "WebGLRenderer · +90° environment / Blender-world light diagnostic";
      graphStatus.textContent = "Top: FIS radiance cardinals · bottom: bound directional-light cardinals · +X, +Z, −X, −Z";
      fallbackStatus.textContent = "Coordinate diagnostic; no production material selected";
      status.textContent = "MaterialX coordinate contract";
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      renderer.setAnimationLoop(() => renderer.render(diagnosticScene, diagnosticCamera));
      return;
    }

    if (metalProbeDiagnostic && officialEssl) {
      const generatedBase = publicUrl("materialx/generated/metal-presets").replace(/\/$/, "");
      const [manifest, presetIndex] = await Promise.all([
        fetch(`${generatedBase}/manifest.json`, {
          cache: "no-store",
          signal: abortController.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`Metal preset ESSL manifest fetch failed: ${response.status}`);
          return response.json() as Promise<EsslManifest>;
        }),
        fetch(publicUrl("materialx/metal-preset-probes.json"), {
          cache: "no-store",
          signal: abortController.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`Metal preset index fetch failed: ${response.status}`);
          return response.json() as Promise<MetalPresetProbeIndex>;
        }),
      ]);
      const preset = metalActiveNonImageScalarDiagnostic
        ? {
            id: "active-gold-core-scalar-gold",
            label: "Gold active non-image core · scalar",
            shader: presetIndex.activeGoldNonImageCore.scalarShader,
          }
        : metalActiveNonImageDiagnostic
        ? {
            id: "active-gold-core-gold",
            label: "Gold active non-image core",
            shader: presetIndex.activeGoldNonImageCore.beautyShader,
          }
        : metalThinFilmStreakScalarDiagnostic
        ? {
            id: "thin-film-streak-scalar-gold",
            label: "Gold thin-film streak · scalar",
            shader: presetIndex.thinFilmStreakProbe.scalarShader,
          }
        : metalThinFilmStreakDiagnostic
        ? {
            id: "thin-film-streak-gold",
            label: "Gold thin-film streak",
            shader: presetIndex.thinFilmStreakProbe.beautyShader,
          }
        : metalBrushedRoughnessScalarDiagnostic
        ? {
            id: "brushed-roughness-scalar-gold",
            label: "Gold brushed roughness · scalar",
            shader: presetIndex.brushedRoughnessProbe.scalarShader,
          }
        : metalBrushedRoughnessDiagnostic
        ? {
            id: "brushed-roughness-gold",
            label: "Gold brushed roughness",
            shader: presetIndex.brushedRoughnessProbe.beautyShader,
          }
        : metalRoughnessFresnelScalarDiagnostic
        ? {
            id: "roughness-fresnel-scalar-gold",
            label: "Gold roughness Fresnel · scalar",
            shader: presetIndex.roughnessFresnelProbe.scalarShader,
          }
        : metalRoughnessFresnelDiagnostic
        ? {
            id: "roughness-fresnel-gold",
            label: "Gold roughness Fresnel",
            shader: presetIndex.roughnessFresnelProbe.beautyShader,
          }
        : metalLayeredRoughnessDiagnostic
        ? {
            id: "layered-roughness-gold",
            label: "Gold layered roughness",
            shader: presetIndex.layeredRoughnessProbe.shader,
          }
        : metalThinFilmDiagnostic
        ? {
            id: "thin-film-gold",
            label: `Gold thin film · ${requestedThinFilmThickness} nm`,
            shader: presetIndex.thinFilmProbe.shader,
          }
        : metalAnisotropyDiagnostic
        ? {
            id: "anisotropy-gold",
            label: `Gold anisotropy · rotation ${requestedMetalRotation}`,
            shader: requestedMetalRotation === 0
              ? presetIndex.anisotropyProbe.shaderRotation0
              : presetIndex.anisotropyProbe.shaderRotationQuarterTurn,
          }
        : metalF82Diagnostic
          ? presetIndex.f82Probe
          : presetIndex.presets.find((candidate) => candidate.id === requestedMetalPreset);
      if (!preset) throw new Error(`Unknown MaterialX metal preset ${requestedMetalPreset}`);
      const shaderRecord = manifest.shaders[preset.shader];
      if (!shaderRecord) throw new Error(`Missing generated MaterialX shader ${preset.shader}`);
      const textureSet = await loadMaterialXTextures({
        baseUrl: generatedBase,
        shader: shaderRecord,
        signal: abortController.signal,
      });
      for (const texture of textureSet.textures) ownTexture(texture);
      const material = ownMaterial(await createMaterialXEsslMaterial({
        baseUrl: generatedBase,
        manifest,
        shaderName: preset.shader,
        radiance,
        irradiance,
        lights: lightData,
        environmentIntensity: 0.18,
        geometry: probe.geometry,
        geometryContract: sceneContract.probe,
        textures: textureSet.uniforms,
        uniformOverrides: metalThinFilmDiagnostic
          ? { f82_thinfilm_thickness: requestedThinFilmThickness }
          : undefined,
      }));
      material.uniforms.u_numActiveLightSources.value = 0;
      for (const light of [key, fill, rim]) light.intensity = 0;
      if (metalAnisotropyDiagnostic || metalThinFilmDiagnostic || metalThinFilmStreakDiagnostic) {
        material.uniforms.u_numActiveLightSources.value = 1;
        material.uniforms.u_envLightIntensity.value = 0;
      }
      if (
        metalRoughnessFresnelScalarDiagnostic
        || metalBrushedRoughnessScalarDiagnostic
        || metalThinFilmStreakScalarDiagnostic
        || metalActiveNonImageScalarDiagnostic
      ) {
        material.uniforms.u_envLightIntensity.value = 0;
      }
      floor.visible = false;
      probe.material = material;
      const metalRenderMode = metalThinFilmStreakScalarDiagnostic || metalActiveNonImageScalarDiagnostic
        ? "UNLIT"
        : metalThinFilmStreakDiagnostic
          ? "DIRECT"
          : "PREFILTER";
      status.textContent = `materialx · ${metalRenderMode} · ${preset.label}`;
      if (metalActiveNonImageScalarDiagnostic || metalActiveNonImageDiagnostic) {
        const activeCore = presetIndex.activeGoldNonImageCore;
        rendererStatus.textContent += metalActiveNonImageScalarDiagnostic
          ? " · unlit scalar field"
          : " · physical conductor layered closure";
        graphStatus.textContent = `${preset.shader} · ${activeCore.renderingType} · ${activeCore.semanticAdapters.join(" + ")}`;
        fallbackStatus.textContent = activeCore.scope;
      } else if (metalThinFilmStreakScalarDiagnostic || metalThinFilmStreakDiagnostic) {
        const streak = presetIndex.thinFilmStreakProbe;
        rendererStatus.textContent += metalThinFilmStreakScalarDiagnostic
          ? " · unlit scalar field"
          : " · generalized Schlick procedural thin film";
        graphStatus.textContent = `${preset.shader} · activated diagnostic override Socket_27 <- Generated · ${streak.thinFilmNoise.dimensions}D raw FBM ${streak.thinFilmNoise.octaves} octaves`;
        fallbackStatus.textContent = `Active source result ${streak.activeSourceResultNanometers} nm · ${streak.activeSourceReason}`;
      } else if (metalBrushedRoughnessScalarDiagnostic || metalBrushedRoughnessDiagnostic) {
        const brushed = presetIndex.brushedRoughnessProbe;
        rendererStatus.textContent += metalBrushedRoughnessScalarDiagnostic
          ? " · unlit scalar field"
          : " · generalized Schlick variable roughness";
        graphStatus.textContent = `${preset.shader} · ${brushed.noise.dimensions} FBM ${brushed.noise.octaves} octaves · factor ${brushed.brushedMetalFactor}`;
        fallbackStatus.textContent = `${brushed.semanticAdapter} · Generated × ${brushed.mappingScale.join(", ")} · length ${brushed.vectorLength}`;
      } else if (metalRoughnessFresnelScalarDiagnostic || metalRoughnessFresnelDiagnostic) {
        const roughnessFresnel = presetIndex.roughnessFresnelProbe;
        rendererStatus.textContent += metalRoughnessFresnelScalarDiagnostic
          ? " · unlit scalar field"
          : " · generalized Schlick variable roughness";
        graphStatus.textContent = `${preset.shader} · Layer Weight ${roughnessFresnel.layerWeightBlend} · η ${roughnessFresnel.frontFaceEta}`;
        fallbackStatus.textContent = `${roughnessFresnel.lut.samples}-sample verified raw LUT · Blender roughness ${roughnessFresnel.blenderPerceptualRoughness}`;
      } else if (metalLayeredRoughnessDiagnostic) {
        const layered = presetIndex.layeredRoughnessProbe;
        rendererStatus.textContent += " · generalized Schlick closure mix";
        graphStatus.textContent = `${layered.shader} · α=${layered.layers.map((layer) => layer.microfacetAlpha).join(", ")}`;
        fallbackStatus.textContent = `Layered roughness ${layered.layeredRoughnessFactor} · weights ${layered.effectiveWeights.join(", ")}`;
      } else if (metalThinFilmDiagnostic) {
        const thinFilm = presetIndex.thinFilmProbe;
        rendererStatus.textContent += " · generalized Schlick thin film";
        graphStatus.textContent = `${thinFilm.shader} · ${requestedThinFilmThickness} nm · IOR ${thinFilm.thinFilmIor}`;
        fallbackStatus.textContent = `Constant-input thin film · ${thinFilm.anodizationVoltage} V × ${thinFilm.nanometersPerVolt} nm/V`;
      } else if (metalAnisotropyDiagnostic) {
        const anisotropy = presetIndex.anisotropyProbe;
        rendererStatus.textContent += " · anisotropic generalized Schlick";
        graphStatus.textContent = `${preset.shader} · αx=${anisotropy.mapping.alphaX} · αy=${anisotropy.mapping.alphaY}`;
        fallbackStatus.textContent = `Constant-input anisotropy ${anisotropy.blenderAnisotropy} · tangent rotation ${requestedMetalRotation} turns`;
      } else if (metalF82Diagnostic) {
        const f82 = presetIndex.f82Probe;
        rendererStatus.textContent += " · generalized Schlick F82";
        graphStatus.textContent = `${f82.shader} · color0=${f82.baseColor.join(", ")} · color82=${f82.edgeTint.join(", ")}`;
        fallbackStatus.textContent = `Constant-input F82 probe · color90=${f82.color90.join(", ")} · exponent ${f82.exponent} · Blender roughness ${presetIndex.probeContract.blenderPerceptualRoughness} → MaterialX α ${presetIndex.probeContract.materialxMicrofacetAlpha}`;
      } else {
        const physical = preset as MetalPresetProbeIndex["presets"][number];
        rendererStatus.textContent += " · physical conductor";
        graphStatus.textContent = `${physical.shader} · n=${physical.ior.join(", ")} · k=${physical.extinction.join(", ")}`;
        fallbackStatus.textContent = `Constant-input PHYSICAL_CONDUCTOR probe · Blender roughness ${presetIndex.probeContract.blenderPerceptualRoughness} → MaterialX α ${presetIndex.probeContract.materialxMicrofacetAlpha}`;
      }
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      ownerDocument.documentElement.dataset.materialxPreset = metalActiveNonImageScalarDiagnostic
        ? "active-gold-core-scalar-gold"
        : metalActiveNonImageDiagnostic
        ? "active-gold-core-gold"
        : metalThinFilmStreakScalarDiagnostic
        ? "thin-film-streak-scalar-gold"
        : metalThinFilmStreakDiagnostic
        ? "thin-film-streak-gold"
        : metalBrushedRoughnessScalarDiagnostic
        ? "brushed-roughness-scalar-gold"
        : metalBrushedRoughnessDiagnostic
        ? "brushed-roughness-gold"
        : metalRoughnessFresnelScalarDiagnostic
        ? "roughness-fresnel-scalar-gold"
        : metalRoughnessFresnelDiagnostic
        ? "roughness-fresnel-gold"
        : metalLayeredRoughnessDiagnostic
        ? "layered-roughness-gold"
        : metalThinFilmDiagnostic
          ? "thin-film-gold"
        : metalAnisotropyDiagnostic
          ? "anisotropy-gold"
        : metalF82Diagnostic
          ? "f82-gold"
          : preset.id;
      if (metalAnisotropyDiagnostic) {
        ownerDocument.documentElement.dataset.materialxRotation = String(requestedMetalRotation);
      }
      if (metalThinFilmDiagnostic) {
        ownerDocument.documentElement.dataset.materialxThinFilm = String(
          requestedThinFilmThickness,
        );
      }
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      return;
    }

    try {
      const [normalMap, roughnessMap] = await Promise.all([
        new THREE.TextureLoader().loadAsync(publicUrl("materialx/baked/chrome-crayon-noise-normal.png")).then(ownTexture),
        new THREE.TextureLoader().loadAsync(publicUrl("materialx/baked/chrome-crayon-roughness.png")).then(ownTexture),
      ]);
      if (!active) return;
      normalMap.colorSpace = THREE.NoColorSpace;
      roughnessMap.colorSpace = THREE.NoColorSpace;
      bakedPbrMaterial = ownMaterial(new THREE.MeshPhysicalMaterial({
        color: 0xcccccc,
        metalness: 1,
        roughness: 1,
        normalMap,
        roughnessMap,
      }));
      bakedPbrMaterial.name = "Chrome Crayon · Blender/Cycles baked PBR";
      bakedPbrMaterial.userData.materialBackend = "baked-pbr";
    } catch {
      bakedPbrMaterial = null;
    }

    if (!active) return;
    const xml = await fetch(publicUrl("materialx/chrome-crayon-prototype.mtlx"), {
      cache: "no-store",
      signal: abortController.signal,
    }).then((response) => {
      if (!response.ok) throw new Error(`MaterialX fetch failed: ${response.status}`);
      return response.text();
    });
    if (!active) return;
    const audit = auditMaterialXDocument(xml, { implementation: officialEssl ? "official-essl" : "three-tsl" });
    graphStatus.textContent = audit.unsupportedElements.length
      ? `Rejected elements: ${audit.unsupportedElements.join(", ")}`
      : `${audit.materialCount} materials · ${audit.elements.length} element types · preflight passed`;
    if (audit.unsupportedElements.length) throw new Error(`Unsupported MaterialX elements: ${audit.unsupportedElements.join(", ")}`);

    if (officialEssl) {
      const generatedBase = publicUrl(
        environmentMode === "prefilter" ? "materialx/generated/prefilter" : "materialx/generated",
      ).replace(/\/$/, "");
      const manifest = await fetch(`${generatedBase}/manifest.json`, {
        cache: "no-store",
        signal: abortController.signal,
      }).then((response) => {
        if (!response.ok) throw new Error(`Generated MaterialX manifest fetch failed: ${response.status}`);
        return response.json() as Promise<EsslManifest>;
      });
      if (!active) return;
      const entries = await Promise.all([
        "ChromeCrayonSourceLowering",
        "ChromeCrayonNoiseBumpProbe",
        "MaterialXSmoothChromeDiagnostic",
        "MaterialXGeompropColorDiagnostic",
      ].map(async (shaderName) => [
        shaderName,
        ownMaterial(await createMaterialXEsslMaterial({
          baseUrl: generatedBase,
          manifest,
          shaderName,
          radiance,
          irradiance,
          lights: lightData,
          environmentIntensity: 0.18,
          geometry: probe.geometry,
          geometryContract: sceneContract.probe,
          uniformOverrides: shaderName === "MaterialXSmoothChromeDiagnostic" && roughnessDiagnostic
            ? { SS_smooth_chrome_diagnostic_specular_roughness: requestedRoughness }
            : undefined,
        })),
      ] as const));
      if (!active) return;
      materialXMaterials = Object.fromEntries(entries) as Record<string, LabMaterial>;
      if (uiNormalBandDiagnostic) {
        const uiBase = `${generatedBase}/ui-normal-band`;
        const [uiManifest, uiXml, uiReport] = await Promise.all([
          fetch(`${uiBase}/manifest.json`, { cache: "no-store", signal: abortController.signal }).then((response) => {
            if (!response.ok) throw new Error(`UI normal-band manifest fetch failed: ${response.status}`);
            return response.json() as Promise<EsslManifest>;
          }),
          fetch(publicUrl("materialx/ui-normal-band-prototype.mtlx"), {
            cache: "no-store",
            signal: abortController.signal,
          }).then((response) => {
            if (!response.ok) throw new Error(`UI normal-band MaterialX fetch failed: ${response.status}`);
            return response.text();
          }),
          fetch(publicUrl("materialx/ui-normal-band.report.json"), {
            cache: "no-store",
            signal: abortController.signal,
          }).then((response) => {
            if (!response.ok) throw new Error(`UI normal-band capability report fetch failed: ${response.status}`);
            return response.json() as Promise<{ capability: { parityReady: boolean; substitutedSemantics: unknown[] } }>;
          }),
        ]);
        if (!active) return;
        const uiAudit = auditMaterialXDocument(uiXml, { implementation: "official-essl" });
        if (uiAudit.unsupportedElements.length) {
          throw new Error(`Unsupported UI normal-band MaterialX elements: ${uiAudit.unsupportedElements.join(", ")}`);
        }
        materialXMaterials.UiNormalBandSemanticRecovery = ownMaterial(await createMaterialXEsslMaterial({
          baseUrl: uiBase,
          manifest: uiManifest,
          shaderName: "UiNormalBandSemanticRecovery",
          radiance,
          irradiance,
          lights: lightData,
          environmentIntensity: 0,
          geometry: probe.geometry,
          geometryContract: sceneContract.probe,
        }));
        if (!active) return;
        materialXMaterials.UiNormalBandSemanticRecovery.userData.capability = uiReport.capability;
      }
      graphStatus.textContent += ` · official MaterialX ${manifest.generator.materialx} ESSL · ${manifest.generator.specularEnvironment}${manifest.generator.specularEnvironment === "FIS" ? ` ${manifest.generator.radianceSamples} spp` : " GGX mip lookup"} · ${lightData.length} bound lights`;
    } else {
      const loader = new MaterialXLoader() as unknown as {
        parse(source: string): { materials: Record<string, MeshPhysicalNodeMaterial> };
      };
      const parsed = loader.parse(xml);
      materialXMaterials = parsed.materials as unknown as Record<string, LabMaterial>;
      for (const material of Object.values(materialXMaterials)) ownMaterial(material);
      if (implementation === "pr33485-native") {
        graphStatus.textContent += " · upstream native procedural normal path";
      } else {
        const adapter = applyProceduralHeightNormals(xml, parsed.materials as unknown as Record<string, MeshPhysicalNodeMaterial>);
        if (adapter.errors.length) throw new Error(adapter.errors.join("; "));
        graphStatus.textContent += ` · canonical normal adapter ${adapter.appliedMaterials.length ? "applied" : "not needed"}`;
      }
    }
    materialXReady = Boolean(materialXMaterials.ChromeCrayonSourceLowering && materialXMaterials.ChromeCrayonNoiseBumpProbe);
    if (uiNormalBandDiagnostic && officialEssl) {
      // Keep the authored probe rotation: transformnormal must carry Blender's
      // Texture Coordinate Normal from object to world space before Mapping.
      probe.updateMatrixWorld(true);
      probe.material = materialXMaterials.UiNormalBandSemanticRecovery;
      status.textContent = "materialx · UI normal-band semantic diagnostic";
      graphStatus.textContent = "World Normal/Mapping/CONSTANT ramp + typed col + unlit surface passed on rotated geometry";
      fallbackStatus.textContent = "Topology-derived portable branch; source .blend remains unavailable for native export audit";
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      return;
    }
    if (geompropColorDiagnostic && officialEssl) {
      probe.material = materialXMaterials.MaterialXGeompropColorDiagnostic;
      status.textContent = "materialx · typed col geometry property";
      fallbackStatus.textContent = "Manifest-driven color3 point attribute diagnostic";
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      return;
    }
    if (roughnessDiagnostic && officialEssl) {
      const rawDiagnosticMaterial = materialXMaterials.MaterialXSmoothChromeDiagnostic as THREE.RawShaderMaterial;
      rawDiagnosticMaterial.uniforms.u_numActiveLightSources.value = 0;
      for (const light of [key, fill, rim]) light.intensity = 0;
      floor.visible = false;
      probe.material = rawDiagnosticMaterial;
      status.textContent = `materialx · ${environmentMode.toUpperCase()} · roughness ${requestedRoughness}`;
      graphStatus.textContent += " · environment-only smooth-conductor diagnostic";
      fallbackStatus.textContent = "No direct lights or floor; exact public-uniform roughness override";
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      ownerDocument.documentElement.dataset.materialxRoughness = String(requestedRoughness);
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      return;
    }
    const selectedLightDiagnostic = lightDiagnostic ?? threeLightDiagnostic;
    if (selectedLightDiagnostic && officialEssl) {
      const selectedIndex = sceneContract.lights.findIndex((light) => light.name === selectedLightDiagnostic);
      if (selectedIndex < 0) throw new Error(`Blender scene contract is missing ${selectedLightDiagnostic}`);
      for (const [index, light] of [key, fill, rim].entries()) light.intensity = index === selectedIndex ? sceneContract.lights[index].intensity : 0;
      scene.environmentIntensity = 0;
      let diagnosticMaterial: LabMaterial;
      if (threeLightDiagnostic) {
        diagnosticMaterial = ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0xcccccc, metalness: 1, roughness: 0.32 }));
        diagnosticMaterial.userData.materialBackend = "materialx";
      } else {
        const rawDiagnosticMaterial = materialXMaterials.MaterialXSmoothChromeDiagnostic as THREE.RawShaderMaterial;
        const inactiveLight = () => ({
          type: 0,
          direction: new THREE.Vector3(),
          color: new THREE.Vector3(),
          intensity: 0,
        });
        rawDiagnosticMaterial.uniforms.u_lightData.value = [lightData[selectedIndex], inactiveLight(), inactiveLight()];
        rawDiagnosticMaterial.uniforms.u_numActiveLightSources.value = 1;
        rawDiagnosticMaterial.uniforms.u_envLightIntensity.value = 0;
        diagnosticMaterial = rawDiagnosticMaterial;
      }
      probe.material = diagnosticMaterial;
      status.textContent = `${threeLightDiagnostic ? "three" : "materialx"} · ${selectedLightDiagnostic} light direction`;
      fallbackStatus.textContent = "Authoritative Blender matrix_world diagnostic";
      graphStatus.textContent += ` · ${selectedLightDiagnostic} only · ${threeLightDiagnostic ? "Three physical control" : "MaterialX LightData"} · environment disabled`;
      ownerDocument.documentElement.dataset.materialxReady = "true";
      ownerDocument.documentElement.dataset.materialBackend = "materialx";
      ownerDocument.documentElement.dataset.materialxImplementation = implementation;
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      return;
    }
    applySelection();
    ownerDocument.documentElement.dataset.materialxImplementation = implementation;
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
  }

  backendSelect.addEventListener("change", applySelection);
  variantSelect.addEventListener("change", applySelection);
  ownerWindow.addEventListener("resize", resize);
  void start().catch((error) => {
    if (!active) return;
    materialXReady = false;
    graphStatus.textContent = error instanceof Error ? error.message : String(error);
    applySelection();
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
  }).finally(() => {
    if (!active) void renderer.dispose();
  });

  return () => {
    if (!active) return;
    active = false;
    abortController.abort();
    backendSelect.removeEventListener("change", applySelection);
    variantSelect.removeEventListener("change", applySelection);
    ownerWindow.removeEventListener("resize", resize);
    renderer.setAnimationLoop(null);
    scene.environment = null;
    probe.removeFromParent();
    floor.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    for (const texture of ownedTextures) texture.dispose();
    ownedGeometries.clear();
    ownedMaterials.clear();
    ownedTextures.clear();
    void renderer.dispose();

    const dataset = ownerDocument.documentElement.dataset;
    if (previousDataset.ready === undefined) delete dataset.materialxReady;
    else dataset.materialxReady = previousDataset.ready;
    if (previousDataset.backend === undefined) delete dataset.materialBackend;
    else dataset.materialBackend = previousDataset.backend;
    if (previousDataset.implementation === undefined) delete dataset.materialxImplementation;
    else dataset.materialxImplementation = previousDataset.implementation;
    if (previousDataset.roughness === undefined) delete dataset.materialxRoughness;
    else dataset.materialxRoughness = previousDataset.roughness;
    if (previousDataset.preset === undefined) delete dataset.materialxPreset;
    else dataset.materialxPreset = previousDataset.preset;
    if (previousDataset.rotation === undefined) delete dataset.materialxRotation;
    else dataset.materialxRotation = previousDataset.rotation;
    if (previousDataset.thinFilm === undefined) delete dataset.materialxThinFilm;
    else dataset.materialxThinFilm = previousDataset.thinFilm;
  };
}
