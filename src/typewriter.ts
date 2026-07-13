import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import type { Dump, TriSoup } from "./gnvm/index";

type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

const canvas = document.querySelector<HTMLCanvasElement>("#typewriter-canvas")!;
const textInput = document.querySelector<HTMLTextAreaElement>("#typewriter-text")!;
const frameInput = document.querySelector<HTMLInputElement>("#typewriter-frame")!;
const frameOutput = document.querySelector<HTMLOutputElement>("#typewriter-frame-output")!;
const playButton = document.querySelector<HTMLButtonElement>("#typewriter-play")!;
const evaluateButton = document.querySelector<HTMLButtonElement>("#typewriter-evaluate")!;
const statusEl = document.querySelector<HTMLElement>("#typewriter-status")!;
const countEl = document.querySelector<HTMLElement>("#typewriter-count")!;
const runtimeEl = document.querySelector<HTMLElement>("#typewriter-runtime")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .01, 5000);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(room, .04).texture; room.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe8eeff, 0x181520, 1.25));
const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(4, 7, 6); scene.add(key);
const model = new THREE.Group(); scene.add(model);
const materials = [
  new THREE.MeshPhysicalMaterial({ color: 0x292d35, metalness: .15, roughness: .38, side: THREE.DoubleSide }),
  new THREE.MeshPhysicalMaterial({ color: 0xb785ff, metalness: .35, roughness: .24, clearcoat: .4, side: THREE.DoubleSide }),
];

let dump: Dump;
let runId = 0;
let appliedId = 0;
let playing = false;
let lastPlay = 0;
let editTimer = 0;

function editableDump(): Dump {
  const next = structuredClone(dump) as Dump;
  const root = (next.node_groups as any).GN;
  const group = root?.nodes?.find((node: any) => node.type === "GeometryNodeGroup" && node.group === "_Typewriter Nodes");
  const textSocket = group?.inputs?.find((socket: any) => socket.name === "Text input");
  if (textSocket) textSocket.value = textInput.value;
  // The source object is a presentation board spelling "_TYPEWRITER NODES".
  // Blender joins that pre-existing mesh with the generated glyphs. For the
  // live web tool, show the procedural output alone so editable text is not
  // hidden inside the much larger demonstration board.
  if (root?.links) root.links = root.links.filter((link: any) => !(link.from_node === "Group Input" && link.to_node === "Join Geometry"));
  return next;
}

function evaluate(): Promise<WorkerReply & { ok: true }> {
  const id = ++runId;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "dojo-typewriter" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (!event.data.ok) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ id, dump: editableDump(), object: "_Typewriter Node Container", overrides: { __frame: Number(frameInput.value) } });
  });
}

function soupMesh(soup: TriSoup): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  return new THREE.Mesh(geometry, materials[1]);
}

function frameModel(): void {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * .5, 1);
  camera.position.set(center.x, center.y - radius * 1.35, center.z + radius * .75);
  camera.near = radius / 300; camera.far = radius * 100; camera.updateProjectionMatrix(); controls.target.copy(center); controls.update();
}

async function update(): Promise<void> {
  const requested = runId + 1;
  statusEl.classList.remove("ready"); statusEl.textContent = "Evaluating animated Geometry Nodes…"; evaluateButton.disabled = true;
  const started = performance.now();
  try {
    const result = await evaluate();
    if (result.id < appliedId || result.id !== requested) return;
    appliedId = result.id;
    model.clear(); model.add(soupMesh(result.soup)); frameModel();
    countEl.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;
    runtimeEl.textContent = `${((performance.now() - started) / 1000).toFixed(2)}s · frame ${frameInput.value}`;
    statusEl.classList.add("ready"); statusEl.textContent = "Portable typewriter graph evaluated";
    (window as typeof window & { __TYPEWRITER__?: unknown }).__TYPEWRITER__ = { ready: true, frame: Number(frameInput.value), stats: result.soup.stats };
  } catch (error) { statusEl.textContent = error instanceof Error ? error.message : String(error); }
  finally { evaluateButton.disabled = false; }
}

function queueUpdate(): void { window.clearTimeout(editTimer); editTimer = window.setTimeout(() => void update(), 140); }
frameInput.addEventListener("input", () => { frameOutput.value = frameInput.value; queueUpdate(); });
textInput.addEventListener("input", queueUpdate);
evaluateButton.addEventListener("click", () => void update());
playButton.addEventListener("click", () => { playing = !playing; playButton.classList.toggle("active", playing); playButton.textContent = playing ? "Pause" : "Play"; });
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop((time) => {
  if (playing && time - lastPlay > 100) {
    lastPlay = time;
    frameInput.value = String((Number(frameInput.value) + 2) % 241); frameOutput.value = frameInput.value; void update();
  }
  controls.update(); renderer.render(scene, camera);
});

fetch(publicUrl("dojo/typewriter/dump.json")).then((response) => response.json()).then((loaded: Dump) => { dump = loaded; void update(); }).catch((error) => { statusEl.textContent = String(error); });
