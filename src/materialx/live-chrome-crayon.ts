import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { publicUrl } from "../base-url";
import {
  createMaterialXEsslMaterial,
  materialXLightFromBlenderContract,
  prepareMaterialXIrradiance,
  prepareMaterialXRadiance,
  type BlenderSceneContract,
  type EsslManifest,
} from "./essl-adapter";
import { prepareLiveChromeCrayonGeometry } from "./live-chrome-geometry";

type NativeResources = {
  manifest: EsslManifest;
  radiance: THREE.DataTexture;
  irradiance: THREE.DataTexture;
  sceneContract: BlenderSceneContract;
};

let resourcesPromise: Promise<NativeResources> | null = null;

function nativeResources(renderer: THREE.WebGLRenderer): Promise<NativeResources> {
  resourcesPromise ??= Promise.all([
    fetch(publicUrl("materialx/generated/native/manifest.json"), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Native MaterialX manifest fetch failed: ${response.status}`);
      return response.json() as Promise<EsslManifest>;
    }),
    new EXRLoader().loadAsync(publicUrl("materialx/references/studio-environment.exr")),
    new EXRLoader().loadAsync(publicUrl("materialx/references/studio-irradiance.exr")),
    fetch(publicUrl("materialx/references/scene-contract.json"), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`MaterialX scene contract fetch failed: ${response.status}`);
      return response.json() as Promise<BlenderSceneContract>;
    }),
  ]).then(([manifest, radianceSource, irradianceSource, sceneContract]) => ({
    manifest,
    radiance: prepareMaterialXRadiance(
      radianceSource as THREE.DataTexture,
      renderer.capabilities.getMaxAnisotropy(),
    ),
    irradiance: prepareMaterialXIrradiance(irradianceSource as THREE.DataTexture),
    sceneContract,
  }));
  return resourcesPromise;
}

/** Compile the recovered native graph against the live 2.5D GN-VM mesh. */
export async function makeLiveChromeCrayonMaterial(
  renderer: THREE.WebGLRenderer,
  geometry: THREE.BufferGeometry,
): Promise<THREE.RawShaderMaterial> {
  const contract = prepareLiveChromeCrayonGeometry(geometry);
  const resources = await nativeResources(renderer);
  const material = await createMaterialXEsslMaterial({
    baseUrl: publicUrl("materialx/generated/native").replace(/\/$/, ""),
    manifest: resources.manifest,
    shaderName: "chrome_003",
    radiance: resources.radiance,
    irradiance: resources.irradiance,
    lights: resources.sceneContract.lights.map((light) => materialXLightFromBlenderContract(light)),
    environmentIntensity: 0.18,
    geometry,
    geometryContract: contract,
  });
  material.name = "chrome.003 · native MaterialX ESSL/FIS";
  material.userData.geometryContract = contract;
  return material;
}
