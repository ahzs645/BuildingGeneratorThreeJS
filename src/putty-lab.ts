import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { publicUrl } from "./base-url";
import { canvasBox, observeCanvasBox } from "./canvas-viewport";
import { EditablePuttyDocument, type PuttyPoint } from "./editable-putty";
import type { Dump, TriSoup } from "./gnvm";
import type { ToolHandle } from "./react/page-runtime";

type Mode = "orbit" | "move" | "add";
type WorkerReply =
  | { id: number; ok: true; soup: TriSoup }
  | { id: number; ok: false; error: string };
type InstallReply = { ok: true; installed: string };

const FIELD_HALF_SIZE = 7;
const FIELD_SUBTRACT = 12;
const PUTTY_DUMP_URL = "dojo/joints/bubble-putty/dump.json";

let puttyDumpPromise: Promise<Dump> | null = null;
function loadPuttyDump(): Promise<Dump> {
  if (!puttyDumpPromise) {
    puttyDumpPromise = fetch(publicUrl(PUTTY_DUMP_URL)).then((response) => {
      if (!response.ok) throw new Error(`Bubble Putty graph failed to load (${response.status})`);
      return response.json() as Promise<Dump>;
    });
    puttyDumpPromise.catch(() => { puttyDumpPromise = null; });
  }
  return puttyDumpPromise;
}

export function createTool(): ToolHandle {
  const canvas = document.querySelector<HTMLCanvasElement>("#putty-canvas")!;
  const status = document.querySelector<HTMLElement>("#putty-status")!;
  const countText = document.querySelector<HTMLElement>("#putty-count")!;
  const runtimeText = document.querySelector<HTMLElement>("#putty-runtime")!;
  const selectionText = document.querySelector<HTMLElement>("#putty-selection")!;
  const orbitButton = document.querySelector<HTMLButtonElement>("#putty-orbit")!;
  const moveButton = document.querySelector<HTMLButtonElement>("#putty-move")!;
  const addModeButton = document.querySelector<HTMLButtonElement>("#putty-add-mode")!;
  const addButton = document.querySelector<HTMLButtonElement>("#putty-add")!;
  const duplicateButton = document.querySelector<HTMLButtonElement>("#putty-duplicate")!;
  const deleteButton = document.querySelector<HTMLButtonElement>("#putty-delete")!;
  const resetButton = document.querySelector<HTMLButtonElement>("#putty-reset")!;
  const radiusInput = document.querySelector<HTMLInputElement>("#putty-radius")!;
  const radiusOutput = document.querySelector<HTMLOutputElement>("#putty-radius-output")!;
  const puttinessInput = document.querySelector<HTMLInputElement>("#putty-puttiness")!;
  const puttinessOutput = document.querySelector<HTMLOutputElement>("#putty-puttiness-output")!;
  const softenInput = document.querySelector<HTMLInputElement>("#putty-soften")!;
  const softenOutput = document.querySelector<HTMLOutputElement>("#putty-soften-output")!;
  const maxBubbleInput = document.querySelector<HTMLInputElement>("#putty-max-bubble")!;
  const maxBubbleOutput = document.querySelector<HTMLOutputElement>("#putty-max-bubble-output")!;
  const rebuildButton = document.querySelector<HTMLButtonElement>("#putty-rebuild")!;
  const previewButton = document.querySelector<HTMLButtonElement>("#putty-preview")!;

  const abort = new AbortController();
  const { signal } = abort;
  let disposed = false;
  let mode: Mode = "move";
  let requestId = 0;
  let worker: Worker | null = null;
  let workerInstalled = false;
  let exactVisible = false;
  let dragging: { pointerId: number; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .95;
  renderer.setClearColor(0x07090c, 1);
  const initialBox = canvasBox(canvas);
  renderer.setSize(initialBox.width, initialBox.height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, initialBox.width / initialBox.height, .01, 250);
  camera.position.set(9, -11, 8);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04).texture;
  room.dispose(); pmrem.dispose();
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xe8f6ee, 0x10151b, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.7); key.position.set(-5, -7, 10); scene.add(key);
  const rim = new THREE.DirectionalLight(0x78bdff, 1.4); rim.position.set(7, 2, 4); scene.add(rim);

  const puttyMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x64d88c,
    emissive: 0x071b0e,
    metalness: .02,
    roughness: .3,
    clearcoat: .55,
    clearcoatRoughness: .28,
    side: THREE.DoubleSide,
  });
  const exactMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x00cc4b,
    emissive: 0x001b08,
    metalness: .02,
    roughness: .38,
    clearcoat: .32,
    side: THREE.DoubleSide,
  });
  const preview = new MarchingCubes(48, puttyMaterial, false, false, 220_000);
  preview.isolation = 80;
  preview.scale.setScalar(FIELD_HALF_SIZE);
  scene.add(preview);
  const proxyRoot = new THREE.Group(); scene.add(proxyRoot);
  const exactRoot = new THREE.Group(); scene.add(exactRoot);

  const proxyGeometry = new THREE.SphereGeometry(1, 20, 14);
  const proxyMaterial = new THREE.MeshBasicMaterial({ color: 0x9affbd, transparent: true, opacity: .075, wireframe: true, depthWrite: false });
  const selectedProxyMaterial = new THREE.MeshBasicMaterial({ color: 0xffd66b, transparent: true, opacity: .42, wireframe: true, depthTest: false });
  const centerGeometry = new THREE.SphereGeometry(.13, 16, 12);
  const centerMaterial = new THREE.MeshBasicMaterial({ color: 0xd7ffe4, depthTest: false });
  const selectedCenterMaterial = new THREE.MeshBasicMaterial({ color: 0xffbd59, depthTest: false });
  const puttyDoc = new EditablePuttyDocument();
  puttyDoc.reset();

  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const dragPoint = new THREE.Vector3();

  function setStatus(message: string, busy = false): void {
    if (disposed) return;
    status.classList.toggle("busy", busy);
    status.lastChild!.textContent = message;
  }

  function clearRoot(root: THREE.Group): void {
    while (root.children.length) {
      const child = root.children.pop()!;
      child.traverse((item) => {
        if (item instanceof THREE.Mesh && item.geometry !== proxyGeometry && item.geometry !== centerGeometry) item.geometry.dispose();
      });
    }
  }

  function updatePointer(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }

  function showInteractivePreview(message?: string): void {
    exactVisible = false;
    exactRoot.visible = false;
    preview.visible = true;
    proxyRoot.visible = mode !== "orbit";
    if (message) setStatus(message);
  }

  function updateProxies(): void {
    clearRoot(proxyRoot);
    for (const blob of puttyDoc.blobs) {
      const selected = blob.id === puttyDoc.selectedId;
      const hitMesh = new THREE.Mesh(proxyGeometry, selected ? selectedProxyMaterial : proxyMaterial);
      hitMesh.position.fromArray(blob.position);
      hitMesh.scale.setScalar(blob.radius);
      hitMesh.userData.puttyBlobId = blob.id;
      hitMesh.renderOrder = 20;
      proxyRoot.add(hitMesh);
      const center = new THREE.Mesh(centerGeometry, selected ? selectedCenterMaterial : centerMaterial);
      center.position.fromArray(blob.position);
      center.userData.puttyBlobId = blob.id;
      center.renderOrder = 21;
      proxyRoot.add(center);
    }
  }

  function updatePreview(): void {
    preview.reset();
    for (const blob of puttyDoc.blobs) {
      const normalizedRadius = blob.radius / (FIELD_HALF_SIZE * 2);
      const strength = (preview.isolation + FIELD_SUBTRACT) * normalizedRadius * normalizedRadius;
      preview.addBall(
        blob.position[0] / (FIELD_HALF_SIZE * 2) + .5,
        blob.position[1] / (FIELD_HALF_SIZE * 2) + .5,
        blob.position[2] / (FIELD_HALF_SIZE * 2) + .5,
        Math.max(.08, strength),
        FIELD_SUBTRACT,
      );
    }
    preview.update();
    updateProxies();
    const selected = puttyDoc.selected();
    countText.textContent = `${puttyDoc.blobs.length} putty blob${puttyDoc.blobs.length === 1 ? "" : "s"}`;
    selectionText.textContent = selected ? `Blob ${selected.id} selected` : "No blob selected";
    if (selected) {
      radiusInput.value = String(selected.radius);
      radiusOutput.value = selected.radius.toFixed(2);
    }
    duplicateButton.disabled = !selected;
    deleteButton.disabled = !selected || puttyDoc.blobs.length <= 1;
  }

  function setMode(next: Mode): void {
    mode = next;
    controls.enabled = next === "orbit";
    orbitButton.classList.toggle("active", next === "orbit");
    moveButton.classList.toggle("active", next === "move");
    addModeButton.classList.toggle("active", next === "add");
    proxyRoot.visible = !exactVisible && next !== "orbit";
    canvas.style.cursor = next === "orbit" ? "grab" : next === "add" ? "copy" : "default";
  }

  function screenPlane(point: THREE.Vector3): THREE.Plane {
    const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
  }

  function addBlobAt(position: THREE.Vector3): void {
    const blob = puttyDoc.add(position.toArray() as PuttyPoint, Number(radiusInput.value));
    puttyDoc.select(blob.id);
    showInteractivePreview("Putty added · drag it or add another blob");
    updatePreview();
  }

  function workerReply<T>(post: (active: Worker) => void): Promise<T> {
    const active = worker ??= new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "bubble-putty-gnvm" });
    return new Promise<T>((resolve, reject) => {
      active.onmessage = (event: MessageEvent<T>) => resolve(event.data);
      active.onerror = (event) => reject(new Error(event.message));
      post(active);
    });
  }

  async function ensureWorker(dump: Dump): Promise<void> {
    if (workerInstalled) return;
    setStatus("Installing the authored Bubble Putty graph…", true);
    const reply = await workerReply<InstallReply>((active) => active.postMessage({ kind: "install", installId: "bubble-putty", dump }));
    if (!reply.ok || reply.installed !== "bubble-putty") throw new Error("Could not initialize Bubble Putty GN-VM");
    workerInstalled = true;
  }

  function exactMesh(soup: TriSoup): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const sphere = geometry.boundingSphere;
    const mesh = new THREE.Mesh(geometry, exactMaterial);
    if (sphere && sphere.radius > 0) {
      mesh.position.copy(sphere.center).multiplyScalar(-1);
      mesh.scale.setScalar(5 / sphere.radius);
    }
    return mesh;
  }

  async function rebuildExact(): Promise<void> {
    if (!puttyDoc.blobs.length) return;
    const id = ++requestId;
    rebuildButton.disabled = true;
    const started = performance.now();
    try {
      const dump = await loadPuttyDump();
      if (disposed || id !== requestId) return;
      await ensureWorker(dump);
      setStatus("Rebuilding the authored Bubble Putty graph…", true);
      const reply = await workerReply<WorkerReply>((active) => active.postMessage({
        kind: "evaluate",
        installId: "bubble-putty",
        id,
        object: "PUTTY.002",
        group: "Bubble Putty Generator_9OCT2024_01",
        modifierIndex: 0,
        targetKind: "object",
        geometryInput: "Geometry",
        seed: puttyDoc.toSeed(2),
        collectionSpheres: {
          collection: "putty structure1",
          relativeToObject: "PUTTY.002",
          spheres: puttyDoc.blobs.map(({ position, radius }) => ({ position, radius })),
        },
        overrides: {
          Puttiness: Number(puttinessInput.value),
          Soften: Number(softenInput.value),
          "Max bubble size": Number(maxBubbleInput.value),
          "finalize for export": false,
        },
      }));
      if (disposed || id !== requestId) return;
      if (!reply.ok) throw new Error(reply.error);
      clearRoot(exactRoot);
      exactRoot.add(exactMesh(reply.soup));
      exactRoot.visible = true;
      exactVisible = true;
      preview.visible = false;
      proxyRoot.visible = false;
      const seconds = (performance.now() - started) / 1000;
      runtimeText.textContent = `${reply.soup.stats.verts.toLocaleString()} verts · ${reply.soup.stats.faces.toLocaleString()} faces · ${seconds.toFixed(1)}s`;
      setStatus("Authored Bubble Putty result ready · edit any blob to return to the live preview");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) rebuildButton.disabled = false;
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || mode === "orbit") return;
    updatePointer(event);
    if (mode === "add") {
      const plane = screenPlane(controls.target);
      if (raycaster.ray.intersectPlane(plane, dragPoint)) addBlobAt(dragPoint.clone());
      return;
    }
    const hit = raycaster.intersectObjects(proxyRoot.children, false)[0];
    const id = Number(hit?.object.userData.puttyBlobId);
    if (!Number.isFinite(id) || !puttyDoc.select(id)) {
      puttyDoc.select(null); updatePreview(); setStatus("Select a putty blob to move it"); return;
    }
    const selected = puttyDoc.selected()!;
    const selectedPoint = new THREE.Vector3().fromArray(selected.position);
    const plane = screenPlane(selectedPoint);
    raycaster.ray.intersectPlane(plane, dragPoint);
    dragging = { pointerId: event.pointerId, plane, offset: selectedPoint.sub(dragPoint) };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
    showInteractivePreview("Moving putty · release to keep the new position");
    updatePreview();
  }, { signal });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    updatePointer(event);
    if (!raycaster.ray.intersectPlane(dragging.plane, dragPoint)) return;
    dragPoint.add(dragging.offset);
    puttyDoc.moveSelected(dragPoint.toArray() as PuttyPoint);
    updatePreview();
  }, { signal });

  canvas.addEventListener("pointerup", (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    dragging = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* optional */ }
    setStatus("Putty moved · live preview updated");
  }, { signal });
  canvas.addEventListener("pointercancel", () => { dragging = null; }, { signal });

  orbitButton.addEventListener("click", () => setMode("orbit"), { signal });
  moveButton.addEventListener("click", () => setMode("move"), { signal });
  addModeButton.addEventListener("click", () => setMode("add"), { signal });
  addButton.addEventListener("click", () => {
    const offset = (puttyDoc.blobs.length % 5 - 2) * .55;
    addBlobAt(new THREE.Vector3(offset, offset * .45, 0));
    setMode("move");
  }, { signal });
  duplicateButton.addEventListener("click", () => {
    if (!puttyDoc.duplicateSelected()) return;
    showInteractivePreview("Selected putty duplicated"); updatePreview();
  }, { signal });
  deleteButton.addEventListener("click", () => {
    if (!puttyDoc.deleteSelected()) return;
    showInteractivePreview("Selected putty removed"); updatePreview();
  }, { signal });
  resetButton.addEventListener("click", () => {
    puttyDoc.reset(); showInteractivePreview("Bubble Putty reset to three editable blobs"); updatePreview();
  }, { signal });
  radiusInput.addEventListener("input", () => {
    radiusOutput.value = Number(radiusInput.value).toFixed(2);
    if (puttyDoc.resizeSelected(Number(radiusInput.value))) {
      showInteractivePreview("Putty size updated"); updatePreview();
    }
  }, { signal });
  for (const [input, output, digits] of [
    [puttinessInput, puttinessOutput, 2],
    [softenInput, softenOutput, 0],
    [maxBubbleInput, maxBubbleOutput, 2],
  ] as const) input.addEventListener("input", () => {
    output.value = Number(input.value).toFixed(digits);
    if (exactVisible) showInteractivePreview("Graph control changed · rebuild when ready");
  }, { signal });
  rebuildButton.addEventListener("click", () => void rebuildExact(), { signal });
  previewButton.addEventListener("click", () => showInteractivePreview("Interactive putty preview"), { signal });

  const stopObserving = observeCanvasBox(canvas, (width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  signal.addEventListener("abort", stopObserving);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  updatePreview();
  setMode("move");
  setStatus("Move a blob or add more putty · preview updates immediately");

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      requestId++;
      abort.abort();
      worker?.terminate(); worker = null;
      renderer.setAnimationLoop(null);
      controls.dispose();
      clearRoot(proxyRoot); clearRoot(exactRoot);
      preview.geometry.dispose();
      proxyGeometry.dispose(); centerGeometry.dispose();
      for (const material of [puttyMaterial, exactMaterial, proxyMaterial, selectedProxyMaterial, centerMaterial, selectedCenterMaterial]) material.dispose();
      environment.dispose();
      renderer.dispose(); renderer.forceContextLoss();
      canvas.style.cursor = "";
    },
  };
}
