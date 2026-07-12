import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

type WorkerReply =
  | { id: number; ok: true; soup: TriSoup; coverage: { handled: number; missingTypes: { type: string; count: number }[] } }
  | { id: number; ok: false; error: string };
type Baseline = { results: { verts: number; faces: number; bbox: { min: number[]; max: number[] } }[] };

const canvas = document.querySelector<HTMLCanvasElement>("#crayon-canvas")!;
const statusEl = document.querySelector<HTMLElement>("#crayon-status")!;
const updateButton = document.querySelector<HTMLButtonElement>("#crayon-update")!;
const splitButton = document.querySelector<HTMLButtonElement>("#crayon-split")!;
const overlayButton = document.querySelector<HTMLButtonElement>("#crayon-overlay")!;
const debugShaderButton = document.querySelector<HTMLButtonElement>("#crayon-shader-debug")!;
const chromeShaderButton = document.querySelector<HTMLButtonElement>("#crayon-shader-chrome")!;
const truthCount = document.querySelector<HTMLElement>("#crayon-truth-count")!;
const vmCount = document.querySelector<HTMLElement>("#crayon-vm-count")!;
const runtimeEl = document.querySelector<HTMLElement>("#crayon-runtime")!;
const gapEl = document.querySelector<HTMLElement>("#crayon-gap")!;
const coverageEl = document.querySelector<HTMLElement>("#crayon-coverage")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .01, 4000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(room, .04).texture;
room.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x11151b, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 7, 5); scene.add(key);

const truthGroup = new THREE.Group(), vmGroup = new THREE.Group();
scene.add(truthGroup, vmGroup);
let split = true;
let dump: Dump;
let baseline: Baseline;
let runId = 0;
let shaderMode: "diagnostic" | "chrome" = "diagnostic";

const truthDiagnostic = new THREE.MeshStandardMaterial({ color: 0xe74f4c, metalness: .28, roughness: .32, transparent: true, opacity: .36, side: THREE.DoubleSide });
const vmDiagnostic = new THREE.MeshStandardMaterial({ color: 0x39aef5, metalness: .25, roughness: .3, transparent: true, opacity: .34, side: THREE.DoubleSide });
const truthWireMaterial = new THREE.MeshBasicMaterial({ color: 0xff716b, wireframe: true, transparent: true, opacity: .6 });
const vmWireMaterial = new THREE.MeshBasicMaterial({ color: 0x63c8ff, wireframe: true, transparent: true, opacity: .62 });

function chromeMaterial(): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xcccccc,
    metalness: 1,
    roughness: .22,
    clearcoat: .12,
    clearcoatRoughness: .03,
    envMapIntensity: 1.55,
    side: THREE.DoubleSide,
  });
  material.name = "chrome.003 · WebGL reconstruction";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCrayonObjectPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCrayonObjectPosition = position;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vCrayonObjectPosition;
float crayonHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float crayonNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(crayonHash(i), crayonHash(i + vec3(1,0,0)), f.x), mix(crayonHash(i + vec3(0,1,0)), crayonHash(i + vec3(1,1,0)), f.x), f.y), mix(mix(crayonHash(i + vec3(0,0,1)), crayonHash(i + vec3(1,0,1)), f.x), mix(crayonHash(i + vec3(0,1,1)), crayonHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`).replace(
      "#include <roughnessmap_fragment>",
      "#include <roughnessmap_fragment>\nvec3 grainP = vCrayonObjectPosition * 0.58;\nfloat grain = crayonNoise(grainP + 8.0 * crayonNoise(grainP * 0.23));\nroughnessFactor = clamp(0.055 + grain * 0.46, 0.04, 0.58);",
    );
  };
  material.customProgramCacheKey = () => "chrome-003-procedural-roughness-v1";
  return material;
}

const reconstructedChrome = chromeMaterial();

function applyShaderMode(): void {
  const apply = (root: THREE.Object3D, engine: "truth" | "vm") => root.traverse((entry) => {
    const mesh = entry as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.crayonPrimary) mesh.material = shaderMode === "chrome" ? reconstructedChrome : engine === "truth" ? truthDiagnostic : vmDiagnostic;
    if (mesh.userData.crayonWire) mesh.visible = shaderMode === "diagnostic";
  });
  apply(truthGroup, "truth"); apply(vmGroup, "vm");
  debugShaderButton.classList.toggle("active", shaderMode === "diagnostic");
  chromeShaderButton.classList.toggle("active", shaderMode === "chrome");
}

function setStatus(message: string, ready = false): void {
  statusEl.classList.toggle("ready", ready);
  statusEl.lastChild!.textContent = message;
}

function soupObject(soup: TriSoup): THREE.Object3D {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  const solid = new THREE.Mesh(geometry, vmDiagnostic);
  const wire = new THREE.Mesh(geometry, vmWireMaterial);
  solid.userData.crayonPrimary = true;
  wire.userData.crayonWire = true;
  const local = new THREE.Group(); local.add(solid, wire);
  const object = dump.objects?.find((entry) => entry.name === "CHROME CRAYON OBJECT");
  if (object) {
    local.position.fromArray(object.location ?? [0, 0, 0]);
    local.rotation.set(...((object.rotation ?? [0, 0, 0]) as [number, number, number]));
    local.scale.fromArray(object.scale ?? [1, 1, 1]);
  }
  const yup = new THREE.Group(); yup.rotation.x = -Math.PI / 2; yup.add(local);
  return yup;
}

function truthObject(source: THREE.Object3D): THREE.Object3D {
  const meshes: THREE.Mesh[] = [];
  source.traverse((entry) => {
    const mesh = entry as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  for (const mesh of meshes) {
    mesh.material = truthDiagnostic;
    mesh.userData.crayonPrimary = true;
    const clone = new THREE.Mesh(mesh.geometry, truthWireMaterial);
    clone.userData.crayonWire = true;
    mesh.add(clone);
  }
  return source;
}

function layoutAndFrame(): void {
  truthGroup.position.set(0, 0, 0); vmGroup.position.set(0, 0, 0);
  const truthBox = new THREE.Box3().setFromObject(truthGroup), vmBox = new THREE.Box3().setFromObject(vmGroup);
  const width = Math.max(truthBox.getSize(new THREE.Vector3()).x, vmBox.getSize(new THREE.Vector3()).x, 1);
  if (split) { truthGroup.position.x = -width * .62; vmGroup.position.x = width * .62; }
  const box = new THREE.Box3().expandByObject(truthGroup).expandByObject(vmGroup);
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * .5, 1);
  camera.position.set(center.x + radius * .8, center.y + radius * .7, center.z + radius * 1.35);
  camera.near = radius / 200; camera.far = radius * 100; camera.updateProjectionMatrix();
  controls.target.copy(center); controls.update();
  splitButton.classList.toggle("active", split); overlayButton.classList.toggle("active", !split);
}

function evaluate(overrides: Record<string, number>): Promise<WorkerReply & { ok: true }> {
  const id = ++runId;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "crayon-gnvm" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (event.data.id !== id) return;
      if (!event.data.ok) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, dump, object: "CHROME CRAYON OBJECT", overrides });
  });
}

function readOverrides(): Record<string, number> {
  const result: Record<string, number> = {};
  document.querySelectorAll<HTMLInputElement>("[data-crayon-param]").forEach((input) => result[input.dataset.crayonParam!] = Number(input.value));
  return result;
}

async function update(): Promise<void> {
  setStatus("Evaluating 22 nested node groups in the Web Worker…");
  updateButton.disabled = true;
  const started = performance.now();
  try {
    const result = await evaluate(readOverrides());
    vmGroup.clear(); vmGroup.add(soupObject(result.soup));
    applyShaderMode();
    const truth = baseline.results[0];
    truthCount.textContent = `${truth.verts.toLocaleString()} verts · ${truth.faces.toLocaleString()} faces`;
    vmCount.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;
    runtimeEl.textContent = `${((performance.now() - started) / 1000).toFixed(2)}s · Web Worker`;
    const faceDelta = result.soup.stats.faces - truth.faces;
    gapEl.textContent = `${faceDelta >= 0 ? "+" : ""}${faceDelta.toLocaleString()} faces`;
    coverageEl.textContent = result.coverage.missingTypes.length ? `${result.coverage.missingTypes.length} missing node types` : `${result.coverage.handled} node types handled · none missing`;
    layoutAndFrame();
    setStatus("Both results loaded · graph executed end-to-end", true);
    (window as typeof window & { __CRAYON_COMPARE__?: unknown }).__CRAYON_COMPARE__ = { ready: true, stats: result.soup.stats, missing: result.coverage.missingTypes, overrides: readOverrides() };
  } catch (error) { setStatus(`Evaluation failed · ${error instanceof Error ? error.message : String(error)}`); }
  finally { updateButton.disabled = false; }
}

async function main(): Promise<void> {
  const [dumpResponse, baselineResponse, glb] = await Promise.all([
    fetch(publicUrl("dojo/crayon/dump.json")),
    fetch(publicUrl("dojo/crayon/blender-baseline.json")),
    new GLTFLoader().loadAsync(publicUrl("dojo/crayon/00-browser-baseline.glb")),
  ]);
  dump = await dumpResponse.json() as Dump;
  baseline = await baselineResponse.json() as Baseline;
  truthGroup.add(truthObject(glb.scene));
  await update();
}

document.querySelectorAll<HTMLInputElement>("[data-crayon-param]").forEach((input) => input.addEventListener("input", () => {
  const output = document.querySelector<HTMLOutputElement>(`[data-crayon-output="${input.dataset.crayonParam}"]`);
  if (output) output.value = Number(input.value).toFixed(input.step === "1" ? 0 : 2);
}));
updateButton.addEventListener("click", () => void update());
splitButton.addEventListener("click", () => { split = true; layoutAndFrame(); });
overlayButton.addEventListener("click", () => { split = false; layoutAndFrame(); });
debugShaderButton.addEventListener("click", () => { shaderMode = "diagnostic"; applyShaderMode(); });
chromeShaderButton.addEventListener("click", () => { shaderMode = "chrome"; applyShaderMode(); });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
void main();
