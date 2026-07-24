import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

export type CrayonWorkerReply =
  | { id: number; ok: true; soup: TriSoup; probeSoup?: TriSoup; coverage: { handled: number; missingTypes: { type: string; count: number }[] } }
  | { id: number; ok: false; error: string };
type Baseline = { results: { verts: number; faces: number; bbox: { min: number[]; max: number[] } }[] };

export type CrayonProbeSelection = { group: string; node: string; socket?: string; type: string };
export type CrayonEvaluationState = "loading" | "queued" | "evaluating" | "ready" | "error";

export type CrayonRuntimeSnapshot = {
  state: CrayonEvaluationState;
  message: string;
  selectionMessage: string;
  truthStats?: { verts: number; faces: number };
  vmStats?: { verts: number; faces: number };
  faceDelta?: number;
  runtimeSeconds?: number;
  coverageMessage?: string;
  lastValid: boolean;
};

export type CrayonRuntimeController = {
  setDump: (dump: Dump) => void;
  setProbe: (selection?: CrayonProbeSelection) => void;
  setLayout: (layout: "split" | "overlay") => void;
  setShader: (shader: "diagnostic" | "chrome") => void;
  evaluate: (overrides: Record<string, number>) => Promise<void>;
  dispose: () => void;
};

type MountCrayonRuntimeOptions = {
  canvas: HTMLCanvasElement;
  initialOverrides: Record<string, number>;
  onState: (snapshot: CrayonRuntimeSnapshot) => void;
};

/**
 * Typed React/Three.js boundary for the Crayon workspace. React owns controls,
 * graph state, and status presentation; this controller owns WebGL and GN-VM.
 * Geometry is swapped only after a successful worker reply, so a failed edit
 * leaves the last valid result visible.
 */
export function mountCrayonRuntime({ canvas, initialOverrides, onState }: MountCrayonRuntimeOptions): CrayonRuntimeController {
let disposed = false;
let queuedEvaluation = 0;
let currentOverrides = { ...initialOverrides };
let snapshot: CrayonRuntimeSnapshot = {
  state: "loading",
  message: "Loading portable graph…",
  selectionMessage: "Output preview · final geometry",
  lastValid: false,
};
const emit = (patch: Partial<CrayonRuntimeSnapshot>): void => {
  snapshot = { ...snapshot, ...patch };
  onState({ ...snapshot });
};

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

const truthGroup = new THREE.Group(), vmGroup = new THREE.Group(), probeGroup = new THREE.Group();
scene.add(truthGroup, vmGroup, probeGroup);
let split = true;
let dump: Dump;
let pendingDump: Dump | undefined;
let baseline: Baseline;
let runId = 0;
let updateVersion = 0;
let activeEvaluation: { worker: Worker; reject: (reason?: unknown) => void } | null = null;
let runtimeReady = false;
let shaderMode: "diagnostic" | "chrome" = "diagnostic";
let probeSelection: CrayonProbeSelection | undefined;

const truthDiagnostic = new THREE.MeshStandardMaterial({ color: 0xe74f4c, metalness: .28, roughness: .32, transparent: true, opacity: .36, side: THREE.DoubleSide });
const vmDiagnostic = new THREE.MeshStandardMaterial({ color: 0x39aef5, metalness: .25, roughness: .3, transparent: true, opacity: .34, side: THREE.DoubleSide });
const truthWireMaterial = new THREE.MeshBasicMaterial({ color: 0xff716b, wireframe: true, transparent: true, opacity: .6 });
const vmWireMaterial = new THREE.MeshBasicMaterial({ color: 0x63c8ff, wireframe: true, transparent: true, opacity: .62 });
const probeMaterial = new THREE.MeshBasicMaterial({ color: 0xffb84f, transparent: true, opacity: .78, depthWrite: false, side: THREE.DoubleSide });
const probeWireMaterial = new THREE.MeshBasicMaterial({ color: 0xffe0a0, wireframe: true, transparent: true, opacity: .9, depthWrite: false });

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
      .replace("#include <common>", "#include <common>\nattribute float rough;\nvarying vec3 vCrayonObjectPosition;\nvarying float vCrayonRough;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCrayonObjectPosition = position;\nvCrayonRough = rough;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vCrayonObjectPosition;
varying float vCrayonRough;
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
      "#include <roughnessmap_fragment>\nvec3 grainP = vCrayonObjectPosition * 0.58;\nfloat grain = crayonNoise(grainP + 8.0 * crayonNoise(grainP * 0.23));\nroughnessFactor = clamp(0.025 + grain * 0.5 * clamp(vCrayonRough, 0.0, 1.0), 0.02, 0.58);",
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
}

function soupObject(soup: TriSoup): THREE.Object3D {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  for (const [name, attribute] of Object.entries(soup.attributes ?? {})) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
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

function probeObject(soup: TriSoup): THREE.Object3D {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  const solid = new THREE.Mesh(geometry, probeMaterial);
  const wire = new THREE.Mesh(geometry, probeWireMaterial);
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
    if (!mesh.geometry.getAttribute("rough")) mesh.geometry.setAttribute("rough", new THREE.BufferAttribute(new Float32Array(mesh.geometry.attributes.position.count), 1));
    mesh.material = truthDiagnostic;
    mesh.userData.crayonPrimary = true;
    const clone = new THREE.Mesh(mesh.geometry, truthWireMaterial);
    clone.userData.crayonWire = true;
    mesh.add(clone);
  }
  return source;
}

function layoutAndFrame(): void {
  truthGroup.position.set(0, 0, 0); vmGroup.position.set(0, 0, 0); probeGroup.position.set(0, 0, 0);
  const truthBox = new THREE.Box3().setFromObject(truthGroup), vmBox = new THREE.Box3().setFromObject(vmGroup);
  const width = Math.max(truthBox.getSize(new THREE.Vector3()).x, vmBox.getSize(new THREE.Vector3()).x, 1);
  if (split) { truthGroup.position.x = -width * .62; vmGroup.position.x = width * .62; }
  probeGroup.position.copy(vmGroup.position);
  const box = new THREE.Box3().expandByObject(truthGroup).expandByObject(vmGroup);
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * .5, 1);
  camera.position.set(center.x + radius * .8, center.y + radius * .7, center.z + radius * 1.35);
  camera.near = radius / 200; camera.far = radius * 100; camera.updateProjectionMatrix();
  controls.target.copy(center); controls.update();
}

function evaluateWorker(overrides: Record<string, number>): Promise<CrayonWorkerReply & { ok: true }> {
  const id = ++runId;
  return new Promise((resolve, reject) => {
    if (activeEvaluation) {
      activeEvaluation.worker.terminate();
      activeEvaluation.reject(new DOMException("Evaluation superseded", "AbortError"));
    }
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "crayon-gnvm" });
    activeEvaluation = { worker, reject };
    worker.onmessage = (event: MessageEvent<CrayonWorkerReply>) => {
      worker.terminate();
      if (activeEvaluation?.worker === worker) activeEvaluation = null;
      if (event.data.id !== id) return;
      if (!event.data.ok) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      if (activeEvaluation?.worker === worker) activeEvaluation = null;
      reject(new Error(event.message));
    };
    worker.postMessage({ id, dump, object: "CHROME CRAYON OBJECT", overrides, probe: probeSelection });
  });
}

async function update(overrides = currentOverrides): Promise<void> {
  currentOverrides = { ...overrides };
  const version = ++updateVersion;
  emit({ state: "evaluating", message: "Evaluating 22 nested node groups in the Web Worker…" });
  const started = performance.now();
  try {
    const result = await evaluateWorker(currentOverrides);
    if (disposed || version !== updateVersion) return;
    // Commit only after the complete graph succeeds. Until here vmGroup still
    // contains the previous last-known-good object.
    vmGroup.clear(); vmGroup.add(soupObject(result.soup));
    probeGroup.clear();
    if (result.probeSoup?.indices.length) probeGroup.add(probeObject(result.probeSoup));
    applyShaderMode();
    const truth = baseline.results[0];
    const faceDelta = result.soup.stats.faces - truth.faces;
    layoutAndFrame();
    emit({
      state: "ready",
      message: "Both results loaded · graph executed end-to-end",
      truthStats: { verts: truth.verts, faces: truth.faces },
      vmStats: { verts: result.soup.stats.verts, faces: result.soup.stats.faces },
      runtimeSeconds: (performance.now() - started) / 1000,
      faceDelta,
      coverageMessage: result.coverage.missingTypes.length ? `${result.coverage.missingTypes.length} missing node types` : `${result.coverage.handled} node types handled · none missing`,
      lastValid: true,
      selectionMessage: probeSelection
      ? result.probeSoup?.indices.length ? `Output preview · ${probeSelection.node} · ${result.probeSoup.stats.faces.toLocaleString()} faces` : `Selected · ${probeSelection.node} · no evaluated geometry output`
      : "Output preview · final geometry",
    });
    (window as typeof window & { __CRAYON_COMPARE__?: unknown }).__CRAYON_COMPARE__ = { ready: true, stats: result.soup.stats, missing: result.coverage.missingTypes, overrides: currentOverrides };
  } catch (error) {
    if (!disposed && version === updateVersion) emit({
      state: "error",
      message: `Evaluation failed · ${error instanceof Error ? error.message : String(error)}${snapshot.lastValid ? " · previous valid result kept" : ""}`,
    });
  }
}

async function main(): Promise<void> {
  const [dumpResponse, baselineResponse, glb] = await Promise.all([
    fetch(publicUrl("dojo/crayon/dump.json")),
    fetch(publicUrl("dojo/crayon/blender-baseline.json")),
    new GLTFLoader().loadAsync(publicUrl("dojo/crayon/00-browser-baseline.glb")),
  ]);
  const loadedDump = await dumpResponse.json() as Dump;
  if (disposed) return;
  dump = pendingDump ?? loadedDump;
  baseline = await baselineResponse.json() as Baseline;
  truthGroup.add(truthObject(glb.scene));
  runtimeReady = true;
  await update();
}

const resize = (): void => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); };
addEventListener("resize", resize);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
void main().catch((error) => emit({ state: "error", message: `Runtime failed · ${error instanceof Error ? error.message : String(error)}` }));

return {
  setDump(next: Dump): void {
    pendingDump = next;
    dump = next;
    window.clearTimeout(queuedEvaluation);
    emit({ state: "queued", message: "Graph changed · waiting to evaluate…" });
    queuedEvaluation = window.setTimeout(() => {
      if (runtimeReady && !disposed) void update();
    }, 250);
  },
  setProbe(selection?: CrayonProbeSelection): void {
    probeSelection = selection;
    emit({ selectionMessage: `Evaluating output · ${selection?.node ?? "final geometry"}…` });
    if (runtimeReady && !disposed) void update();
  },
  setLayout(layout: "split" | "overlay"): void {
    split = layout === "split";
    if (runtimeReady) layoutAndFrame();
  },
  setShader(shader: "diagnostic" | "chrome"): void {
    shaderMode = shader;
    applyShaderMode();
  },
  evaluate(overrides: Record<string, number>): Promise<void> {
    window.clearTimeout(queuedEvaluation);
    return runtimeReady ? update(overrides) : Promise.resolve();
  },
  dispose(): void {
    disposed = true;
    updateVersion += 1;
    activeEvaluation?.worker.terminate();
    activeEvaluation?.reject(new DOMException("Runtime disposed", "AbortError"));
    activeEvaluation = null;
    window.clearTimeout(queuedEvaluation);
    removeEventListener("resize", resize);
    renderer.setAnimationLoop(null);
    controls.dispose();
    renderer.dispose();
    truthGroup.clear();
    vmGroup.clear();
    probeGroup.clear();
    reconstructedChrome.dispose();
    truthDiagnostic.dispose();
    vmDiagnostic.dispose();
    truthWireMaterial.dispose();
    vmWireMaterial.dispose();
    probeMaterial.dispose();
    probeWireMaterial.dispose();
  },
};
}
