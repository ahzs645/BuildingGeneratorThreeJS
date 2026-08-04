import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { publicUrl } from "./base-url";
import {
  fitBaseShape,
  listLibraryShapes,
  loadFileBaseShape,
  loadLibraryBaseShape,
  type LibraryShapeInfo,
} from "./base-shapes";
import { fitPerspectiveCameraToObject } from "./camera-fit";
import { canvasBox, observeCanvasBox, preferredCanvasPixelRatio, releaseToolContext } from "./canvas-viewport";
import { inlineMeshSeedFromObject } from "./inline-mesh-conversion";
import { bindStatusLine } from "./status-line";
import type { ToolHandle } from "./react/page-runtime";
import type { Dump, InlineMeshSeed, TriSoup } from "./gnvm/index";

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
  const reframeButton = document.querySelector<HTMLButtonElement>("#typewriter-reframe")!;
  const setStatus = bindStatusLine("#typewriter-status");
  const countEl = document.querySelector<HTMLElement>("#typewriter-count")!;
  const runtimeEl = document.querySelector<HTMLElement>("#typewriter-runtime")!;
  const fontFileEl = document.querySelector<HTMLInputElement>("#typewriter-font-file")!;
  const fontStatusEl = document.querySelector<HTMLElement>("#typewriter-font-status")!;
  const baseSelect = document.querySelector<HTMLSelectElement>("#typewriter-base-select")!;
  const baseImportButton = document.querySelector<HTMLButtonElement>("#typewriter-base-import")!;
  const baseClearButton = document.querySelector<HTMLButtonElement>("#typewriter-base-clear")!;
  const baseFileInput = document.querySelector<HTMLInputElement>("#typewriter-base-file")!;
  const baseStateEl = document.querySelector<HTMLElement>("#typewriter-base-state")!;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
  const viewport = canvasBox(canvas);
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, viewport.width / viewport.height, .01, 5000);
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
  let hasFramed = false;
  let baseShape: { label: string; seed: InlineMeshSeed } | null = null;
  let baseRequest = 0;
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
    // hidden inside the much larger demonstration board. When the user picks a
    // base object, keep the authored join and let the seed replace the board.
    if (!baseShape && root?.links) root.links = root.links.filter((link: any) => !(link.from_node === "Group Input" && link.to_node === "Join Geometry"));
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
      worker.postMessage({
        id,
        dump: editableDump(),
        object: "_Typewriter Node Container",
        // The graph's base-geometry input reaches Join Geometry through a
        // "Show presentation board" switch; turning it on lets the seed —
        // which replaces the authored board — join the generated glyphs.
        overrides: {
          __frame: Number(frameInput.value),
          ...(baseShape ? { "Show presentation board": true } : {}),
        },
        seed: baseShape?.seed,
      });
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
    hasFramed = fitPerspectiveCameraToObject(camera, controls, model) || hasFramed;
  }

  async function update(): Promise<void> {
    const requested = runId + 1;
    setStatus("busy", "Evaluating animated Geometry Nodes…"); evaluateButton.disabled = true;
    const started = performance.now();
    try {
      const result = await evaluate();
      if (disposed || result.id < appliedId || result.id !== requested) return;
      appliedId = result.id;
      clearModel(); model.add(soupMesh(result.soup));
      // Frame the first successful result only. Later edits preserve the
      // camera the user established unless they explicitly reframe.
      if (!hasFramed) frameModel();
      countEl.textContent = `${result.soup.stats.verts.toLocaleString()} verts · ${result.soup.stats.faces.toLocaleString()} faces`;
      runtimeEl.textContent = `${((performance.now() - started) / 1000).toFixed(2)}s · frame ${frameInput.value}`;
      setStatus("ready", "Portable typewriter graph evaluated");
      (window as typeof window & { __TYPEWRITER__?: unknown }).__TYPEWRITER__ = { ready: true, frame: Number(frameInput.value), stats: result.soup.stats };
    } catch (error) { if (!disposed) setStatus("error", error instanceof Error ? error.message : String(error)); }
    finally { if (!disposed) evaluateButton.disabled = false; }
  }

  function queueUpdate(): void { window.clearTimeout(editTimer); editTimer = window.setTimeout(() => void update(), 140); }

  function applyBaseObject(label: string, object: THREE.Object3D, fingerprint: string): void {
    // The typed line runs from the origin to roughly x=4 at z=0. Fit the shape
    // to that width and park it just behind the glyph plane, centered on the
    // text run — the same role the authored presentation board played.
    fitBaseShape(object, 4);
    const box = new THREE.Box3().setFromObject(object);
    object.position.x += 2.05 - (box.min.x + box.max.x) / 2;
    object.position.y += -0.05 - (box.min.y + box.max.y) / 2;
    object.position.z += -0.05 - box.max.z;
    object.updateWorldMatrix(true, true);
    baseShape = { label, seed: inlineMeshSeedFromObject(object, label, `${fingerprint}:fit4`) };
    baseClearButton.disabled = false;
    const verts = Math.floor(baseShape.seed.positions.length / 3);
    baseStateEl.textContent = `${label} · ${verts.toLocaleString()} verts joined with the typed text.`;
    hasFramed = false;
    queueUpdate();
  }

  function clearBaseObject(): void {
    baseRequest++;
    if (!baseShape) return;
    baseShape = null;
    baseSelect.value = "";
    baseClearButton.disabled = true;
    baseStateEl.textContent = "Join the typed text with a reference object or any imported shape — the graph's own base-geometry input.";
    hasFramed = false;
    queueUpdate();
  }

  let libraryShapes: LibraryShapeInfo[] = [];
  void listLibraryShapes()
    .then((shapes) => {
      if (disposed) return;
      libraryShapes = shapes;
      // Remounts retain the DOM: rebuild after the placeholder instead of appending.
      while (baseSelect.options.length > 1) baseSelect.remove(1);
      for (const shape of shapes) baseSelect.add(new Option(shape.title, shape.id));
    })
    .catch(() => { if (!disposed) baseStateEl.textContent = "Reference catalog unavailable · import a shape file instead."; });

  const onBaseSelect = (): void => {
    const id = baseSelect.value;
    if (!id) { clearBaseObject(); return; }
    const info = libraryShapes.find((shape) => shape.id === id);
    if (!info) return;
    const request = ++baseRequest;
    setStatus("busy", `Evaluating ${info.title} through the GN-VM…`);
    loadLibraryBaseShape(info)
      .then((shape) => { if (!disposed && request === baseRequest) applyBaseObject(shape.label, shape.object, `library:${info.id}`); })
      .catch((error) => {
        if (disposed || request !== baseRequest) return;
        setStatus("error", error instanceof Error ? error.message : String(error));
      });
  };
  const onBaseImport = (): void => baseFileInput.click();
  const onBaseFile = (): void => {
    const file = baseFileInput.files?.[0];
    baseFileInput.value = "";
    if (!file) return;
    const request = ++baseRequest;
    setStatus("busy", `Loading ${file.name}…`);
    loadFileBaseShape(file)
      .then((shape) => {
        if (disposed || request !== baseRequest) return;
        baseSelect.value = "";
        applyBaseObject(shape.label, shape.object, shape.seed.fingerprint ?? file.name);
      })
      .catch((error) => {
        if (disposed || request !== baseRequest) return;
        setStatus("error", error instanceof Error ? error.message : String(error));
      });
  };
  const onBaseClear = (): void => clearBaseObject();
  const onFrameInput = (): void => { frameOutput.value = frameInput.value; queueUpdate(); };
  const onEvaluate = (): void => void update();
  const onReframe = (): void => frameModel();
  const onPlay = (): void => { playing = !playing; playButton.classList.toggle("active", playing); playButton.textContent = playing ? "Pause" : "Play"; };
  const onFontFileChange = (): void => void onFontFile();

  fontFileEl.addEventListener("change", onFontFileChange);
  baseSelect.addEventListener("change", onBaseSelect);
  baseImportButton.addEventListener("click", onBaseImport);
  baseFileInput.addEventListener("change", onBaseFile);
  baseClearButton.addEventListener("click", onBaseClear);
  frameInput.addEventListener("input", onFrameInput);
  textInput.addEventListener("input", queueUpdate);
  evaluateButton.addEventListener("click", onEvaluate);
  reframeButton.addEventListener("click", onReframe);
  playButton.addEventListener("click", onPlay);
  // The canvas is a grid column of the studio shell, not the whole window.
  const stopObservingCanvas = observeCanvasBox(canvas, (width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });

  renderer.setAnimationLoop((time) => {
    if (playing && time - lastPlay > 100) {
      lastPlay = time;
      frameInput.value = String((Number(frameInput.value) + 2) % 241); frameOutput.value = frameInput.value; void update();
    }
    controls.update(); renderer.render(scene, camera);
  });

  Promise.all([loadDisplayFallback(), loadDump()])
    .then(([, loaded]) => { if (disposed) return; dump = loaded; void update(); })
    .catch((error) => { if (!disposed) setStatus("error", String(error)); });

  return {
    dispose(): void {
      disposed = true;
      window.clearTimeout(editTimer);
      frameInput.removeEventListener("input", onFrameInput);
      textInput.removeEventListener("input", queueUpdate);
      evaluateButton.removeEventListener("click", onEvaluate);
      reframeButton.removeEventListener("click", onReframe);
      playButton.removeEventListener("click", onPlay);
      fontFileEl.removeEventListener("change", onFontFileChange);
      baseSelect.removeEventListener("change", onBaseSelect);
      baseImportButton.removeEventListener("click", onBaseImport);
      baseFileInput.removeEventListener("change", onBaseFile);
      baseClearButton.removeEventListener("click", onBaseClear);
      stopObservingCanvas();
      for (const worker of liveWorkers) worker.terminate();
      liveWorkers.clear();
      renderer.setAnimationLoop(null);
      controls.dispose();
      clearModel();
      for (const material of materials) material.dispose();
      envTexture.dispose();
      renderer.dispose();
      releaseToolContext(renderer);
      delete (window as typeof window & { __TYPEWRITER__?: unknown }).__TYPEWRITER__;
    },
  };
}
