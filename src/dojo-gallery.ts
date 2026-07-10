import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";

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
  { id: "dojo-bin", title: "Recursive Bin Generator", detail: "existing Node Dojo bake · 100% Blender fidelity", file: publicUrl("dojo/bin.glb"), accent: 0x5b83ff },
];

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
const titleEl = document.querySelector<HTMLElement>("#title")!;
const subtitleEl = document.querySelector<HTMLElement>("#subtitle")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const modelsEl = document.querySelector<HTMLElement>("#models")!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080a0d);
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.8;
room.dispose();
pmrem.dispose();
const fog = new THREE.FogExp2(0x080a0d, 0.018);
scene.fog = fog;
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.001, 10000);
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
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
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
  statusEl.textContent = "loading Blender bake…";
  document.documentElement.style.setProperty("--accent", `#${active.accent.toString(16).padStart(6, "0")}`);
  document.querySelectorAll<HTMLButtonElement>(".model").forEach((button) => button.classList.toggle("active", button.dataset.model === active.id));
  const url = new URL(location.href);
  url.searchParams.set("model", active.id);
  history.replaceState(null, "", url);

  try {
    const gltf = await loader.loadAsync(`${active.file}?v=${Date.now()}`);
    if (token !== loadToken) {
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
    statusEl.innerHTML = `<span class="ok">ready</span> · ${meshes} mesh${meshes === 1 ? "" : "es"} · ${Math.round(triangles).toLocaleString()} triangles · drag to orbit · scroll to zoom`;
    console.log("DOJO_GALLERY_READY", JSON.stringify(ready));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusEl.innerHTML = `<span class="err">failed to load</span> · ${message}`;
    console.error("DOJO_GALLERY_ERROR", message);
  }
}

for (const example of examples) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "model";
  button.dataset.model = example.id;
  button.innerHTML = `<strong>${example.title}</strong><span>${example.detail}</span>`;
  button.addEventListener("click", () => void showExample(example.id));
  modelsEl.append(button);
}

document.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((button) => button.addEventListener("click", () => {
  viewStyle = button.dataset.style as typeof viewStyle;
  applyStyle();
}));
document.querySelector<HTMLButtonElement>("#spin")!.addEventListener("click", (event) => {
  controls.autoRotate = !controls.autoRotate;
  (event.currentTarget as HTMLButtonElement).classList.toggle("active", controls.autoRotate);
});
document.querySelector<HTMLButtonElement>("#reset")!.addEventListener("click", () => root && frameObject(root));
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

void showExample(new URLSearchParams(location.search).get("model") ?? examples[0].id);
