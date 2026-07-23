import * as THREE from "three/webgpu";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { MaterialXLoader } from "three/addons/loaders/MaterialXLoader.js";

function probeGeometry(widthSegments = 64, heightSegments = 32): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= heightSegments; y += 1) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x += 1) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const px = Math.sin(phi) * Math.cos(theta);
      const py = Math.cos(phi);
      const pz = Math.sin(phi) * Math.sin(theta);
      positions.push(px, py, pz);
      normals.push(px, py, pz);
      uvs.push(u, 1 - v);
    }
  }
  for (let y = 0; y < heightSegments; y += 1) {
    for (let x = 0; x < widthSegments; x += 1) {
      const a = y * (widthSegments + 1) + x;
      const b = a + widthSegments + 1;
      if (y !== 0) indices.push(a, b, a + 1);
      if (y !== heightSegments - 1) indices.push(b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeTangents();
  return geometry;
}

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const normalScale = Number(query.get("normalScale") ?? "1");
  const normalY = Number(query.get("normalY") ?? "1");
  const canvas = document.querySelector<HTMLCanvasElement>("#baked-canvas");
  if (!canvas) throw new Error("Missing baked canvas");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
  renderer.setPixelRatio(1);
  renderer.setSize(768, 768, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();

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

  const environment = await new EXRLoader().loadAsync("/materialx/references/studio-environment.exr");
  environment.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = environment;
  scene.environmentIntensity = 0.18;
  scene.environmentRotation.y = Math.PI * 1.5;

  const loader = new THREE.TextureLoader();
  const [normalMap, roughnessMap] = await Promise.all([
    loader.loadAsync("/materialx/baked/chrome-crayon-noise-normal.png"),
    loader.loadAsync("/materialx/baked/chrome-crayon-roughness.png"),
  ]);
  normalMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.colorSpace = THREE.NoColorSpace;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  roughnessMap.minFilter = THREE.LinearMipmapLinearFilter;
  let material: THREE.Material & { normalScale?: THREE.Vector2 } = new THREE.MeshPhysicalMaterial({
    color: 0xcccccc,
    metalness: 1,
    roughness: 1,
    normalMap,
    roughnessMap,
  });
  material.normalScale?.set(normalScale, normalScale * normalY);
  material.name = "Chrome Crayon · baked PBR validation";
  material.userData.materialBackend = "baked-pbr";
  if (query.get("backend") === "materialx") {
    const parsed = await new MaterialXLoader().setPath("/materialx/baked/").loadAsync("chrome-crayon-noise-baked.mtlx") as unknown as {
      materials: Record<string, THREE.Material & { normalScale?: THREE.Vector2 }>;
    };
    material = parsed.materials.ChromeCrayonBakedNoiseBump;
    if (!material) throw new Error("Baked MaterialX material was not created");
    material.normalScale?.set(normalScale, normalScale * normalY);
    material.userData.materialBackend = "materialx-baked-pbr";
  }

  const probe = new THREE.Mesh(probeGeometry(), material);
  probe.rotation.y = -0.38;
  scene.add(probe);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(3.4, 96),
    new THREE.MeshPhysicalMaterial({ color: 0x252a2d, roughness: 0.82 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.12;
  scene.add(floor);
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  document.documentElement.dataset.bakedReady = "true";
  document.documentElement.dataset.normalScale = String(normalScale);
  document.documentElement.dataset.normalY = String(normalY);
  document.documentElement.dataset.backend = String(material.userData.materialBackend);
}

void start().catch((error) => {
  document.documentElement.dataset.bakedError = error instanceof Error ? error.message : String(error);
});
