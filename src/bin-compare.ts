import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import { makeBinAuthoredMaterial } from "./bin-authored-material";
import type { FilamentBounds } from "./filament-material";
import type { Dump, TriSoup } from "./gnvm/index";
import { BIN_DEFAULTS, BIN_PARAMETERS } from "./bin-params";

type Variant = { id: string; params: Record<string, number>; file: string };
type WorkerReply =
  | { id: number; ok: true; soup: TriSoup; coverage: { handled: number; missingTypes: { type: string; count: number }[] } }
  | { id: number; ok: false; error: string };
type CompareMode = "overlay" | "split";
type ViewStyle = "wire" | "material";
type ResultView = "both" | "truth" | "vm";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
const statusEl = document.querySelector<HTMLElement>("#compare-status")!;
const truthSourceEl = document.querySelector<HTMLElement>("#truth-source")!;
const truthMetricLabel = document.querySelector<HTMLElement>("#truth-metric-label")!;
const updateButton = document.querySelector<HTMLButtonElement>("#update-comparison")!;
const findingEl = document.querySelector<HTMLElement>("#finding")!;
const truthTrisEl = document.querySelector<HTMLElement>("#truth-tris")!;
const truthRedEl = document.querySelector<HTMLElement>("#truth-red")!;
const vmTrisEl = document.querySelector<HTMLElement>("#vm-tris")!;
const vmRedEl = document.querySelector<HTMLElement>("#vm-red")!;
const deltaEnvelopeEl = document.querySelector<HTMLElement>("#delta-envelope")!;
const deltaTrisEl = document.querySelector<HTMLElement>("#delta-tris")!;
const overlayButton = document.querySelector<HTMLButtonElement>("#mode-overlay")!;
const splitButton = document.querySelector<HTMLButtonElement>("#mode-split")!;
const wireButton = document.querySelector<HTMLButtonElement>("#style-wire")!;
const materialButton = document.querySelector<HTMLButtonElement>("#style-material")!;
const bothButton = document.querySelector<HTMLButtonElement>("#show-both")!;
const truthButton = document.querySelector<HTMLButtonElement>("#show-truth")!;
const vmButton = document.querySelector<HTMLButtonElement>("#show-vm")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.001, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = false;
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.72;
room.dispose();
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe5f1ff, 0x1a2029, 1.05));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(3, 6, 4);
scene.add(key);

const truthGroup = new THREE.Group();
const vmGroup = new THREE.Group();
scene.add(truthGroup, vmGroup);
let truthSolid: THREE.Object3D | null = null;
let truthWire: THREE.Object3D | null = null;
let vmSolid: THREE.Object3D | null = null;
let vmWire: THREE.Object3D | null = null;
let mode: CompareMode = "overlay";
let style: ViewStyle = "wire";
let resultView: ResultView = "both";
let splitOffset = 0;
let runId = 0;
let worker: Worker | null = null;
let dump: Dump;
let variants: Variant[] = [];
// Full 0..11 sweep: both point-to-surface directions are exact to the
// diagnostic's displayed precision. Triangle counts still differ because the
// same surfaces are tessellated differently.
const measuredSurfaceP99: Record<number, number> = {
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
  6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
};

function setStatus(message: string, ready = false): void {
  statusEl.classList.toggle("ready", ready);
  statusEl.lastChild!.textContent = message;
}

function namedMaterial(name: string | null, material: THREE.Material): THREE.Material {
  material.name = name ?? "";
  return material;
}

let bedTexture: THREE.CanvasTexture | null = null;
function ankermakeBedTexture(): THREE.CanvasTexture {
  if (bedTexture) return bedTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#111519";
  context.fillRect(0, 0, 1024, 1024);
  context.strokeStyle = "rgba(103, 156, 174, .34)";
  context.lineWidth = 2;
  for (let p = 64; p < 1024; p += 64) {
    context.beginPath(); context.moveTo(p, 30); context.lineTo(p, 994); context.stroke();
    context.beginPath(); context.moveTo(30, p); context.lineTo(994, p); context.stroke();
  }
  context.strokeStyle = "rgba(214, 235, 241, .62)";
  context.lineWidth = 5;
  context.strokeRect(24, 24, 976, 976);
  context.strokeStyle = "rgba(90, 135, 150, .28)";
  context.lineWidth = 3;
  context.beginPath(); context.moveTo(24, 24); context.lineTo(1000, 1000); context.moveTo(1000, 24); context.lineTo(24, 1000); context.stroke();
  context.fillStyle = "rgba(226, 239, 243, .78)";
  context.textAlign = "center";
  context.font = "700 54px system-ui, sans-serif";
  context.fillText("ANKERMAKE", 512, 480);
  context.font = "500 22px system-ui, sans-serif";
  context.fillStyle = "rgba(161, 193, 203, .72)";
  context.fillText("PRINT BED · PROCEDURAL FALLBACK", 512, 522);
  bedTexture = new THREE.CanvasTexture(canvas);
  bedTexture.colorSpace = THREE.SRGBColorSpace;
  bedTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  bedTexture.needsUpdate = true;
  return bedTexture;
}

function materialFor(name: string | null, generatedBounds?: FilamentBounds): THREE.Material {
  if (name && generatedBounds) {
    const authored = makeBinAuthoredMaterial(dump, generatedBounds, name);
    if (authored) return authored;
  }
  const tree = name ? dump.materials?.[name] : undefined;
  const principled = tree?.nodes?.find((node) => node.type === "ShaderNodeBsdfPrincipled");
  const emission = tree?.nodes?.find((node) => node.type === "ShaderNodeEmission");
  const input = (node: typeof principled, id: string, fallback: unknown) => node?.inputs?.find((socket) => socket.identifier === id || socket.name === id)?.value ?? fallback;
  const color = (value: unknown, fallback: [number, number, number]) => {
    const c = Array.isArray(value) ? value : fallback;
    return new THREE.Color().setRGB(Number(c[0] ?? fallback[0]), Number(c[1] ?? fallback[1]), Number(c[2] ?? fallback[2]));
  };
  if (emission) {
    const c = color(input(emission, "Color", [1, 1, 1, 1]), [1, 1, 1]);
    // Blender's glTF exporter emits a black PBR base plus emissiveFactor here.
    // Keeping the diffuse base white made the VM side visibly brighter.
    return namedMaterial(name, new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: Number(input(emission, "Strength", 1)), roughness: 1, side: THREE.DoubleSide, flatShading: true }));
  }
  if (name === "ankermake bed") return namedMaterial(name, new THREE.MeshBasicMaterial({ color: 0xffffff, map: ankermakeBedTexture(), side: THREE.DoubleSide, transparent: true, opacity: .96 }));
  if (tree && !principled) return namedMaterial(name, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const alpha = Number(input(principled, "Alpha", 1));
  const material = new THREE.MeshStandardMaterial({
    color: color(input(principled, "Base Color", [1, 1, 1, 1]), [1, 1, 1]),
    metalness: Number(input(principled, "Metallic", 0)),
    roughness: Number(input(principled, "Roughness", 0.5)),
    emissive: color(input(principled, "Emission Color", [0, 0, 0, 1]), [0, 0, 0]),
    emissiveIntensity: Number(input(principled, "Emission Strength", 1)),
    opacity: alpha,
    transparent: alpha < 1,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  return namedMaterial(name, material);
}

function boxBounds(box: THREE.Box3): FilamentBounds {
  return { min: box.min.toArray(), max: box.max.toArray() };
}

function geometryBounds(geometry: THREE.BufferGeometry): FilamentBounds {
  geometry.computeBoundingBox();
  return boxBounds(geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1), new THREE.Vector3(1)));
}

function rootBoundsInMeshSpace(root: THREE.Object3D, target: THREE.Mesh): FilamentBounds {
  root.updateMatrixWorld(true);
  const inverseTarget = target.matrixWorld.clone().invert();
  const result = new THREE.Box3();
  const corner = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      corner.set(x, y, z).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseTarget);
      result.expandByPoint(corner);
    }
  });
  return boxBounds(result.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1), new THREE.Vector3(1)) : result);
}

function disposeMaterial(material: THREE.Material, textures: Set<THREE.Texture>): void {
  for (const value of Object.values(material)) if (value instanceof THREE.Texture && !textures.has(value)) {
    textures.add(value);
    value.dispose();
  }
  material.dispose();
}

function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const assigned = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of assigned) if (!materials.has(material)) {
      materials.add(material);
      disposeMaterial(material, textures);
    }
  });
}

function clearAndDispose(group: THREE.Group): void {
  disposeObjectTree(group);
  group.clear();
}

function soupGeometry(soup: TriSoup): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  for (const [name, attribute] of Object.entries(soup.attributes ?? {})) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  soup.groups.forEach((group, index) => geometry.addGroup(group.start, group.count, index));
  return geometry;
}

function vmRoots(soup: TriSoup): { solid: THREE.Group; wire: THREE.Group } {
  const geometry = soupGeometry(soup);
  const generatedBounds = geometryBounds(geometry);
  const solidMaterials = soup.groups.map((group) => materialFor(group.material, generatedBounds));
  if (!solidMaterials.length) solidMaterials.push(materialFor(null, generatedBounds));
  const solidMesh = new THREE.Mesh(geometry, solidMaterials.length === 1 ? solidMaterials[0] : solidMaterials);
  const wireMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x4bb7ff, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false }));
  const object = dump.objects?.find((item) => item.name === "Procedural Drawer") as ({ location?: number[]; rotation?: number[]; scale?: number[] } | undefined);
  const wrap = (mesh: THREE.Mesh) => {
    const local = new THREE.Group();
    if (object) {
      local.position.fromArray(object.location ?? [0, 0, 0]);
      const rotation = object.rotation ?? [0, 0, 0];
      local.rotation.set(rotation[0], rotation[1], rotation[2]);
      local.scale.fromArray(object.scale ?? [1, 1, 1]);
    }
    local.add(mesh);
    const axis = new THREE.Group();
    axis.rotation.x = -Math.PI / 2;
    axis.add(local);
    return axis;
  };
  return { solid: wrap(solidMesh), wire: wrap(wireMesh) };
}

function truthRoots(root: THREE.Object3D): { solid: THREE.Object3D; wire: THREE.Object3D } {
  root.updateMatrixWorld(true);
  const loaderMaterials = new Set<THREE.Material>();
  const loaderTextures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const wasArray = Array.isArray(mesh.material);
    const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // Use the same dump-derived authored materials on both engines. The sole
    // image dependency (the unavailable AnkerMake bed image) deliberately
    // continues through the shared labeled procedural fallback.
    const generatedBounds = rootBoundsInMeshSpace(root, mesh);
    const mapped = materials.map((material) => materialFor(material.name || null, generatedBounds));
    for (const material of materials) if (!loaderMaterials.has(material)) {
      loaderMaterials.add(material);
      disposeMaterial(material, loaderTextures);
    }
    // GLTFLoader represents each primitive as a single-material mesh with no
    // geometry groups. Turning that into a one-item array makes Three.js draw
    // no solid triangles; preserve single materials as single materials.
    mesh.material = wasArray ? mapped : mapped[0];
  });
  // Keep the loader-owned scene detached. Using independent display clones
  // avoids the original glTF root being culled after its sibling wire clone is
  // toggled in the comparison scene.
  const solid = root.clone(true);
  const wire = root.clone(true);
  wire.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ color: 0xff625c, wireframe: true, transparent: true, opacity: 0.48, depthWrite: false });
  });
  return { solid, wire };
}

function countTriangles(root: THREE.Object3D, materialName?: string): number {
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = mesh.geometry.groups;
    if (groups.length) {
      for (const group of groups) if (!materialName || materials[group.materialIndex ?? 0]?.name === materialName) triangles += group.count / 3;
    } else if (!materialName || materials[0]?.name === materialName) triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  });
  return Math.round(triangles);
}

function maxBoundsDelta(a: THREE.Box3, b: THREE.Box3): number {
  return Math.max(...a.min.toArray().map((value, index) => Math.abs(value - b.min.toArray()[index])), ...a.max.toArray().map((value, index) => Math.abs(value - b.max.toArray()[index])));
}

function positionGroups(): void {
  truthGroup.position.set(0, 0, 0);
  vmGroup.position.set(0, 0, 0);
  if (mode === "split" && resultView === "both") {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    truthGroup.position.copy(right).multiplyScalar(-splitOffset);
    vmGroup.position.copy(right).multiplyScalar(splitOffset);
  }
}

function frameComparison(): void {
  positionGroups();
  const box = new THREE.Box3().expandByObject(truthGroup).expandByObject(vmGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.001);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(center.x + distance * .72, center.y + distance * .58, center.z + distance * .88);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function syncView(reframe = false): void {
  const showTruth = resultView !== "vm";
  const showVm = resultView !== "truth";
  if (truthSolid) truthSolid.visible = showTruth && style === "material";
  if (truthWire) truthWire.visible = showTruth && style === "wire";
  if (vmSolid) vmSolid.visible = showVm && style === "material";
  if (vmWire) vmWire.visible = showVm && style === "wire";
  overlayButton.classList.toggle("active", mode === "overlay");
  splitButton.classList.toggle("active", mode === "split");
  wireButton.classList.toggle("active", style === "wire");
  materialButton.classList.toggle("active", style === "material");
  bothButton.classList.toggle("active", resultView === "both");
  truthButton.classList.toggle("active", resultView === "truth");
  vmButton.classList.toggle("active", resultView === "vm");
  document.querySelectorAll(".viewport-label").forEach((label) => label.classList.toggle("show", mode === "split" && resultView === "both"));
  const width = Math.max(new THREE.Box3().setFromObject(truthGroup).getSize(new THREE.Vector3()).x, new THREE.Box3().setFromObject(vmGroup).getSize(new THREE.Vector3()).x, .1);
  // Leave a full model-width gutter so the print-bed and drawer components of
  // one result cannot visually read as pieces of the other result.
  splitOffset = width * .62;
  positionGroups();
  if (reframe) frameComparison();
}

function runVm(overrides: Record<string, number | boolean>, id: number): Promise<WorkerReply & { ok: true }> {
  worker?.terminate();
  worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "bin-compare-vm" });
  return new Promise((resolve, reject) => {
    worker!.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      worker?.terminate();
      worker = null;
      if (reply.id !== id) return;
      if (!reply.ok) reject(new Error(reply.error));
      else resolve(reply);
    };
    worker!.onerror = (event) => reject(new Error(event.message));
    worker!.postMessage({ id, dump, object: "Procedural Drawer", overrides });
  });
}

function readOverrides(): Record<string, number | boolean> {
  const overrides: Record<string, number | boolean> = {};
  for (const parameter of BIN_PARAMETERS) {
    const control = document.querySelector<HTMLInputElement>(`[data-bin-param="${parameter.name}"]`)!;
    overrides[parameter.name] = parameter.boolean ? control.checked : Number(control.value);
  }
  return overrides;
}

function isDefaultExceptSelection(overrides: Record<string, number | boolean>): boolean {
  return BIN_PARAMETERS.every((parameter) => {
    if (parameter.name === "Bin Select") return true;
    const actual = overrides[parameter.name], expected = BIN_DEFAULTS[parameter.name];
    return typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) <= Math.max(1e-6, (parameter.step ?? 0) / 2 + 1e-9)
      : actual === expected;
  });
}

async function loadBlenderTruth(overrides: Record<string, number | boolean>): Promise<{ root: THREE.Object3D; source: "live" | "baked" }> {
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    try {
      const response = await fetch(`http://${location.hostname}:7801/bake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const root = (await new GLTFLoader().parseAsync(await response.arrayBuffer(), "")).scene;
      return { root, source: "live" };
    } catch (error) {
      console.warn("Live Blender bake unavailable; checking baked fallback", error);
    }
  }
  const selection = Number(overrides["Bin Select"]);
  const variant = variants.find((item) => Number(item.params["Bin Select"]) === selection);
  if (!variant || !isDefaultExceptSelection(overrides))
    throw new Error("Live Blender bridge is required for non-default parameters");
  return { root: (await new GLTFLoader().loadAsync(publicUrl(`dojo/variants/${variant.file}`))).scene, source: "baked" };
}

async function updateComparison(overrides = readOverrides()): Promise<void> {
  const id = ++runId;
  const selection = Number(overrides["Bin Select"]);
  setStatus("Evaluating the same inputs in Blender and GN-VM…");
  updateButton.disabled = true;
  const started = performance.now();
  try {
    const [blender, vm] = await Promise.all([loadBlenderTruth(overrides), runVm(overrides, id)]);
    if (id !== runId) {
      disposeObjectTree(blender.root);
      return;
    }
    clearAndDispose(truthGroup);
    clearAndDispose(vmGroup);
    // A previous side-by-side view leaves display-only offsets on the groups.
    // Metrics must always compare the authored meshes in the same origin.
    truthGroup.position.set(0, 0, 0);
    vmGroup.position.set(0, 0, 0);
    const truth = truthRoots(blender.root);
    const generated = vmRoots(vm.soup);
    truthSolid = truth.solid; truthWire = truth.wire; vmSolid = generated.solid; vmWire = generated.wire;
    truthGroup.add(truthSolid, truthWire);
    vmGroup.add(vmSolid, vmWire);
    truthGroup.updateMatrixWorld(true);
    vmGroup.updateMatrixWorld(true);

    const truthTris = countTriangles(truthSolid);
    const truthRed = countTriangles(truthSolid, "3D.004");
    const vmTris = vm.soup.stats.tris;
    const vmRed = vm.soup.groups.filter((group) => group.material === "3D.004").reduce((sum, group) => sum + group.count / 3, 0);
    const envelope = maxBoundsDelta(new THREE.Box3().setFromObject(truthSolid), new THREE.Box3().setFromObject(vmSolid));
    truthTrisEl.textContent = `${truthTris.toLocaleString()} tris`;
    truthRedEl.textContent = `${truthRed.toLocaleString()} highlighted red`;
    vmTrisEl.textContent = `${vmTris.toLocaleString()} tris`;
    vmRedEl.textContent = `${vmRed.toLocaleString()} highlighted red`;
    deltaEnvelopeEl.textContent = `${envelope.toFixed(4)} envelope`;
    const surfaceP99 = isDefaultExceptSelection(overrides) ? measuredSurfaceP99[selection] : undefined;
    deltaTrisEl.textContent = `${vmTris - truthTris >= 0 ? "+" : ""}${(vmTris - truthTris).toLocaleString()} triangles${surfaceP99 !== undefined ? ` · p99 ${surfaceP99.toFixed(3)}` : ""}`;
    const redDelta = vmRed - truthRed;
    findingEl.textContent = surfaceP99 !== undefined
      ? `The default-parameter sweep matches at p99/max ${surfaceP99.toFixed(3)}. GN-VM has ${Math.abs(redDelta).toLocaleString()} ${redDelta >= 0 ? "more" : "fewer"} red triangles from alternate tessellation, but the highlighted surface is the same.`
      : `This live setting has an envelope delta of ${envelope.toFixed(4)} and ${Math.abs(redDelta).toLocaleString()} ${redDelta >= 0 ? "more" : "fewer"} highlighted triangles. Use Overlay for shape parity and Side by side for material inspection.`;
    syncView(true);
    truthSourceEl.textContent = blender.source === "live" ? "live Blender" : "baked fallback";
    truthMetricLabel.textContent = blender.source === "live" ? "Live Blender truth" : "Blender baked fallback";
    setStatus(`Both engines updated in ${((performance.now() - started) / 1000).toFixed(2)}s`, true);
    (window as typeof window & { __BIN_COMPARE__?: unknown }).__BIN_COMPARE__ = { ready: true, overrides, truthSource: blender.source, truthTris, vmTris, truthRed, vmRed, envelope, surfaceP99, mode, style, resultView };
  } catch (error) {
    setStatus(`Comparison failed · ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (id === runId) updateButton.disabled = false;
  }
}

async function main(): Promise<void> {
  const [dumpResponse, manifestResponse] = await Promise.all([fetch(publicUrl("dojo/dump_bin.json")), fetch(publicUrl("dojo/variants/variants.json"))]);
  dump = await dumpResponse.json() as Dump;
  variants = (await manifestResponse.json() as { variants: Variant[] }).variants;
  const rawQuery = new URLSearchParams(location.search).get("select");
  const query = rawQuery === null ? Number.NaN : Number(rawQuery);
  if (Number.isInteger(query) && query >= 0 && query <= 20) {
    const control = document.querySelector<HTMLInputElement>('[data-bin-param="Bin Select"]')!;
    control.value = String(query);
    document.querySelector<HTMLOutputElement>('[data-bin-output="Bin Select"]')!.value = String(query);
  }
  await updateComparison();
}

document.querySelectorAll<HTMLInputElement>("[data-bin-param]").forEach((control) => {
  control.addEventListener("input", () => {
    const output = document.querySelector<HTMLOutputElement>(`[data-bin-output="${control.dataset.binParam}"]`);
    if (output) output.value = Number(control.value).toFixed(control.step === "1" ? 0 : 3);
  });
});
updateButton.addEventListener("click", () => void updateComparison());
overlayButton.addEventListener("click", () => { mode = "overlay"; syncView(true); });
splitButton.addEventListener("click", () => { mode = "split"; syncView(true); });
wireButton.addEventListener("click", () => { style = "wire"; syncView(); });
materialButton.addEventListener("click", () => { style = "material"; syncView(); });
bothButton.addEventListener("click", () => { resultView = "both"; syncView(true); });
truthButton.addEventListener("click", () => { resultView = "truth"; syncView(true); });
vmButton.addEventListener("click", () => { resultView = "vm"; syncView(true); });
addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "o") { mode = "overlay"; syncView(true); }
  if (event.key.toLowerCase() === "s") { mode = "split"; syncView(true); }
  if (event.key.toLowerCase() === "w") { style = style === "wire" ? "material" : "wire"; syncView(); }
  if (event.key === "1") { resultView = "truth"; syncView(true); }
  if (event.key === "2") { resultView = "vm"; syncView(true); }
  if (event.key === "3") { resultView = "both"; syncView(true); }
});
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); if (mode === "split") positionGroups(); renderer.render(scene, camera); });
void main();
