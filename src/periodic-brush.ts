import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

const canvas = document.querySelector<HTMLCanvasElement>("#periodic-canvas")!;
const distanceInput = document.querySelector<HTMLInputElement>("#periodic-distance")!;
const distanceOutput = document.querySelector<HTMLOutputElement>("#periodic-distance-output")!;
const sizeInput = document.querySelector<HTMLInputElement>("#periodic-size")!;
const sizeOutput = document.querySelector<HTMLOutputElement>("#periodic-size-output")!;
const resetButton = document.querySelector<HTMLButtonElement>("#periodic-reset")!;
const statusEl = document.querySelector<HTMLElement>("#periodic-status")!;
const countEl = document.querySelector<HTMLElement>("#periodic-count")!;
const runtimeEl = document.querySelector<HTMLElement>("#periodic-runtime")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .01, 5000);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(room, .04).texture; room.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xeef5e8, 0x161b16, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-4, -5, 8); scene.add(key);
const model = new THREE.Group(); scene.add(model);
const material = new THREE.MeshPhysicalMaterial({ color: 0xb6e56e, metalness: .08, roughness: .31, clearcoat: .22, side: THREE.DoubleSide });

let dump: Dump;
let runId = 0;
let appliedId = 0;
let editTimer = 0;

function evaluate(): Promise<WorkerReply & { ok: true }> {
  const id = ++runId;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "dojo-periodic-brush" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (!event.data.ok) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, dump, object: "PERIODIC BRUSH", overrides: { "Dot Distance": Number(distanceInput.value), "dot size": Number(sizeInput.value) } });
  });
}

function soupMesh(soup: TriSoup): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, material);
}

function frameModel(): void {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * .5, 1);
  camera.position.set(center.x, center.y - radius * 1.6, center.z + radius * 1.15);
  camera.near = radius / 300; camera.far = radius * 100; camera.updateProjectionMatrix(); controls.target.copy(center); controls.update();
}

async function update(): Promise<void> {
  const requested = runId + 1;
  statusEl.classList.remove("ready"); statusEl.textContent = "Evaluating collection instances…";
  const started = performance.now();
  try {
    const result = await evaluate();
    if (result.id < appliedId || result.id !== requested) return;
    appliedId = result.id;
    model.clear(); model.add(soupMesh(result.soup)); frameModel();
    countEl.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;
    runtimeEl.textContent = `${((performance.now() - started) / 1000).toFixed(2)}s · 9 collection shapes`;
    statusEl.classList.add("ready"); statusEl.textContent = "Blender-matched graph evaluated";
    (window as typeof window & { __PERIODIC_BRUSH__?: unknown }).__PERIODIC_BRUSH__ = { ready: true, stats: result.soup.stats, distance: Number(distanceInput.value), size: Number(sizeInput.value) };
  } catch (error) { statusEl.textContent = error instanceof Error ? error.message : String(error); }
}

function queueUpdate(): void {
  distanceOutput.value = Number(distanceInput.value).toFixed(3);
  sizeOutput.value = Number(sizeInput.value).toFixed(2);
  window.clearTimeout(editTimer); editTimer = window.setTimeout(() => void update(), 100);
}
distanceInput.addEventListener("input", queueUpdate);
sizeInput.addEventListener("input", queueUpdate);
resetButton.addEventListener("click", () => { distanceInput.value = "2.151417"; sizeInput.value = "1"; queueUpdate(); });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

fetch(publicUrl("dojo/periodic-brush/dump.json")).then((response) => response.json()).then((loaded: Dump) => { dump = loaded; void update(); }).catch((error) => { statusEl.textContent = String(error); });
