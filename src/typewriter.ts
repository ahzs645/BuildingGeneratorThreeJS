import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import type { ToolHandle } from "./react/page-runtime";
import type { Dump, TriSoup } from "./gnvm/index";

type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };

// Pure-data caches that may persist across remounts: the fetched graph dump
// and the fallback preview FontFace (document.fonts entries survive anyway).
let dumpPromise: Promise<Dump> | null = null;
function loadDump(): Promise<Dump> {
  dumpPromise ??= fetch(publicUrl("dojo/typewriter/dump.json")).then((response) => response.json() as Promise<Dump>);
  return dumpPromise;
}

let fallbackFacePromise: Promise<FontFace | null> | null = null;
function loadFallbackFace(): Promise<FontFace | null> {
  fallbackFacePromise ??= new FontFace("Pixels Medium", `url(${JSON.stringify(publicUrl("dojo/fonts/pixels.ttf"))})`)
    .load()
    .then((face) => { document.fonts.add(face); return face; })
    .catch(() => null);
  return fallbackFacePromise;
}

export function createTool(): ToolHandle {
  const canvas = document.querySelector<HTMLCanvasElement>("#typewriter-canvas")!;
  const textInput = document.querySelector<HTMLTextAreaElement>("#typewriter-text")!;
  const frameInput = document.querySelector<HTMLInputElement>("#typewriter-frame")!;
  const frameOutput = document.querySelector<HTMLOutputElement>("#typewriter-frame-output")!;
  const playButton = document.querySelector<HTMLButtonElement>("#typewriter-play")!;
  const evaluateButton = document.querySelector<HTMLButtonElement>("#typewriter-evaluate")!;
  const statusEl = document.querySelector<HTMLElement>("#typewriter-status")!;
  const countEl = document.querySelector<HTMLElement>("#typewriter-count")!;
  const runtimeEl = document.querySelector<HTMLElement>("#typewriter-runtime")!;
  const fontFileEl = document.querySelector<HTMLInputElement>("#typewriter-font-file")!;
  const fontStatusEl = document.querySelector<HTMLElement>("#typewriter-font-status")!;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .01, 5000);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(room, .04).texture;
  scene.environment = envTexture; room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe8eeff, 0x181520, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(4, 7, 6); scene.add(key);
  const model = new THREE.Group(); scene.add(model);
  const materials = [
    new THREE.MeshPhysicalMaterial({ color: 0x292d35, metalness: .15, roughness: .38, side: THREE.DoubleSide }),
    new THREE.MeshPhysicalMaterial({ color: 0xb785ff, metalness: .35, roughness: .24, clearcoat: .4, side: THREE.DoubleSide }),
  ];

  let disposed = false;
  let dump: Dump;
  let runId = 0;
  let appliedId = 0;
  let playing = false;
  let lastPlay = 0;
  let editTimer = 0;
  const liveWorkers = new Set<Worker>();

  async function loadDisplayFallback(): Promise<boolean> {
    const face = await loadFallbackFace();
    if (disposed) return face !== null;
    if (face) {
      textInput.style.fontFamily = `"${face.family}", ui-monospace, monospace`;
      fontStatusEl.className = "typewriter-font-status fallback";
      fontStatusEl.textContent = "Exact Blurmed glyph geometry is embedded · editor preview currently uses the supplied Pixels fallback. Choose the recovered Blurmed.ttf above to match it.";
      return true;
    }
    fontStatusEl.className = "typewriter-font-status fallback";
    fontStatusEl.textContent = "Exact Blurmed glyph geometry is embedded · no editor-preview TTF is loaded. Choose your local recovered Blurmed.ttf above.";
    return false;
  }

  const onFontFile = async (): Promise<void> => {
    const file = fontFileEl.files?.[0];
    if (!file) return;
    try {
      const family = "BlurMedium Local";
      const face = await new FontFace(family, await file.arrayBuffer()).load();
      document.fonts.add(face);
      if (disposed) return;
      textInput.style.fontFamily = `"${family}", ui-monospace, monospace`;
      fontStatusEl.className = "typewriter-font-status loaded";
      fontStatusEl.textContent = `${file.name} loaded locally for editor preview · generated geometry continues to use the matching embedded Blender outline atlas.`;
    } catch {
      if (disposed) return;
      fontStatusEl.className = "typewriter-font-status fallback";
      fontStatusEl.textContent = `${file.name} could not be loaded as a TTF · exact embedded Blurmed geometry remains active.`;
    }
  };

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
      if (disposed) { reject(new Error("Tool disposed")); return; }
      const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "dojo-typewriter" });
      liveWorkers.add(worker);
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        worker.terminate(); liveWorkers.delete(worker);
        if (!event.data.ok) reject(new Error(event.data.error)); else resolve(event.data);
      };
      worker.onerror = (event) => { worker.terminate(); liveWorkers.delete(worker); reject(new Error(event.message)); };
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

  function clearModel(): void {
    for (const child of model.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
    model.clear();
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
      if (disposed || result.id < appliedId || result.id !== requested) return;
      appliedId = result.id;
      clearModel(); model.add(soupMesh(result.soup)); frameModel();
      countEl.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;
      runtimeEl.textContent = `${((performance.now() - started) / 1000).toFixed(2)}s · frame ${frameInput.value}`;
      statusEl.classList.add("ready"); statusEl.textContent = "Portable typewriter graph evaluated";
      (window as typeof window & { __TYPEWRITER__?: unknown }).__TYPEWRITER__ = { ready: true, frame: Number(frameInput.value), stats: result.soup.stats };
    } catch (error) { if (!disposed) statusEl.textContent = error instanceof Error ? error.message : String(error); }
    finally { if (!disposed) evaluateButton.disabled = false; }
  }

  function queueUpdate(): void { window.clearTimeout(editTimer); editTimer = window.setTimeout(() => void update(), 140); }
  const onFrameInput = (): void => { frameOutput.value = frameInput.value; queueUpdate(); };
  const onEvaluate = (): void => void update();
  const onPlay = (): void => { playing = !playing; playButton.classList.toggle("active", playing); playButton.textContent = playing ? "Pause" : "Play"; };
  const onResize = (): void => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); };
  const onFontFileChange = (): void => void onFontFile();

  fontFileEl.addEventListener("change", onFontFileChange);
  frameInput.addEventListener("input", onFrameInput);
  textInput.addEventListener("input", queueUpdate);
  evaluateButton.addEventListener("click", onEvaluate);
  playButton.addEventListener("click", onPlay);
  addEventListener("resize", onResize);

  renderer.setAnimationLoop((time) => {
    if (playing && time - lastPlay > 100) {
      lastPlay = time;
      frameInput.value = String((Number(frameInput.value) + 2) % 241); frameOutput.value = frameInput.value; void update();
    }
    controls.update(); renderer.render(scene, camera);
  });

  Promise.all([loadDisplayFallback(), loadDump()])
    .then(([, loaded]) => { if (disposed) return; dump = loaded; void update(); })
    .catch((error) => { if (!disposed) statusEl.textContent = String(error); });

  return {
    dispose(): void {
      disposed = true;
      window.clearTimeout(editTimer);
      frameInput.removeEventListener("input", onFrameInput);
      textInput.removeEventListener("input", queueUpdate);
      evaluateButton.removeEventListener("click", onEvaluate);
      playButton.removeEventListener("click", onPlay);
      fontFileEl.removeEventListener("change", onFontFileChange);
      removeEventListener("resize", onResize);
      for (const worker of liveWorkers) worker.terminate();
      liveWorkers.clear();
      renderer.setAnimationLoop(null);
      controls.dispose();
      clearModel();
      for (const material of materials) material.dispose();
      envTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      delete (window as typeof window & { __TYPEWRITER__?: unknown }).__TYPEWRITER__;
    },
  };
}
