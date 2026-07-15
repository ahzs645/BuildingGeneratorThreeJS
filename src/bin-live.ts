// Live Blender-backed bin viewer: every slider (Size X/Y/Z, gap, wall, fillet,
// divide, bin select, ...) re-bakes the bin in a warm Blender process via the
// bake bridge, so you get the FULL parameter set at 100% Blender fidelity.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import GUI from "lil-gui";
import { BIN_PARAMETERS } from "./bin-params";

const BRIDGE = "http://localhost:7801";
const canvas = document.getElementById("app") as HTMLCanvasElement;
const statEl = document.getElementById("stat")!;
const busyEl = document.getElementById("busy")!;

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
controls.autoRotateSpeed = 0.5;

scene.add(new THREE.HemisphereLight(0xdfeaff, 0x20242a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.3);
key.position.set(3, 6, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x88b0ff, 1.1);
rim.position.set(-5, 2, -3); scene.add(rim);
const grid = new THREE.GridHelper(10, 40, 0x2a3340, 0x161b21);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.45;
scene.add(grid);

const loader = new GLTFLoader();
let current: THREE.Object3D | null = null;
let framed = false;
function frame(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center); obj.position.y += size.y / 2;
  const radius = Math.max(size.length() / 2, 0.01);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
  camera.position.set(dist * 0.7, dist * 0.5, dist * 0.9);
  camera.near = radius / 100; camera.far = radius * 100; camera.updateProjectionMatrix();
  controls.target.set(0, size.y / 2, 0); controls.update();
}
function show(g: THREE.Group) {
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const mat = m.material as THREE.MeshStandardMaterial; if (mat && "roughness" in mat) mat.roughness = 0.55; } });
  if (current) scene.remove(current);
  current = g; scene.add(g);
  // keep the framing stable across re-bakes; only frame once
  if (!framed) { frame(g); framed = true; }
}

const state: Record<string, number | boolean> = {};
for (const p of BIN_PARAMETERS) state[p.name] = p.defaultValue;

let baking = false;
let pending = false;
async function bake() {
  if (baking) { pending = true; return; }
  baking = true;
  busyEl.classList.add("on");
  const t0 = performance.now();
  try {
    const resp = await fetch(`${BRIDGE}/bake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
    const buf = await resp.arrayBuffer();
    const gltf = await loader.parseAsync(buf, "");
    show(gltf.scene);
    statEl.innerHTML = `<span class="ok">baked in ${(performance.now() - t0).toFixed(0)} ms</span> · Blender-evaluated geometry · drag any slider`;
  } catch (e: any) {
    statEl.innerHTML = `<span class="err">bake failed: ${e.message}</span> — is the bake server running?`;
    console.log("BINLIVE_ERROR", e.message);
  } finally {
    baking = false;
    busyEl.classList.remove("on");
    if (pending) { pending = false; bake(); }
  }
}

let debounce: number | undefined;
function requestBake() {
  clearTimeout(debounce);
  debounce = setTimeout(bake, 300) as unknown as number;
}

async function main() {
  // check bridge/server
  try {
    const s = await (await fetch(`${BRIDGE}/status`)).json();
    if (!s.ready) throw new Error("server not ready");
  } catch (e: any) {
    statEl.innerHTML = `<span class="err">bake server offline</span> — run: <code>node tools/bake-bridge.mjs</code> + the Blender server`;
    return;
  }
  const gui = new GUI({ title: "dojo bin · live (Blender)" });
  for (const p of BIN_PARAMETERS) {
    if (p.boolean) gui.add(state, p.name).onChange(requestBake);
    else gui.add(state, p.name, p.min, p.max, p.step).onChange(requestBake);
  }
  await bake(); // initial
}

addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
main();
