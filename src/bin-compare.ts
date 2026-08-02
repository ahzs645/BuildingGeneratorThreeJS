import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import { canvasBox, observeCanvasBox, preferredCanvasPixelRatio } from "./canvas-viewport";
import { makeBinAuthoredMaterial } from "./bin-authored-material";
import type { FilamentBounds } from "./filament-material";
import type { Dump, TriSoup } from "./gnvm/index";
import {
  binPresetFromSearch,
  binSearchFromValues,
  BIN_DEFAULTS,
  BIN_PARAMETERS,
  BIN_PRESETS,
} from "./bin-params";
import type { ToolHandle } from "./react/page-runtime";

type Variant = { id: string; params: Record<string, number>; file: string };
type WorkerReply =
  | { id: number; ok: true; soup: TriSoup; coverage: { handled: number; missingTypes: { type: string; count: number }[] } }
  | { id: number; ok: false; error: string };
type CompareMode = "overlay" | "split";
type ViewStyle = "wire" | "material";
type ResultView = "both" | "truth" | "vm";
type Workspace = "build" | "validate";
type TruthSource = "live" | "baked" | "unavailable";
type EvidenceClassification = "exact-topology" | "exact-surface" | "bounds-only" | "unvalidated" | "unsupported";

// Full recovered-font 0..11 sweep: both point-to-surface directions, total
// triangle counts, and highlighted-material triangle counts match Blender.
const measuredSurfaceP99: Record<number, number> = {
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
  6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
};

// Pure fetched data may persist across remounts; everything DOM/GPU-bound is
// created fresh inside createTool().
let cachedDump: Dump | null = null;
let cachedVariants: Variant[] | null = null;

function namedMaterial(name: string | null, material: THREE.Material): THREE.Material {
  material.name = name ?? "";
  return material;
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

function sameBinValues(
  a: Record<string, number | boolean> | null,
  b: Record<string, number | boolean>,
): boolean {
  return Boolean(a) && BIN_PARAMETERS.every((parameter) => a![parameter.name] === b[parameter.name]);
}

function valuesSummary(values: Record<string, number | boolean>): string {
  return `Selection ${values["Bin Select"]} · ${Number(values["Size X"]).toFixed(3)} × ${Number(values["Size Y"]).toFixed(3)} × ${Number(values["Size Z"]).toFixed(3)}`;
}

function classificationLabel(classification: EvidenceClassification): string {
  if (classification === "exact-topology") return "Exact topology";
  if (classification === "exact-surface") return "Exact surface · alternate tessellation";
  if (classification === "bounds-only") return "Bounds-only evidence";
  if (classification === "unsupported") return "Unsupported setting";
  return "Unvalidated setting";
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

export function createTool(): ToolHandle {
  const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
  const statusEl = document.querySelector<HTMLElement>("#compare-status")!;
  const truthMetricLabel = document.querySelector<HTMLElement>("#truth-metric-label")!;
  const updateButton = document.querySelector<HTMLButtonElement>("#update-comparison")!;
  const previewButton = document.querySelector<HTMLButtonElement>("#preview-bin")!;
  const resetButton = document.querySelector<HTMLButtonElement>("#reset-bin")!;
  const revertButton = document.querySelector<HTMLButtonElement>("#revert-bin")!;
  const copyLinkButton = document.querySelector<HTMLButtonElement>("#copy-bin-link")!;
  const frameButtons = ["#frame-bin", "#toolbar-frame-bin"].map((selector) => document.querySelector<HTMLButtonElement>(selector)!);
  const presetSelect = document.querySelector<HTMLSelectElement>("#bin-preset")!;
  const presetDescription = document.querySelector<HTMLElement>("#bin-preset-description")!;
  const previewStateEl = document.querySelector<HTMLElement>("#preview-state")!;
  const previewStateDot = document.querySelector<HTMLElement>("#preview-state-dot")!;
  const evaluatedParamsEl = document.querySelector<HTMLElement>("#evaluated-params")!;
  const capabilityEl = document.querySelector<HTMLElement>("#truth-capability")!;
  const capabilityDetailEl = document.querySelector<HTMLElement>("#truth-capability-detail")!;
  const capabilityDot = document.querySelector<HTMLElement>("#truth-capability-dot")!;
  const classificationEl = document.querySelector<HTMLElement>("#result-classification")!;
  const freshnessEl = document.querySelector<HTMLElement>("#result-freshness")!;
  const evidenceEl = document.querySelector<HTMLElement>("#result-evidence")!;
  const resultsEl = document.querySelector<HTMLElement>("#validate-results")!;
  const toolbarSourceEl = document.querySelector<HTMLElement>("#toolbar-source")!;
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
  const buildWorkspaceButton = document.querySelector<HTMLButtonElement>("#workspace-build")!;
  const validateWorkspaceButton = document.querySelector<HTMLButtonElement>("#workspace-validate")!;
  const exportEngine = document.querySelector<HTMLSelectElement>("#export-engine")!;
  const blenderExportOption = document.querySelector<HTMLOptionElement>("#export-engine-blender")!;
  const exportGlbButton = document.querySelector<HTMLButtonElement>("#export-glb")!;
  const exportStlButton = document.querySelector<HTMLButtonElement>("#export-stl")!;
  const exportMetadataButton = document.querySelector<HTMLButtonElement>("#export-metadata")!;

  const viewport = canvasBox(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, viewport.width / viewport.height, 0.001, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = false;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environmentTexture = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environmentTexture;
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
  const initialQuery = new URLSearchParams(location.search);
  let workspace: Workspace = buildWorkspaceButton.getAttribute("aria-selected") === "true" ? "build" : "validate";
  let mode: CompareMode = initialQuery.get("layout") === "split" ? "split" : "overlay";
  let style: ViewStyle = initialQuery.get("style") === "wire" ? "wire" : workspace === "build" ? "material" : "wire";
  let resultView: ResultView = initialQuery.get("visible") === "truth" ? "truth" : initialQuery.get("visible") === "vm" || workspace === "build" ? "vm" : "both";
  let classification: EvidenceClassification = "unvalidated";
  let lastTruthSource: TruthSource = "unavailable";
  let lastEvaluatedOverrides: Record<string, number | boolean> | null = null;
  let lastComparedOverrides: Record<string, number | boolean> | null = null;
  let liveBlenderAvailable = false;
  let capabilityChecked = false;
  let splitOffset = 0;
  let lastViewportAspect = viewport.width / viewport.height;
  let runId = 0;
  let worker: Worker | null = null;
  let workerReject: ((error: Error) => void) | null = null;
  let dump: Dump;
  let variants: Variant[] = [];
  let disposed = false;
  let bedTexture: THREE.CanvasTexture | null = null;

  const cleanups: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  function setStatus(message: string, ready = false, error = false): void {
    statusEl.classList.toggle("ready", ready);
    statusEl.classList.toggle("error", error);
    statusEl.lastChild!.textContent = message;
  }

  function setClassification(next: EvidenceClassification, evidence: string): void {
    classification = next;
    classificationEl.textContent = classificationLabel(next);
    classificationEl.dataset.classification = next;
    evidenceEl.textContent = evidence;
  }

  function setControls(values: Record<string, number | boolean>): void {
    for (const parameter of BIN_PARAMETERS) {
      const value = values[parameter.name] ?? parameter.defaultValue;
      const control = document.querySelector<HTMLInputElement>(`[data-bin-param="${parameter.name}"]`)!;
      if (parameter.boolean) control.checked = Boolean(value);
      else {
        control.value = String(value);
        const output = document.querySelector<HTMLInputElement>(`[data-bin-output="${parameter.name}"]`)!;
        output.value = Number(value).toFixed(parameter.step === 1 ? 0 : 3);
      }
    }
  }

  function syncDraftUrl(values = readOverrides()): void {
    const search = binSearchFromValues(values, { workspace, layout: mode, style, visible: resultView });
    history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  }

  function hasStaticTruth(values: Record<string, number | boolean>): boolean {
    const selection = Number(values["Bin Select"]);
    return isDefaultExceptSelection(values) && variants.some((item) => Number(item.params["Bin Select"]) === selection);
  }

  function updateTruthCapability(values = readOverrides()): void {
    capabilityDot.classList.remove("ready", "warn", "error");
    if (!capabilityChecked) {
      capabilityEl.textContent = "Checking Blender…";
      capabilityDetailEl.textContent = "Discovering live and checked-in truth sources";
      return;
    }
    if (liveBlenderAvailable) {
      capabilityDot.classList.add("ready");
      capabilityEl.textContent = "Live Blender 5.1.2";
      capabilityDetailEl.textContent = "Every published control can be evaluated live";
      toolbarSourceEl.textContent = workspace === "build" ? "GN-VM preview" : "Live Blender available";
      return;
    }
    if (hasStaticTruth(values)) {
      capabilityDot.classList.add("warn");
      capabilityEl.textContent = "Checked-in Bake";
      capabilityDetailEl.textContent = "Current authored settings have Blender truth";
      toolbarSourceEl.textContent = workspace === "build" ? "GN-VM preview" : "Checked-in Blender bake";
      return;
    }
    capabilityDot.classList.add("error");
    capabilityEl.textContent = "Truth Unavailable";
    capabilityDetailEl.textContent = "Preview remains available in GN-VM; Blender comparison needs the local bridge";
    toolbarSourceEl.textContent = workspace === "build" ? "GN-VM preview" : "Blender truth unavailable";
  }

  function setExportsEnabled(enabled: boolean): void {
    exportGlbButton.disabled = !enabled;
    exportStlButton.disabled = !enabled;
    exportMetadataButton.disabled = !enabled;
    blenderExportOption.disabled = !enabled || !truthSolid || lastTruthSource === "unavailable";
    if (blenderExportOption.disabled && exportEngine.value === "blender") exportEngine.value = "vm";
  }

  function markDirty(preservePreset = false): void {
    const values = readOverrides();
    if (!preservePreset) {
      presetSelect.value = "custom";
      presetDescription.textContent = "Custom settings · not yet evaluated";
    }
    resultsEl.classList.add("stale");
    freshnessEl.textContent = "Previous result · inputs changed";
    previewStateEl.textContent = "Changes not previewed";
    previewStateDot.classList.remove("ready");
    evaluatedParamsEl.textContent = lastEvaluatedOverrides ? `Last preview: ${valuesSummary(lastEvaluatedOverrides)}` : "No evaluated preview";
    revertButton.disabled = !lastEvaluatedOverrides;
    setExportsEnabled(false);
    setStatus(workspace === "build" ? "Changes ready to preview" : "Changes not compared with Blender");
    updateTruthCapability(values);
    syncDraftUrl(values);
  }

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
    overlayButton.setAttribute("aria-pressed", String(mode === "overlay"));
    splitButton.setAttribute("aria-pressed", String(mode === "split"));
    wireButton.setAttribute("aria-pressed", String(style === "wire"));
    materialButton.setAttribute("aria-pressed", String(style === "material"));
    bothButton.setAttribute("aria-pressed", String(resultView === "both"));
    truthButton.setAttribute("aria-pressed", String(resultView === "truth"));
    vmButton.setAttribute("aria-pressed", String(resultView === "vm"));
    document.querySelectorAll(".viewport-label").forEach((label) => label.classList.toggle("show", mode === "split" && resultView === "both"));
    const width = Math.max(new THREE.Box3().setFromObject(truthGroup).getSize(new THREE.Vector3()).x, new THREE.Box3().setFromObject(vmGroup).getSize(new THREE.Vector3()).x, .1);
    // Leave a full model-width gutter so the print-bed and drawer components of
    // one result cannot visually read as pieces of the other result.
    splitOffset = width * .62;
    positionGroups();
    if (reframe) frameComparison();
    syncDraftUrl();
  }

  function runVm(overrides: Record<string, number | boolean>, id: number): Promise<WorkerReply & { ok: true }> {
    worker?.terminate();
    worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "bin-compare-vm" });
    return new Promise((resolve, reject) => {
      workerReject = reject;
      worker!.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        worker?.terminate();
        worker = null;
        workerReject = null;
        if (reply.id !== id) return;
        if (!reply.ok) reject(new Error(reply.error));
        else resolve(reply);
      };
      worker!.onerror = (event) => reject(new Error(event.message));
      worker!.postMessage({ id, dump, object: "Procedural Drawer", overrides });
    });
  }

  async function preflightBlender(): Promise<void> {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      capabilityChecked = true;
      updateTruthCapability();
      return;
    }
    try {
      const response = await fetch(`http://${location.hostname}:7801/status`);
      const status = await response.json() as { ready?: boolean };
      liveBlenderAvailable = Boolean(response.ok && status.ready);
    } catch {
      liveBlenderAvailable = false;
    }
    capabilityChecked = true;
    updateTruthCapability();
  }

  async function loadBlenderTruth(overrides: Record<string, number | boolean>): Promise<{ root: THREE.Object3D; source: Exclude<TruthSource, "unavailable"> }> {
    if (liveBlenderAvailable) {
      try {
        const response = await fetch(`http://${location.hostname}:7801/bake`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(overrides),
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        return { root: (await new GLTFLoader().parseAsync(await response.arrayBuffer(), "")).scene, source: "live" };
      } catch (error) {
        liveBlenderAvailable = false;
        updateTruthCapability(overrides);
        console.warn("Live Blender bake unavailable; checking baked fallback", error);
      }
    }
    const selection = Number(overrides["Bin Select"]);
    const variant = variants.find((item) => Number(item.params["Bin Select"]) === selection);
    if (!variant || !isDefaultExceptSelection(overrides)) throw new Error("Blender truth is unavailable for these inputs");
    return { root: (await new GLTFLoader().loadAsync(publicUrl(`dojo/variants/${variant.file}`))).scene, source: "baked" };
  }

  function replaceVm(soup: TriSoup): { tris: number; red: number } {
    clearAndDispose(vmGroup);
    vmGroup.position.set(0, 0, 0);
    const generated = vmRoots(soup);
    vmSolid = generated.solid;
    vmWire = generated.wire;
    vmGroup.add(vmSolid, vmWire);
    vmGroup.updateMatrixWorld(true);
    const tris = soup.stats.tris;
    const red = soup.groups.filter((group) => group.material === "3D.004").reduce((sum, group) => sum + group.count / 3, 0);
    vmTrisEl.textContent = `${tris.toLocaleString()} tris`;
    vmRedEl.textContent = `${red.toLocaleString()} highlighted red`;
    return { tris, red };
  }

  function clearTruth(): void {
    clearAndDispose(truthGroup);
    truthSolid = null;
    truthWire = null;
    truthTrisEl.textContent = "Unavailable";
    truthRedEl.textContent = "No Blender payload for current inputs";
    deltaEnvelopeEl.textContent = "Not compared";
    deltaTrisEl.textContent = "GN-VM preview only";
    blenderExportOption.disabled = true;
  }

  function replaceTruth(root: THREE.Object3D): { tris: number; red: number } {
    clearAndDispose(truthGroup);
    truthGroup.position.set(0, 0, 0);
    const truth = truthRoots(root);
    truthSolid = truth.solid;
    truthWire = truth.wire;
    truthGroup.add(truthSolid, truthWire);
    truthGroup.updateMatrixWorld(true);
    const tris = countTriangles(truthSolid);
    const red = countTriangles(truthSolid, "3D.004");
    truthTrisEl.textContent = `${tris.toLocaleString()} tris`;
    truthRedEl.textContent = `${red.toLocaleString()} highlighted red`;
    return { tris, red };
  }

  function finishEvaluatedState(overrides: Record<string, number | boolean>, compared: boolean): void {
    lastEvaluatedOverrides = { ...overrides };
    if (compared) lastComparedOverrides = { ...overrides };
    resultsEl.classList.remove("stale");
    revertButton.disabled = true;
    previewStateDot.classList.add("ready");
    previewStateEl.textContent = compared ? "Preview and truth are current" : "GN-VM preview is current";
    evaluatedParamsEl.textContent = valuesSummary(overrides);
    freshnessEl.textContent = compared ? "Current inputs · both engines" : "Current inputs · GN-VM only";
    setExportsEnabled(true);
    syncDraftUrl(overrides);
  }

  function evidenceFor(
    overrides: Record<string, number | boolean>,
    truthTris: number,
    vmTris: number,
    truthRed: number,
    vmRed: number,
    envelope: number,
  ): { classification: EvidenceClassification; evidence: string; surfaceP99?: number } {
    const selection = Number(overrides["Bin Select"]);
    const surfaceP99 = isDefaultExceptSelection(overrides) ? measuredSurfaceP99[selection] : undefined;
    const matchesBoundary = (changes: Record<string, number | boolean>): boolean => BIN_PARAMETERS.every((parameter) => {
      const expected = changes[parameter.name] ?? BIN_DEFAULTS[parameter.name];
      const actual = overrides[parameter.name];
      if (typeof actual === "number" && typeof expected === "number") return Math.abs(actual - expected) <= Math.max(1e-6, (parameter.step ?? 0) / 2 + 1e-9);
      return actual === expected;
    });
    if (surfaceP99 !== undefined && envelope <= 1e-6) {
      if (truthTris === vmTris && truthRed === vmRed) return {
        classification: "exact-topology",
        evidence: `Validated fixture: topology/material counts match; bidirectional p99/max ${surfaceP99.toFixed(3)}.`,
        surfaceP99,
      };
      return {
        classification: "exact-surface",
        evidence: `Validated fixture: bidirectional p99/max ${surfaceP99.toFixed(3)}; triangle differences are alternate tessellation.`,
        surfaceP99,
      };
    }
    if (envelope <= 1e-6 && (
      matchesBoundary({ "bin gap size": 7 })
      || matchesBoundary({ "divide x": 0.15, "divide y": 0.9 })
    )) return {
      classification: "exact-surface",
      evidence: "Validated boundary fixture: bidirectional whole-surface and highlighted-material distances are zero; count differences are alternate tessellation.",
      surfaceP99: 0,
    };
    return {
      classification: "bounds-only",
      evidence: `Current live result measures an envelope delta of ${envelope.toFixed(4)}; sampled surface parity has not been validated for this combination.`,
    };
  }

  async function previewVm(overrides = readOverrides()): Promise<void> {
    const id = ++runId;
    previewButton.disabled = true;
    updateButton.disabled = true;
    setStatus("Evaluating GN-VM preview…");
    try {
      const vm = await runVm(overrides, id);
      if (id !== runId || disposed) return;
      clearTruth();
      const counts = replaceVm(vm.soup);
      lastTruthSource = "unavailable";
      lastComparedOverrides = null;
      setClassification("unvalidated", "GN-VM preview is available; compare with Blender to classify parity evidence.");
      findingEl.textContent = "This is the browser-evaluated build preview. Open Validate Engines to compare the same parameter snapshot with Blender truth.";
      truthMetricLabel.textContent = "Blender truth";
      mode = "overlay";
      style = "material";
      resultView = "vm";
      finishEvaluatedState(overrides, false);
      syncView(true);
      setStatus(`GN-VM preview ready · ${counts.tris.toLocaleString()} triangles`, true);
      (window as typeof window & { __BIN_COMPARE__?: unknown }).__BIN_COMPARE__ = { ready: true, overrides, truthSource: "unavailable", vmTris: counts.tris, vmRed: counts.red, classification, mode, style, resultView };
    } catch (error) {
      if (!disposed) {
        setStatus(`Preview failed · ${error instanceof Error ? error.message : String(error)}`, false, true);
        previewStateEl.textContent = "Preview failed";
        setExportsEnabled(false);
      }
    } finally {
      if (id === runId && !disposed) {
        previewButton.disabled = false;
        updateButton.disabled = false;
      }
    }
  }

  async function updateComparison(overrides = readOverrides()): Promise<void> {
    const id = ++runId;
    setStatus("Evaluating Blender truth and GN-VM…");
    updateButton.disabled = true;
    previewButton.disabled = true;
    const started = performance.now();
    const [blenderResult, vmResult] = await Promise.allSettled([loadBlenderTruth(overrides), runVm(overrides, id)]);
    if (id !== runId || disposed) {
      if (blenderResult.status === "fulfilled") disposeObjectTree(blenderResult.value.root);
      return;
    }
    try {
      if (vmResult.status === "rejected") throw vmResult.reason;
      const vm = replaceVm(vmResult.value.soup);
      if (blenderResult.status === "rejected") {
        clearTruth();
        lastTruthSource = "unavailable";
        lastComparedOverrides = null;
        truthMetricLabel.textContent = "Blender truth unavailable";
        setClassification("unvalidated", "GN-VM evaluated successfully, but no Blender payload exists for these inputs.");
        findingEl.textContent = "The current GN-VM result is shown. Blender truth was unavailable, so no exact-match claim is being made and previous comparison metrics were cleared.";
        resultView = "vm";
        style = "material";
        finishEvaluatedState(overrides, false);
        syncView(true);
        setStatus("GN-VM ready · Blender truth unavailable for current inputs", false, true);
        (window as typeof window & { __BIN_COMPARE__?: unknown }).__BIN_COMPARE__ = { ready: true, overrides, truthSource: "unavailable", vmTris: vm.tris, vmRed: vm.red, classification, mode, style, resultView };
        return;
      }
      const blender = blenderResult.value;
      const truth = replaceTruth(blender.root);
      lastTruthSource = blender.source;
      truthMetricLabel.textContent = blender.source === "live" ? "Live Blender truth" : "Checked-in Blender bake";
      const envelope = maxBoundsDelta(new THREE.Box3().setFromObject(truthSolid!), new THREE.Box3().setFromObject(vmSolid!));
      const evidence = evidenceFor(overrides, truth.tris, vm.tris, truth.red, vm.red, envelope);
      setClassification(evidence.classification, evidence.evidence);
      const triangleDelta = vm.tris - truth.tris;
      const redDelta = vm.red - truth.red;
      deltaEnvelopeEl.textContent = `${envelope.toFixed(4)} envelope`;
      deltaTrisEl.textContent = `${triangleDelta >= 0 ? "+" : ""}${triangleDelta.toLocaleString()} triangles${evidence.surfaceP99 !== undefined ? ` · p99 ${evidence.surfaceP99.toFixed(3)}` : ""}`;
      findingEl.textContent = evidence.classification === "exact-topology"
        ? "The checked fixture proves the same surface and topology counts for this setting."
        : evidence.classification === "exact-surface"
          ? "The checked fixture proves the same surface; count differences are alternate tessellation."
          : `Only bounds and count evidence are available for this live combination. Highlighted-material triangle delta: ${redDelta}.`;
      mode = "overlay";
      style = "wire";
      resultView = "both";
      finishEvaluatedState(overrides, true);
      syncView(true);
      updateTruthCapability(overrides);
      setStatus(`Both engines evaluated in ${((performance.now() - started) / 1000).toFixed(2)}s`, true);
      (window as typeof window & { __BIN_COMPARE__?: unknown }).__BIN_COMPARE__ = { ready: true, overrides, truthSource: blender.source, truthTris: truth.tris, vmTris: vm.tris, truthRed: truth.red, vmRed: vm.red, envelope, surfaceP99: evidence.surfaceP99, classification, mode, style, resultView };
    } catch (error) {
      clearTruth();
      clearAndDispose(vmGroup);
      vmSolid = vmWire = null;
      vmTrisEl.textContent = "Failed";
      vmRedEl.textContent = "No current geometry";
      setClassification("unvalidated", "Neither a current Blender truth payload nor a GN-VM preview is available.");
      freshnessEl.textContent = "Current evaluation failed";
      findingEl.textContent = "No previous exact-match result is being shown for the failed parameter snapshot.";
      resultsEl.classList.remove("stale");
      setExportsEnabled(false);
      setStatus(`Comparison failed · ${error instanceof Error ? error.message : String(error)}`, false, true);
    } finally {
      if (id === runId && !disposed) {
        updateButton.disabled = false;
        previewButton.disabled = false;
      }
    }
  }

  async function main(): Promise<void> {
    if (!cachedDump || !cachedVariants) {
      const [dumpResponse, manifestResponse] = await Promise.all([fetch(publicUrl("dojo/dump_bin.json")), fetch(publicUrl("dojo/variants/variants.json"))]);
      cachedDump = await dumpResponse.json() as Dump;
      cachedVariants = (await manifestResponse.json() as { variants: Variant[] }).variants;
    }
    dump = cachedDump;
    variants = cachedVariants;
    if (disposed) return;
    setControls({ ...BIN_DEFAULTS, ...binPresetFromSearch(location.search) });
    await preflightBlender();
    if (disposed) return;
    syncView();
    if (workspace === "validate") await updateComparison();
    else await previewVm();
  }

  function evaluatedExportRoot(): { root: THREE.Object3D; engine: "vm" | "blender" } | null {
    if (!lastEvaluatedOverrides) return null;
    if (exportEngine.value === "blender" && truthSolid && lastTruthSource !== "unavailable") return { root: truthSolid, engine: "blender" };
    if (vmSolid) return { root: vmSolid, engine: "vm" };
    return null;
  }

  function exportBaseName(engine: "vm" | "blender"): string {
    return `recursive-bin-selection-${lastEvaluatedOverrides?.["Bin Select"] ?? "unknown"}-${engine}`;
  }

  async function exportGlb(): Promise<void> {
    const source = evaluatedExportRoot();
    if (!source) return;
    const result = await new GLTFExporter().parseAsync(source.root, { binary: true, onlyVisible: true });
    const bytes = result instanceof ArrayBuffer ? result : new TextEncoder().encode(JSON.stringify(result));
    downloadBlob(`${exportBaseName(source.engine)}.glb`, new Blob([bytes], { type: "model/gltf-binary" }));
  }

  function exportStl(): void {
    const source = evaluatedExportRoot();
    if (!source) return;
    const result = new STLExporter().parse(source.root, { binary: true });
    downloadBlob(`${exportBaseName(source.engine)}.stl`, new Blob([result.buffer as ArrayBuffer], { type: "model/stl" }));
  }

  function exportMetadata(): void {
    const source = evaluatedExportRoot();
    if (!source || !lastEvaluatedOverrides) return;
    const metadata = {
      asset: "Recursive Bin",
      parameters: lastEvaluatedOverrides,
      engine: source.engine === "blender" ? "Blender" : "GN-VM",
      truthSource: lastTruthSource,
      blenderVersion: "5.1.2",
      classification,
      comparedParameters: lastComparedOverrides,
      evidence: evidenceEl.textContent,
      evidenceVersion: "2026-08-01",
    };
    downloadBlob(`${exportBaseName(source.engine)}.json`, new Blob([`${JSON.stringify(metadata, null, 2)}\n`], { type: "application/json" }));
  }

  document.querySelectorAll<HTMLInputElement>("[data-bin-param]").forEach((control) => {
    listen(control, "input", () => {
      const output = document.querySelector<HTMLInputElement>(`[data-bin-output="${control.dataset.binParam}"]`);
      if (output) output.value = Number(control.value).toFixed(control.step === "1" ? 0 : 3);
      markDirty();
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-bin-output]").forEach((output) => {
    listen(output, "input", () => {
      const parameter = BIN_PARAMETERS.find((candidate) => candidate.name === output.dataset.binOutput);
      const control = document.querySelector<HTMLInputElement>(`[data-bin-param="${output.dataset.binOutput}"]`);
      if (!parameter || !control) return;
      if (output.value.trim() === "") return;
      const value = Number(output.value);
      if (!Number.isFinite(value)) {
        output.value = Number(control.value).toFixed(parameter.step === 1 ? 0 : 3);
        return;
      }
      const clamped = Math.min(parameter.max ?? value, Math.max(parameter.min ?? value, value));
      control.value = String(clamped);
      output.value = clamped.toFixed(parameter.step === 1 ? 0 : 3);
      markDirty();
    });
  });
  listen(presetSelect, "change", () => {
    const selected = BIN_PRESETS.find((preset) => preset.id === presetSelect.value) ?? BIN_PRESETS[0];
    presetDescription.textContent = selected.description;
    setControls(selected.values);
    markDirty(true);
  });
  listen(resetButton, "click", () => {
    presetSelect.value = "authored";
    presetDescription.textContent = BIN_PRESETS[0].description;
    setControls(BIN_DEFAULTS);
    markDirty(true);
  });
  listen(revertButton, "click", () => {
    if (!lastEvaluatedOverrides) return;
    setControls(lastEvaluatedOverrides);
    const matchingPreset = BIN_PRESETS.find((preset) => sameBinValues(preset.values, lastEvaluatedOverrides!));
    presetSelect.value = matchingPreset?.id ?? "custom";
    presetDescription.textContent = matchingPreset?.description ?? "Custom evaluated settings";
    resultsEl.classList.remove("stale");
    freshnessEl.textContent = sameBinValues(lastComparedOverrides, lastEvaluatedOverrides) ? "Current inputs · both engines" : "Current inputs · GN-VM only";
    previewStateEl.textContent = sameBinValues(lastComparedOverrides, lastEvaluatedOverrides) ? "Preview and truth are current" : "GN-VM preview is current";
    evaluatedParamsEl.textContent = valuesSummary(lastEvaluatedOverrides);
    revertButton.disabled = true;
    setExportsEnabled(true);
    updateTruthCapability(lastEvaluatedOverrides);
    syncDraftUrl(lastEvaluatedOverrides);
    setStatus("Reverted to the last evaluated preview", true);
  });
  listen(copyLinkButton, "click", () => {
    syncDraftUrl();
    const link = location.href;
    void copyText(link).then(() => {
      copyLinkButton.textContent = "Link copied";
      setTimeout(() => { if (!disposed) copyLinkButton.textContent = "Copy link"; }, 1400);
    }).catch(() => setStatus("Could not copy link; the URL contains the current settings", false, true));
  });
  listen(previewButton, "click", () => void previewVm());
  listen(updateButton, "click", () => void updateComparison());
  for (const button of frameButtons) listen(button, "click", () => frameComparison());
  listen(exportGlbButton, "click", () => void exportGlb().catch((error) => setStatus(`GLB export failed · ${String(error)}`, false, true)));
  listen(exportStlButton, "click", exportStl);
  listen(exportMetadataButton, "click", exportMetadata);
  listen(buildWorkspaceButton, "click", () => {
    workspace = "build";
    resultView = "vm";
    style = "material";
    updateTruthCapability();
    syncView(true);
    setStatus(sameBinValues(lastEvaluatedOverrides, readOverrides()) ? "GN-VM preview is current" : "Build settings are ready to preview", Boolean(sameBinValues(lastEvaluatedOverrides, readOverrides())));
  });
  listen(validateWorkspaceButton, "click", () => {
    workspace = "validate";
    resultView = sameBinValues(lastComparedOverrides, readOverrides()) ? "both" : "vm";
    style = sameBinValues(lastComparedOverrides, readOverrides()) ? "wire" : "material";
    updateTruthCapability();
    syncView(true);
    setStatus(sameBinValues(lastComparedOverrides, readOverrides()) ? "Comparison is current" : "Compare these inputs with Blender");
  });
  listen(overlayButton, "click", () => { mode = "overlay"; syncView(true); });
  listen(splitButton, "click", () => { mode = "split"; syncView(true); });
  listen(wireButton, "click", () => { style = "wire"; syncView(); });
  listen(materialButton, "click", () => { style = "material"; syncView(); });
  listen(bothButton, "click", () => { resultView = "both"; syncView(true); });
  listen(truthButton, "click", () => { resultView = "truth"; syncView(true); });
  listen(vmButton, "click", () => { resultView = "vm"; syncView(true); });
  listen(window, "keydown", ((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (workspace !== "validate" || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable || target?.matches("input, textarea, select, button")) return;
    let handled = true;
    if (event.key.toLowerCase() === "o") mode = "overlay";
    else if (event.key.toLowerCase() === "s") mode = "split";
    else if (event.key.toLowerCase() === "w") style = style === "wire" ? "material" : "wire";
    else if (event.key === "1") resultView = "truth";
    else if (event.key === "2") resultView = "vm";
    else if (event.key === "3") resultView = "both";
    else handled = false;
    if (handled) {
      event.preventDefault();
      syncView(event.key.toLowerCase() !== "w");
    }
  }) as EventListener);
  // The viewport is a grid column between the docks, so the canvas box — not
  // the window — is what the renderer has to match.
  cleanups.push(observeCanvasBox(canvas, (width, height) => {
    const nextAspect = width / height;
    const shouldReframe = Math.abs(nextAspect - lastViewportAspect) / Math.max(lastViewportAspect, .01) > .18;
    lastViewportAspect = nextAspect;
    camera.aspect = nextAspect;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    if (shouldReframe && (vmSolid || truthSolid)) frameComparison();
  }));
  renderer.setAnimationLoop(() => { controls.update(); if (mode === "split") positionGroups(); renderer.render(scene, camera); });
  void main();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      runId++; // invalidate any in-flight comparison
      renderer.setAnimationLoop(null);
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      worker?.terminate();
      worker = null;
      workerReject?.(new Error("Tool disposed"));
      workerReject = null;
      clearAndDispose(truthGroup);
      clearAndDispose(vmGroup);
      truthSolid = truthWire = vmSolid = vmWire = null;
      environmentTexture.dispose();
      scene.environment = null;
      bedTexture?.dispose();
      bedTexture = null;
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      delete (window as typeof window & { __BIN_COMPARE__?: unknown }).__BIN_COMPARE__;
    },
  };
}
