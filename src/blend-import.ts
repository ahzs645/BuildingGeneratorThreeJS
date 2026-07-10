import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { REGISTRY, type Dump, type TriSoup } from "./gnvm/index";
import { isStaticDeploy, publicUrl } from "./base-url";

type ImportedDump = Omit<Dump, "objects" | "node_groups" | "materials"> & {
  blender_version?: string;
  import_meta?: { filename?: string; bytes?: number; blender_version?: string; extracted_at?: string; transient?: boolean };
  objects?: Array<{
    name: string;
    type?: string;
    modifiers?: Array<{ type: string; node_group?: string; input_values?: Record<string, unknown> }>;
  }>;
  node_groups: Record<string, RawGroup>;
  materials?: Record<string, RawMaterial>;
};

type RawSocket = { name: string; identifier: string; socket_type?: string; in_out?: string; item_type?: string; default?: unknown; min_value?: number; max_value?: number };
type RawNode = { name: string; type: string; label?: string | null; inputs?: Array<{ name: string; identifier: string; linked: boolean; value: unknown }> };
type RawGroup = { name?: string; interface?: RawSocket[]; nodes?: RawNode[]; links?: unknown[] };
type RawMaterial = { nodes?: RawNode[] };
type GnObject = NonNullable<ImportedDump["objects"]>[number] & { group: string; saved: Record<string, unknown> };
type WorkerReply =
  | { id: number; ok: true; soup: TriSoup; coverage: { handled: number; missingTypes: { type: string; count: number }[] } }
  | { id: number; ok: false; error: string };

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const fileInput = $("#file-input") as HTMLInputElement;
const dropzone = $("#dropzone");
const sourceCard = $("#source-card");
const objectSelect = $("#object-select") as HTMLSelectElement;
const previewButton = $("#preview-button") as HTMLButtonElement;
const cancelButton = $("#cancel-button") as HTMLButtonElement;
const sampleButton = $("#sample-button") as HTMLButtonElement;
const exportDumpButton = $("#export-dump") as HTMLButtonElement;
const exportMeshButton = $("#export-mesh") as HTMLButtonElement;
const importProgress = $("#import-progress");
const stageStatus = $("#stage-status");
const emptyState = $("#empty-state");
const parameterContainer = $("#parameters");
const groupContainer = $("#groups");
const nodeSearch = $("#node-search") as HTMLInputElement;

let dump: ImportedDump | null = null;
let objects: GnObject[] = [];
let activeObject: GnObject | null = null;
let params: Record<string, number | boolean> = {};
let worker: Worker | null = null;
let workerTimeout = 0;
let runId = 0;
let latestSoup: TriSoup | null = null;
let currentMesh: THREE.Mesh | null = null;
let currentGrid: THREE.GridHelper | null = null;

function humanBytes(value = 0): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function status(message: string, live = false): void {
  stageStatus.innerHTML = live ? `<span class="live">●</span> ${message}` : message;
}

function setBusy(busy: boolean): void {
  importProgress.classList.toggle("active", busy);
  fileInput.disabled = busy;
  sampleButton.disabled = busy;
  previewButton.disabled = busy || !activeObject;
}

function download(name: string, value: BlobPart, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const canvas = $("#preview") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.001, 100000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.75;
room.dispose();
pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x171b25, 1.35));
const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(4, 7, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x80a8ff, 1.25);
rim.position.set(-5, 3, -4);
scene.add(rim);

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
  camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function inputValue(node: RawNode | undefined, identifier: string, fallback: unknown): unknown {
  return node?.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier)?.value ?? fallback;
}

function color(value: unknown, fallback: [number, number, number]): THREE.Color {
  const c = Array.isArray(value) ? value : fallback;
  return new THREE.Color().setRGB(Number(c[0] ?? fallback[0]), Number(c[1] ?? fallback[1]), Number(c[2] ?? fallback[2]));
}

function materialFor(name: string | null): THREE.Material {
  const tree = name && dump?.materials ? dump.materials[name] : undefined;
  const principled = tree?.nodes?.find((node) => node.type === "ShaderNodeBsdfPrincipled");
  const emission = tree?.nodes?.find((node) => node.type === "ShaderNodeEmission");
  if (emission) {
    const c = color(inputValue(emission, "Color", [1, 1, 1, 1]), [1, 1, 1]);
    return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: Number(inputValue(emission, "Strength", 1)), roughness: 1, side: THREE.DoubleSide });
  }
  const alpha = Number(inputValue(principled, "Alpha", 1));
  return new THREE.MeshStandardMaterial({
    color: color(inputValue(principled, "Base Color", [1, 1, 1, 1]), [1, 1, 1]),
    metalness: Number(inputValue(principled, "Metallic", 0)),
    roughness: Number(inputValue(principled, "Roughness", 0.5)),
    emissive: color(inputValue(principled, "Emission Color", [0, 0, 0, 1]), [0, 0, 0]),
    emissiveIntensity: Number(inputValue(principled, "Emission Strength", 1)),
    opacity: alpha,
    transparent: alpha < 1,
    side: THREE.DoubleSide,
  });
}

function disposeCurrent(): void {
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh.geometry.dispose();
    const mats = Array.isArray(currentMesh.material) ? currentMesh.material : [currentMesh.material];
    mats.forEach((material) => material.dispose());
    currentMesh = null;
  }
  if (currentGrid) {
    scene.remove(currentGrid);
    currentGrid.geometry.dispose();
    (currentGrid.material as THREE.Material).dispose();
    currentGrid = null;
  }
}

function showSoup(soup: TriSoup): void {
  disposeCurrent();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  const materials: THREE.Material[] = [];
  for (const [index, group] of soup.groups.entries()) {
    geometry.addGroup(group.start, group.count, index);
    materials.push(materialFor(group.material));
  }
  if (!materials.length) materials.push(materialFor(null));
  currentMesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
  currentMesh.rotation.x = -Math.PI / 2;
  scene.add(currentMesh);
  currentMesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(currentMesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  currentMesh.position.sub(center);
  currentMesh.updateMatrixWorld(true);
  const radius = Math.max(size.length() * 0.5, 0.01);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
  camera.position.set(distance * 0.72, distance * 0.48, distance * 0.92);
  camera.near = Math.max(radius / 1000, 0.0001);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  const gridSize = Math.max(size.x, size.z, radius) * 4;
  currentGrid = new THREE.GridHelper(gridSize, 30, 0x3a424d, 0x1d2229);
  (currentGrid.material as THREE.Material).transparent = true;
  (currentGrid.material as THREE.Material).opacity = 0.42;
  scene.add(currentGrid);
  emptyState.style.display = "none";
}

const intrinsicTypes = new Set([
  "NodeGroupInput", "NodeGroupOutput", "NodeReroute", "NodeFrame", "GeometryNodeGroup",
  "GeometryNodeRepeatInput", "GeometryNodeRepeatOutput", "GeometryNodeSimulationInput", "GeometryNodeSimulationOutput",
]);
const supported = (type: string) => intrinsicTypes.has(type) || REGISTRY.has(type);

function nodeInventory(): { nodes: RawNode[]; unsupported: string[] } {
  if (!dump) return { nodes: [], unsupported: [] };
  const nodes = Object.values(dump.node_groups).flatMap((group) => group.nodes ?? []);
  const unsupportedTypes = [...new Set(nodes.filter((node) => !supported(node.type)).map((node) => node.type))].sort();
  return { nodes, unsupported: unsupportedTypes };
}

function renderGroups(query = ""): void {
  groupContainer.replaceChildren();
  if (!dump) return;
  const needle = query.trim().toLowerCase();
  for (const [name, group] of Object.entries(dump.node_groups)) {
    const nodes = (group.nodes ?? []).filter((node) => !needle || `${name} ${node.name} ${node.type}`.toLowerCase().includes(needle));
    if (!nodes.length && needle) continue;
    const details = document.createElement("details");
    details.className = "group";
    if (name === activeObject?.group || (needle && nodes.length)) details.open = true;
    const summary = document.createElement("summary");
    const groupName = document.createElement("span");
    groupName.className = "group-name";
    groupName.textContent = name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = `${nodes.length} nodes`;
    summary.append(groupName, count);
    const list = document.createElement("div");
    list.className = "node-list";
    for (const node of nodes) {
      const row = document.createElement("div");
      row.className = `node-row${supported(node.type) ? "" : " unsupported"}`;
      const dot = document.createElement("span"); dot.className = "node-dot";
      const label = document.createElement("span"); label.className = "node-name"; label.textContent = node.label || node.name;
      const type = document.createElement("span"); type.className = "node-type"; type.textContent = node.type.replace(/^(GeometryNode|ShaderNode|FunctionNode)/, "");
      row.append(dot, label, type);
      list.append(row);
    }
    details.append(summary, list);
    groupContainer.append(details);
  }
}

function graphObjects(value: ImportedDump): GnObject[] {
  const found: GnObject[] = [];
  for (const object of value.objects ?? []) {
    for (const modifier of object.modifiers ?? []) {
      if (modifier.type === "NODES" && modifier.node_group && value.node_groups[modifier.node_group]) {
        found.push({ ...object, group: modifier.node_group, saved: modifier.input_values ?? {} });
        break;
      }
    }
  }
  return found;
}

function saneRange(item: RawSocket, value: number): [number, number, number] {
  const name = item.name.toLowerCase();
  if (item.socket_type?.includes("Int")) {
    const min = Number.isFinite(item.min_value) && Math.abs(item.min_value!) < 100000 ? item.min_value! : 0;
    const max = Number.isFinite(item.max_value) && Math.abs(item.max_value!) < 100000 ? item.max_value! : Math.max(20, value * 2);
    return [min, max, 1];
  }
  if (item.socket_type?.includes("Factor") || name.includes("factor") || name.includes("divide")) return [0, 1, 0.001];
  let min = Number.isFinite(item.min_value) && Math.abs(item.min_value!) < 1e6 ? item.min_value! : Math.min(0, value * 2);
  let max = Number.isFinite(item.max_value) && Math.abs(item.max_value!) < 1e6 ? item.max_value! : Math.max(1, Math.abs(value) * 3);
  if (max - min > Math.max(10000, Math.abs(value) * 1000)) { min = Math.min(0, value * 2); max = Math.max(1, Math.abs(value) * 3); }
  return [min, max, Math.max((max - min) / 1000, 0.0001)];
}

function renderParameters(): void {
  parameterContainer.replaceChildren();
  if (!dump || !activeObject) return;
  const group = dump.node_groups[activeObject.group];
  const inputs = (group.interface ?? []).filter((item) => item.item_type === "SOCKET" && item.in_out === "INPUT" && item.socket_type !== "NodeSocketGeometry");
  params = {};
  for (const item of inputs) {
    const saved = activeObject.saved[item.name];
    const raw = saved ?? item.default ?? (item.socket_type?.includes("Bool") ? false : 0);
    const value = item.socket_type?.includes("Bool") ? Boolean(raw) : Number(raw) || 0;
    params[item.name] = value;
    const row = document.createElement("div");
    row.className = "param";
    const head = document.createElement("div"); head.className = "param-head";
    const label = document.createElement("label"); label.textContent = item.name;
    const output = document.createElement("output"); output.textContent = typeof value === "boolean" ? (value ? "on" : "off") : String(Number(value.toFixed?.(4) ?? value));
    head.append(label, output);
    row.append(head);
    if (typeof value === "boolean") {
      const control = document.createElement("input"); control.type = "checkbox"; control.checked = value;
      control.addEventListener("change", () => { params[item.name] = control.checked; output.textContent = control.checked ? "on" : "off"; markDirty(); });
      row.append(control);
    } else {
      const [min, max, step] = saneRange(item, value);
      const control = document.createElement("input"); control.type = "range"; control.min = String(min); control.max = String(max); control.step = String(step); control.value = String(value);
      control.addEventListener("input", () => { const next = Number(control.value); params[item.name] = next; output.textContent = String(Number(next.toFixed(4))); markDirty(); });
      row.append(control);
    }
    parameterContainer.append(row);
  }
  $("#parameter-intro").textContent = inputs.length ? `${inputs.length} inputs exposed by ${activeObject.group}.` : "This modifier has no exposed numeric or boolean inputs.";
}

function markDirty(): void {
  if (latestSoup) status("Parameters changed · build preview to apply");
}

function selectObject(index: number): void {
  activeObject = objects[index] ?? null;
  previewButton.disabled = !activeObject;
  $("#stage-object").textContent = activeObject ? `${activeObject.name} · ${activeObject.group}` : "No object selected";
  renderParameters();
  renderGroups(nodeSearch.value);
}

function loadDump(value: ImportedDump, filename: string, bytes: number): void {
  if (!value?.node_groups || typeof value.node_groups !== "object") throw new Error("The JSON file is not a BlendBridge node dump.");
  cancelEvaluation();
  dump = value;
  objects = graphObjects(value);
  latestSoup = null;
  exportMeshButton.disabled = true;
  objectSelect.replaceChildren();
  for (const [index, object] of objects.entries()) {
    const option = document.createElement("option"); option.value = String(index); option.textContent = `${object.name}  ·  ${object.group}`; objectSelect.append(option);
  }
  if (!objects.length) {
    const option = document.createElement("option"); option.textContent = "No Geometry Nodes modifiers found"; objectSelect.append(option);
  }
  objectSelect.disabled = !objects.length;
  exportDumpButton.disabled = false;
  sourceCard.classList.add("visible");
  $("#source-name").textContent = value.import_meta?.filename || filename;
  $("#source-meta").textContent = `${humanBytes(value.import_meta?.bytes ?? bytes)} · Blender ${value.blender_version ?? "unknown"}`;
  $("#file-badge").textContent = filename.toLowerCase().endsWith(".json") ? "JSON" : "BLEND";
  const inventory = nodeInventory();
  $("#metric-objects").textContent = String(objects.length);
  $("#metric-groups").textContent = String(Object.keys(value.node_groups).length);
  $("#metric-nodes").textContent = inventory.nodes.length.toLocaleString();
  $("#metric-materials").textContent = String(Object.keys(value.materials ?? {}).length);
  const compatible = inventory.nodes.filter((node) => supported(node.type)).length;
  const score = inventory.nodes.length ? Math.round(compatible / inventory.nodes.length * 100) : 100;
  $("#compat").hidden = false;
  $("#compat-score").textContent = `${score}%`;
  $("#compat-detail").textContent = `${compatible}/${inventory.nodes.length} nodes recognized`;
  $("#unsupported").textContent = inventory.unsupported.length ? `Fallback node types: ${inventory.unsupported.join(" · ")}` : "All extracted node types are recognized by the runtime.";
  renderGroups();
  selectObject(0);
  status(objects.length ? "Graph extracted · choose an object and build" : "Graph extracted · no runnable Geometry Nodes object found");
  (window as typeof window & { __BLENDBRIDGE__?: unknown }).__BLENDBRIDGE__ = { loaded: true, filename, objects: objects.length, groups: Object.keys(value.node_groups).length, nodes: inventory.nodes.length, compatibility: score };
}

async function importFile(file: File): Promise<void> {
  setBusy(true);
  sourceCard.classList.add("visible");
  $("#source-name").textContent = file.name;
  $("#source-meta").textContent = `${humanBytes(file.size)} · preparing`;
  $("#file-badge").textContent = file.name.toLowerCase().endsWith(".json") ? "JSON" : "BLEND";
  status(file.name.toLowerCase().endsWith(".json") ? "Reading extracted graph…" : "Blender is extracting nodes and materials…", true);
  try {
    let value: ImportedDump;
    if (file.name.toLowerCase().endsWith(".json")) {
      value = JSON.parse(await file.text()) as ImportedDump;
    } else {
      if (isStaticDeploy) throw new Error("Direct .blend extraction needs the local app. Export graph JSON locally, then drop that JSON here.");
      const response = await fetch("/api/blend-import", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Blend-Filename": file.name }, body: file });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status})`);
      value = body as ImportedDump;
    }
    loadDump(value, file.name, file.size);
  } catch (error) {
    status(`Import failed · ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

async function loadSample(): Promise<void> {
  setBusy(true);
  status("Loading the included bin graph…", true);
  try {
    const response = await fetch(publicUrl("dojo/dump_bin.json"));
    if (!response.ok) throw new Error(`Sample failed to load (${response.status})`);
    const value = await response.json() as ImportedDump;
    loadDump(value, "dojo-bin-sample.json", Number(response.headers.get("content-length")) || 0);
  } catch (error) {
    status(`Sample failed · ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

function cancelEvaluation(message = "Evaluation stopped"): void {
  if (worker) worker.terminate();
  worker = null;
  clearTimeout(workerTimeout);
  cancelButton.disabled = true;
  previewButton.disabled = !activeObject;
  if (message) status(message);
}

function buildPreview(): void {
  if (!dump || !activeObject) return;
  cancelEvaluation("");
  const started = performance.now();
  const id = ++runId;
  worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module" });
  cancelButton.disabled = false;
  previewButton.disabled = true;
  status("Evaluating Geometry Nodes in the browser…", true);
  workerTimeout = window.setTimeout(() => cancelEvaluation("Evaluation stopped after the 180 second safety limit"), 180_000);
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    if (event.data.id !== id) return;
    const reply = event.data;
    worker?.terminate(); worker = null; clearTimeout(workerTimeout);
    cancelButton.disabled = true; previewButton.disabled = false;
    if (!reply.ok) { status(`Evaluation failed · ${reply.error.split("\n")[0]}`); return; }
    latestSoup = reply.soup;
    exportMeshButton.disabled = false;
    showSoup(reply.soup);
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    status(`${reply.soup.stats.verts.toLocaleString()} vertices · ${reply.soup.stats.tris.toLocaleString()} triangles · ${elapsed}s`, true);
    $("#stage-mode").textContent = reply.coverage.missingTypes.length ? `${reply.coverage.missingTypes.length} fallback types` : "100% runtime coverage";
    (window as typeof window & { __BLENDBRIDGE__?: Record<string, unknown> }).__BLENDBRIDGE__ = {
      ...((window as typeof window & { __BLENDBRIDGE__?: Record<string, unknown> }).__BLENDBRIDGE__ ?? {}),
      preview: { object: activeObject?.name, ...reply.soup.stats, seconds: Number(elapsed), missing: reply.coverage.missingTypes.length },
    };
  };
  worker.onerror = (event) => { cancelEvaluation(`Evaluation worker failed · ${event.message}`); };
  worker.postMessage({ id, dump, object: activeObject.name, overrides: params });
}

dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") fileInput.click(); });
for (const name of ["dragenter", "dragover"]) dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("drag"); });
for (const name of ["dragleave", "drop"]) dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("drag"); });
dropzone.addEventListener("drop", (event) => { const file = (event as DragEvent).dataTransfer?.files[0]; if (file) void importFile(file); });
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void importFile(file); fileInput.value = ""; });
sampleButton.addEventListener("click", () => void loadSample());
objectSelect.addEventListener("change", () => selectObject(Number(objectSelect.value)));
previewButton.addEventListener("click", buildPreview);
cancelButton.addEventListener("click", () => cancelEvaluation());
nodeSearch.addEventListener("input", () => renderGroups(nodeSearch.value));
exportDumpButton.addEventListener("click", () => {
  if (!dump) return;
  const base = (dump.import_meta?.filename ?? "blend-graph").replace(/\.blend$/i, "").replace(/[^a-z0-9._-]+/gi, "-");
  download(`${base}.nodes.json`, JSON.stringify(dump));
});
exportMeshButton.addEventListener("click", () => {
  if (!latestSoup || !activeObject) return;
  download(`${activeObject.name.replace(/[^a-z0-9._-]+/gi, "-")}.mesh.json`, JSON.stringify({
    positions: Array.from(latestSoup.positions), normals: Array.from(latestSoup.normals), indices: Array.from(latestSoup.indices), groups: latestSoup.groups, stats: latestSoup.stats, object: activeObject.name, overrides: params,
  }));
});
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${button.dataset.tab}`));
}));

if (isStaticDeploy) {
  const el = $("#health");
  el.classList.add("bad");
  el.querySelector("span:last-child")!.textContent = "Static demo · graph JSON supported";
} else void fetch("/api/blend-import/health").then((response) => response.json()).then((health) => {
  const el = $("#health");
  el.classList.add(health.available ? "ok" : "bad");
  el.querySelector("span:last-child")!.textContent = health.available ? "Blender ready · local only" : "Blender not found";
}).catch(() => {
  const el = $("#health"); el.classList.add("bad"); el.querySelector("span:last-child")!.textContent = "Import service unavailable";
});
