import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

declare module "three" {
  interface BufferGeometry { computeBoundsTree: typeof computeBoundsTree; disposeBoundsTree: typeof disposeBoundsTree }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

type Sample = { point: THREE.Vector3; normal: THREE.Vector3; areaUv?: [number, number] };
type Stroke = Sample[];
type CrayonLayout = { stroke: Stroke; start: number; length: number };
type DrawingArea = { center: THREE.Vector3; normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; size: number };
type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

const canvas = document.querySelector<HTMLCanvasElement>("#surface-canvas")!;
const fileInput = document.querySelector<HTMLInputElement>("#surface-file")!;
const fileName = document.querySelector<HTMLElement>("#surface-file-name")!;
const status = document.querySelector<HTMLElement>("#surface-status")!;
const orbitButton = document.querySelector<HTMLButtonElement>("#surface-orbit")!;
const areaButton = document.querySelector<HTMLButtonElement>("#surface-area")!;
const drawButton = document.querySelector<HTMLButtonElement>("#surface-draw")!;
const demoButton = document.querySelector<HTMLButtonElement>("#surface-demo")!;
const flatButton = document.querySelector<HTMLButtonElement>("#surface-flat")!;
const sampleButton = document.querySelector<HTMLButtonElement>("#surface-sample")!;
const parityPathButton = document.querySelector<HTMLButtonElement>("#surface-parity-path")!;
const curvedParityPathButton = document.querySelector<HTMLButtonElement>("#surface-curved-parity-path")!;
const undoButton = document.querySelector<HTMLButtonElement>("#surface-undo")!;
const clearButton = document.querySelector<HTMLButtonElement>("#surface-clear")!;
const clearAreaButton = document.querySelector<HTMLButtonElement>("#surface-clear-area")!;
const areaDoodleButton = document.querySelector<HTMLButtonElement>("#surface-area-doodle")!;
const areaSize = document.querySelector<HTMLInputElement>("#surface-area-size")!;
const areaSizeOutput = document.querySelector<HTMLOutputElement>("#surface-area-size-output")!;
const brushSelect = document.querySelector<HTMLSelectElement>("#surface-brush")!;
const periodicControls = document.querySelector<HTMLElement>("#surface-periodic-controls")!;
const crayonControls = document.querySelector<HTMLElement>("#surface-crayon-controls")!;
const crayonPreset = document.querySelector<HTMLSelectElement>("#surface-crayon-preset")!;
const spacing = document.querySelector<HTMLInputElement>("#surface-spacing")!;
const size = document.querySelector<HTMLInputElement>("#surface-size")!;
const spacingOutput = document.querySelector<HTMLOutputElement>("#surface-spacing-output")!;
const sizeOutput = document.querySelector<HTMLOutputElement>("#surface-size-output")!;
const thickness = document.querySelector<HTMLInputElement>("#surface-thickness")!;
const peak = document.querySelector<HTMLInputElement>("#surface-peak")!;
const sigilize = document.querySelector<HTMLInputElement>("#surface-sigilize")!;
const soften = document.querySelector<HTMLInputElement>("#surface-soften")!;
const resolution = document.querySelector<HTMLInputElement>("#surface-resolution")!;
const spiro = document.querySelector<HTMLInputElement>("#surface-spiro")!;
const extrude = document.querySelector<HTMLInputElement>("#surface-extrude")!;
const flatten = document.querySelector<HTMLInputElement>("#surface-flatten")!;
const thicknessOutput = document.querySelector<HTMLOutputElement>("#surface-thickness-output")!;
const peakOutput = document.querySelector<HTMLOutputElement>("#surface-peak-output")!;
const sigilizeOutput = document.querySelector<HTMLOutputElement>("#surface-sigilize-output")!;
const softenOutput = document.querySelector<HTMLOutputElement>("#surface-soften-output")!;
const resolutionOutput = document.querySelector<HTMLOutputElement>("#surface-resolution-output")!;
const spiroOutput = document.querySelector<HTMLOutputElement>("#surface-spiro-output")!;
const extrudeOutput = document.querySelector<HTMLOutputElement>("#surface-extrude-output")!;
const pointCount = document.querySelector<HTMLElement>("#surface-points")!;
const runtime = document.querySelector<HTMLElement>("#surface-runtime")!;
const boundsText = document.querySelector<HTMLElement>("#surface-bounds")!;
const sigilButton = document.querySelector<HTMLButtonElement>("#surface-sigil")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, .01, 200);
camera.position.set(6.7, -8.5, 5.6);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.target.set(0, 0, 0);
const room = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(room, .04).texture; room.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe9f4ed, 0x172019, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-5, -7, 9); scene.add(key);

const targetRoot = new THREE.Group(); scene.add(targetRoot);
const brushRoot = new THREE.Group(); scene.add(brushRoot);
const previewRoot = new THREE.Group(); scene.add(previewRoot);
const areaRoot = new THREE.Group(); scene.add(areaRoot);
const targetMaterial = new THREE.MeshPhysicalMaterial({ color: 0x53645b, metalness: .08, roughness: .46, clearcoat: .28, side: THREE.DoubleSide });
const brushMaterial = new THREE.MeshPhysicalMaterial({ color: 0xb9ff8c, emissive: 0x13260b, metalness: .18, roughness: .27, clearcoat: .48, side: THREE.DoubleSide });
const chromeMaterial = new THREE.MeshPhysicalMaterial({ color: 0xdce6e2, metalness: .92, roughness: .16, clearcoat: .35, side: THREE.DoubleSide });
const sigilMaterial = new THREE.MeshPhysicalMaterial({ color: 0x91c8ff, metalness: 1, roughness: .08, clearcoat: 1, clearcoatRoughness: .06, side: THREE.DoubleSide });
const previewMaterial = new THREE.LineBasicMaterial({ color: 0xe8ffd8, depthTest: false, transparent: true, opacity: .9 });
const areaMaterial = new THREE.LineBasicMaterial({ color: 0xffe56f, depthTest: false, transparent: true, opacity: .72 });
const raycaster = new THREE.Raycaster(); raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2();
const strokes: Stroke[] = [];
let activeStroke: Stroke | null = null;
let drawing = true;
let selectingArea = false;
let drawingArea: DrawingArea | null = null;
const dumps: Partial<Record<"periodic" | "crayon", Dump>> = {};
let authoredTemplate: THREE.Group | null = null;
let requestId = 0;
let updateTimer = 0;
let surfaceKind: "flat" | "curved" = "curved";
let parityPathMode: "none" | "flat" | "curved" = "none";
const CRAYON_SCALE = 20;

function setStatus(message: string, busy = false): void { status.classList.toggle("busy", busy); status.lastChild!.textContent = message; }

function prepareTarget(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.material = targetMaterial;
    const geometry = child.geometry as THREE.BufferGeometry;
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.computeBoundsTree?.();
  });
}

function normalizeTarget(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());
  const scale = 6 / Math.max(extent.x, extent.y, extent.z, 1e-6);
  root.position.copy(center).multiplyScalar(-scale); root.scale.setScalar(scale); root.updateMatrixWorld(true);
}

function clearObject(root: THREE.Object3D): void {
  while (root.children.length) {
    const child = root.children.pop()!;
    child.traverse((item) => { if (item instanceof THREE.Mesh || item instanceof THREE.Line) item.geometry.dispose(); });
  }
}

function demoSurface(): void {
  surfaceKind = "curved";
  removeDrawingArea();
  camera.position.set(6.7, -8.5, 5.6); controls.target.set(0, 0, 0); controls.update();
  clearObject(targetRoot);
  const geometry = new THREE.SphereGeometry(3, 96, 64);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i);
    const wobble = 1 + .075 * Math.sin(p.z * 2.4) * Math.cos(Math.atan2(p.y, p.x) * 5);
    p.multiplyScalar(wobble); position.setXYZ(i, p.x, p.y, p.z);
  }
  position.needsUpdate = true; geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, targetMaterial); targetRoot.add(mesh); prepareTarget(targetRoot);
  fileName.textContent = "Using generated demo surface"; setStatus("Ready on the demo surface"); clearStrokes();
}

function flatSurface(): void {
  surfaceKind = "flat"; removeDrawingArea(); clearObject(targetRoot);
  camera.position.set(0, 0, 10); controls.target.set(0, 0, 0); controls.update();
  const geometry = new THREE.PlaneGeometry(8, 8, 32, 32);
  const mesh = new THREE.Mesh(geometry, targetMaterial); targetRoot.add(mesh); prepareTarget(targetRoot);
  fileName.textContent = "Flat XY parity surface"; setStatus("Flat parity surface ready"); clearStrokes();
}

async function loadTarget(url: string, ext: string, label: string, readText?: () => Promise<string>, readBuffer?: () => Promise<ArrayBuffer>): Promise<void> {
    surfaceKind = "curved";
    removeDrawingArea();
    setStatus(`Loading ${label}…`, true);
    let loaded: THREE.Object3D;
    if (ext === "glb" || ext === "gltf") loaded = (await new GLTFLoader().loadAsync(url)).scene;
    else if (ext === "obj" && readText) loaded = new OBJLoader().parse(await readText());
    else if (ext === "stl" && readBuffer) loaded = new THREE.Mesh(new STLLoader().parse(await readBuffer()), targetMaterial);
    else throw new Error("Choose a GLB, GLTF, OBJ, or STL file.");
    clearObject(targetRoot); targetRoot.add(loaded); normalizeTarget(loaded); prepareTarget(loaded);
    fileName.textContent = label; clearStrokes(); setStatus(`${label} ready · draw on its surface`);
}

async function loadFile(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try { await loadTarget(url, file.name.split(".").pop()?.toLowerCase() ?? "", file.name, () => file.text(), () => file.arrayBuffer()); }
  finally { URL.revokeObjectURL(url); }
}

function surfaceHit(event: PointerEvent, addBrushOffset = true): Sample | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(targetRoot, true)[0];
  if (!hit?.face) return null;
  const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  const offset = !addBrushOffset ? 0 : brushSelect.value === "crayon"
    ? Math.max(.012, Number(extrude.value) / CRAYON_SCALE * 1.1)
    : Math.max(.006, Number(size.value) * .08);
  return { point: hit.point.clone().addScaledVector(normal, offset), normal };
}

function addSample(event: PointerEvent): void {
  if (!activeStroke) return;
  const sample = surfaceHit(event); if (!sample) return;
  if (drawingArea) {
    const delta = sample.point.clone().sub(drawingArea.center);
    const half = drawingArea.size * .5;
    if (Math.abs(delta.dot(drawingArea.u)) > half || Math.abs(delta.dot(drawingArea.v)) > half) return;
    sample.areaUv = [delta.dot(drawingArea.u), delta.dot(drawingArea.v)];
  }
  const previous = activeStroke.at(-1);
  if (previous && previous.point.distanceTo(sample.point) < .035) return;
  activeStroke.push(sample); renderPreviews(); updateMetrics();
}

function renderPreviews(): void {
  clearObject(previewRoot);
  for (const stroke of [...strokes, ...(activeStroke ? [activeStroke] : [])]) {
    if (stroke.length < 2) continue;
    const geometry = new THREE.BufferGeometry().setFromPoints(stroke.map((sample) => sample.point));
    const line = new THREE.Line(geometry, previewMaterial); line.renderOrder = 10; previewRoot.add(line);
  }
}

function allCurves(scale = 1): { points: number[][]; cyclic: boolean }[] {
  return strokes.filter((stroke) => stroke.length > 1).map((stroke) => ({ cyclic: false, points: stroke.map(({ point }) => point.clone().multiplyScalar(scale).toArray()) }));
}

function loadParityPath(): void {
  flatSurface();
  parityPathMode = "flat";
  const points: [number, number, number][] = [[-2.4, -.7, 0], [-1.65, .42, 0], [-.8, .82, 0], [.05, .08, 0], [.9, -.62, 0], [1.7, -.25, 0], [2.4, .68, 0]];
  strokes.push(points.map((point) => ({ point: new THREE.Vector3(...point), normal: new THREE.Vector3(0, 0, 1) })));
  renderPreviews(); updateMetrics(); queueEvaluation();
}

function curvedParityStroke(): Stroke {
  const center = new THREE.Vector3(.55, -.7, .46).normalize();
  const u = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), center).normalize();
  const v = new THREE.Vector3().crossVectors(center, u).normalize();
  return Array.from({ length: 41 }, (_, index) => {
    const t = -1 + index / 20;
    const cross = .22 * Math.sin(t * Math.PI * 1.4) + .08 * Math.cos(t * Math.PI * 2.6);
    const normal = center.clone().addScaledVector(u, t * .75).addScaledVector(v, cross).normalize();
    const base = normal.clone().multiplyScalar(3);
    const wobble = 1 + .075 * Math.sin(base.z * 2.4) * Math.cos(Math.atan2(base.y, base.x) * 5);
    return { point: base.multiplyScalar(wobble), normal };
  });
}

function loadCurvedParityPath(): void {
  demoSurface();
  parityPathMode = "curved";
  strokes.push(curvedParityStroke());
  renderPreviews(); updateMetrics(); queueEvaluation();
}

function smoothStroke(source: Stroke): Stroke {
  if (parityPathMode === "curved") return source.map((sample) => ({ point: sample.point.clone(), normal: sample.normal.clone() }));
  if (source.length < 3) return source.map((sample) => ({ point: sample.point.clone(), normal: sample.normal.clone() }));
  const curve = new THREE.CatmullRomCurve3(source.map((sample) => sample.point), false, "centripetal", .5);
  const count = Math.min(96, Math.max(source.length, Math.ceil(curve.getLength() / .08)));
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0 : index / (count - 1);
    const sourcePosition = t * (source.length - 1);
    const a = Math.min(Math.floor(sourcePosition), source.length - 1);
    const b = Math.min(a + 1, source.length - 1);
    return { point: curve.getPoint(t), normal: source[a].normal.clone().lerp(source[b].normal, sourcePosition - a).normalize() };
  });
}

function crayonInput(): { curves: { points: number[][]; cyclic: boolean }[]; layouts: CrayonLayout[] } {
  const curves: { points: number[][]; cyclic: boolean }[] = [];
  const layouts: CrayonLayout[] = [];
  let cursor = 0;
  for (const source of strokes.filter((candidate) => candidate.length > 1)) {
    const stroke = smoothStroke(source);
    let distance = 0;
    const points: number[][] = [[cursor * CRAYON_SCALE, 0, 0]];
    for (let i = 1; i < stroke.length; i++) {
      distance += stroke[i].point.distanceTo(stroke[i - 1].point);
      points.push([(cursor + distance) * CRAYON_SCALE, 0, 0]);
    }
    curves.push({ points, cyclic: false });
    layouts.push({ stroke, start: cursor, length: distance });
    cursor += distance + 1;
  }
  return { curves, layouts };
}

function sigilInput(layout: CrayonLayout): { points: number[][]; cyclic: boolean }[] {
  const frame = drawingArea
    ? { point: drawingArea.center, tangent: drawingArea.u, lateral: drawingArea.v }
    : strokeFrame(layout, layout.length * .5);
  const local = strokes.filter((stroke) => stroke.length > 1).map((stroke) => stroke.map((sample) => {
      if (sample.areaUv) return [sample.areaUv[0], sample.areaUv[1], 0];
      const delta = sample.point.clone().sub(frame.point);
      return [delta.dot(frame.tangent), delta.dot(frame.lateral), 0];
    }));
  const flat = local.flat();
  const width = Math.max(...flat.map((point) => point[0])) - Math.min(...flat.map((point) => point[0]));
  const height = Math.max(...flat.map((point) => point[1])) - Math.min(...flat.map((point) => point[1]));
  const scale = 96 / Math.max(width, height, 1e-9);
  return local.map((points) => ({ cyclic: false, points: points.map((point) => [
    Number((point[0] * scale).toFixed(6)), Number((point[1] * scale).toFixed(6)), 0,
  ]) }));
}

function strokeFrame(layout: CrayonLayout, distance: number): { point: THREE.Vector3; tangent: THREE.Vector3; lateral: THREE.Vector3; normal: THREE.Vector3 } {
  const stroke = layout.stroke;
  let remaining = THREE.MathUtils.clamp(distance, 0, layout.length);
  let index = 0;
  while (index < stroke.length - 2) {
    const segment = stroke[index].point.distanceTo(stroke[index + 1].point);
    if (remaining <= segment) break;
    remaining -= segment; index++;
  }
  const a = stroke[index], b = stroke[Math.min(index + 1, stroke.length - 1)];
  const segmentLength = Math.max(a.point.distanceTo(b.point), 1e-9);
  const t = THREE.MathUtils.clamp(remaining / segmentLength, 0, 1);
  const point = a.point.clone().lerp(b.point, t);
  const tangent = b.point.clone().sub(a.point).normalize();
  const normal = a.normal.clone().lerp(b.normal, t).normalize();
  let lateral = normal.clone().cross(tangent).normalize();
  if (lateral.lengthSq() < 1e-9) lateral = new THREE.Vector3(0, 1, 0);
  return { point, tangent, lateral, normal };
}

function wrapCrayonSoup(soup: TriSoup, layouts: CrayonLayout[]): void {
  const p = soup.positions, n = soup.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] / CRAYON_SCALE;
    let layout = layouts[0];
    let best = Infinity;
    for (const candidate of layouts) {
      const delta = x < candidate.start ? candidate.start - x : x > candidate.start + candidate.length ? x - candidate.start - candidate.length : 0;
      if (delta < best) { best = delta; layout = candidate; }
    }
    const frame = strokeFrame(layout, x - layout.start);
    const y = p[i + 1] / CRAYON_SCALE, z = p[i + 2] / CRAYON_SCALE;
    const world = frame.point.clone().addScaledVector(frame.lateral, y).addScaledVector(frame.normal, z);
    p[i] = world.x; p[i + 1] = world.y; p[i + 2] = world.z;
    const worldNormal = frame.tangent.clone().multiplyScalar(n[i]).addScaledVector(frame.lateral, n[i + 1]).addScaledVector(frame.normal, n[i + 2]).normalize();
    n[i] = worldNormal.x; n[i + 1] = worldNormal.y; n[i + 2] = worldNormal.z;
  }
}

type ClosestSurface = { point: THREE.Vector3; normal: THREE.Vector3 };

function closestTargetSurface(worldPoint: THREE.Vector3): ClosestSurface | null {
  let closest: (ClosestSurface & { distance: number }) | null = null;
  targetRoot.traverse((item) => {
    if (!(item instanceof THREE.Mesh)) return;
    const geometry = item.geometry as THREE.BufferGeometry & {
      boundsTree?: { closestPointToPoint: (point: THREE.Vector3) => { point: THREE.Vector3; distance: number; faceIndex?: number } };
    };
    if (!geometry.boundsTree) return;
    const localQuery = item.worldToLocal(worldPoint.clone());
    const hit = geometry.boundsTree.closestPointToPoint(localQuery);
    const point = item.localToWorld(hit.point.clone());
    const distance = point.distanceTo(worldPoint);
    if (closest && distance >= closest.distance) return;
    let normal = point.clone().normalize();
    if (hit.faceIndex !== undefined) {
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      const index = geometry.index;
      const offset = hit.faceIndex * 3;
      const a = index ? index.getX(offset) : offset;
      const b = index ? index.getX(offset + 1) : offset + 1;
      const c = index ? index.getX(offset + 2) : offset + 2;
      const triangle = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(positions, a),
        new THREE.Vector3().fromBufferAttribute(positions, b),
        new THREE.Vector3().fromBufferAttribute(positions, c),
      );
      normal = triangle.getNormal(new THREE.Vector3()).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(item.matrixWorld)).normalize();
    }
    closest = { point, normal, distance };
  });
  return closest;
}

function removeDrawingArea(): void {
  drawingArea = null;
  clearObject(areaRoot);
}

function renderDrawingArea(): void {
  clearObject(areaRoot);
  if (!drawingArea) return;
  const grid = 10, samples = 18, half = drawingArea.size * .5;
  const makeLine = (constant: number, swap: boolean) => {
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= samples; index++) {
      const variable = -half + drawingArea!.size * index / samples;
      const x = swap ? variable : constant, y = swap ? constant : variable;
      const guess = drawingArea!.center.clone().addScaledVector(drawingArea!.u, x).addScaledVector(drawingArea!.v, y);
      const surface = closestTargetSurface(guess);
      points.push((surface?.point ?? guess).addScaledVector(surface?.normal ?? drawingArea!.normal, .018));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, areaMaterial); line.renderOrder = 9; areaRoot.add(line);
  };
  for (let index = 0; index <= grid; index++) {
    const constant = -half + drawingArea.size * index / grid;
    makeLine(constant, false); makeLine(constant, true);
  }
}

function placeDrawingArea(sample: Sample): void {
  let u = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  u.addScaledVector(sample.normal, -u.dot(sample.normal)).normalize();
  if (u.lengthSq() < 1e-9) u = new THREE.Vector3(0, 1, 0).cross(sample.normal).normalize();
  const v = sample.normal.clone().cross(u).normalize();
  drawingArea = { center: sample.point.clone(), normal: sample.normal.clone(), u, v, size: Number(areaSize.value) };
  renderDrawingArea();
  setStatus("Drawing area placed · draw inside the yellow patch");
}

function addAreaDoodle(): void {
  if (!drawingArea) { setStatus("Select an area on the model first"); return; }
  // Same proportions as the verified Blender parity doodle, normalized into
  // the selected patch. The narrow Y range is what produces the long barbs.
  const shape: [number, number][] = [
    [-48 / 60, -14 / 60], [-33 / 60, 8.4 / 60], [-16 / 60, 16.4 / 60],
    [1 / 60, 1.6 / 60], [18 / 60, -12.4 / 60], [34 / 60, -5 / 60], [48 / 60, 13.6 / 60],
  ];
  const stroke: Stroke = [];
  for (const [x, y] of shape) {
    const guess = drawingArea.center.clone()
      .addScaledVector(drawingArea.u, x * drawingArea.size * .5)
      .addScaledVector(drawingArea.v, y * drawingArea.size * .5);
    const surface = closestTargetSurface(guess);
    stroke.push({
      point: (surface?.point ?? guess).addScaledVector(surface?.normal ?? drawingArea.normal, .055),
      normal: (surface?.normal ?? drawingArea.normal).clone(),
      areaUv: [x * drawingArea.size * .5, y * drawingArea.size * .5],
    });
  }
  strokes.push(stroke); previewRoot.visible = true; renderPreviews(); updateMetrics(); queueEvaluation();
}

function projectSigilSoup(soup: TriSoup, layout: CrayonLayout): void {
  const p = soup.positions, n = soup.normals;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], p[i + axis]); max[axis] = Math.max(max[axis], p[i + axis]);
  }
  const span = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
  const heightSpan = Math.max(max[2] - min[2], 1e-9);
  const stampScale = (drawingArea ? drawingArea.size * .82 : Math.min(layout.length * .72, 2.6)) / span;
  const centerX = (min[0] + max[0]) * .5, centerY = (min[1] + max[1]) * .5;
  const frame = drawingArea
    ? { point: drawingArea.center, tangent: drawingArea.u, lateral: drawingArea.v, normal: drawingArea.normal }
    : strokeFrame(layout, layout.length * .5);
  for (let i = 0; i < p.length; i += 3) {
    const planePoint = frame.point.clone()
      .addScaledVector(frame.tangent, (p[i] - centerX) * stampScale)
      .addScaledVector(frame.lateral, (p[i + 1] - centerY) * stampScale);
    const surface = closestTargetSurface(planePoint);
    const point = surface?.point ?? planePoint;
    const normal = surface?.normal ?? frame.normal;
    point.addScaledVector(normal, ((p[i + 2] - min[2]) / heightSpan) * .09 + .012);
    p[i] = point.x; p[i + 1] = point.y; p[i + 2] = point.z;
    n[i] = normal.x; n[i + 1] = normal.y; n[i + 2] = normal.z;
  }
}

function authoredStamp(stroke: Stroke): { group: THREE.Group; verts: number; faces: number } {
  if (!authoredTemplate) throw new Error("Blender-authored Chrome Crayon stamp is still loading");
  const source = authoredTemplate;
  source.updateMatrixWorld(true);
  const prepared: THREE.BufferGeometry[] = [];
  source.traverse((item) => {
    if (!(item instanceof THREE.Mesh)) return;
    const geometry = item.geometry.clone(); geometry.applyMatrix4(item.matrixWorld);
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    prepared.push(geometry);
  });
  const bounds = new THREE.Box3();
  for (const geometry of prepared) { geometry.computeBoundingBox(); if (geometry.boundingBox) bounds.union(geometry.boundingBox); }
  const min = bounds.min.toArray(), max = bounds.max.toArray();
  const axes = [0, 1, 2].sort((a, b) => (max[b] - min[b]) - (max[a] - min[a]));
  const [alongAxis, lateralAxis, heightAxis] = axes;
  const smoothed = smoothStroke(stroke);
  let length = 0; for (let i = 1; i < smoothed.length; i++) length += smoothed[i].point.distanceTo(smoothed[i - 1].point);
  const layout: CrayonLayout = { stroke: smoothed, start: 0, length };
  const scale = length / Math.max(max[alongAxis] - min[alongAxis], 1e-9);
  const lateralCenter = (min[lateralAxis] + max[lateralAxis]) * .5;
  const group = new THREE.Group(); let verts = 0, faces = 0;
  for (const geometry of prepared) {
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      const raw = [positions.getX(i), positions.getY(i), positions.getZ(i)];
      const rawNormal = [normals.getX(i), normals.getY(i), normals.getZ(i)];
      const frame = strokeFrame(layout, (raw[alongAxis] - min[alongAxis]) * scale);
      const world = frame.point.clone().addScaledVector(frame.lateral, (raw[lateralAxis] - lateralCenter) * scale).addScaledVector(frame.normal, (raw[heightAxis] - min[heightAxis]) * scale);
      positions.setXYZ(i, world.x, world.y, world.z);
      const worldNormal = frame.tangent.clone().multiplyScalar(rawNormal[alongAxis]).addScaledVector(frame.lateral, rawNormal[lateralAxis]).addScaledVector(frame.normal, rawNormal[heightAxis]).normalize();
      normals.setXYZ(i, worldNormal.x, worldNormal.y, worldNormal.z);
    }
    positions.needsUpdate = true; normals.needsUpdate = true; geometry.computeBoundingSphere();
    group.add(new THREE.Mesh(geometry, chromeMaterial));
    verts += positions.count; faces += geometry.index ? geometry.index.count / 3 : positions.count / 3;
  }
  return { group, verts, faces };
}

function updateMetrics(): void {
  const count = strokes.reduce((sum, stroke) => sum + stroke.length, 0) + (activeStroke?.length ?? 0);
  pointCount.textContent = `${count} projected point${count === 1 ? "" : "s"}`;
}

function soupMesh(soup: TriSoup, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3)); geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3)); geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  return new THREE.Mesh(geometry, material);
}

function soupBounds(soup: TriSoup): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], soup.positions[i + axis]);
      max[axis] = Math.max(max[axis], soup.positions[i + axis]);
    }
  }
  return { min, max };
}

async function evaluateBrush(): Promise<void> {
  const brush = brushSelect.value === "periodic" ? "periodic" : "crayon";
  const dump = dumps[brush];
  const authored = brush === "crayon" && crayonPreset.value === "exact";
  const directFlat = brush === "crayon" && !authored && surfaceKind === "flat";
  const sigilStamp = brush === "crayon" && !authored && !directFlat && Number(sigilize.value) > 0;
  const crayon = crayonInput();
  const curves = brush === "crayon" ? directFlat ? allCurves(CRAYON_SCALE) : sigilStamp ? sigilInput(crayon.layouts.at(-1)!) : crayon.curves : allCurves();
  if (!dump || !strokes.some((stroke) => stroke.length > 1)) { clearObject(brushRoot); runtime.textContent = "Draw a stroke to evaluate GN-VM"; return; }
  const id = ++requestId; const started = performance.now(); setStatus("Evaluating projected curve in GN-VM…", true);
  if (authored) {
    const stamp = authoredStamp(strokes.at(-1)!);
    clearObject(brushRoot); brushRoot.add(stamp.group);
    runtime.textContent = `${stamp.verts.toLocaleString()} verts · ${Math.round(stamp.faces).toLocaleString()} tris · Blender-validated GLB`;
    setStatus("Blender-authored seven-spline motif wrapped to surface");
    (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__ = { ready: true, brush, preset: "exact", strokes: strokes.length, points: strokes.reduce((sum, item) => sum + item.length, 0), stats: { verts: stamp.verts, faces: Math.round(stamp.faces) } };
    return;
  }
  const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "surface-draw-gnvm" });
  const result = await new Promise<WorkerReply>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message));
    const object = brush === "crayon" ? "CHROME CRAYON OBJECT" : "PERIODIC BRUSH";
    const overrides = brush === "crayon" ? {
      "Line Thiccness": Number(thickness.value), "Peak Height": Number(peak.value), resolution: Number(resolution.value),
      Sigilize: Number(sigilize.value), Soften: Number(soften.value), FLATTEN: flatten.checked, "Extrude Base": Number(extrude.value), SPIRO: Number(spiro.value),
    } : { "Dot Distance": Number(spacing.value), "dot size": Number(size.value) };
    worker.postMessage({ id, dump, object, curves: authored ? undefined : curves, overrides });
  }).finally(() => worker.terminate());
  if (id !== requestId) return;
  if (!result.ok) throw new Error(result.error);
  if (directFlat) for (let i = 0; i < result.soup.positions.length; i++) result.soup.positions[i] /= CRAYON_SCALE;
  else if (sigilStamp) projectSigilSoup(result.soup, crayon.layouts.at(-1)!);
  else if (brush === "crayon") wrapCrayonSoup(result.soup, crayon.layouts);
  const bounds = soupBounds(result.soup);
  previewRoot.visible = !sigilStamp;
  clearObject(brushRoot); brushRoot.add(soupMesh(result.soup, sigilStamp ? sigilMaterial : brush === "crayon" ? chromeMaterial : brushMaterial));
  runtime.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces · ${((performance.now() - started) / 1000).toFixed(2)}s`;
  boundsText.textContent = `min ${bounds.min.map((value) => value.toFixed(3)).join(", ")} · max ${bounds.max.map((value) => value.toFixed(3)).join(", ")}`;
  const brushName = authored ? "authored Chrome Crayon motif" : directFlat ? "flat direct Chrome Crayon" : sigilStamp ? "projected unique Sigilize stamp" : brush === "crayon" && parityPathMode === "curved" ? "curved Blender parity Chrome Crayon" : brush === "crayon" ? "adapted Chrome Crayon" : "Periodic Brush";
  setStatus(`Projected curve evaluated with ${brushName}`);
  (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__ = {
    ready: true,
    brush,
    preset: authored ? "exact" : "adapted",
    surface: surfaceKind,
    parityPath: parityPathMode,
    strokes: strokes.length,
    points: strokes.reduce((sum, stroke) => sum + stroke.length, 0),
    stats: result.soup.stats,
    bounds,
  };
}

function queueEvaluation(): void { window.clearTimeout(updateTimer); updateTimer = window.setTimeout(() => void evaluateBrush().catch((error) => setStatus(error instanceof Error ? error.message : String(error))), 120); }
function clearStrokes(): void { strokes.length = 0; activeStroke = null; parityPathMode = "none"; previewRoot.visible = true; clearObject(brushRoot); renderPreviews(); updateMetrics(); runtime.textContent = "Draw a stroke to evaluate GN-VM"; boundsText.textContent = "Bounds appear after evaluation"; }
function setMode(next: "draw" | "area" | "orbit"): void {
  drawing = next === "draw"; selectingArea = next === "area"; controls.enabled = next === "orbit";
  drawButton.classList.toggle("active", drawing); areaButton.classList.toggle("active", selectingArea); orbitButton.classList.toggle("active", next === "orbit");
  canvas.style.cursor = selectingArea ? "cell" : drawing ? "crosshair" : "grab";
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (selectingArea) {
    const sample = surfaceHit(event, false);
    if (sample) { placeDrawingArea(sample); setMode("draw"); }
    return;
  }
  if (!drawing) return;
  parityPathMode = "none"; previewRoot.visible = true;
  try { canvas.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in embedded/test browsers. */ }
  activeStroke = []; addSample(event);
});
canvas.addEventListener("pointermove", (event) => { if (drawing && activeStroke) addSample(event); });
canvas.addEventListener("pointerup", (event) => { if (!activeStroke) return; try { canvas.releasePointerCapture(event.pointerId); } catch { /* no active capture */ } if (activeStroke.length > 1) strokes.push(activeStroke); activeStroke = null; renderPreviews(); updateMetrics(); queueEvaluation(); });
canvas.addEventListener("pointercancel", () => { activeStroke = null; renderPreviews(); });
fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void loadFile(file).catch((error) => setStatus(error instanceof Error ? error.message : String(error))); });
demoButton.addEventListener("click", demoSurface);
flatButton.addEventListener("click", flatSurface);
sampleButton.addEventListener("click", () => void loadTarget(publicUrl("dojo/crayon/00-browser-baseline.glb"), "glb", "Node Dojo Chrome Crayon GLB").catch((error) => setStatus(error instanceof Error ? error.message : String(error))));
parityPathButton.addEventListener("click", loadParityPath);
curvedParityPathButton.addEventListener("click", loadCurvedParityPath);
drawButton.addEventListener("click", () => setMode("draw")); orbitButton.addEventListener("click", () => setMode("orbit"));
areaButton.addEventListener("click", () => { setMode("area"); setStatus("Click the model to place the drawing area"); });
clearAreaButton.addEventListener("click", () => { removeDrawingArea(); setStatus("Drawing area removed · drawing is unrestricted"); });
areaDoodleButton.addEventListener("click", addAreaDoodle);
areaSize.addEventListener("input", () => {
  areaSizeOutput.value = Number(areaSize.value).toFixed(1);
  if (drawingArea) { drawingArea.size = Number(areaSize.value); renderDrawingArea(); }
});
undoButton.addEventListener("click", () => { strokes.pop(); renderPreviews(); updateMetrics(); queueEvaluation(); }); clearButton.addEventListener("click", clearStrokes);
for (const input of [spacing, size]) input.addEventListener("input", () => { spacingOutput.value = Number(spacing.value).toFixed(2); sizeOutput.value = Number(size.value).toFixed(3); queueEvaluation(); });
for (const [input, output, decimals] of [[thickness, thicknessOutput, 1], [peak, peakOutput, 1], [sigilize, sigilizeOutput, 0], [soften, softenOutput, 0], [resolution, resolutionOutput, 3], [spiro, spiroOutput, 0], [extrude, extrudeOutput, 1]] as const)
  input.addEventListener("input", () => { output.value = Number(input.value).toFixed(decimals); queueEvaluation(); });
flatten.addEventListener("change", queueEvaluation);
function applyCrayonPreset(): void {
  const exact = crayonPreset.value === "exact";
  const values = exact
    ? [24.318, 404.742, 665, 0, .835, 3, 1]
    : [6, 10, 0, 0, .8, 1, 1];
  const controlsAndOutputs = [[thickness, thicknessOutput, 1], [peak, peakOutput, 1], [sigilize, sigilizeOutput, 0], [soften, softenOutput, 0], [resolution, resolutionOutput, 3], [spiro, spiroOutput, 0], [extrude, extrudeOutput, 1]] as const;
  controlsAndOutputs.forEach(([input, output, decimals], index) => { input.value = String(values[index]); input.disabled = exact; output.value = values[index].toFixed(decimals); });
  flatten.disabled = exact;
  queueEvaluation();
}
crayonPreset.addEventListener("change", applyCrayonPreset);
sigilButton.addEventListener("click", () => {
  if (crayonPreset.value !== "adapted") { crayonPreset.value = "adapted"; applyCrayonPreset(); }
  thickness.value = "24.318"; thicknessOutput.value = "24.3";
  peak.value = "404.742"; peakOutput.value = "404.7";
  resolution.value = ".835"; resolutionOutput.value = ".835";
  sigilize.value = "665"; sigilizeOutput.value = "665";
  spiro.value = "3"; spiroOutput.value = "3";
  setStatus("Original unique-sigil preset enabled · Sigilize 665 · SPIRO 3");
  queueEvaluation();
});
brushSelect.addEventListener("change", () => {
  const crayon = brushSelect.value === "crayon";
  crayonControls.hidden = !crayon; periodicControls.hidden = crayon;
  clearObject(brushRoot); queueEvaluation();
});
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

setMode("draw"); applyCrayonPreset(); demoSurface();
Promise.all([
  fetch(publicUrl("dojo/periodic-brush/dump.json")).then((response) => response.json()),
  fetch(publicUrl("dojo/crayon/dump.json")).then((response) => response.json()),
  new GLTFLoader().loadAsync(publicUrl("dojo/crayon/00-browser-baseline.glb")),
]).then(([periodic, crayon, authored]) => { dumps.periodic = periodic as Dump; dumps.crayon = crayon as Dump; authoredTemplate = authored.scene; }).catch((error) => setStatus(String(error)));
