import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import { fitDistanceForRadius } from "./camera-fit";
import { describeLoadProgress } from "./load-progress";
import { bindStatusLine } from "./status-line";
import { canvasBox, observeCanvasBox, preferredCanvasPixelRatio, releaseToolContext } from "./canvas-viewport";
import type { ToolHandle } from "./react/page-runtime";

type Example = {
  id: string;
  title: string;
  detail: string;
  file: string;
  accent: number;
};

const examples: Example[] = [
  { id: "chrome-crayon", title: "Chrome Crayon", detail: "curve-driven drawing generator · 81,958 faces", file: publicUrl("dojo/gallery/chrome-crayon.glb"), accent: 0x8fcfff },
  { id: "shoen-gyroid", title: "Schoen Gyroid", detail: "Math Clay TPMS study · 46,920 faces", file: publicUrl("dojo/gallery/shoen-gyroid.glb"), accent: 0xd9a7ff },
  { id: "schwarz-p", title: "Schwarz P-Surface", detail: "Math Clay TPMS study · 18,978 faces", file: publicUrl("dojo/gallery/schwarz-p.glb"), accent: 0xffb56d },
  { id: "hat-front", title: "Send Nodes Hat", detail: "complete procedural hat assembly · 379,885 faces", file: publicUrl("dojo/gallery/hat-front.glb"), accent: 0xff758c },
  { id: "dojo-bin", title: "Recursive Bin Generator", detail: "existing Blender-evaluated geometry bake", file: publicUrl("dojo/bin.glb"), accent: 0x5b83ff },
];

export function createTool(): ToolHandle {
  const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
  const titleEl = document.querySelector<HTMLElement>("#title")!;
  const subtitleEl = document.querySelector<HTMLElement>("#subtitle")!;
  const setStatus = bindStatusLine("#status");
  const modelsEl = document.querySelector<HTMLElement>("#models")!;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
  const viewport = canvasBox(canvas);
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080a0d);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environmentTexture = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environmentTexture;
  scene.environmentIntensity = 0.8;
  room.dispose();
  pmrem.dispose();
  const fog = new THREE.FogExp2(0x080a0d, 0.018);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(42, viewport.width / viewport.height, 0.001, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.65;

  scene.add(new THREE.HemisphereLight(0xe7f2ff, 0x161922, 1.45));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 7, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f92ff, 2.1);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  const loader = new GLTFLoader();
  let disposed = false;
  let root: THREE.Object3D | null = null;
  let grid: THREE.GridHelper | null = null;
  let loadToken = 0;
  let active: Example;
  let viewStyle: "original" | "studio" | "wireframe" = "original";
  let studioMaterial: THREE.MeshStandardMaterial | null = null;
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  function disposeObject(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) mat.dispose();
    });
  }

  function applyStyle() {
    if (!root) return;
    studioMaterial?.dispose();
    studioMaterial = null;
    if (viewStyle !== "original") {
      studioMaterial = new THREE.MeshStandardMaterial({
        color: active.accent,
        roughness: viewStyle === "wireframe" ? 0.38 : 0.46,
        metalness: viewStyle === "wireframe" ? 0.08 : 0.18,
        wireframe: viewStyle === "wireframe",
        side: THREE.DoubleSide,
      });
    }
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = viewStyle === "original" ? originals.get(mesh)! : studioMaterial!;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((button) => {
      button.classList.toggle("active", button.dataset.style === viewStyle);
    });
  }

  function frameObject(obj: THREE.Object3D) {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.x -= center.x;
    obj.position.y -= box.min.y;
    obj.position.z -= center.z;
    obj.updateMatrixWorld(true);
    const radius = Math.max(size.length() * 0.5, 0.001);
    const distance = fitDistanceForRadius(camera, radius);
    camera.position.set(distance * 0.72, distance * 0.48, distance * 0.92);
    controls.target.set(0, size.y * 0.45, 0);
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.update();
    fog.density = 0.018 / radius;

    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    const gridSize = Math.max(size.x, size.z, radius) * 4;
    grid = new THREE.GridHelper(gridSize, 32, 0x34404b, 0x171c22);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.45;
    scene.add(grid);
  }

  async function showExample(id: string) {
    active = examples.find((item) => item.id === id) ?? examples[0];
    const token = ++loadToken;
    titleEl.textContent = active.title;
    subtitleEl.textContent = active.detail;
    setStatus("busy", "loading Blender bake…");
    document.querySelectorAll<HTMLButtonElement>(".model").forEach((button) => button.classList.toggle("active", button.dataset.model === active.id));
    const url = new URL(location.href);
    url.searchParams.set("model", active.id);
    history.replaceState(null, "", url);

    try {
      // No Date.now() cache-buster: these bakes are immutable for the life of a
      // session, and busting the cache re-downloaded up to 38 MB every time a
      // model was reselected. And progress is reported in bytes — a silent
      // 38 MB wait on a phone reads as a hang, not as loading.
      const gltf = await new Promise<Awaited<ReturnType<typeof loader.loadAsync>>>((resolve, reject) => {
        loader.load(
          active.file,
          resolve,
          (event) => {
            if (token !== loadToken || disposed) return;
            setStatus("busy", describeLoadProgress("loading Blender bake…", event.loaded, event.total));
          },
          reject,
        );
      });
      if (token !== loadToken || disposed) {
        disposeObject(gltf.scene);
        return;
      }
      if (root) {
        scene.remove(root);
        disposeObject(root);
      }
      originals.clear();
      root = gltf.scene;
      let meshes = 0;
      let triangles = 0;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        triangles += (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
        originals.set(mesh, mesh.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      scene.add(root);
      applyStyle();
      frameObject(root);
      const ready = { model: active.id, meshes, triangles: Math.round(triangles) };
      (window as typeof window & { __READY__?: unknown }).__READY__ = ready;
      setStatus("ready", `${meshes} mesh${meshes === 1 ? "" : "es"} · ${Math.round(triangles).toLocaleString()} triangles · drag to orbit · scroll to zoom`);
      console.log("DOJO_GALLERY_READY", JSON.stringify(ready));
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error", `failed to load · ${message}`);
      console.error("DOJO_GALLERY_ERROR", message);
    }
  }

  const modelButtons: HTMLButtonElement[] = [];
  for (const example of examples) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model";
    button.dataset.model = example.id;
    button.innerHTML = `<strong>${example.title}</strong><span>${example.detail}</span>`;
    button.addEventListener("click", () => void showExample(example.id));
    modelsEl.append(button);
    modelButtons.push(button);
  }

  const buttonCleanups: Array<() => void> = [];
  document.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((button) => {
    const onClick = () => {
      viewStyle = button.dataset.style as typeof viewStyle;
      applyStyle();
    };
    button.addEventListener("click", onClick);
    buttonCleanups.push(() => button.removeEventListener("click", onClick));
  });
  const spinButton = document.querySelector<HTMLButtonElement>("#spin")!;
  const onSpinClick = (event: MouseEvent) => {
    controls.autoRotate = !controls.autoRotate;
    (event.currentTarget as HTMLButtonElement).classList.toggle("active", controls.autoRotate);
  };
  spinButton.addEventListener("click", onSpinClick);
  buttonCleanups.push(() => spinButton.removeEventListener("click", onSpinClick));
  const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
  const onResetClick = () => root && frameObject(root);
  resetButton.addEventListener("click", onResetClick);
  buttonCleanups.push(() => resetButton.removeEventListener("click", onResetClick));
  // The viewport is a grid column beside the dock, so track the canvas box
  // rather than the window.
  const stopObservingCanvas = observeCanvasBox(canvas, (width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  void showExample(new URLSearchParams(location.search).get("model") ?? examples[0].id);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken++;
      renderer.setAnimationLoop(null);
      stopObservingCanvas();
      for (const cleanup of buttonCleanups) cleanup();
      buttonCleanups.length = 0;
      for (const button of modelButtons) button.remove();
      modelButtons.length = 0;
      controls.dispose();
      if (root) {
        scene.remove(root);
        disposeObject(root);
        root = null;
      }
      if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        (grid.material as THREE.Material).dispose();
        grid = null;
      }
      studioMaterial?.dispose();
      studioMaterial = null;
      originals.clear();
      environmentTexture.dispose();
      delete (window as typeof window & { __READY__?: unknown }).__READY__;
      renderer.dispose();
      releaseToolContext(renderer);
    },
  };
}
