import * as THREE from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { publicUrl } from "./base-url";
import { decodeBase64Asset } from "./base64-asset";

let studioEnvironment: Promise<THREE.DataTexture> | null = null;

/** Load the exact CC0 studio environment used by the committed Blender references. */
export function loadBlenderStudioEnvironment(): Promise<THREE.DataTexture> {
  if (studioEnvironment) return studioEnvironment;
  const loading = (async () => {
    const response = await fetch(publicUrl("dojo/blender-studio.exr.b64"), { cache: "force-cache" });
    if (!response.ok) throw new Error(`Blender studio environment failed to load: ${response.status}`);
    const bytes = decodeBase64Asset(await response.text());
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/x-exr" }));
    try {
      const texture = await new EXRLoader().loadAsync(objectUrl);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.name = "Blender 5.1 CC0 studio.exr";
      return texture;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  })();
  studioEnvironment = loading.catch((error) => {
    studioEnvironment = null;
    throw error;
  });
  return studioEnvironment;
}
