import * as THREE from "three";
import { WebGPURenderer, type MeshPhysicalNodeMaterial } from "three/webgpu";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { MaterialXLoader } from "three/addons/loaders/MaterialXLoader.js";
import { publicUrl } from "./base-url";
import { resolveMaterialBackend, type MaterialBackend } from "./material-backend";
import { auditMaterialXDocument } from "./materialx/capabilities";
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

  const query = new URLSearchParams(options.search ?? location.search);
  const capture = query.get("capture") === "1";
  const dependencyImplementation = import.meta.env.VITE_MATERIALX_THREE_IMPLEMENTATION || "r185";
  const implementation = query.get("implementation") === "tsl" || dependencyImplementation !== "r185"
    ? dependencyImplementation
    : "official-essl-fis";
  const officialEssl = implementation === "official-essl-fis";
  const coordinateDiagnostic = query.get("diagnostic") === "coordinates";
  const geompropColorDiagnostic = query.get("diagnostic") === "geomprop-col";
  const uiNormalBandDiagnostic = query.get("diagnostic") === "ui-normal-band";
  const lightDiagnostic = query.get("diagnostic")?.match(/^light-(key|fill|rim)$/)?.[1] ?? null;
  const threeLightDiagnostic = query.get("diagnostic")?.match(/^three-light-(key|fill|rim)$/)?.[1] ?? null;
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
      ? `${backendName} · official ESSL/FIS`
      : `${backendName}${query.get("forceWebGL") === "1" ? " · forced WebGL2" : " · WebGPU with automatic WebGL2 fallback"}`;

    const radiance = ownTexture(prepareMaterialXRadiance(
      environment as THREE.DataTexture,
      renderer instanceof THREE.WebGLRenderer ? renderer.capabilities.getMaxAnisotropy() : 1,
    ));
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
      const generatedBase = publicUrl("materialx/generated").replace(/\/$/, "");
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
      graphStatus.textContent += ` · official MaterialX ${manifest.generator.materialx} ESSL · FIS ${manifest.generator.radianceSamples} spp · ${lightData.length} bound lights`;
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
      // The capability report records that the standalone ESSL graph resolves this
      // source's world normal as object space. Identity makes the two spaces equal
      // for the branch diagnostic without claiming transformed-asset parity.
      probe.rotation.y = 0;
      probe.updateMatrixWorld(true);
      probe.material = materialXMaterials.UiNormalBandSemanticRecovery;
      status.textContent = "materialx · UI normal-band semantic diagnostic";
      graphStatus.textContent = "Normal/Mapping/CONSTANT ramp + typed col passed · normal space and surface coercion substituted · parity gated";
      fallbackStatus.textContent = "Diagnostic emission wrapper only; production authored material remains active elsewhere";
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
  };
}
