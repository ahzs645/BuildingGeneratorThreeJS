// Interactive baked-bin viewer: pre-baked GLB variants (100% Blender fidelity)
// swapped live via a Bin Select slider. The "complete bin example".
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import GUI from "lil-gui";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const statEl = document.getElementById("stat")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.3);
key.position.set(3, 6, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88b0ff, 1.1);
rim.position.set(-5, 2, -3);
scene.add(rim);
const grid = new THREE.GridHelper(10, 40, 0x2a3340, 0x161b21);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.45;
scene.add(grid);

interface Variant { id: string; label: string; params: Record<string, number>; file: string; }
const loader = new GLTFLoader();
const cache = new Map<string, THREE.Group>();
let current: THREE.Object3D | null = null;
let framed = false;

function frame(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  obj.position.y += size.y / 2;
  const radius = size.length() / 2;
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
  camera.position.set(dist * 0.7, dist * 0.5, dist * 0.9);
  camera.near = radius / 100; camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, size.y / 2, 0);
  controls.update();
}

function show(g: THREE.Group) {
  if (current) scene.remove(current);
  current = g;
  scene.add(g);
  if (!framed) { frame(g); framed = true; }
}

async function loadVariant(base: string, v: Variant): Promise<THREE.Group> {
  if (cache.has(v.id)) return cache.get(v.id)!;
  const gltf = await loader.loadAsync(`${base}/${v.file}`);
  cache.set(v.id, gltf.scene);
  return gltf.scene;
}

async function main() {
  const base = "/dojo/variants";
  const manifest = (await (await fetch(`${base}/variants.json`)).json()) as { axis: string; variants: Variant[] };
  const variants = manifest.variants;
  const state = { [manifest.axis]: 0 };

  // show first, then warm the cache in the background
  show(await loadVariant(base, variants[0]));
  statEl.innerHTML = `<span class="ok">${variants.length} baked variants</span> · slide to move the highlighted bin`;

  const gui = new GUI({ title: "dojo bin · baked" });
  gui.add(state, manifest.axis, 0, variants.length - 1, 1).name(manifest.axis).onChange(async (i: number) => {
    const v = variants[Math.max(0, Math.min(variants.length - 1, Math.round(i)))];
    show(await loadVariant(base, v));
  });

  // prefetch the rest so switching is instant
  for (const v of variants.slice(1)) loadVariant(base, v).catch(() => {});
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
main().catch((e) => { statEl.innerHTML = `<span style="color:#ff9a9a">error: ${e.message}</span>`; console.log("BINSTUDIO_ERROR", e.message); });
