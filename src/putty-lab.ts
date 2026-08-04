import * as THREE from "three";
import { bindStatusLine } from "./status-line";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { publicUrl } from "./base-url";
import {
  fitBaseShape,
  listLibraryShapes,
  loadFileBaseShape,
  loadLibraryBaseShape,
  type LibraryShapeInfo,
} from "./base-shapes";
import { canvasBox, observeCanvasBox, preferredCanvasPixelRatio, releaseToolContext } from "./canvas-viewport";
import { EditablePipeFixture, EditablePuttyDocument, type PuttyPoint } from "./editable-putty";
import { inlineMeshSeedFromObject } from "./inline-mesh-conversion";
import type { Dump, InlineMeshSeed, TriSoup } from "./gnvm";
import type { ToolHandle } from "./react/page-runtime";

type Mode = "orbit" | "move" | "add" | "pipes";
type FixtureMode = "blobs" | "pipes";
type WorkerReply =
  | { id: number; ok: true; soup: TriSoup }
  | { id: number; ok: false; error: string };
type InstallReply = { ok: true; installed: string };

const FIELD_HALF_SIZE = 7;
const FIELD_SUBTRACT = 12;
const PIPE_INFLUENCE_DIAMETERS = 8;
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
  const applyStatus = bindStatusLine("#putty-status");
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
  const blobFixtureButton = document.querySelector<HTMLButtonElement>("#putty-blob-fixture")!;
  const pipeFixtureButton = document.querySelector<HTMLButtonElement>("#putty-pipe-fixture")!;
  const lockPipeButton = document.querySelector<HTMLButtonElement>("#putty-lock-pipe")!;
  const movePipesButton = document.querySelector<HTMLButtonElement>("#putty-move-pipes")!;
  const anchorState = document.querySelector<HTMLElement>("#putty-anchor-state")!;
  const sizeLabel = document.querySelector<HTMLElement>("#putty-size-label")!;
  const canvasHelpText = document.querySelector<HTMLElement>("#putty-canvas-help-text")!;
  const interactionHint = document.querySelector<HTMLElement>("#putty-interaction-hint")!;
  const baseSelect = document.querySelector<HTMLSelectElement>("#putty-base-select")!;
  const baseImportButton = document.querySelector<HTMLButtonElement>("#putty-base-import")!;
  const baseClearButton = document.querySelector<HTMLButtonElement>("#putty-base-clear")!;
  const baseFileInput = document.querySelector<HTMLInputElement>("#putty-base-file")!;
  const baseStateText = document.querySelector<HTMLElement>("#putty-base-state")!;

  const abort = new AbortController();
  const { signal } = abort;
  let disposed = false;
  let mode: Mode = "move";
  let fixtureMode: FixtureMode = "blobs";
  let pipePuttyInitialized = false;
  let requestId = 0;
  let worker: Worker | null = null;
  let workerInstalled = false;
  let exactVisible = false;
  let dragging: { pointerId: number; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
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
  // Optional reference object / imported shape the putty molds onto.
  const baseRoot = new THREE.Group(); scene.add(baseRoot);
  const baseMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x8b93a4,
    metalness: .1,
    roughness: .55,
    side: THREE.DoubleSide,
  });
  let baseShape: { label: string; seed: InlineMeshSeed } | null = null;
  let baseRequest = 0;

  const proxyGeometry = new THREE.SphereGeometry(1, 20, 14);
  const proxyMaterial = new THREE.MeshBasicMaterial({ color: 0x9affbd, transparent: true, opacity: .075, wireframe: true, depthWrite: false });
  const selectedProxyMaterial = new THREE.MeshBasicMaterial({ color: 0xffd66b, transparent: true, opacity: .42, wireframe: true, depthTest: false });
  const centerGeometry = new THREE.SphereGeometry(.13, 16, 12);
  const centerMaterial = new THREE.MeshBasicMaterial({ color: 0xd7ffe4, depthTest: false });
  const selectedCenterMaterial = new THREE.MeshBasicMaterial({ color: 0xffbd59, depthTest: false });
  const pipeGeometry = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
  const solidPipeMaterial = new THREE.MeshPhysicalMaterial({ color: 0x080b0d, metalness: .55, roughness: .22, clearcoat: .5 });
  const pipeMaterial = new THREE.MeshBasicMaterial({ color: 0x91a1b2, wireframe: true, transparent: true, opacity: .18, depthTest: false });
  const selectedPipeMaterial = new THREE.MeshBasicMaterial({ color: 0xffb64f, wireframe: true, transparent: true, opacity: .46, depthTest: false });
  const lockedPipeMaterial = new THREE.MeshBasicMaterial({ color: 0x56a9ff, wireframe: true, transparent: true, opacity: .42, depthTest: false });
  const puttyDoc = new EditablePuttyDocument();
  puttyDoc.reset();
  const pipeFixture = new EditablePipeFixture();
  pipeFixture.resetThreePipes();

  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const dragPoint = new THREE.Vector3();

  function setStatus(message: string, busy = false): void {
    if (disposed) return;
    applyStatus(busy ? "busy" : "ready", message);
  }

  function clearRoot(root: THREE.Group): void {
    while (root.children.length) {
      const child = root.children.pop()!;
      child.traverse((item) => {
        if (item instanceof THREE.Mesh && item.geometry !== proxyGeometry && item.geometry !== centerGeometry && item.geometry !== pipeGeometry) item.geometry.dispose();
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
    for (const child of proxyRoot.children) child.visible = true;
    proxyRoot.visible = mode !== "orbit";
    baseRoot.visible = baseShape !== null && fixtureMode === "blobs";
    if (message) setStatus(message);
  }

  function orientPipe(mesh: THREE.Mesh, direction: PuttyPoint): void {
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3().fromArray(direction).normalize(),
    );
  }

  function updateProxies(): void {
    clearRoot(proxyRoot);
    if (fixtureMode === "pipes") {
      for (const pipe of pipeFixture.pipes) {
        const selected = pipe.id === pipeFixture.selectedId;
        const solid = new THREE.Mesh(pipeGeometry, solidPipeMaterial);
        solid.position.fromArray(pipe.position);
        solid.scale.set(pipe.radius, pipe.length, pipe.radius);
        orientPipe(solid, pipe.direction);
        solid.userData.puttyPipeId = pipe.id;
        solid.userData.puttyPipeSolid = true;
        solid.renderOrder = 10;
        proxyRoot.add(solid);
        const mesh = new THREE.Mesh(
          pipeGeometry,
          pipe.locked ? lockedPipeMaterial : mode === "pipes" && selected ? selectedPipeMaterial : pipeMaterial,
        );
        mesh.position.fromArray(pipe.position);
        mesh.scale.set(pipe.radius, pipe.length, pipe.radius);
        orientPipe(mesh, pipe.direction);
        mesh.userData.puttyPipeId = pipe.id;
        mesh.renderOrder = 22;
        proxyRoot.add(mesh);
      }
    }
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
    const addFieldBall = (position: PuttyPoint, radius: number): void => {
      const normalizedRadius = radius / (FIELD_HALF_SIZE * 2);
      const strength = (preview.isolation + FIELD_SUBTRACT) * normalizedRadius * normalizedRadius;
      preview.addBall(
        position[0] / (FIELD_HALF_SIZE * 2) + .5,
        position[1] / (FIELD_HALF_SIZE * 2) + .5,
        position[2] / (FIELD_HALF_SIZE * 2) + .5,
        Math.max(.08, strength),
        FIELD_SUBTRACT,
      );
    };
    if (fixtureMode === "pipes") {
      for (const pipe of pipeFixture.pipes) {
        const influenceLength = Math.min(pipe.length, Math.max(pipe.radius * PIPE_INFLUENCE_DIAMETERS, 1.8));
        const samples = Math.max(5, Math.ceil(influenceLength / Math.max(pipe.radius * 1.25, .35)));
        for (let index = 0; index < samples; index++) {
          const along = (index / (samples - 1) - .5) * influenceLength;
          addFieldBall([
            pipe.position[0] + pipe.direction[0] * along,
            pipe.position[1] + pipe.direction[1] * along,
            pipe.position[2] + pipe.direction[2] * along,
          ], pipe.radius + .16);
        }
      }
    }
    for (const blob of puttyDoc.blobs) addFieldBall(blob.position, blob.radius);
    preview.update();
    updateProxies();
    if (fixtureMode === "pipes") {
      const selectedPipe = pipeFixture.selected();
      const selectedBlob = puttyDoc.selected();
      const anchor = pipeFixture.pipes.find((pipe) => pipe.locked);
      countText.textContent = `${puttyDoc.blobs.length} putty control${puttyDoc.blobs.length === 1 ? "" : "s"} · ${pipeFixture.pipes.length} pipes`;
      selectionText.textContent = mode === "pipes"
        ? selectedPipe ? `Pipe ${selectedPipe.id} selected${selectedPipe.locked ? " · locked" : ""}` : "No pipe selected"
        : selectedBlob ? `Putty ${selectedBlob.id} selected · surface locked` : "No putty selected";
      anchorState.textContent = anchor
        ? `Pipe ${anchor.id} is locked as the anchor surface`
        : "Select a pipe and lock it as the anchor surface";
      const sized = mode === "pipes" ? selectedPipe : selectedBlob;
      if (sized) {
        radiusInput.value = String(sized.radius);
        radiusOutput.value = sized.radius.toFixed(2);
      }
      duplicateButton.disabled = !selectedBlob;
      deleteButton.disabled = !selectedBlob || puttyDoc.blobs.length <= 1;
      addButton.disabled = false;
      addModeButton.disabled = false;
      lockPipeButton.disabled = !selectedPipe;
      movePipesButton.disabled = false;
      return;
    }
    const selected = puttyDoc.selected();
    countText.textContent = `${puttyDoc.blobs.length} putty blob${puttyDoc.blobs.length === 1 ? "" : "s"}`;
    selectionText.textContent = selected ? `Blob ${selected.id} selected` : "No blob selected";
    if (selected) {
      radiusInput.value = String(selected.radius);
      radiusOutput.value = selected.radius.toFixed(2);
    }
    duplicateButton.disabled = !selected;
    deleteButton.disabled = !selected || puttyDoc.blobs.length <= 1;
    addButton.disabled = false;
    addModeButton.disabled = false;
    lockPipeButton.disabled = true;
    movePipesButton.disabled = true;
  }

  function setMode(next: Mode): void {
    if (fixtureMode === "blobs" && next === "pipes") next = "move";
    mode = next;
    controls.enabled = next === "orbit";
    orbitButton.classList.toggle("active", next === "orbit");
    moveButton.classList.toggle("active", next === "move");
    addModeButton.classList.toggle("active", next === "add");
    movePipesButton.classList.toggle("active", next === "pipes");
    sizeLabel.textContent = fixtureMode === "pipes" && next === "pipes" ? "Pipe radius" : fixtureMode === "pipes" ? "Putty size" : "Blob size";
    proxyRoot.visible = !exactVisible && next !== "orbit";
    canvas.style.cursor = next === "orbit" ? "grab" : next === "add" ? "copy" : "default";
  }

  function setFixtureMode(next: FixtureMode): void {
    fixtureMode = next;
    blobFixtureButton.classList.toggle("active", next === "blobs");
    pipeFixtureButton.classList.toggle("active", next === "pipes");
    canvasHelpText.textContent = next === "pipes"
      ? "three movable pipes · one locked anchor surface"
      : "editable source blobs · one shared body";
    interactionHint.textContent = next === "pipes"
      ? "Drag the putty controls around the blue anchor surface or place more putty. Use Move pipes only when you want to rearrange the fixture."
      : "Select and drag a blob to reshape the shared putty body. Orbit, then return to Move putty to reposition blobs in another screen plane.";
    if (next === "pipes") {
      if (!pipePuttyInitialized) {
        puttyDoc.resetForPipeJoint();
        pipePuttyInitialized = true;
        maxBubbleInput.value = ".65";
        maxBubbleOutput.value = "0.65";
      }
      radiusInput.min = ".18";
      radiusInput.max = "1.5";
      radiusInput.step = ".02";
      setMode("move");
      lockPuttyControlsToAnchor();
      showInteractivePreview("Three-pipe fixture ready · Pipe 1 is locked to its surface");
    } else {
      radiusInput.min = ".4";
      radiusInput.max = "4.5";
      radiusInput.step = ".05";
      anchorState.textContent = "Blob authoring · choose Three pipes to test a locked surface";
      showInteractivePreview("Blob authoring preview");
    }
    updatePreview();
  }

  function screenPlane(point: THREE.Vector3): THREE.Plane {
    const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
  }

  function projectToAnchorSurface(point: THREE.Vector3, puttyRadius: number): THREE.Vector3 {
    const anchor = pipeFixture.pipes.find((pipe) => pipe.locked);
    if (!anchor) return point.clone();
    const center = new THREE.Vector3().fromArray(anchor.position);
    const axis = new THREE.Vector3().fromArray(anchor.direction).normalize();
    const delta = point.clone().sub(center);
    const along = THREE.MathUtils.clamp(delta.dot(axis), -anchor.length / 2, anchor.length / 2);
    const axisPoint = center.clone().addScaledVector(axis, along);
    let radial = point.clone().sub(axisPoint);
    if (radial.lengthSq() < 1e-8) {
      radial = camera.getWorldDirection(new THREE.Vector3()).cross(axis);
      if (radial.lengthSq() < 1e-8) radial.set(0, 0, 1).cross(axis);
    }
    return axisPoint.add(radial.normalize().multiplyScalar(anchor.radius + Math.min(puttyRadius * .22, .3)));
  }

  function lockPuttyControlsToAnchor(): void {
    for (const blob of puttyDoc.blobs) {
      blob.position = projectToAnchorSurface(new THREE.Vector3().fromArray(blob.position), blob.radius)
        .toArray() as PuttyPoint;
    }
  }

  function addBlobAt(position: THREE.Vector3): void {
    const radius = Number(radiusInput.value);
    const lockedPosition = fixtureMode === "pipes" ? projectToAnchorSurface(position, radius) : position;
    const blob = puttyDoc.add(lockedPosition.toArray() as PuttyPoint, radius);
    puttyDoc.select(blob.id);
    showInteractivePreview("Putty added · drag it or add another blob");
    updatePreview();
  }

  /** Pointer ray against the loaded base shape, when one is active for blob authoring. */
  function baseSurfaceHit(): THREE.Intersection | null {
    if (!baseShape || fixtureMode !== "blobs" || !baseRoot.visible) return null;
    return raycaster.intersectObjects(baseRoot.children, true)[0] ?? null;
  }

  function installBaseObject(label: string, object: THREE.Object3D, fingerprint: string): void {
    clearRoot(baseRoot);
    object.traverse((child) => { if (child instanceof THREE.Mesh) child.material = baseMaterial; });
    baseRoot.add(object);
    // Match the putty world: blobs live in roughly a 7-unit half-size field.
    fitBaseShape(object, 5);
    const seed = inlineMeshSeedFromObject(baseRoot, label, `${fingerprint}:fit5`);
    baseShape = { label, seed };
    baseClearButton.disabled = false;
    const verts = Math.floor(seed.positions.length / 3);
    baseStateText.textContent = `${label} · ${verts.toLocaleString()} verts join the putty body${
      verts > 60_000 ? " · large shape, rebuilding may take a while" : ""}`;
    showInteractivePreview(`${label} placed · click its surface to put putty on it, then rebuild`);
    updatePreview();
  }

  function clearBaseShape(message = "Base object cleared · putty forms from blobs alone"): void {
    baseRequest++;
    clearRoot(baseRoot);
    baseShape = null;
    baseSelect.value = "";
    baseClearButton.disabled = true;
    baseStateText.textContent = "Pick a reference object or import any shape — it joins the putty body and blobs snap onto its surface.";
    showInteractivePreview(message);
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
    return new THREE.Mesh(geometry, exactMaterial);
  }

  async function rebuildExact(): Promise<void> {
    if (fixtureMode === "blobs" && !puttyDoc.blobs.length) return;
    const id = ++requestId;
    rebuildButton.disabled = true;
    const started = performance.now();
    try {
      const dump = await loadPuttyDump();
      if (disposed || id !== requestId) return;
      await ensureWorker(dump);
      setStatus("Rebuilding the authored Bubble Putty graph…", true);
      const pipeMode = fixtureMode === "pipes";
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
        collectionCylinders: pipeMode ? {
          collection: "putty structure1",
          relativeToObject: "PUTTY.002",
          cylinders: pipeFixture.toCylinders().map((pipe) => ({
            ...pipe,
            length: Math.min(pipe.length, Math.max(pipe.radius * PIPE_INFLUENCE_DIAMETERS, 1.8)),
          })),
        } : undefined,
        collectionMeshes: !pipeMode && baseShape ? {
          collection: "putty structure1",
          relativeToObject: "PUTTY.002",
          meshes: [{
            positions: baseShape.seed.positions,
            indices: baseShape.seed.indices,
            name: baseShape.label,
          }],
        } : undefined,
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
      // The authored result already wraps the base shape, so hide the input copy.
      baseRoot.visible = false;
      for (const child of proxyRoot.children) {
        child.visible = child.userData.puttyPipeSolid === true;
      }
      proxyRoot.visible = pipeMode;
      const seconds = (performance.now() - started) / 1000;
      runtimeText.textContent = `${reply.soup.stats.verts.toLocaleString()} verts · ${reply.soup.stats.faces.toLocaleString()} faces · ${seconds.toFixed(1)}s`;
      setStatus(pipeMode
        ? "Authored putty molded around all three pipes · drag putty or move an unlocked pipe to continue"
        : baseShape
          ? `Authored putty molded around ${baseShape.label} · edit any blob to return to the live preview`
          : "Authored Bubble Putty result ready · edit any blob to return to the live preview");
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
      const surfaceHit = baseSurfaceHit();
      if (surfaceHit) { addBlobAt(surfaceHit.point.clone()); return; }
      const plane = screenPlane(controls.target);
      if (raycaster.ray.intersectPlane(plane, dragPoint)) addBlobAt(dragPoint.clone());
      return;
    }
    if (fixtureMode === "pipes" && mode === "pipes") {
      const pipeHit = raycaster.intersectObjects(
        proxyRoot.children.filter((object) => Number.isFinite(Number(object.userData.puttyPipeId))),
        false,
      )[0];
      const pipeId = Number(pipeHit?.object.userData.puttyPipeId);
      if (!Number.isFinite(pipeId) || !pipeFixture.select(pipeId)) {
        pipeFixture.select(null); updatePreview(); setStatus("Select a pipe to move or anchor it"); return;
      }
      const pipe = pipeFixture.selected()!;
      updatePreview();
      if (pipe.locked) {
        setStatus(`Pipe ${pipe.id} is the locked anchor surface · choose another pipe to move it`);
        return;
      }
      const selectedPoint = new THREE.Vector3().fromArray(pipe.position);
      const plane = screenPlane(selectedPoint);
      raycaster.ray.intersectPlane(plane, dragPoint);
      dragging = { pointerId: event.pointerId, plane, offset: selectedPoint.sub(dragPoint) };
      try { canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
      showInteractivePreview(`Moving Pipe ${pipe.id} relative to the locked surface`);
      return;
    }
    const blobHit = raycaster.intersectObjects(
      proxyRoot.children.filter((object) => Number.isFinite(Number(object.userData.puttyBlobId))),
      false,
    )[0];
    const blobId = Number(blobHit?.object.userData.puttyBlobId);
    if (!Number.isFinite(blobId) || !puttyDoc.select(blobId)) {
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
    if (fixtureMode === "pipes" && mode === "pipes") {
      pipeFixture.moveSelected(dragPoint.toArray() as PuttyPoint);
    } else {
      const selected = puttyDoc.selected();
      const surfaceHit = baseSurfaceHit();
      const next = surfaceHit ? surfaceHit.point
        : fixtureMode === "pipes" && selected
          ? projectToAnchorSurface(dragPoint, selected.radius)
          : dragPoint;
      puttyDoc.moveSelected(next.toArray() as PuttyPoint);
    }
    updatePreview();
  }, { signal });

  canvas.addEventListener("pointerup", (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    dragging = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* optional */ }
    setStatus(fixtureMode === "pipes" && mode === "pipes"
      ? "Pipe moved · the putty preview remolded around the three-pipe fixture"
      : fixtureMode === "pipes"
        ? "Putty dragged around the locked pipe surface"
        : "Putty moved · live preview updated");
  }, { signal });
  canvas.addEventListener("pointercancel", () => { dragging = null; }, { signal });

  orbitButton.addEventListener("click", () => { setMode("orbit"); updatePreview(); }, { signal });
  moveButton.addEventListener("click", () => { setMode("move"); updatePreview(); }, { signal });
  addModeButton.addEventListener("click", () => { setMode("add"); updatePreview(); }, { signal });
  movePipesButton.addEventListener("click", () => { setMode("pipes"); updatePreview(); }, { signal });
  addButton.addEventListener("click", () => {
    const offset = (puttyDoc.blobs.length % 5 - 2) * .55;
    addBlobAt(new THREE.Vector3(offset, offset * .45, 0));
    setMode("move");
  }, { signal });
  duplicateButton.addEventListener("click", () => {
    if (!puttyDoc.duplicateSelected()) return;
    if (fixtureMode === "pipes") {
      const selected = puttyDoc.selected()!;
      selected.position = projectToAnchorSurface(new THREE.Vector3().fromArray(selected.position), selected.radius).toArray() as PuttyPoint;
    }
    showInteractivePreview("Selected putty duplicated"); updatePreview();
  }, { signal });
  deleteButton.addEventListener("click", () => {
    if (!puttyDoc.deleteSelected()) return;
    showInteractivePreview("Selected putty removed"); updatePreview();
  }, { signal });
  resetButton.addEventListener("click", () => {
    if (fixtureMode === "pipes") {
      pipeFixture.resetThreePipes();
      puttyDoc.resetForPipeJoint();
      lockPuttyControlsToAnchor();
      showInteractivePreview("Three pipes reset · Pipe 1 is the locked anchor surface");
    } else {
      puttyDoc.reset(); showInteractivePreview("Bubble Putty reset to three editable blobs");
    }
    updatePreview();
  }, { signal });
  radiusInput.addEventListener("input", () => {
    radiusOutput.value = Number(radiusInput.value).toFixed(2);
    const resized = fixtureMode === "pipes" && mode === "pipes"
      ? pipeFixture.resizeSelected(Number(radiusInput.value))
      : puttyDoc.resizeSelected(Number(radiusInput.value));
    if (resized && fixtureMode === "pipes" && mode !== "pipes") {
      const selected = puttyDoc.selected()!;
      selected.position = projectToAnchorSurface(new THREE.Vector3().fromArray(selected.position), selected.radius).toArray() as PuttyPoint;
    }
    if (resized) {
      showInteractivePreview(fixtureMode === "pipes" && mode === "pipes" ? "Pipe radius updated" : "Putty size updated");
      updatePreview();
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

  let libraryShapes: LibraryShapeInfo[] = [];
  void listLibraryShapes()
    .then((shapes) => {
      if (disposed) return;
      libraryShapes = shapes;
      // Remounts retain the DOM: rebuild after the placeholder instead of appending.
      while (baseSelect.options.length > 1) baseSelect.remove(1);
      for (const shape of shapes) baseSelect.add(new Option(shape.title, shape.id));
    })
    .catch(() => {
      if (!disposed) baseStateText.textContent = "Reference catalog unavailable · import a shape file instead";
    });

  baseSelect.addEventListener("change", () => {
    const id = baseSelect.value;
    if (!id) { clearBaseShape(); return; }
    const info = libraryShapes.find((shape) => shape.id === id);
    if (!info) return;
    const request = ++baseRequest;
    setStatus(`Evaluating ${info.title} through the GN-VM…`, true);
    baseStateText.textContent = `Evaluating ${info.title}…`;
    loadLibraryBaseShape(info)
      .then((shape) => {
        if (disposed || request !== baseRequest) return;
        installBaseObject(shape.label, shape.object, `library:${info.id}`);
      })
      .catch((error) => {
        if (disposed || request !== baseRequest) return;
        setStatus(error instanceof Error ? error.message : String(error));
        baseStateText.textContent = `${info.title} could not be evaluated · choose another shape`;
      });
  }, { signal });

  baseImportButton.addEventListener("click", () => baseFileInput.click(), { signal });
  baseFileInput.addEventListener("change", () => {
    const file = baseFileInput.files?.[0];
    baseFileInput.value = "";
    if (!file) return;
    const request = ++baseRequest;
    setStatus(`Loading ${file.name}…`, true);
    loadFileBaseShape(file)
      .then((shape) => {
        if (disposed || request !== baseRequest) return;
        baseSelect.value = "";
        installBaseObject(shape.label, shape.object, shape.seed.fingerprint ?? file.name);
      })
      .catch((error) => {
        if (disposed || request !== baseRequest) return;
        setStatus(error instanceof Error ? error.message : String(error));
        baseStateText.textContent = `${file.name} could not be loaded · choose a GLB, GLTF, OBJ, STL, PLY, or FBX file`;
      });
  }, { signal });
  baseClearButton.addEventListener("click", () => clearBaseShape(), { signal });
  blobFixtureButton.addEventListener("click", () => setFixtureMode("blobs"), { signal });
  pipeFixtureButton.addEventListener("click", () => setFixtureMode("pipes"), { signal });
  lockPipeButton.addEventListener("click", () => {
    if (!pipeFixture.lockSelected()) return;
    const selected = pipeFixture.selected()!;
    lockPuttyControlsToAnchor();
    showInteractivePreview(`Pipe ${selected.id} locked as the anchor surface`);
    updatePreview();
  }, { signal });

  const stopObserving = observeCanvasBox(canvas, (width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  signal.addEventListener("abort", stopObserving);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  updatePreview();
  setMode("move");
  setFixtureMode("blobs");
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
      clearRoot(proxyRoot); clearRoot(exactRoot); clearRoot(baseRoot);
      preview.geometry.dispose();
      proxyGeometry.dispose(); centerGeometry.dispose(); pipeGeometry.dispose();
      for (const material of [
        puttyMaterial, exactMaterial, proxyMaterial, selectedProxyMaterial,
        centerMaterial, selectedCenterMaterial, pipeMaterial, selectedPipeMaterial,
        lockedPipeMaterial, solidPipeMaterial, baseMaterial,
      ]) material.dispose();
      environment.dispose();
      renderer.dispose(); releaseToolContext(renderer);
      canvas.style.cursor = "";
    },
  };
}
