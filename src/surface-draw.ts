import * as THREE from "three";
import { bindStatusLine } from "./status-line";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { publicUrl } from "./base-url";
import { evaluateLibraryShape, listLibraryShapes, loadLibraryBaseShape, type LibraryShapeInfo } from "./base-shapes";
import { canvasBox, observeCanvasBox, preferredCanvasPixelRatio, releaseToolContext } from "./canvas-viewport";
import {
  EditableCurveDocument,
  type EditableCurvePoint,
  type EditableCurveStroke,
  type ProjectedCurvePoint,
} from "./editable-curves";
import type { Dump, TriSoup } from "./gnvm/index";
import type { ToolHandle } from "./react/page-runtime";
import {
  ALL_TARGET_SURFACES,
  PICK_TARGET_SURFACE,
  collectTargetSurfaces,
  surfacesForTarget,
  targetLabel,
  type TargetSurface,
} from "./surface-targets";
import { SweptContactSelection, type SweptContactSnapshot } from "./swept-contact-selection";
import { relaxClothLattice } from "./cloth-lattice-relaxation";
import { SelectionMaskDocument, type SelectionMaskOperation } from "./selection-mask-document";

declare module "three" {
  interface BufferGeometry { computeBoundsTree: typeof computeBoundsTree; disposeBoundsTree: typeof disposeBoundsTree }
}

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

type Sample = EditableCurvePoint;
type NewSample = Omit<EditableCurvePoint, "id">;
type SurfaceHit = NewSample & { target: THREE.Mesh };
type StrokeSamples = EditableCurvePoint[];
type CrayonLayout = { stroke: StrokeSamples; start: number; length: number };
type DrawingArea = { center: THREE.Vector3; normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; sizeU: number; sizeV: number };
type CurveFrame = Pick<DrawingArea, "center" | "normal" | "u" | "v">;
type WorkerReply = { id: number; ok: true; soup: TriSoup } | { id: number; ok: false; error: string };
type WorkerInstallReply = { ok: true; installed: string };

const CRAYON_SCALE = 20;
// Curved targets must remain visibly below the generated shell. GN output can
// straddle its input plane, so surface projection rebases its lowest Z to this
// clearance instead of allowing negative vertices to sink into the target.
const SURFACE_CLEARANCE = .018;
const AREA_CONTACT_SAMPLES = 20;

// Pure fetched/parsed brush assets may persist across remounts; everything
// DOM/GPU/listener-bound is created fresh inside createTool().
type BrushAssets = { periodic: Dump; crayon: Dump; authored: THREE.Group };
let brushAssetsPromise: Promise<BrushAssets> | null = null;
function loadBrushAssets(): Promise<BrushAssets> {
  if (!brushAssetsPromise) {
    brushAssetsPromise = Promise.all([
      fetch(publicUrl("dojo/periodic-brush/dump.json")).then((response) => response.json()),
      fetch(publicUrl("dojo/crayon/dump.json")).then((response) => response.json()),
      new GLTFLoader().loadAsync(publicUrl("dojo/crayon/00-browser-baseline.glb")),
    ]).then(([periodic, crayon, authored]) => ({ periodic: periodic as Dump, crayon: crayon as Dump, authored: authored.scene }));
    brushAssetsPromise.catch(() => { brushAssetsPromise = null; });
  }
  return brushAssetsPromise;
}

// Typewriter glyph geometry for the text brush: the studies text graph runs
// once per distinct string; the flat glyph soup is then swept along strokes.
let typewriterDumpPromise: Promise<Dump> | null = null;
const typewriterSoupCache = new Map<string, Promise<TriSoup>>();
function typewriterTextSoup(text: string): Promise<TriSoup> {
  let cached = typewriterSoupCache.get(text);
  if (cached) return cached;
  typewriterDumpPromise ??= fetch(publicUrl("dojo/typewriter/dump.json")).then((response) => {
    if (!response.ok) throw new Error(`Typewriter graph failed to load (${response.status})`);
    return response.json() as Promise<Dump>;
  });
  typewriterDumpPromise.catch(() => { typewriterDumpPromise = null; });
  cached = typewriterDumpPromise.then((dump) => new Promise<TriSoup>((resolve, reject) => {
    const worker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "surface-text" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.soup); else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    // The graph animates a type-then-erase demo cycle; a far frame plus a
    // deferred backspace keyframe shows the whole string fully typed.
    worker.postMessage({
      id: 1,
      dump,
      object: "_Typewriter Node Container",
      overrides: { __frame: 2400, "Text input": text, "Keyframe to Backspace": 100000 },
    });
  }));
  cached.catch(() => typewriterSoupCache.delete(text));
  typewriterSoupCache.set(text, cached);
  return cached;
}

export function createTool(): ToolHandle {
  const canvas = document.querySelector<HTMLCanvasElement>("#surface-canvas")!;
  const selectionHud = document.querySelector<HTMLElement>("#surface-selection-hud")!;
  const selectionReticle = document.querySelector<HTMLElement>("#surface-selection-reticle")!;
  const selectionLabel = document.querySelector<HTMLElement>("#surface-selection-label")!;
  const flatOverlay = document.querySelector<HTMLElement>("#surface-flat-overlay")!;
  const brushReticle = document.querySelector<HTMLElement>("#surface-brush-reticle")!;
  const brushLabel = document.querySelector<HTMLElement>("#surface-brush-label")!;
  const fileInput = document.querySelector<HTMLInputElement>("#surface-file")!;
  const fileName = document.querySelector<HTMLElement>("#surface-file-name")!;
  const targetSelect = document.querySelector<HTMLSelectElement>("#surface-target")!;
  const targetPickButton = document.querySelector<HTMLButtonElement>("#surface-target-pick")!;
  const targetSummary = document.querySelector<HTMLElement>("#surface-target-summary")!;
  const targetPicker = targetSelect.closest<HTMLElement>(".surface-target-picker")!;
  const applyStatus = bindStatusLine("#surface-status");
  const orbitButton = document.querySelector<HTMLButtonElement>("#surface-orbit")!;
  const areaButton = document.querySelector<HTMLButtonElement>("#surface-area")!;
  const drawButton = document.querySelector<HTMLButtonElement>("#surface-draw")!;
  const selectButton = document.querySelector<HTMLButtonElement>("#surface-select")!;
  const demoButton = document.querySelector<HTMLButtonElement>("#surface-demo")!;
  const flatButton = document.querySelector<HTMLButtonElement>("#surface-flat")!;
  const sampleButton = document.querySelector<HTMLButtonElement>("#surface-sample")!;
  const parityPathButton = document.querySelector<HTMLButtonElement>("#surface-parity-path")!;
  const curvedParityPathButton = document.querySelector<HTMLButtonElement>("#surface-curved-parity-path")!;
  const undoButton = document.querySelector<HTMLButtonElement>("#surface-undo")!;
  const undoAreaButton = document.querySelector<HTMLButtonElement>("#surface-undo-area")!;
  const clearButton = document.querySelector<HTMLButtonElement>("#surface-clear")!;
  const clearAreaButton = document.querySelector<HTMLButtonElement>("#surface-clear-area")!;
  const areaDoodleButton = document.querySelector<HTMLButtonElement>("#surface-area-doodle")!;
  const gizmoMoveButton = document.querySelector<HTMLButtonElement>("#surface-gizmo-move")!;
  const gizmoRotateButton = document.querySelector<HTMLButtonElement>("#surface-gizmo-rotate")!;
  const gizmoScaleButton = document.querySelector<HTMLButtonElement>("#surface-gizmo-scale")!;
  const areaSnap = document.querySelector<HTMLInputElement>("#surface-area-snap")!;
  const areaSpace = document.querySelector<HTMLSelectElement>("#surface-area-space")!;
  const selectorList = document.querySelector<HTMLSelectElement>("#surface-selector-list")!;
  const selectorNewButton = document.querySelector<HTMLButtonElement>("#surface-selector-new")!;
  const selectorDeleteButton = document.querySelector<HTMLButtonElement>("#surface-selector-delete")!;
  const selectorVisible = document.querySelector<HTMLInputElement>("#surface-selector-visible")!;
  const selectorLocked = document.querySelector<HTMLInputElement>("#surface-selector-locked")!;
  const maskOperation = document.querySelector<HTMLSelectElement>("#surface-mask-operation")!;
  const projectionHeight = document.querySelector<HTMLInputElement>("#surface-projection-height")!;
  const projectionHeightOutput = document.querySelector<HTMLOutputElement>("#surface-projection-height-output")!;
  const dropAreaButton = document.querySelector<HTMLButtonElement>("#surface-drop-area")!;
  const pushThroughButton = document.querySelector<HTMLButtonElement>("#surface-push-through")!;
  const areaSize = document.querySelector<HTMLInputElement>("#surface-area-size")!;
  const areaSizeOutput = document.querySelector<HTMLOutputElement>("#surface-area-size-output")!;
  const contactSoftness = document.querySelector<HTMLInputElement>("#surface-contact-softness")!;
  const contactSoftnessOutput = document.querySelector<HTMLOutputElement>("#surface-contact-softness-output")!;
  const contactDepthControl = document.querySelector<HTMLInputElement>("#surface-contact-depth")!;
  const contactDepthOutput = document.querySelector<HTMLOutputElement>("#surface-contact-depth-output")!;
  const maxSurfaceAngle = document.querySelector<HTMLInputElement>("#surface-max-angle")!;
  const maxSurfaceAngleOutput = document.querySelector<HTMLOutputElement>("#surface-max-angle-output")!;
  const drapeStretch = document.querySelector<HTMLInputElement>("#surface-drape-stretch")!;
  const drapeStretchOutput = document.querySelector<HTMLOutputElement>("#surface-drape-stretch-output")!;
  const drapeIterations = document.querySelector<HTMLInputElement>("#surface-drape-iterations")!;
  const drapeIterationsOutput = document.querySelector<HTMLOutputElement>("#surface-drape-iterations-output")!;
  const contactLock = document.querySelector<HTMLInputElement>("#surface-contact-lock")!;
  const clearContactButton = document.querySelector<HTMLButtonElement>("#surface-contact-clear")!;
  const clothEnabled = document.querySelector<HTMLInputElement>("#surface-cloth-enabled")!;
  const clothSag = document.querySelector<HTMLInputElement>("#surface-cloth-sag")!;
  const clothSagOutput = document.querySelector<HTMLOutputElement>("#surface-cloth-sag-output")!;
  const transformPosition = (["x", "y", "z"] as const).map((axis) => document.querySelector<HTMLInputElement>(`#surface-area-position-${axis}`)!);
  const transformRotation = (["x", "y", "z"] as const).map((axis) => document.querySelector<HTMLInputElement>(`#surface-area-rotation-${axis}`)!);
  const transformScale = (["x", "y", "z"] as const).map((axis) => document.querySelector<HTMLInputElement>(`#surface-area-scale-${axis}`)!);
  const applyTransformButton = document.querySelector<HTMLButtonElement>("#surface-area-apply-transform")!;
  const resetTransformButton = document.querySelector<HTMLButtonElement>("#surface-area-reset-transform")!;
  const brushSelect = document.querySelector<HTMLSelectElement>("#surface-brush")!;
  const periodicControls = document.querySelector<HTMLElement>("#surface-periodic-controls")!;
  const crayonControls = document.querySelector<HTMLElement>("#surface-crayon-controls")!;
  const textControls = document.querySelector<HTMLElement>("#surface-text-controls")!;
  const surfaceText = document.querySelector<HTMLInputElement>("#surface-text")!;
  const textFit = document.querySelector<HTMLInputElement>("#surface-text-fit")!;
  const textSize = document.querySelector<HTMLInputElement>("#surface-text-size")!;
  const textSizeOutput = document.querySelector<HTMLOutputElement>("#surface-text-size-output")!;
  const textOffset = document.querySelector<HTMLInputElement>("#surface-text-offset")!;
  const textOffsetOutput = document.querySelector<HTMLOutputElement>("#surface-text-offset-output")!;
  const stampControls = document.querySelector<HTMLElement>("#surface-stamp-controls")!;
  const stampAsset = document.querySelector<HTMLSelectElement>("#surface-stamp-asset")!;
  const stampSize = document.querySelector<HTMLInputElement>("#surface-stamp-size")!;
  const stampSizeOutput = document.querySelector<HTMLOutputElement>("#surface-stamp-size-output")!;
  const stampSpacing = document.querySelector<HTMLInputElement>("#surface-stamp-spacing")!;
  const stampSpacingOutput = document.querySelector<HTMLOutputElement>("#surface-stamp-spacing-output")!;
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

  const abort = new AbortController();
  const { signal } = abort;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
  const viewport = canvasBox(canvas);
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .82;
  const scene = new THREE.Scene();
  const perspectiveCamera = new THREE.PerspectiveCamera(40, viewport.width / viewport.height, .01, 200);
  const flatCamera = new THREE.OrthographicCamera(-4, 4, 4, -4, .01, 200);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;
  perspectiveCamera.position.set(6.7, -8.5, 5.6);
  flatCamera.position.set(0, 0, 10);
  const controls = new OrbitControls<THREE.Camera>(camera, canvas); controls.enableDamping = true; controls.target.set(0, 0, 0);
  const areaAnchor = new THREE.Object3D(); areaAnchor.name = "Chrome Crayon drawing area"; scene.add(areaAnchor);
  const areaTransform = new TransformControls(camera, canvas);
  areaTransform.setSpace("local"); areaTransform.setSize(.72); areaTransform.enabled = false;
  const areaTransformHelper = areaTransform.getHelper(); areaTransformHelper.visible = false; scene.add(areaTransformHelper);
  const room = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(renderer); const envTexture = pmrem.fromScene(room, .04).texture; scene.environment = envTexture; room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe9f4ed, 0x172019, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-5, -7, 9); scene.add(key);

  const targetRoot = new THREE.Group(); scene.add(targetRoot);
  const brushRoot = new THREE.Group(); scene.add(brushRoot);
  const previewRoot = new THREE.Group(); scene.add(previewRoot);
  const areaRoot = new THREE.Group(); scene.add(areaRoot);
  const selectorOverlayRoot = new THREE.Group(); scene.add(selectorOverlayRoot);
  const handleRoot = new THREE.Group(); scene.add(handleRoot);
  // A matte neutral target keeps the yellow contact mask legible and makes it
  // clear that selector feedback is not Blender's shiny-object selection tint.
  const targetMaterial = new THREE.MeshPhysicalMaterial({ color: 0x66726d, metalness: 0, roughness: 1, clearcoat: 0, envMapIntensity: .22, side: THREE.DoubleSide });
  const inactiveTargetMaterial = new THREE.MeshPhysicalMaterial({ color: 0x27312d, metalness: 0, roughness: .72, transparent: true, opacity: .24, depthWrite: false, side: THREE.DoubleSide });
  const flatTargetMaterial = new THREE.MeshBasicMaterial({ color: 0x696d6a, side: THREE.DoubleSide });
  const brushMaterial = new THREE.MeshPhysicalMaterial({ color: 0xb9ff8c, emissive: 0x13260b, metalness: .18, roughness: .27, clearcoat: .48, side: THREE.DoubleSide });
  const chromeMaterial = new THREE.MeshPhysicalMaterial({ color: 0xb7c3c0, metalness: 1, roughness: .22, envMapIntensity: .8, side: THREE.DoubleSide });
  const sigilMaterial = new THREE.MeshPhysicalMaterial({ color: 0x91c8ff, metalness: 1, roughness: .08, clearcoat: 1, clearcoatRoughness: .06, side: THREE.DoubleSide });
  const previewMaterial = new THREE.LineBasicMaterial({ color: 0xe8ffd8, depthTest: false, transparent: true, opacity: .9 });
  const selectedPreviewMaterial = new THREE.LineBasicMaterial({ color: 0xffbd59, depthTest: false, transparent: true, opacity: 1 });
  const areaGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xffc400, depthTest: false, depthWrite: false, transparent: true, opacity: .34, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
  const areaFillMaterial = new THREE.MeshBasicMaterial({ color: 0xffff32, depthTest: false, depthWrite: false, transparent: true, opacity: .68, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
  const areaMaterial = new THREE.LineBasicMaterial({ color: 0xffffb0, depthTest: false, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, toneMapped: false });
  const sourceAreaMaterial = new THREE.LineBasicMaterial({ color: 0xdce5e3, depthTest: false, transparent: true, opacity: .74 });
  const projectionRayMaterial = new THREE.MeshBasicMaterial({ color: 0x65ff74, depthTest: false, depthWrite: false, transparent: true, opacity: .94 });
  const selectionGuideMaterial = new LineMaterial({ color: 0xffff5b, linewidth: 1.45, depthTest: false, depthWrite: false, transparent: true, opacity: 1, toneMapped: false });
  selectionGuideMaterial.resolution.set(viewport.width, viewport.height);
  const handleMaterial = new THREE.PointsMaterial({ color: 0xfff2c2, size: .13, sizeAttenuation: true, depthTest: false });
  const selectedHandleMaterial = new THREE.PointsMaterial({ color: 0xff713d, size: .2, sizeAttenuation: true, depthTest: false });
  const selectionGuidePositions = new Float32Array(8 * 3 * 2 * 3);
  const selectionGuideGeometry = new LineSegmentsGeometry();
  selectionGuideGeometry.setPositions(selectionGuidePositions);
  const selectionGuideRoot = new LineSegments2(selectionGuideGeometry, selectionGuideMaterial);
  selectionGuideRoot.name = "Chrome Crayon selection box corners";
  selectionGuideRoot.frustumCulled = false;
  selectionGuideRoot.renderOrder = 1000;
  selectionGuideRoot.visible = false;
  scene.add(selectionGuideRoot);
  const raycaster = new THREE.Raycaster(); raycaster.firstHitOnly = true;
  const projectionRaycaster = new THREE.Raycaster(); projectionRaycaster.firstHitOnly = true;
  const curveRaycaster = new THREE.Raycaster();
  curveRaycaster.params.Line = { threshold: .12 };
  curveRaycaster.params.Points = { threshold: .17 };
  const pointer = new THREE.Vector2();
  const curveDocument = new EditableCurveDocument();
  const strokes = curveDocument.strokes;
  let libraryShapes: LibraryShapeInfo[] = [];
  let drawing = true;
  let selectingTarget = false;
  let selectingArea = false;
  let selectingCurve = false;
  let drawingArea: DrawingArea | null = null;
  let areaDropped = false;
  let areaPreviewVisible = false;
  const sweptAreaSelection = new SweptContactSelection({ pointMode: "strongest", undoLimit: 24 });
  let areaContactPatchId: string | null = null;
  let areaContactPatchCounter = 0;
  let suppressAreaContactAccumulationOnce = false;
  type AreaSelectorState = {
    id: string;
    name: string;
    area: DrawingArea | null;
    initialArea: DrawingArea | null;
    dropped: boolean;
    projectionHeight: string;
    contactLocked: boolean;
    patchId: string | null;
    renderPoints: [number, number, number][];
    renderIndices: number[];
  };
  const maskDocument = new SelectionMaskDocument({
    vertexCount: (AREA_CONTACT_SAMPLES + 1) * (AREA_CONTACT_SAMPLES + 1),
    cellCount: AREA_CONTACT_SAMPLES * AREA_CONTACT_SAMPLES,
  });
  let selectorCounter = 1;
  maskDocument.createSelector("selector-1", { name: "Selector 1", operation: "replace", history: false });
  const selectorStates = new Map<string, AreaSelectorState>([["selector-1", {
    id: "selector-1", name: "Selector 1", area: null, initialArea: null, dropped: false,
    projectionHeight: projectionHeight.value, contactLocked: false, patchId: null, renderPoints: [], renderIndices: [],
  }]]);
  type AreaHistorySnapshot = {
    area: DrawingArea;
    dropped: boolean;
    projectionHeight: string;
    contactLocked: boolean;
    contacts: SweptContactSnapshot;
    points: { id: number; point: THREE.Vector3; normal: THREE.Vector3; local?: [number, number] }[];
  };
  const areaHistory: AreaHistorySnapshot[] = [];
  let targetSurfaces: TargetSurface[] = [];
  const dumps: Partial<Record<"periodic" | "crayon", Dump>> = {};
  let crayonGraphReceived = false;
  let authoredTemplate: THREE.Group | null = null;
  let requestId = 0;
  let updateTimer = 0;
  let surfaceKind: "flat" | "curved" = "curved";
  let parityPathMode: "none" | "flat" | "curved" = "none";
  let activeWorker: Worker | null = null;
  let installedWorkerDump: Dump | null = null;
  let installedWorkerId = "";
  let workerInstallCounter = 0;
  let evaluationBusy = false;
  let evaluationQueued = false;
  let activeObjectUrl: string | null = null;
  let disposed = false;
  let curveDrag: { pointerId: number; lastSurfacePoint: THREE.Vector3 } | null = null;
  let areaBaseSizeU = Number(areaSize.value);
  let areaBaseSizeV = Number(areaSize.value);
  let syncingAreaTransform = false;
  let areaDepthDrag: {
    anchorPosition: THREE.Vector3;
    normal: THREE.Vector3;
    initialDepth: number;
    lastDepth: number;
  } | null = null;
  let selectionGuidesDirty = true;

  const selectionBox = new THREE.Box3();
  const selectionViewBox = new THREE.Box3();
  const selectionBoxSize = new THREE.Vector3();
  const selectionBoxSourceCorner = new THREE.Vector3();
  const selectionBoxCorner = new THREE.Vector3();
  const selectionBoxArm = new THREE.Vector3();
  const selectionBoxWorldCorner = new THREE.Vector3();
  const selectionBoxWorldArm = new THREE.Vector3();

  function updateSurfaceSelectionGuides(): void {
    selectionGuidesDirty = false;
    selectionGuideRoot.visible = selectingArea && surfaceKind === "curved";
    if (!selectionGuideRoot.visible) {
      return;
    }

    targetRoot.updateMatrixWorld(true);
    selectionBox.makeEmpty();
    for (const surface of selectedTargetSurfaces()) selectionBox.expandByObject(surface.mesh, true);
    if (selectionBox.isEmpty()) {
      selectionGuideRoot.visible = false;
      return;
    }

    camera.updateMatrixWorld(true);
    selectionViewBox.makeEmpty();
    for (const xSide of [-1, 1]) for (const ySide of [-1, 1]) for (const zSide of [-1, 1]) {
      selectionBoxSourceCorner.set(
        xSide < 0 ? selectionBox.min.x : selectionBox.max.x,
        ySide < 0 ? selectionBox.min.y : selectionBox.max.y,
        zSide < 0 ? selectionBox.min.z : selectionBox.max.z,
      ).project(camera);
      selectionViewBox.expandByPoint(selectionBoxSourceCorner);
    }

    selectionViewBox.getSize(selectionBoxSize);
    const centerX = (selectionViewBox.min.x + selectionViewBox.max.x) * .5;
    const centerY = (selectionViewBox.min.y + selectionViewBox.max.y) * .5;
    const halfX = Math.min(Math.max(.16, selectionBoxSize.x * .48), Math.max(.16, .9 - Math.abs(centerX)));
    const halfY = Math.min(Math.max(.16, selectionBoxSize.y * .48), Math.max(.16, .9 - Math.abs(centerY)));
    const nearZ = Math.max(-.98, selectionViewBox.min.z - .002);
    const farZ = Math.min(.998, selectionViewBox.max.z + .002);
    const rearScale = .74;
    const armFraction = .16;
    let vertex = 0;
    const writeSegment = (from: THREE.Vector3, to: THREE.Vector3): void => {
      selectionGuidePositions[vertex++] = from.x;
      selectionGuidePositions[vertex++] = from.y;
      selectionGuidePositions[vertex++] = from.z;
      selectionGuidePositions[vertex++] = to.x;
      selectionGuidePositions[vertex++] = to.y;
      selectionGuidePositions[vertex++] = to.z;
    };

    for (const xSide of [-1, 1]) for (const ySide of [-1, 1]) for (const zSide of [-1, 1]) {
      const planeScale = zSide < 0 ? 1 : rearScale;
      const otherScale = zSide < 0 ? rearScale : 1;
      selectionBoxCorner.set(
        centerX + xSide * halfX * planeScale,
        centerY + ySide * halfY * planeScale,
        zSide < 0 ? nearZ : farZ,
      );
      selectionBoxWorldCorner.copy(selectionBoxCorner).unproject(camera);

      selectionBoxArm.copy(selectionBoxCorner);
      selectionBoxArm.x -= xSide * halfX * planeScale * armFraction;
      selectionBoxWorldArm.copy(selectionBoxArm).unproject(camera);
      writeSegment(selectionBoxWorldCorner, selectionBoxWorldArm);

      selectionBoxArm.copy(selectionBoxCorner);
      selectionBoxArm.y -= ySide * halfY * planeScale * armFraction;
      selectionBoxWorldArm.copy(selectionBoxArm).unproject(camera);
      writeSegment(selectionBoxWorldCorner, selectionBoxWorldArm);

      selectionBoxArm.set(
        centerX + xSide * halfX * otherScale,
        centerY + ySide * halfY * otherScale,
        zSide < 0 ? farZ : nearZ,
      ).unproject(camera);
      selectionBoxWorldArm.copy(selectionBoxWorldCorner).lerp(selectionBoxArm, armFraction);
      writeSegment(selectionBoxWorldCorner, selectionBoxWorldArm);
    }

    selectionGuideRoot.visible = vertex > 0;
    if (vertex > 0) selectionGuideGeometry.setPositions(selectionGuidePositions.subarray(0, vertex));
  }

  const invalidateSelectionGuides = (): void => { selectionGuidesDirty = true; };
  controls.addEventListener("change", invalidateSelectionGuides);

  function evaluationWorker(): Worker {
    if (!activeWorker) {
      activeWorker = new Worker(new URL("./blend-import-worker.ts", import.meta.url), { type: "module", name: "surface-draw-gnvm" });
      installedWorkerDump = null;
      installedWorkerId = "";
    }
    return activeWorker;
  }

  function workerReply<T>(worker: Worker, post: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<T>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      post();
    });
  }

  async function ensureWorkerDump(dump: Dump): Promise<{ worker: Worker; installId: string }> {
    const worker = evaluationWorker();
    if (installedWorkerDump === dump && installedWorkerId) return { worker, installId: installedWorkerId };
    const installId = `surface-draw-${++workerInstallCounter}`;
    const reply = await workerReply<WorkerInstallReply>(worker, () => worker.postMessage({ kind: "install", installId, dump }));
    if (!reply.ok || reply.installed !== installId) throw new Error("Could not initialize the Chrome Crayon evaluator");
    installedWorkerDump = dump;
    installedWorkerId = installId;
    return { worker, installId };
  }

  function setStatus(message: string, busy = false): void { if (disposed) return; applyStatus(busy ? "busy" : "ready", message); }

  function useCamera(next: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    camera = next;
    controls.object = next;
    areaTransform.camera = next;
    controls.target.set(0, 0, 0);
    controls.update();
  }

  function sizeCameras(width: number, height: number): void {
    const aspect = width / height;
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();
    const halfHeight = 4.5;
    flatCamera.left = -halfHeight * aspect;
    flatCamera.right = halfHeight * aspect;
    flatCamera.top = halfHeight;
    flatCamera.bottom = -halfHeight;
    flatCamera.updateProjectionMatrix();
  }

  function showFlatWorkspace(show: boolean): void {
    flatOverlay.hidden = !show;
    if (show) {
      brushReticle.style.left = "50%";
      brushReticle.style.top = "50%";
    }
  }

  function positionBrushReticle(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const left = `${event.clientX - rect.left}px`;
    const top = `${event.clientY - rect.top}px`;
    if (!flatOverlay.hidden) {
      brushReticle.style.left = left;
      brushReticle.style.top = top;
    }
    if (!selectionHud.hidden) {
      selectionReticle.style.left = left;
      selectionReticle.style.top = top;
    }
  }

  function updateSurfaceSelectionHud(event?: PointerEvent): void {
    if (!selectingArea || selectionHud.hidden) return;
    const hit = event ? surfaceHit(event, false) : null;
    const surface = hit ? targetSurfaces.find((candidate) => candidate.mesh === hit.target) : null;
    selectionHud.dataset.hit = hit ? "true" : "false";
    selectionLabel.textContent = hit
      ? `CHROME CRAYON · ${surface?.label ?? "SURFACE"} · PLACE AREA`
      : "CHROME CRAYON · PLACE AREA";
    canvas.style.cursor = hit ? "crosshair" : "cell";
  }

  function updateTargetPickerHover(event: PointerEvent): void {
    if (!selectingTarget) return;
    const hit = surfaceHit(event, false);
    canvas.style.cursor = hit ? "crosshair" : "not-allowed";
    targetPickButton.dataset.hit = hit ? "true" : "false";
  }

  function prepareTarget(root: THREE.Object3D, material: THREE.Material = targetMaterial): void {
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.material = material;
      const geometry = child.geometry as THREE.BufferGeometry;
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      geometry.computeBoundsTree?.();
    });
  }

  function selectedTargetSurfaces(): TargetSurface[] {
    return surfacesForTarget(targetSurfaces, targetSelect.value);
  }

  function updateTargetSummary(): void {
    const count = targetSurfaces.length;
    targetSummary.textContent = `${count} usable mesh${count === 1 ? "" : "es"} · ${targetLabel(targetSurfaces, targetSelect.value)}`;
  }

  function applyTargetAppearance(): void {
    const selected = new Set(selectedTargetSurfaces().map((surface) => surface.id));
    const isolate = targetSelect.value !== PICK_TARGET_SURFACE && targetSelect.value !== ALL_TARGET_SURFACES;
    targetPicker.dataset.mode = isolate ? "locked" : targetSelect.value === PICK_TARGET_SURFACE ? "pick" : "all";
    const activeMaterial = surfaceKind === "flat" ? flatTargetMaterial : targetMaterial;
    for (const surface of targetSurfaces) {
      surface.mesh.material = !isolate || selected.has(surface.id) ? activeMaterial : inactiveTargetMaterial;
    }
    updateTargetSummary();
    selectionGuidesDirty = true;
  }

  function refreshTargetInventory(defaultTarget = PICK_TARGET_SURFACE): void {
    targetSurfaces = collectTargetSurfaces(targetRoot);
    targetSelect.replaceChildren(
      new Option("Pick mesh when placing area", PICK_TARGET_SURFACE),
      new Option("All visible meshes", ALL_TARGET_SURFACES),
      ...targetSurfaces.map((surface) => new Option(surface.label, surface.id)),
    );
    targetSelect.value = targetSurfaces.length === 1 ? targetSurfaces[0].id : defaultTarget;
    applyTargetAppearance();
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
      child.traverse((item) => { if (item instanceof THREE.Mesh || item instanceof THREE.Line || item instanceof THREE.Points) item.geometry.dispose(); });
    }
  }

  function demoSurface(): void {
    surfaceKind = "curved";
    showFlatWorkspace(false);
    removeDrawingArea();
    perspectiveCamera.position.set(6.7, -8.5, 5.6); useCamera(perspectiveCamera);
    clearObject(targetRoot);
    const geometry = new THREE.SphereGeometry(3, 96, 64);
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i);
      const wobble = 1 + .075 * Math.sin(p.z * 2.4) * Math.cos(Math.atan2(p.y, p.x) * 5);
      p.multiplyScalar(wobble); position.setXYZ(i, p.x, p.y, p.z);
    }
    position.needsUpdate = true; geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, targetMaterial); mesh.name = "Wobbled surface"; targetRoot.add(mesh); prepareTarget(targetRoot); refreshTargetInventory();
    fileName.textContent = "Using generated demo surface"; setStatus("Ready on the demo surface"); clearStrokes();
  }

  function flatSurface(): void {
    surfaceKind = "flat"; showFlatWorkspace(true); removeDrawingArea(); clearObject(targetRoot);
    flatCamera.position.set(0, 0, 10); flatCamera.zoom = 1; useCamera(flatCamera);
    const geometry = new THREE.PlaneGeometry(200, 200);
    const mesh = new THREE.Mesh(geometry, flatTargetMaterial); mesh.name = "Flat canvas"; targetRoot.add(mesh); prepareTarget(targetRoot, flatTargetMaterial); refreshTargetInventory(ALL_TARGET_SURFACES);
    fileName.textContent = "Infinite XY drawing canvas"; setStatus("Flat canvas ready · draw anywhere"); clearStrokes();
  }

  async function loadTarget(url: string, ext: string, label: string, readText?: () => Promise<string>, readBuffer?: () => Promise<ArrayBuffer>): Promise<void> {
      surfaceKind = "curved";
      showFlatWorkspace(false);
      useCamera(perspectiveCamera);
      removeDrawingArea();
      setStatus(`Loading ${label}…`, true);
      let loaded: THREE.Object3D;
      if (ext === "glb" || ext === "gltf") loaded = (await new GLTFLoader().loadAsync(url)).scene;
      else if (ext === "obj" && readText) loaded = new OBJLoader().parse(await readText());
      else if (ext === "stl" && readBuffer) loaded = new THREE.Mesh(new STLLoader().parse(await readBuffer()), targetMaterial);
      else if (ext === "ply") loaded = new THREE.Mesh(await new PLYLoader().loadAsync(url), targetMaterial);
      else if (ext === "fbx") loaded = await new FBXLoader().loadAsync(url);
      else throw new Error("Choose a GLB, GLTF, OBJ, STL, PLY, or FBX file.");
      if (disposed) return;
      clearObject(targetRoot); targetRoot.add(loaded); normalizeTarget(loaded); prepareTarget(loaded);
      refreshTargetInventory();
      if (!targetSurfaces.length) throw new Error(`${label} does not contain a usable mesh surface.`);
      fileName.textContent = label; clearStrokes(); setStatus(`${label} ready · ${targetSurfaces.length} projection mesh${targetSurfaces.length === 1 ? "" : "es"}`);
  }

  async function loadFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    activeObjectUrl = url;
    try { await loadTarget(url, file.name.split(".").pop()?.toLowerCase() ?? "", file.name, () => file.text(), () => file.arrayBuffer()); }
    finally { URL.revokeObjectURL(url); if (activeObjectUrl === url) activeObjectUrl = null; }
  }

  /** Evaluate a ported reference object through the GN-VM and install it as the projection surface. */
  async function loadLibrarySurface(info: LibraryShapeInfo): Promise<void> {
    surfaceKind = "curved";
    showFlatWorkspace(false);
    useCamera(perspectiveCamera);
    removeDrawingArea();
    setStatus(`Evaluating ${info.title} through the GN-VM…`, true);
    const shape = await loadLibraryBaseShape(info);
    if (disposed) return;
    clearObject(targetRoot); targetRoot.add(shape.object); normalizeTarget(shape.object); prepareTarget(shape.object);
    refreshTargetInventory();
    if (!targetSurfaces.length) throw new Error(`${info.title} does not contain a usable mesh surface.`);
    fileName.textContent = info.title; clearStrokes();
    setStatus(`${info.title} ready · ${targetSurfaces.length} projection mesh${targetSurfaces.length === 1 ? "" : "es"}`);
  }

  function updatePointer(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }

  function currentBrushOffset(): number {
    return brushSelect.value === "crayon"
      ? Math.max(.012, Number(extrude.value) / CRAYON_SCALE * 1.1)
      : Math.max(.006, Number(size.value) * .08);
  }

  function surfaceHit(event: PointerEvent, addBrushOffset = true): SurfaceHit | null {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(selectedTargetSurfaces().map((surface) => surface.mesh), false)[0];
    if (!hit?.face) return null;
    const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    const offset = addBrushOffset ? currentBrushOffset() : 0;
    return { point: hit.point.clone().addScaledVector(normal, offset), normal, target: hit.object as THREE.Mesh };
  }

  function addSample(event: PointerEvent): void {
    const activeStroke = curveDocument.activeStroke;
    if (!activeStroke) return;
    const sample = surfaceHit(event); if (!sample) return;
    if (drawingArea) {
      const delta = sample.point.clone().sub(drawingArea.center);
      if (Math.abs(delta.dot(drawingArea.u)) > drawingArea.sizeU * .5 || Math.abs(delta.dot(drawingArea.v)) > drawingArea.sizeV * .5) return;
      sample.local = [delta.dot(drawingArea.u), delta.dot(drawingArea.v)];
    }
    const previous = activeStroke.points.at(-1);
    if (previous && previous.point.distanceTo(sample.point) < .035) return;
    curveDocument.appendPoint(sample); renderPreviews(); updateMetrics();
  }

  function renderPreviews(): void {
    clearObject(previewRoot);
    clearObject(handleRoot);
    const activeStroke = curveDocument.activeStroke;
    for (const stroke of [...strokes, ...(activeStroke ? [activeStroke] : [])]) {
      if (stroke.points.length < 2) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints(stroke.points.map((sample) => sample.point));
      const selected = curveDocument.selection?.strokeId === stroke.id;
      const line = new THREE.Line(geometry, selected ? selectedPreviewMaterial : previewMaterial);
      line.userData.strokeId = stroke.id;
      line.renderOrder = 10;
      previewRoot.add(line);
      if (!selected || !selectingCurve) continue;
      const handles = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(stroke.points.map((sample) => sample.point)),
        handleMaterial,
      );
      handles.userData.strokeId = stroke.id;
      handles.renderOrder = 12;
      handleRoot.add(handles);
      const selectedPoint = curveDocument.selectedPoint();
      if (selectedPoint) {
        const point = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints([selectedPoint.point]),
          selectedHandleMaterial,
        );
        point.userData.strokeId = stroke.id;
        point.userData.pointId = selectedPoint.id;
        point.renderOrder = 13;
        handleRoot.add(point);
      }
    }
  }

  function allCurves(scale = 1): { points: number[][]; cyclic: boolean }[] {
    return curveDocument.toCurves(({ point }) => point.clone().multiplyScalar(scale).toArray());
  }

  function loadParityPath(): void {
    flatSurface();
    parityPathMode = "flat";
    // Restore the authored validation controls. Normal drawing uses edge
    // smoothing, while this fixture deliberately exposes the unsmoothed mesh
    // so its topology remains directly comparable with Blender's reference.
    crayonPreset.value = "adapted";
    const parityValues = [
      [thickness, thicknessOutput, 6, 1],
      [peak, peakOutput, 10, 1],
      [sigilize, sigilizeOutput, 0, 0],
      [soften, softenOutput, 0, 0],
      [resolution, resolutionOutput, .8, 3],
      [spiro, spiroOutput, 1, 0],
      [extrude, extrudeOutput, 1, 1],
    ] as const;
    for (const [input, output, value, decimals] of parityValues) {
      input.disabled = false;
      input.value = String(value);
      output.value = value.toFixed(decimals);
    }
    flatten.disabled = false;
    flatten.checked = false;
    const points: [number, number, number][] = [[-2.4, -.7, 0], [-1.65, .42, 0], [-.8, .82, 0], [.05, .08, 0], [.9, -.62, 0], [1.7, -.25, 0], [2.4, .68, 0]];
    curveDocument.addStroke(points.map((point) => ({ point: new THREE.Vector3(...point), normal: new THREE.Vector3(0, 0, 1) })));
    renderPreviews(); updateMetrics(); queueEvaluation();
  }

  function curvedParityStroke(): NewSample[] {
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
    curveDocument.addStroke(curvedParityStroke());
    renderPreviews(); updateMetrics(); queueEvaluation();
  }

  function smoothStroke(source: EditableCurveStroke): StrokeSamples {
    if (parityPathMode === "curved") return source.points.map((sample) => ({ ...sample, point: sample.point.clone(), normal: sample.normal.clone() }));
    if (source.points.length < 3) return source.points.map((sample) => ({ ...sample, point: sample.point.clone(), normal: sample.normal.clone() }));
    const curve = new THREE.CatmullRomCurve3(source.points.map((sample) => sample.point), false, "centripetal", .5);
    const count = Math.min(96, Math.max(source.points.length, Math.ceil(curve.getLength() / .08)));
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0 : index / (count - 1);
      const sourcePosition = t * (source.points.length - 1);
      const a = Math.min(Math.floor(sourcePosition), source.points.length - 1);
      const b = Math.min(a + 1, source.points.length - 1);
      const local = source.points[a].local && source.points[b].local
        ? [
          THREE.MathUtils.lerp(source.points[a].local[0], source.points[b].local[0], sourcePosition - a),
          THREE.MathUtils.lerp(source.points[a].local[1], source.points[b].local[1], sourcePosition - a),
        ] as [number, number]
        : undefined;
      return { id: -index - 1, point: curve.getPoint(t), normal: source.points[a].normal.clone().lerp(source.points[b].normal, sourcePosition - a).normalize(), local };
    });
  }

  function crayonInput(): { curves: { points: number[][]; cyclic: boolean }[]; layouts: CrayonLayout[] } {
    const curves: { points: number[][]; cyclic: boolean }[] = [];
    const layouts: CrayonLayout[] = [];
    let cursor = 0;
    for (const source of strokes.filter((candidate) => candidate.points.length > 1)) {
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

  function editableCurveFrame(): CurveFrame {
    if (drawingArea) return drawingArea;
    const points = strokes.flatMap((stroke) => stroke.points);
    const center = points.reduce((sum, sample) => sum.add(sample.point), new THREE.Vector3()).multiplyScalar(1 / Math.max(points.length, 1));
    const normal = points.reduce((sum, sample) => sum.add(sample.normal), new THREE.Vector3()).normalize();
    if (normal.lengthSq() < 1e-9) normal.set(0, 0, 1);
    const first = points[0]?.point;
    const last = points.at(-1)?.point;
    let u = first && last ? last.clone().sub(first) : new THREE.Vector3(1, 0, 0);
    u.addScaledVector(normal, -u.dot(normal)).normalize();
    if (u.lengthSq() < 1e-9) {
      u = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      u.addScaledVector(normal, -u.dot(normal)).normalize();
    }
    if (u.lengthSq() < 1e-9) u = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
    return { center, normal, u, v: normal.clone().cross(u).normalize() };
  }

  function frameCoordinates(sample: Pick<Sample, "point" | "local">, frame: CurveFrame): [number, number] {
    if (drawingArea && sample.local) return sample.local;
    const delta = sample.point.clone().sub(frame.center);
    return [delta.dot(frame.u), delta.dot(frame.v)];
  }

  function localCrayonInput(frame: CurveFrame): { points: number[][]; cyclic: boolean }[] {
    return strokes.filter((stroke) => stroke.points.length > 1).map((stroke) => ({
      cyclic: stroke.cyclic,
      points: smoothStroke(stroke).map((sample) => {
        const [u, v] = frameCoordinates(sample, frame);
        return [u * CRAYON_SCALE, v * CRAYON_SCALE, 0];
      }),
    }));
  }

  function sigilInput(frame: CurveFrame): { points: number[][]; cyclic: boolean }[] {
    const local = strokes.filter((stroke) => stroke.points.length > 1).map((stroke) => stroke.points.map((sample) => {
      const [u, v] = frameCoordinates(sample, frame);
      return [u, v, 0];
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

  type ClosestSurface = { point: THREE.Vector3; normal: THREE.Vector3; distance: number };

  function closestTargetSurface(worldPoint: THREE.Vector3): ClosestSurface | null {
    let closest: ClosestSurface | null = null;
    for (const { mesh: item } of selectedTargetSurfaces()) {
      const geometry = item.geometry as THREE.BufferGeometry & {
        boundsTree?: { closestPointToPoint: (point: THREE.Vector3) => { point: THREE.Vector3; distance: number; faceIndex?: number } };
      };
      if (!geometry.boundsTree) continue;
      const localQuery = item.worldToLocal(worldPoint.clone());
      const hit = geometry.boundsTree.closestPointToPoint(localQuery);
      const localPoint = hit.point.clone();
      const point = item.localToWorld(localPoint.clone());
      const distance = point.distanceTo(worldPoint);
      if (closest && distance >= closest.distance) continue;
      let normal = point.clone().normalize();
      if (hit.faceIndex !== undefined) {
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        const vertexNormals = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
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
        const barycentric = vertexNormals ? triangle.getBarycoord(localPoint, new THREE.Vector3()) : null;
        if (vertexNormals && barycentric) {
          normal = new THREE.Vector3().fromBufferAttribute(vertexNormals, a).multiplyScalar(barycentric.x)
            .addScaledVector(new THREE.Vector3().fromBufferAttribute(vertexNormals, b), barycentric.y)
            .addScaledVector(new THREE.Vector3().fromBufferAttribute(vertexNormals, c), barycentric.z);
        } else {
          normal = triangle.getNormal(new THREE.Vector3());
        }
        normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(item.matrixWorld)).normalize();
      }
      closest = { point, normal, distance };
    }
    return closest;
  }

  function cloneDrawingArea(area: DrawingArea): DrawingArea {
    return {
      center: area.center.clone(), normal: area.normal.clone(), u: area.u.clone(), v: area.v.clone(),
      sizeU: area.sizeU, sizeV: area.sizeV,
    };
  }

  function activeSelectorState(): AreaSelectorState {
    const id = maskDocument.activeSelectorId ?? "selector-1";
    const state = selectorStates.get(id);
    if (!state) throw new Error(`Missing selector viewport state ${id}`);
    return state;
  }

  function saveActiveSelectorState(): void {
    const state = activeSelectorState();
    state.area = drawingArea ? cloneDrawingArea(drawingArea) : null;
    state.dropped = areaDropped;
    state.projectionHeight = projectionHeight.value;
    state.contactLocked = contactLock.checked;
    state.patchId = areaContactPatchId;
  }

  function syncSelectorUI(): void {
    const activeId = maskDocument.activeSelectorId;
    selectorList.replaceChildren(...maskDocument.selectors.map((selector) => new Option(selector.name, selector.id)));
    if (!activeId) return;
    selectorList.value = activeId;
    const selector = maskDocument.getSelector(activeId);
    maskOperation.value = selector.operation;
    selectorVisible.checked = selector.visible;
    selectorLocked.checked = selector.locked;
    selectorDeleteButton.disabled = maskDocument.selectorIds.length <= 1;
    const locked = selector.locked || !selector.editable;
    for (const control of [gizmoMoveButton, gizmoRotateButton, gizmoScaleButton, applyTransformButton, resetTransformButton, dropAreaButton, pushThroughButton]) control.disabled = locked;
    areaTransform.enabled = Boolean(drawingArea) && !locked;
    areaTransformHelper.visible = Boolean(drawingArea) && !locked;
  }

  function renderInactiveSelectorOverlays(): void {
    clearObject(selectorOverlayRoot);
    const activeId = maskDocument.activeSelectorId;
    const composedVertices = new Set(maskDocument.compose().vertices);
    for (const selector of maskDocument.selectors) {
      if (!selector.visible || selector.id === activeId) continue;
      const state = selectorStates.get(selector.id);
      if (!state?.renderPoints.length || !state.renderIndices.length) continue;
      const points = state.renderPoints.map((point) => new THREE.Vector3(...point));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const indices: number[] = [];
      for (let index = 0; index < state.renderIndices.length; index += 3) {
        const triangle = state.renderIndices.slice(index, index + 3);
        if (triangle.every((vertex) => composedVertices.has(vertex))) indices.push(...triangle);
      }
      if (!indices.length) { geometry.dispose(); continue; }
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, areaFillMaterial);
      mesh.renderOrder = 7;
      mesh.userData.selectorId = selector.id;
      selectorOverlayRoot.add(mesh);
    }
  }

  function loadSelector(id: string): void {
    if (id === maskDocument.activeSelectorId) return;
    saveActiveSelectorState();
    maskDocument.setActiveSelector(id);
    const state = activeSelectorState();
    drawingArea = state.area ? cloneDrawingArea(state.area) : null;
    areaDropped = state.dropped;
    projectionHeight.value = state.projectionHeight;
    projectionHeightOutput.value = Number(state.projectionHeight).toFixed(2);
    contactLock.checked = state.contactLocked;
    areaContactPatchId = state.patchId;
    areaHistory.length = 0;
    if (drawingArea) syncAreaAnchor();
    else {
      areaTransform.detach();
      areaTransform.enabled = false;
      areaTransformHelper.visible = false;
    }
    syncSelectorUI();
    renderDrawingArea();
    setStatus(`${state.name} active · all visible selector masks remain shown`);
  }

  function createSelector(): void {
    saveActiveSelectorState();
    const id = `selector-${++selectorCounter}`;
    const name = `Selector ${selectorCounter}`;
    maskDocument.createSelector(id, { name, operation: "add" });
    selectorStates.set(id, {
      id, name, area: null, initialArea: null, dropped: false,
      projectionHeight: projectionHeight.value, contactLocked: false, patchId: null, renderPoints: [], renderIndices: [],
    });
    drawingArea = null;
    areaDropped = false;
    areaContactPatchId = null;
    areaHistory.length = 0;
    areaTransform.detach();
    areaTransform.enabled = false;
    areaTransformHelper.visible = false;
    syncSelectorUI();
    renderDrawingArea();
    setMode("area");
    setStatus(`${name} created · click the matte object to place it`);
  }

  function deleteActiveSelector(): void {
    if (maskDocument.selectorIds.length <= 1) {
      setStatus("At least one selector layer is required");
      return;
    }
    const id = maskDocument.activeSelectorId!;
    const state = activeSelectorState();
    if (state.patchId) sweptAreaSelection.removePatch(state.patchId);
    const remainingId = maskDocument.selectorIds.find((candidate) => candidate !== id)!;
    maskDocument.removeSelector(id, { force: true });
    selectorStates.delete(id);
    maskDocument.setActiveSelector(remainingId, false);
    const next = activeSelectorState();
    drawingArea = next.area ? cloneDrawingArea(next.area) : null;
    areaDropped = next.dropped;
    projectionHeight.value = next.projectionHeight;
    projectionHeightOutput.value = Number(next.projectionHeight).toFixed(2);
    contactLock.checked = next.contactLocked;
    areaContactPatchId = next.patchId;
    if (drawingArea) syncAreaAnchor();
    syncSelectorUI();
    renderDrawingArea();
    setStatus(`${state.name} deleted`);
  }

  function checkpointDrawingArea(): void {
    if (!drawingArea || !areaContactPatchId) return;
    const editableStrokes = [...strokes, ...(curveDocument.activeStroke ? [curveDocument.activeStroke] : [])];
    areaHistory.push({
      area: cloneDrawingArea(drawingArea),
      dropped: areaDropped,
      projectionHeight: projectionHeight.value,
      contactLocked: contactLock.checked,
      contacts: sweptAreaSelection.snapshot(),
      points: editableStrokes.flatMap((stroke) => stroke.points.map((sample) => ({
        id: sample.id,
        point: sample.point.clone(),
        normal: sample.normal.clone(),
        local: sample.local ? [...sample.local] as [number, number] : undefined,
      }))),
    });
    if (areaHistory.length > 24) areaHistory.shift();
  }

  function undoDrawingArea(): void {
    const snapshot = areaHistory.pop();
    if (!snapshot) { setStatus("No selector change to undo"); return; }
    drawingArea = cloneDrawingArea(snapshot.area);
    areaDropped = snapshot.dropped;
    projectionHeight.value = snapshot.projectionHeight;
    projectionHeightOutput.value = Number(snapshot.projectionHeight).toFixed(2);
    contactLock.checked = snapshot.contactLocked;
    sweptAreaSelection.restore(snapshot.contacts);
    areaContactPatchId = snapshot.contacts.activePatchId;
    const pointsById = new Map(snapshot.points.map((point) => [point.id, point]));
    const editableStrokes = [...strokes, ...(curveDocument.activeStroke ? [curveDocument.activeStroke] : [])];
    for (const stroke of editableStrokes) for (const sample of stroke.points) {
      const previous = pointsById.get(sample.id);
      if (!previous) continue;
      sample.point.copy(previous.point); sample.normal.copy(previous.normal);
      sample.local = previous.local ? [...previous.local] : undefined;
    }
    dropAreaButton.classList.toggle("projected", areaDropped);
    dropAreaButton.textContent = areaDropped ? "Contact captured ✓" : "First contact";
    pushThroughButton.classList.toggle("projected", areaDropped && Number(projectionHeight.value) < 0);
    areaBaseSizeU = drawingArea.sizeU; areaBaseSizeV = drawingArea.sizeV;
    areaSize.value = String(Math.min(4, Math.max(.6, (drawingArea.sizeU + drawingArea.sizeV) * .5)));
    areaSizeOutput.value = `${drawingArea.sizeU.toFixed(1)} × ${drawingArea.sizeV.toFixed(1)}`;
    syncAreaAnchor();
    suppressAreaContactAccumulationOnce = true;
    renderDrawingArea(); renderPreviews(); updateMetrics(); queueEvaluation();
    setStatus("Selector, captured surface, and affected strokes restored");
  }

  function removeDrawingArea(): void {
    drawingArea = null;
    areaDropped = false;
    areaPreviewVisible = false;
    for (const patchId of [...sweptAreaSelection.patchIds]) sweptAreaSelection.removePatch(patchId);
    areaContactPatchId = null;
    areaHistory.length = 0;
    dropAreaButton.classList.remove("projected");
    dropAreaButton.textContent = "First contact";
    pushThroughButton.classList.remove("projected");
    areaTransform.detach();
    areaTransform.enabled = false;
    areaTransformHelper.visible = false;
    clearObject(areaRoot);
    clearObject(selectorOverlayRoot);
    for (const state of selectorStates.values()) {
      state.area = null;
      state.initialArea = null;
      state.dropped = false;
      state.patchId = null;
      state.renderPoints = [];
      state.renderIndices = [];
    }
    for (const selector of maskDocument.selectors) maskDocument.clearSelectorMask(selector.id, { history: false, force: true });
  }

  function clearActiveSelectorArea(): void {
    const state = activeSelectorState();
    if (state.patchId) sweptAreaSelection.removePatch(state.patchId);
    maskDocument.clearSelectorMask(state.id, { force: true });
    state.area = null;
    state.initialArea = null;
    state.dropped = false;
    state.patchId = null;
    state.renderPoints = [];
    state.renderIndices = [];
    drawingArea = null;
    areaDropped = false;
    areaContactPatchId = null;
    areaHistory.length = 0;
    areaTransform.detach();
    areaTransform.enabled = false;
    areaTransformHelper.visible = false;
    renderDrawingArea();
  }

  function renderDrawingArea(): void {
    clearObject(areaRoot);
    areaPreviewVisible = false;
    if (!drawingArea) { renderInactiveSelectorOverlays(); return; }
    const activeSelector = maskDocument.activeSelectorId ? maskDocument.getSelector(maskDocument.activeSelectorId) : null;
    if (activeSelector && !activeSelector.visible) { renderInactiveSelectorOverlays(); return; }
    const grid = 10, samples = AREA_CONTACT_SAMPLES, halfU = drawingArea.sizeU * .5, halfV = drawingArea.sizeV * .5;
    const sourceCenter = drawingArea.center.clone().addScaledVector(drawingArea.normal, Number(projectionHeight.value));
    const rayStart = sourceCenter.clone().addScaledVector(drawingArea.normal, .35);
    const rayEnd = drawingArea.center.clone().addScaledVector(drawingArea.normal, -.12);
    const rayDirection = rayEnd.clone().sub(rayStart);
    const ray = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, rayDirection.length(), 8), projectionRayMaterial);
    ray.position.copy(rayStart).add(rayEnd).multiplyScalar(.5);
    ray.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), rayDirection.normalize());
    ray.renderOrder = 12; areaRoot.add(ray);

    if (!areaContactPatchId) {
      areaContactPatchId = `area-${++areaContactPatchCounter}`;
      sweptAreaSelection.createPatch(areaContactPatchId, {
        vertexCount: (samples + 1) * (samples + 1),
        cellCount: samples * samples,
      });
    }

    const cellSize = Math.min(drawingArea.sizeU, drawingArea.sizeV) / AREA_CONTACT_SAMPLES;
    const contactDepth = Number(contactDepthControl.value) + Number(contactSoftness.value) * cellSize * 1.5;
    const facingThreshold = Math.cos(THREE.MathUtils.degToRad(Number(maxSurfaceAngle.value)));
    areaGlowMaterial.opacity = areaDropped ? .34 : .28;
    areaFillMaterial.opacity = areaDropped ? .68 : .58;
    const selectedMeshes = selectedTargetSurfaces().map((surface) => surface.mesh);
    const targetBounds = new THREE.Box3();
    for (const mesh of selectedMeshes) targetBounds.expandByObject(mesh);
    let targetFront = Number.NEGATIVE_INFINITY;
    if (!targetBounds.isEmpty()) {
      for (let corner = 0; corner < 8; corner++) {
        const point = new THREE.Vector3(
          corner & 1 ? targetBounds.max.x : targetBounds.min.x,
          corner & 2 ? targetBounds.max.y : targetBounds.min.y,
          corner & 4 ? targetBounds.max.z : targetBounds.min.z,
        );
        targetFront = Math.max(targetFront, point.dot(drawingArea.normal));
      }
    }

    type ProjectedAreaPoint = {
      sourcePoint: THREE.Vector3;
      surfacePoint: THREE.Vector3 | null;
      touching: boolean;
    };
    const projectPoint = (x: number, y: number, offset = .02): ProjectedAreaPoint => {
      const sourcePoint = sourceCenter.clone().addScaledVector(drawingArea!.u, x).addScaledVector(drawingArea!.v, y);
      if (!Number.isFinite(targetFront)) return { sourcePoint, surfacePoint: null, touching: false };
      const rayLift = Math.max(.25, targetFront - sourcePoint.dot(drawingArea!.normal) + .25);
      const rayOrigin = sourcePoint.clone().addScaledVector(drawingArea!.normal, rayLift);
      projectionRaycaster.set(rayOrigin, drawingArea!.normal.clone().negate());
      const hit = projectionRaycaster.intersectObjects(selectedMeshes, false)[0];
      if (hit?.face) {
        const hitNormal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        // Always start beyond the target and keep only the first near-facing
        // surface. This never switches to the exit face after the selector has
        // moved inside a closed object.
        const alignment = hitNormal.dot(drawingArea!.normal);
        // Blender's reference uses Project Shrinkwrap with face culling off.
        // The first ray hit already identifies the near surface, so winding
        // must not punch holes through steep crests or imported meshes whose
        // normals happen to be reversed. Reorient only for the display offset.
        if (Math.abs(alignment) >= facingThreshold - 1e-6) {
          if (alignment < 0) hitNormal.negate();
          const clearance = sourcePoint.clone().sub(hit.point).dot(drawingArea!.normal);
          // Contact is a narrow band around the actual surface crossing. A
          // projector far inside the object is not still "touching" every
          // point; swept samples latch the crossings as the grid moves down.
          return { sourcePoint, surfacePoint: hit.point.clone().addScaledVector(hitNormal, offset), touching: Math.abs(clearance) <= contactDepth };
        }
      }
      return { sourcePoint, surfacePoint: null, touching: false };
    };

    const liveGrid: ProjectedAreaPoint[] = [];
    const vertexSamples: { index: number; point: [number, number, number] }[] = [];
    const patchIndices: number[] = [];
    for (let row = 0; row <= samples; row++) {
      const y = -halfV + drawingArea.sizeV * row / samples;
      for (let column = 0; column <= samples; column++) {
        const x = -halfU + drawingArea.sizeU * column / samples;
        const projected = projectPoint(x, y, .016);
        const index = row * (samples + 1) + column;
        liveGrid.push(projected);
        if (projected.touching && projected.surfacePoint) {
          vertexSamples.push({ index, point: [projected.surfacePoint.x, projected.surfacePoint.y, projected.surfacePoint.z] });
        }
      }
    }
    const cellSamples: { index: number; point: [number, number, number] }[] = [];
    for (let row = 0; row < samples; row++) for (let column = 0; column < samples; column++) {
      const a = row * (samples + 1) + column, b = a + 1, c = a + samples + 1, d = c + 1;
      const contacts = [liveGrid[a], liveGrid[b], liveGrid[c], liveGrid[d]];
      if (contacts.every((contact) => contact.touching && contact.surfacePoint)) {
        const center = contacts.reduce((point, contact) => point.add(contact.surfacePoint!), new THREE.Vector3()).multiplyScalar(.25);
        cellSamples.push({ index: row * samples + column, point: [center.x, center.y, center.z] });
      }
    }
    if (suppressAreaContactAccumulationOnce) suppressAreaContactAccumulationOnce = false;
    else {
      // Unlocked contact is a live mask. Locked contact is a swept/latching
      // mask, so moving through the surface keeps every crossing selected.
      if (!contactLock.checked) sweptAreaSelection.clearPatch(areaContactPatchId);
      if (vertexSamples.length || cellSamples.length) {
        sweptAreaSelection.accumulate({ vertices: vertexSamples, cells: cellSamples }, areaContactPatchId);
      }
    }

    const retainedVertices = sweptAreaSelection.vertexContacts(areaContactPatchId);
    const retainedCells = sweptAreaSelection.cellContacts(areaContactPatchId);
    const activeId = maskDocument.activeSelectorId;
    if (activeId && maskDocument.isSelectorEditable(activeId)) {
      maskDocument.setSelectorMask(activeId, { vertices: retainedVertices.keys(), cells: retainedCells.keys() }, { history: false });
    }
    areaPreviewVisible = retainedVertices.size > 0;
    let patchPoints = liveGrid.map((live, index) => {
      const retained = retainedVertices.get(index)?.point;
      return retained ? new THREE.Vector3(retained[0], retained[1], retained[2]) : live.sourcePoint;
    });
    if (clothEnabled.checked && retainedVertices.size > 0) {
      const sourcePositions = liveGrid.flatMap((live) => live.sourcePoint.toArray());
      const initialPositions = [...sourcePositions];
      const sag = Number(clothSag.value) * Math.min(drawingArea.sizeU, drawingArea.sizeV) * .32;
      for (let row = 0; row <= samples; row++) for (let column = 0; column <= samples; column++) {
        const index = row * (samples + 1) + column;
        if (retainedVertices.has(index)) continue;
        const fold = Math.sin(Math.PI * row / samples) * Math.sin(Math.PI * column / samples);
        const ripple = .72 + .28 * Math.sin(column * 1.7 + row * .45);
        const offset = index * 3;
        initialPositions[offset] -= drawingArea.normal.x * sag * fold * ripple;
        initialPositions[offset + 1] -= drawingArea.normal.y * sag * fold * ripple;
        initialPositions[offset + 2] -= drawingArea.normal.z * sag * fold * ripple;
      }
      const relaxed = relaxClothLattice({
        columns: samples + 1,
        rows: samples + 1,
        sourcePositions,
        initialPositions,
        contacts: [...retainedVertices].flatMap(([index, contact]) => contact.point ? [{ index, position: contact.point }] : []),
        stretchIterations: Number(drapeIterations.value),
        stretchStrength: Number(drapeStretch.value),
        bendIterations: Number(drapeIterations.value),
        bendStrength: Math.min(.6, Number(contactSoftness.value) * .6),
      });
      patchPoints = liveGrid.map((_, index) => new THREE.Vector3(
        relaxed.positions[index * 3], relaxed.positions[index * 3 + 1], relaxed.positions[index * 3 + 2],
      ));
    }
    const composedVertices = new Set(maskDocument.compose().vertices);
    const patchValid = liveGrid.map((_, index) => retainedVertices.has(index) && composedVertices.has(index));
    for (let row = 0; row < samples; row++) for (let column = 0; column < samples; column++) {
      const a = row * (samples + 1) + column;
      const b = a + 1;
      const c = a + samples + 1;
      const d = c + 1;
      if (patchValid[a] && patchValid[c] && patchValid[b]) patchIndices.push(a, c, b);
      if (patchValid[b] && patchValid[c] && patchValid[d]) patchIndices.push(b, c, d);
    }
    areaPreviewVisible = patchIndices.length > 0;
    const selectorState = activeSelectorState();
    selectorState.area = cloneDrawingArea(drawingArea);
    selectorState.dropped = areaDropped;
    selectorState.projectionHeight = projectionHeight.value;
    selectorState.contactLocked = contactLock.checked;
    selectorState.patchId = areaContactPatchId;
    selectorState.renderPoints = patchPoints.map((point) => point.toArray() as [number, number, number]);
    selectorState.renderIndices = [...patchIndices];
    const patchGeometry = new THREE.BufferGeometry().setFromPoints(patchPoints);
    patchGeometry.setIndex(patchIndices);
    const glow = new THREE.Mesh(patchGeometry.clone(), areaGlowMaterial); glow.renderOrder = 7; areaRoot.add(glow);
    const patch = new THREE.Mesh(patchGeometry, areaFillMaterial); patch.renderOrder = 8; areaRoot.add(patch);

    const freeSegments: THREE.Vector3[] = [];
    const contactSegments: THREE.Vector3[] = [];
    const pushEdge = (a: number, b: number) => {
      const bothTouch = patchValid[a] && patchValid[b];
      const bothFree = !patchValid[a] && !patchValid[b];
      if (bothTouch) contactSegments.push(patchPoints[a], patchPoints[b]);
      else if (bothFree && (!areaDropped || clothEnabled.checked)) freeSegments.push(patchPoints[a], patchPoints[b]);
    };
    const gridStep = samples / grid;
    for (let lineIndex = 0; lineIndex <= grid; lineIndex++) {
      const fixed = lineIndex * gridStep;
      for (let variable = 0; variable < samples; variable++) {
        pushEdge(variable * (samples + 1) + fixed, (variable + 1) * (samples + 1) + fixed);
        pushEdge(fixed * (samples + 1) + variable, fixed * (samples + 1) + variable + 1);
      }
    }
    const addSegments = (points: THREE.Vector3[], material: THREE.LineBasicMaterial, renderOrder: number) => {
      if (!points.length) return;
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material);
      line.renderOrder = renderOrder; areaRoot.add(line);
    };
    addSegments(freeSegments, sourceAreaMaterial, 11);
    addSegments(contactSegments, areaMaterial, 9);
    renderInactiveSelectorOverlays();
    if (areaDropped && retainedVertices.size === (samples + 1) * (samples + 1)) {
      setStatus("Selector fully conformed · the flat source grid is completely gone");
    }
  }

  function setAreaTransformMode(mode: "translate" | "rotate" | "scale"): void {
    areaTransform.setMode(mode);
    gizmoMoveButton.classList.toggle("active", mode === "translate");
    gizmoRotateButton.classList.toggle("active", mode === "rotate");
    gizmoScaleButton.classList.toggle("active", mode === "scale");
    if (drawingArea) setStatus(`${mode === "translate" ? "Move" : mode === "rotate" ? "Rotate" : "Scale"} the yellow selector with its viewport handles`);
  }

  function applyAreaTransformSnap(): void {
    const enabled = areaSnap.checked;
    areaTransform.setTranslationSnap(enabled ? .1 : null);
    areaTransform.setRotationSnap(enabled ? THREE.MathUtils.degToRad(15) : null);
    areaTransform.setScaleSnap(enabled ? .1 : null);
    setStatus(enabled ? "Selector snapping enabled · 0.1 units / 15°" : "Selector snapping disabled");
  }

  function syncAreaAnchor(): void {
    if (!drawingArea) return;
    syncingAreaTransform = true;
    areaAnchor.position.copy(drawingArea.center);
    const basis = new THREE.Matrix4().makeBasis(drawingArea.u, drawingArea.v, drawingArea.normal);
    areaAnchor.quaternion.setFromRotationMatrix(basis);
    areaAnchor.scale.set(1, 1, 1);
    areaBaseSizeU = drawingArea.sizeU;
    areaBaseSizeV = drawingArea.sizeV;
    areaTransform.attach(areaAnchor);
    areaTransform.enabled = true;
    areaTransformHelper.visible = true;
    areaTransformHelper.renderOrder = 20;
    syncingAreaTransform = false;
    syncTransformFields();
    syncSelectorUI();
  }

  function syncTransformFields(): void {
    const rotation = new THREE.Euler().setFromQuaternion(areaAnchor.quaternion, "XYZ");
    [areaAnchor.position.x, areaAnchor.position.y, areaAnchor.position.z].forEach((value, index) => { transformPosition[index].value = value.toFixed(3); });
    [rotation.x, rotation.y, rotation.z].forEach((value, index) => { transformRotation[index].value = THREE.MathUtils.radToDeg(value).toFixed(2); });
    [areaAnchor.scale.x, areaAnchor.scale.y, areaAnchor.scale.z].forEach((value, index) => { transformScale[index].value = value.toFixed(3); });
  }

  function updateDrawingAreaFromAnchor(): void {
    if (!drawingArea || syncingAreaTransform) return;
    const oldU = drawingArea.u.clone(), oldV = drawingArea.v.clone();
    const oldCenter = drawingArea.center.clone();
    const oldSizeU = Math.max(drawingArea.sizeU, 1e-6), oldSizeV = Math.max(drawingArea.sizeV, 1e-6);
    const nextU = new THREE.Vector3(1, 0, 0).applyQuaternion(areaAnchor.quaternion).normalize();
    const nextV = new THREE.Vector3(0, 1, 0).applyQuaternion(areaAnchor.quaternion).normalize();
    const nextNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(areaAnchor.quaternion).normalize();
    const nextSizeU = Math.max(.15, areaBaseSizeU * Math.abs(areaAnchor.scale.x));
    const nextSizeV = Math.max(.15, areaBaseSizeV * Math.abs(areaAnchor.scale.y));

    const editableStrokes = [...strokes, ...(curveDocument.activeStroke ? [curveDocument.activeStroke] : [])];
    for (const stroke of editableStrokes) for (const sample of stroke.points) {
      const previousLocal = sample.local ?? [
        sample.point.clone().sub(oldCenter).dot(oldU),
        sample.point.clone().sub(oldCenter).dot(oldV),
      ];
      const nextLocal: [number, number] = [previousLocal[0] / oldSizeU * nextSizeU, previousLocal[1] / oldSizeV * nextSizeV];
      const guess = areaAnchor.position.clone().addScaledVector(nextU, nextLocal[0]).addScaledVector(nextV, nextLocal[1]);
      const surface = closestTargetSurface(guess);
      sample.normal.copy(surface?.normal ?? nextNormal);
      sample.point.copy(surface?.point ?? guess).addScaledVector(sample.normal, currentBrushOffset());
      sample.local = nextLocal;
    }

    drawingArea.center.copy(areaAnchor.position);
    drawingArea.u.copy(nextU); drawingArea.v.copy(nextV); drawingArea.normal.copy(nextNormal);
    drawingArea.sizeU = nextSizeU; drawingArea.sizeV = nextSizeV;
    areaSize.value = String(Math.min(4, Math.max(.6, (nextSizeU + nextSizeV) * .5)));
    areaSizeOutput.value = `${nextSizeU.toFixed(1)} × ${nextSizeV.toFixed(1)}`;
    syncTransformFields();
    renderDrawingArea(); renderPreviews(); updateMetrics(); queueEvaluation();
  }

  function updateAreaTransformInteraction(): void {
    if (!areaDepthDrag) {
      updateDrawingAreaFromAnchor();
      return;
    }
    const displacement = areaAnchor.position.clone().sub(areaDepthDrag.anchorPosition);
    const nextDepth = THREE.MathUtils.clamp(
      areaDepthDrag.initialDepth + displacement.dot(areaDepthDrag.normal),
      Number(projectionHeight.min),
      Number(projectionHeight.max),
    );
    // TransformControls calculates every drag sample from its pointer-down
    // pose. Restore that pose after reading the local-Z delta so the selector
    // frame stays anchored and only its projector depth changes.
    syncingAreaTransform = true;
    areaAnchor.position.copy(areaDepthDrag.anchorPosition);
    syncingAreaTransform = false;

    const renderDepth = (depth: number): void => {
      projectionHeight.value = depth.toFixed(3);
      projectionHeightOutput.value = depth.toFixed(2);
      renderDrawingArea();
    };
    if (contactLock.checked) {
      // A fast gizmo drag can leap across the narrow contact band between
      // pointer events. Sample the intervening depths just like Push Through.
      const step = Math.max(.025, Number(contactDepthControl.value) * .65);
      const direction = Math.sign(nextDepth - areaDepthDrag.lastDepth);
      if (direction !== 0) {
        for (
          let depth = areaDepthDrag.lastDepth + direction * step;
          direction > 0 ? depth < nextDepth : depth > nextDepth;
          depth += direction * step
        ) renderDepth(depth);
      }
    }
    renderDepth(nextDepth);
    areaDepthDrag.lastDepth = nextDepth;
    syncTransformFields();
  }

  function placeDrawingArea(sample: NewSample): void {
    areaHistory.length = 0;
    if (areaContactPatchId) sweptAreaSelection.removePatch(areaContactPatchId);
    areaContactPatchId = `area-${++areaContactPatchCounter}`;
    sweptAreaSelection.createPatch(areaContactPatchId, {
      vertexCount: (AREA_CONTACT_SAMPLES + 1) * (AREA_CONTACT_SAMPLES + 1),
      cellCount: AREA_CONTACT_SAMPLES * AREA_CONTACT_SAMPLES,
    });
    let u = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    u.addScaledVector(sample.normal, -u.dot(sample.normal)).normalize();
    if (u.lengthSq() < 1e-9) u = new THREE.Vector3(0, 1, 0).cross(sample.normal).normalize();
    const v = sample.normal.clone().cross(u).normalize();
    const initialSize = Number(areaSize.value);
    drawingArea = { center: sample.point.clone(), normal: sample.normal.clone(), u, v, sizeU: initialSize, sizeV: initialSize };
    const selectorState = activeSelectorState();
    selectorState.initialArea = cloneDrawingArea(drawingArea);
    selectorState.area = cloneDrawingArea(drawingArea);
    selectorState.patchId = areaContactPatchId;
    areaDropped = false;
    dropAreaButton.classList.remove("projected");
    dropAreaButton.textContent = "First contact";
    pushThroughButton.classList.remove("projected");
    renderDrawingArea();
    syncAreaAnchor();
    setAreaTransformMode("translate");
    setStatus("Source grid placed above the mesh · lower it until contact reveals the yellow area");
  }

  function addAreaDoodle(): void {
    if (!drawingArea) { setStatus("Select an area on the model first"); return; }
    if (!areaDropped) { setStatus("Drop the source grid to the surface before drawing"); return; }
    // Same proportions as the verified Blender parity doodle, normalized into
    // the selected patch. The narrow Y range is what produces the long barbs.
    const shape: [number, number][] = [
      [-48 / 60, -14 / 60], [-33 / 60, 8.4 / 60], [-16 / 60, 16.4 / 60],
      [1 / 60, 1.6 / 60], [18 / 60, -12.4 / 60], [34 / 60, -5 / 60], [48 / 60, 13.6 / 60],
    ];
    const stroke: NewSample[] = [];
    for (const [x, y] of shape) {
      const guess = drawingArea.center.clone()
        .addScaledVector(drawingArea.u, x * drawingArea.sizeU * .5)
        .addScaledVector(drawingArea.v, y * drawingArea.sizeV * .5);
      const surface = closestTargetSurface(guess);
      stroke.push({
        point: (surface?.point ?? guess).addScaledVector(surface?.normal ?? drawingArea.normal, .055),
        normal: (surface?.normal ?? drawingArea.normal).clone(),
        local: [x * drawingArea.sizeU * .5, y * drawingArea.sizeV * .5],
      });
    }
    curveDocument.addStroke(stroke); previewRoot.visible = true; renderPreviews(); updateMetrics(); queueEvaluation();
  }

  function projectLocalSoup(soup: TriSoup, frame: CurveFrame): void {
    const positions = soup.positions;
    const normals = soup.normals;
    let minHeight = Infinity;
    for (let index = 2; index < positions.length; index += 3) minHeight = Math.min(minHeight, positions[index]);
    if (!Number.isFinite(minHeight)) minHeight = 0;
    for (let index = 0; index < positions.length; index += 3) {
      const planePoint = frame.center.clone()
        .addScaledVector(frame.u, positions[index] / CRAYON_SCALE)
        .addScaledVector(frame.v, positions[index + 1] / CRAYON_SCALE);
      const surface = closestTargetSurface(planePoint);
      const point = surface?.point ?? planePoint;
      const normal = surface?.normal ?? frame.normal;
      const height = (positions[index + 2] - minHeight) / CRAYON_SCALE + SURFACE_CLEARANCE;
      point.addScaledVector(normal, height);
      positions[index] = point.x;
      positions[index + 1] = point.y;
      positions[index + 2] = point.z;
      const sourceNormal = frame.u.clone().multiplyScalar(normals[index])
        .addScaledVector(frame.v, normals[index + 1])
        .addScaledVector(normal, normals[index + 2])
        .normalize();
      normals[index] = sourceNormal.x;
      normals[index + 1] = sourceNormal.y;
      normals[index + 2] = sourceNormal.z;
    }
  }

  function projectSigilSoup(soup: TriSoup, layout: CrayonLayout): void {
    const p = soup.positions, n = soup.normals;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[i + axis]); max[axis] = Math.max(max[axis], p[i + axis]);
    }
    const span = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
    const heightSpan = Math.max(max[2] - min[2], 1e-9);
    const stampScale = (drawingArea ? Math.min(drawingArea.sizeU, drawingArea.sizeV) * .82 : Math.min(layout.length * .72, 2.6)) / span;
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

  function authoredStamp(stroke: EditableCurveStroke): { group: THREE.Group; verts: number; faces: number } {
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
    const count = curveDocument.pointCount;
    pointCount.textContent = `${count} projected point${count === 1 ? "" : "s"}`;
    flatOverlay.dataset.empty = count === 0 ? "true" : "false";
  }

  function soupMesh(soup: TriSoup, material: THREE.Material, rebuildNormals = false): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
    if (rebuildNormals) geometry.computeVertexNormals();
    else geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
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

  /** strokeFrame, but positions past either stroke end continue along the end tangent. */
  function strokeFrameExtended(layout: CrayonLayout, distance: number): ReturnType<typeof strokeFrame> {
    const clamped = THREE.MathUtils.clamp(distance, 0, layout.length);
    const frame = strokeFrame(layout, clamped);
    if (distance !== clamped) frame.point.addScaledVector(frame.tangent, distance - clamped);
    return frame;
  }

  /**
   * Sweep the flat typewriter glyph soup along one stroke: glyph X maps to
   * stroke arc length, glyph Y to the surface-tangent lateral direction, and
   * glyph height rides the surface normal. Each vertex re-projects onto the
   * nearest target surface so the text conforms to curvature between samples.
   * Fit mode scales the string to the stroke; fixed mode uses a world glyph
   * height and lets the string run past the stroke ends along their tangents.
   */
  function textAlongStroke(soup: TriSoup, layout: CrayonLayout): THREE.BufferGeometry {
    const source = soup.positions;
    const positions = new Float32Array(source.length);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < source.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], source[i + axis]);
      max[axis] = Math.max(max[axis], source[i + axis]);
    }
    const scale = textFit.checked
      ? layout.length / Math.max(max[0] - min[0], 1e-9)
      : Number(textSize.value) / Math.max(max[1] - min[1], 1e-9);
    const offset = Number(textOffset.value);
    const lateralCenter = (min[1] + max[1]) * .5;
    for (let i = 0; i < source.length; i += 3) {
      const frame = strokeFrameExtended(layout, (source[i] - min[0]) * scale);
      const planePoint = frame.point.clone()
        .addScaledVector(frame.lateral, (source[i + 1] - lateralCenter) * scale + offset);
      const surface = surfaceKind === "flat" ? null : closestTargetSurface(planePoint);
      const point = surface?.point ?? planePoint;
      const normal = surface?.normal ?? frame.normal;
      point.addScaledVector(normal, (source[i + 2] - min[2]) * scale + SURFACE_CLEARANCE);
      positions[i] = point.x; positions[i + 1] = point.y; positions[i + 2] = point.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(soup.indices.slice(), 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  async function evaluateTextBrush(): Promise<void> {
    const text = surfaceText.value.trim();
    const { layouts } = crayonInput();
    if (!text || !layouts.length) {
      clearObject(brushRoot);
      runtime.textContent = text ? "Draw a stroke to place the text" : "Type some text first";
      return;
    }
    const id = ++requestId;
    const started = performance.now();
    setStatus("Evaluating typewriter glyphs in GN-VM…", true);
    const soup = await typewriterTextSoup(text);
    if (id !== requestId || disposed) return;
    const group = new THREE.Group();
    let verts = 0, tris = 0;
    for (const layout of layouts) {
      const geometry = textAlongStroke(soup, layout);
      verts += geometry.getAttribute("position").count;
      tris += geometry.index ? geometry.index.count / 3 : 0;
      group.add(new THREE.Mesh(geometry, chromeMaterial));
    }
    previewRoot.visible = selectingCurve || curveDocument.activeStroke !== null;
    clearObject(brushRoot); brushRoot.add(group);
    runtime.textContent = `${verts.toLocaleString()} verts · ${Math.round(tris).toLocaleString()} tris · ${((performance.now() - started) / 1000).toFixed(2)}s`;
    boundsText.textContent = `“${text}” swept along ${layouts.length} stroke${layouts.length === 1 ? "" : "s"}`;
    setStatus("Typewriter text wrapped onto the surface · draw more strokes or edit the text");
    (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__ = {
      ready: true,
      brush: "text",
      surface: surfaceKind,
      strokes: strokes.length,
      points: curveDocument.pointCount,
      stats: { verts, faces: Math.round(tris) },
    };
  }

  /**
   * Repeat a reference object's evaluated mesh along each stroke: stamps sit
   * at spacing intervals, oriented by the local stroke frame (asset X along
   * the stroke, Y lateral, Blender Z-up along the surface normal). Placement
   * is rigid per stamp — stamps are small, so chordal error stays negligible.
   */
  const STAMP_VERTEX_BUDGET = 400_000;
  function stampsAlongStroke(soup: TriSoup, layout: CrayonLayout, size: number, spacing: number, budget: number): { geometry: THREE.BufferGeometry; count: number } | null {
    const source = soup.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < source.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], source[i + axis]);
      max[axis] = Math.max(max[axis], source[i + axis]);
    }
    const footprint = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
    const scale = size / footprint;
    const centerX = (min[0] + max[0]) * .5;
    const centerY = (min[1] + max[1]) * .5;
    const vertexCount = source.length / 3;
    const fitCount = Math.max(1, Math.floor((layout.length - size) / spacing) + 1);
    const count = Math.max(1, Math.min(fitCount, Math.floor(budget / Math.max(vertexCount, 1))));
    if (!count) return null;
    const startDistance = (layout.length - (count - 1) * spacing) * .5;
    const positions = new Float32Array(source.length * count);
    const indices = new Uint32Array(soup.indices.length * count);
    for (let stamp = 0; stamp < count; stamp++) {
      const frame = strokeFrame(layout, startDistance + stamp * spacing);
      const vertexBase = stamp * vertexCount;
      const positionBase = stamp * source.length;
      for (let i = 0; i < source.length; i += 3) {
        const x = (source[i] - centerX) * scale;
        const y = (source[i + 1] - centerY) * scale;
        const z = (source[i + 2] - min[2]) * scale + SURFACE_CLEARANCE;
        positions[positionBase + i] = frame.point.x + frame.tangent.x * x + frame.lateral.x * y + frame.normal.x * z;
        positions[positionBase + i + 1] = frame.point.y + frame.tangent.y * x + frame.lateral.y * y + frame.normal.y * z;
        positions[positionBase + i + 2] = frame.point.z + frame.tangent.z * x + frame.lateral.z * y + frame.normal.z * z;
      }
      const indexBase = stamp * soup.indices.length;
      for (let i = 0; i < soup.indices.length; i++) indices[indexBase + i] = soup.indices[i] + vertexBase;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return { geometry, count };
  }

  async function evaluateStampBrush(): Promise<void> {
    const info = libraryShapes.find((shape) => shape.id === stampAsset.value);
    const { layouts } = crayonInput();
    if (!info || !layouts.length) {
      clearObject(brushRoot);
      runtime.textContent = info ? "Draw a stroke to place the stamps" : "Choose a reference object to stamp";
      return;
    }
    const id = ++requestId;
    const started = performance.now();
    setStatus(`Evaluating ${info.title} in GN-VM…`, true);
    const soup = await evaluateLibraryShape(info);
    if (id !== requestId || disposed) return;
    const size = Number(stampSize.value);
    const spacing = Number(stampSpacing.value);
    const group = new THREE.Group();
    let verts = 0, tris = 0, stamps = 0, budget = STAMP_VERTEX_BUDGET;
    for (const layout of layouts) {
      const placed = stampsAlongStroke(soup, layout, size, spacing, budget);
      if (!placed) continue;
      stamps += placed.count;
      budget -= placed.count * (soup.positions.length / 3);
      verts += placed.geometry.getAttribute("position").count;
      tris += placed.geometry.index ? placed.geometry.index.count / 3 : 0;
      group.add(new THREE.Mesh(placed.geometry, chromeMaterial));
    }
    previewRoot.visible = selectingCurve || curveDocument.activeStroke !== null;
    clearObject(brushRoot); brushRoot.add(group);
    const capped = budget <= soup.positions.length / 3;
    runtime.textContent = `${stamps} stamp${stamps === 1 ? "" : "s"} · ${verts.toLocaleString()} verts · ${((performance.now() - started) / 1000).toFixed(2)}s${capped ? " · capped for performance" : ""}`;
    boundsText.textContent = `${info.title} repeated along ${layouts.length} stroke${layouts.length === 1 ? "" : "s"}`;
    setStatus(`${info.title} stamped along the stroke${capped ? " · heavy asset, stamp count capped" : ""}`);
    (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__ = {
      ready: true,
      brush: "stamp",
      surface: surfaceKind,
      strokes: strokes.length,
      points: curveDocument.pointCount,
      stats: { verts, faces: Math.round(tris) },
      stamps,
    };
  }

  async function evaluateBrush(): Promise<void> {
    if (brushSelect.value === "text") { await evaluateTextBrush(); return; }
    if (brushSelect.value === "stamp") { await evaluateStampBrush(); return; }
    const brush = brushSelect.value === "periodic" ? "periodic" : "crayon";
    const dump = dumps[brush];
    const authored = brush === "crayon" && crayonPreset.value === "exact";
    const directFlat = brush === "crayon" && !authored && surfaceKind === "flat";
    const sigilStamp = brush === "crayon" && !authored && !directFlat && Number(sigilize.value) > 0;
    const editableSurface = brush === "crayon" && !authored && !directFlat && parityPathMode !== "curved";
    const crayon = crayonInput();
    const localFrame = editableSurface ? editableCurveFrame() : null;
    const curves = brush === "crayon"
      ? directFlat
        ? allCurves(CRAYON_SCALE)
        : sigilStamp
          ? sigilInput(localFrame!)
          : editableSurface
            ? localCrayonInput(localFrame!)
            : crayon.curves
      : allCurves();
    if (!dump || !strokes.some((stroke) => stroke.points.length > 1)) { clearObject(brushRoot); runtime.textContent = "Draw a stroke to evaluate GN-VM"; return; }
    const id = ++requestId; const started = performance.now(); setStatus("Evaluating projected curve in GN-VM…", true);
    if (authored) {
      const stamp = authoredStamp(strokes.at(-1)!);
      clearObject(brushRoot); brushRoot.add(stamp.group);
      runtime.textContent = `${stamp.verts.toLocaleString()} verts · ${Math.round(stamp.faces).toLocaleString()} tris · Blender-validated GLB`;
      setStatus("Blender-authored seven-spline motif wrapped to surface");
      (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__ = { ready: true, brush, preset: "exact", strokes: strokes.length, points: curveDocument.pointCount, stats: { verts: stamp.verts, faces: Math.round(stamp.faces) } };
      return;
    }
    const { worker, installId } = await ensureWorkerDump(dump);
    const result = await workerReply<WorkerReply>(worker, () => {
      const object = brush === "crayon" ? "CHROME CRAYON OBJECT" : "PERIODIC BRUSH";
      const overrides = brush === "crayon" ? {
        "Line Thiccness": Number(thickness.value), "Peak Height": Number(peak.value), resolution: Number(resolution.value),
        Sigilize: Number(sigilize.value), Soften: Number(soften.value), FLATTEN: flatten.checked, "Extrude Base": Number(extrude.value), SPIRO: Number(spiro.value),
      } : { "Dot Distance": Number(spacing.value), "dot size": Number(size.value) };
      worker.postMessage({ kind: "evaluate", installId, id, object, curves: authored ? undefined : curves, overrides });
    });
    if (id !== requestId) return;
    if (!result.ok) throw new Error(result.error);
    if (directFlat) for (let i = 0; i < result.soup.positions.length; i++) result.soup.positions[i] /= CRAYON_SCALE;
    else if (sigilStamp) projectSigilSoup(result.soup, crayon.layouts.at(-1)!);
    else if (editableSurface) projectLocalSoup(result.soup, localFrame!);
    else if (brush === "crayon") wrapCrayonSoup(result.soup, crayon.layouts);
    const bounds = soupBounds(result.soup);
    // The curve is an editing guide, not part of the finished render. Keeping
    // it visible over chrome reads as a material seam, so reveal it only while
    // drawing or selecting. Chrome normals are rebuilt from the final GN mesh:
    // the graph's Soften stage changes positions/topology after its normal data
    // was captured, which otherwise leaves bright triangular shading wedges.
    previewRoot.visible = !sigilStamp && (selectingCurve || curveDocument.activeStroke !== null);
    const material = sigilStamp ? sigilMaterial : brush === "crayon" ? chromeMaterial : brushMaterial;
    clearObject(brushRoot); brushRoot.add(soupMesh(result.soup, material, brush === "crayon"));
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
      points: curveDocument.pointCount,
      editable: true,
      selection: curveDocument.selection,
      stats: result.soup.stats,
      bounds,
    };
  }

  async function runEvaluationLoop(): Promise<void> {
    if (evaluationBusy) { evaluationQueued = true; return; }
    evaluationBusy = true;
    try {
      do {
        evaluationQueued = false;
        await evaluateBrush();
      } while (evaluationQueued && !disposed);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      evaluationBusy = false;
    }
  }

  function queueEvaluation(): void {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => {
      if (disposed) return;
      if (evaluationBusy) evaluationQueued = true;
      else void runEvaluationLoop();
    }, 120);
  }
  function clearStrokes(): void { curveDocument.clear(); parityPathMode = "none"; previewRoot.visible = true; clearObject(brushRoot); renderPreviews(); updateMetrics(); runtime.textContent = "Draw a stroke to evaluate GN-VM"; boundsText.textContent = "Bounds appear after evaluation"; }
  function setMode(next: "draw" | "select" | "area" | "orbit" | "target"): void {
    drawing = next === "draw"; selectingCurve = next === "select"; selectingArea = next === "area"; selectingTarget = next === "target"; controls.enabled = next === "orbit";
    drawButton.classList.toggle("active", drawing); selectButton.classList.toggle("active", selectingCurve); areaButton.classList.toggle("active", selectingArea); orbitButton.classList.toggle("active", next === "orbit");
    targetPickButton.classList.toggle("active", selectingTarget);
    targetPickButton.dataset.hit = "false";
    canvas.style.cursor = selectingTarget ? "crosshair" : selectingArea ? "cell" : selectingCurve ? "default" : drawing ? "crosshair" : "grab";
    brushReticle.hidden = !drawing;
    selectionHud.hidden = !selectingArea;
    selectionHud.dataset.hit = "false";
    selectionLabel.textContent = `CHROME CRAYON · ${targetLabel(targetSurfaces, targetSelect.value)} · PLACE AREA`;
    selectionGuidesDirty = true;
    updateSurfaceSelectionGuides();
    previewRoot.visible = selectingCurve || curveDocument.activeStroke !== null;
    renderPreviews();
  }

  function curveHit(event: PointerEvent): { strokeId: number; pointId?: number } | null {
    updatePointer(event);
    curveRaycaster.setFromCamera(pointer, camera);
    const pointHit = curveRaycaster.intersectObject(handleRoot, true)[0];
    if (pointHit) {
      const strokeId = Number(pointHit.object.userData.strokeId);
      const stroke = curveDocument.stroke(strokeId);
      const pointId = pointHit.object.userData.pointId === undefined
        ? stroke?.points[pointHit.index ?? -1]?.id
        : Number(pointHit.object.userData.pointId);
      if (stroke && pointId !== undefined) return { strokeId, pointId };
    }
    const lineHit = curveRaycaster.intersectObject(previewRoot, true)[0];
    const strokeId = Number(lineHit?.object.userData.strokeId);
    return Number.isFinite(strokeId) && curveDocument.stroke(strokeId) ? { strokeId } : null;
  }

  function projectedEditablePoint(proposed: THREE.Vector3): ProjectedCurvePoint {
    const surface = closestTargetSurface(proposed);
    const normal = surface?.normal ?? drawingArea?.normal ?? new THREE.Vector3(0, 0, 1);
    const point = (surface?.point ?? proposed).clone().addScaledVector(normal, currentBrushOffset());
    const local = drawingArea
      ? [
        point.clone().sub(drawingArea.center).dot(drawingArea.u),
        point.clone().sub(drawingArea.center).dot(drawingArea.v),
      ] as [number, number]
      : undefined;
    return { point, normal: normal.clone(), local };
  }

  function beginCurveDrag(event: PointerEvent, hit: { strokeId: number; pointId?: number }): void {
    if (hit.pointId === undefined) curveDocument.selectStroke(hit.strokeId);
    else curveDocument.selectPoint(hit.strokeId, hit.pointId);
    const surface = surfaceHit(event, false);
    renderPreviews();
    if (!surface) return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
    curveDrag = { pointerId: event.pointerId, lastSurfacePoint: surface.point };
    setStatus(hit.pointId === undefined ? "Moving selected stroke · nearby parts re-evaluate together" : "Moving curve control point");
  }

  function moveCurveDrag(event: PointerEvent): void {
    if (!curveDrag || curveDrag.pointerId !== event.pointerId) return;
    const surface = surfaceHit(event, false);
    if (!surface) return;
    if (curveDocument.selectedPoint()) {
      curveDocument.moveSelectedPoint(surface.point, (proposed) => projectedEditablePoint(proposed));
    } else {
      const delta = surface.point.clone().sub(curveDrag.lastSurfacePoint);
      curveDocument.translateSelection(delta, (proposed) => projectedEditablePoint(proposed));
    }
    curveDrag.lastSurfacePoint.copy(surface.point);
    parityPathMode = "none";
    previewRoot.visible = true;
    renderPreviews();
    updateMetrics();
    queueEvaluation();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (areaTransform.enabled && (areaTransform.dragging || areaTransform.axis !== null)) return;
    if (selectingTarget) {
      const sample = surfaceHit(event, false);
      if (sample) {
        targetSelect.value = sample.target.uuid;
        applyTargetAppearance();
        setMode("area");
        positionBrushReticle(event);
        updateSurfaceSelectionHud(event);
        setStatus(`${targetLabel(targetSurfaces, targetSelect.value)} locked · now click to place the drawing area`);
      }
      return;
    }
    if (selectingArea) {
      if (targetSelect.value === PICK_TARGET_SURFACE) {
        setMode("target");
        setStatus("Choose the target object first · the area-placement HUD will appear after it is locked");
        return;
      }
      const sample = surfaceHit(event, false);
      if (sample) {
        placeDrawingArea(sample);
        setMode("draw");
      }
      return;
    }
    if (selectingCurve) {
      const hit = curveHit(event);
      if (hit) beginCurveDrag(event, hit);
      else { curveDocument.deselect(); renderPreviews(); setStatus("Select a stroke or one of its control points"); }
      return;
    }
    if (!drawing) return;
    if (drawingArea && !areaDropped) { setStatus("Drop / project the source grid to the surface before drawing"); return; }
    parityPathMode = "none"; previewRoot.visible = true;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in embedded/test browsers. */ }
    curveDocument.beginStroke(); addSample(event);
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    positionBrushReticle(event);
    if (selectingTarget) updateTargetPickerHover(event);
    if (selectingArea) updateSurfaceSelectionHud(event);
    if (curveDrag) moveCurveDrag(event);
    else if (drawing && curveDocument.activeStroke) addSample(event);
  }, { signal });
  canvas.addEventListener("pointerleave", () => {
    if (selectingTarget) {
      targetPickButton.dataset.hit = "false";
      canvas.style.cursor = "crosshair";
    } else if (selectingArea) {
      selectionHud.dataset.hit = "false";
      selectionLabel.textContent = `CHROME CRAYON · ${targetLabel(targetSurfaces, targetSelect.value)} · PLACE AREA`;
      canvas.style.cursor = "cell";
    }
  }, { signal });
  canvas.addEventListener("pointerup", (event) => {
    if (curveDrag?.pointerId === event.pointerId) {
      curveDrag = null;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* no active capture */ }
      queueEvaluation();
      return;
    }
    if (!curveDocument.activeStroke) return;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* no active capture */ }
    curveDocument.commitStroke();
    renderPreviews(); updateMetrics(); queueEvaluation();
  }, { signal });
  canvas.addEventListener("pointercancel", () => { curveDrag = null; curveDocument.cancelStroke(); renderPreviews(); }, { signal });
  areaTransform.addEventListener("mouseDown", () => {
    checkpointDrawingArea();
    areaDepthDrag = drawingArea
      && areaTransform.getMode() === "translate"
      && areaTransform.axis === "Z"
      ? {
          anchorPosition: areaAnchor.position.clone(),
          normal: drawingArea.normal.clone(),
          initialDepth: Number(projectionHeight.value),
          lastDepth: Number(projectionHeight.value),
        }
      : null;
    controls.enabled = false;
    canvas.style.cursor = "grabbing";
  });
  areaTransform.addEventListener("mouseUp", () => {
    const finishedDepthDrag = Boolean(areaDepthDrag);
    areaDepthDrag = null;
    controls.enabled = orbitButton.classList.contains("active");
    canvas.style.cursor = selectingTarget ? "crosshair" : selectingArea ? "cell" : selectingCurve ? "default" : drawing ? "crosshair" : "grab";
    setStatus(finishedDepthDrag
      ? contactLock.checked
        ? "Manual push depth updated · crossed surface cells remain locked yellow"
        : areaPreviewVisible
          ? "Manual push is touching the surface · raise it to deselect"
          : "Manual push depth updated · unlocked mask follows only the current contact band"
      : areaDropped
      ? "Committed yellow area updated · projected strokes follow its surface frame"
      : areaPreviewVisible
        ? "Selector touches the target · yellow surface preview is live"
        : "Selector is above the target · lower it until the yellow area appears");
  });
  areaTransform.addEventListener("objectChange", updateAreaTransformInteraction);
  fileInput.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void loadFile(file).catch((error) => setStatus(error instanceof Error ? error.message : String(error))); }, { signal });
  targetSelect.addEventListener("change", () => {
    removeDrawingArea();
    clearStrokes();
    applyTargetAppearance();
    const target = targetLabel(targetSurfaces, targetSelect.value);
    if (selectingTarget && targetSelect.value !== PICK_TARGET_SURFACE) {
      setMode("area");
      setStatus(`${target} locked · click the surface to place the drawing area`);
    } else {
      setStatus(targetSelect.value === PICK_TARGET_SURFACE ? "Choose a target object before placing the area" : `Projection target changed · ${target}`);
    }
  }, { signal });
  targetPickButton.addEventListener("click", () => {
    targetSelect.value = PICK_TARGET_SURFACE;
    removeDrawingArea();
    clearStrokes();
    applyTargetAppearance();
    setMode("target");
    setStatus("Target picker armed · click once to lock an object (area HUD stays hidden)");
  }, { signal });
  demoButton.addEventListener("click", demoSurface, { signal });
  flatButton.addEventListener("click", flatSurface, { signal });
  {
    const librarySelect = document.querySelector<HTMLSelectElement>("#surface-library")!;
    void listLibraryShapes()
      .then((shapes) => {
        if (disposed) return;
        libraryShapes = shapes;
        // Remounts retain the DOM: rebuild after the placeholders instead of appending.
        while (librarySelect.options.length > 1) librarySelect.remove(1);
        while (stampAsset.options.length > 1) stampAsset.remove(1);
        for (const shape of shapes) {
          librarySelect.add(new Option(shape.title, shape.id));
          stampAsset.add(new Option(shape.title, shape.id));
        }
      })
      .catch(() => { /* catalog unavailable — uploads and the demo surface remain */ });
    librarySelect.addEventListener("change", () => {
      const info = libraryShapes.find((shape) => shape.id === librarySelect.value);
      if (info) void loadLibrarySurface(info).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    }, { signal });
  }
  sampleButton.addEventListener("click", () => void loadTarget(publicUrl("dojo/crayon/00-browser-baseline.glb"), "glb", "Node Dojo Chrome Crayon GLB").catch((error) => setStatus(error instanceof Error ? error.message : String(error))), { signal });
  parityPathButton.addEventListener("click", loadParityPath, { signal });
  curvedParityPathButton.addEventListener("click", loadCurvedParityPath, { signal });
  drawButton.addEventListener("click", () => setMode("draw"), { signal });
  selectButton.addEventListener("click", () => { setMode("select"); setStatus("Select a stroke to move it · click a handle to edit one point"); }, { signal });
  orbitButton.addEventListener("click", () => setMode("orbit"), { signal });
  areaButton.addEventListener("click", () => {
    if (targetSelect.value === PICK_TARGET_SURFACE) {
      setMode("target");
      setStatus("Choose the target object first · area placement starts on the next step");
    } else {
      setMode("area");
      setStatus("Initial area selection · click the surface to place the drawing area");
    }
  }, { signal });
  clearAreaButton.addEventListener("click", () => { clearActiveSelectorArea(); setStatus("Active selector area removed · other visible selectors remain"); }, { signal });
  areaDoodleButton.addEventListener("click", addAreaDoodle, { signal });
  selectorList.addEventListener("change", () => loadSelector(selectorList.value), { signal });
  selectorNewButton.addEventListener("click", createSelector, { signal });
  selectorDeleteButton.addEventListener("click", deleteActiveSelector, { signal });
    maskOperation.addEventListener("change", () => {
    const id = maskDocument.activeSelectorId;
    if (!id) return;
    maskDocument.updateSelector(id, { operation: maskOperation.value as SelectionMaskOperation });
    renderDrawingArea();
    setStatus(`${activeSelectorState().name} mask operation · ${maskOperation.value}`);
  }, { signal });
  selectorVisible.addEventListener("change", () => {
    const id = maskDocument.activeSelectorId;
    if (!id) return;
    maskDocument.updateSelector(id, { visible: selectorVisible.checked });
    renderDrawingArea();
    setStatus(`${activeSelectorState().name} ${selectorVisible.checked ? "visible" : "hidden"}`);
  }, { signal });
  selectorLocked.addEventListener("change", () => {
    const id = maskDocument.activeSelectorId;
    if (!id) return;
    maskDocument.updateSelector(id, { locked: selectorLocked.checked });
    syncSelectorUI();
    setStatus(`${activeSelectorState().name} ${selectorLocked.checked ? "locked" : "unlocked"}`);
  }, { signal });
  gizmoMoveButton.addEventListener("click", () => setAreaTransformMode("translate"), { signal });
  gizmoRotateButton.addEventListener("click", () => setAreaTransformMode("rotate"), { signal });
  gizmoScaleButton.addEventListener("click", () => setAreaTransformMode("scale"), { signal });
  areaSnap.addEventListener("change", applyAreaTransformSnap, { signal });
  areaSpace.addEventListener("change", () => {
    areaTransform.setSpace(areaSpace.value === "world" ? "world" : "local");
    setStatus(`Selector transform space · ${areaSpace.value}`);
  }, { signal });
  applyTransformButton.addEventListener("click", () => {
    if (!drawingArea) { setStatus("Place the active selector before entering a transform"); return; }
    checkpointDrawingArea();
    const position = transformPosition.map((input, index) => Number.isFinite(Number(input.value)) ? Number(input.value) : areaAnchor.position.getComponent(index));
    const rotation = transformRotation.map((input) => THREE.MathUtils.degToRad(Number.isFinite(Number(input.value)) ? Number(input.value) : 0));
    const scale = transformScale.map((input, index) => Number.isFinite(Number(input.value)) ? Math.max(.01, Math.abs(Number(input.value))) : areaAnchor.scale.getComponent(index));
    areaAnchor.position.set(position[0], position[1], position[2]);
    areaAnchor.quaternion.setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], "XYZ"));
    areaAnchor.scale.set(scale[0], scale[1], scale[2]);
    updateDrawingAreaFromAnchor();
    setStatus("Numeric selector transform applied");
  }, { signal });
  resetTransformButton.addEventListener("click", () => {
    const state = activeSelectorState();
    if (!state.initialArea) { setStatus("This selector has no placed transform to reset"); return; }
    checkpointDrawingArea();
    drawingArea = cloneDrawingArea(state.initialArea);
    syncAreaAnchor();
    renderDrawingArea();
    setStatus("Selector transform reset to its placement pose");
  }, { signal });
  for (const [input, output, decimals, suffix] of [
    [contactSoftness, contactSoftnessOutput, 2, ""],
    [contactDepthControl, contactDepthOutput, 2, ""],
    [maxSurfaceAngle, maxSurfaceAngleOutput, 0, "°"],
    [drapeStretch, drapeStretchOutput, 2, ""],
    [drapeIterations, drapeIterationsOutput, 0, ""],
    [clothSag, clothSagOutput, 2, ""],
  ] as const) {
    input.addEventListener("pointerdown", checkpointDrawingArea, { signal });
    input.addEventListener("input", () => {
      output.value = `${Number(input.value).toFixed(decimals)}${suffix}`;
      renderDrawingArea();
    }, { signal });
  }
  clothEnabled.addEventListener("change", () => {
    checkpointDrawingArea();
    renderDrawingArea();
    setStatus(clothEnabled.checked
      ? "Optional cloth relaxation enabled · contacts stay pinned while free cells sag"
      : "Blender-style projected shrinkwrap enabled · cloth relaxation off");
  }, { signal });
  contactLock.addEventListener("change", () => {
    checkpointDrawingArea();
    activeSelectorState().contactLocked = contactLock.checked;
    renderDrawingArea();
    setStatus(contactLock.checked
      ? "Contact mask locked · swept surface crossings remain selected"
      : "Contact mask live · raise the grid to deselect the surface");
  }, { signal });
  clearContactButton.addEventListener("click", () => {
    if (!areaContactPatchId) { setStatus("The active selector has no contact mask"); return; }
    checkpointDrawingArea();
    sweptAreaSelection.clearPatch(areaContactPatchId);
    const id = maskDocument.activeSelectorId;
    if (id) maskDocument.clearSelectorMask(id, { history: false, force: true });
    const state = activeSelectorState();
    state.renderPoints = [];
    state.renderIndices = [];
    areaDropped = false;
    contactLock.checked = false;
    renderDrawingArea();
    setStatus("Active contact mask cleared · lower the grid to select again");
  }, { signal });
  projectionHeight.addEventListener("input", () => {
    projectionHeightOutput.value = Number(projectionHeight.value).toFixed(2);
    renderDrawingArea();
    setStatus(areaDropped
      ? "Projection height changed · committed yellow result updated"
      : areaPreviewVisible
        ? "Source grid reached the target · yellow surface preview is live"
        : "Source grid is still above the target · no yellow area yet");
  }, { signal });
  projectionHeight.addEventListener("pointerdown", checkpointDrawingArea, { signal });
  dropAreaButton.addEventListener("click", () => {
    if (!drawingArea) { setMode("area"); setStatus("Click an object first to place the floating source grid"); return; }
    checkpointDrawingArea();
    // Lower in small increments and stop at the first real surface crossing,
    // matching the reference instead of treating every point below the plane
    // as contact.
    const startHeight = Number(projectionHeight.value);
    const contactStep = Math.max(.02, Number(contactDepthControl.value) * .45);
    areaDropped = false;
    for (let height = startHeight; height >= -0.5; height -= contactStep) {
      projectionHeight.value = height.toFixed(3);
      projectionHeightOutput.value = height.toFixed(2);
      renderDrawingArea();
      if (areaPreviewVisible) break;
    }
    areaDropped = areaPreviewVisible;
    dropAreaButton.classList.add("projected");
    dropAreaButton.textContent = "Contact captured ✓";
    renderDrawingArea();
    setStatus(areaPreviewVisible
      ? "Lowered to first contact · only the crossing cells are yellow and conformed"
      : "No surface contact found inside the projection limit");
  }, { signal });
  pushThroughButton.addEventListener("click", () => {
    if (!drawingArea) { setMode("area"); setStatus("Place the selector on an object first"); return; }
    checkpointDrawingArea();
    areaDropped = true;
    contactLock.checked = true;
    dropAreaButton.classList.add("projected");
    dropAreaButton.textContent = "Contact captured ✓";
    pushThroughButton.classList.add("projected");
    const finalHeight = -1.25;
    const contactStep = Math.max(.025, Number(contactDepthControl.value) * .65);
    for (let height = Number(projectionHeight.value) - contactStep; height > finalHeight; height -= contactStep) {
      projectionHeight.value = height.toFixed(3);
      projectionHeightOutput.value = height.toFixed(2);
      renderDrawingArea();
    }
    projectionHeight.value = String(finalHeight);
    projectionHeightOutput.value = finalHeight.toFixed(2);
    renderDrawingArea();
    setStatus("Pushed through · latched near-side contacts remain yellow and the flat grid is hidden");
  }, { signal });
  areaSize.addEventListener("pointerdown", checkpointDrawingArea, { signal });
  areaSize.addEventListener("input", () => {
    areaSizeOutput.value = Number(areaSize.value).toFixed(1);
    if (drawingArea) {
      areaBaseSizeU = Number(areaSize.value); areaBaseSizeV = Number(areaSize.value);
      areaAnchor.scale.set(1, 1, 1);
      updateDrawingAreaFromAnchor();
    }
  }, { signal });
  window.addEventListener("keydown", (event) => {
    if (!drawingArea || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, select, textarea, [contenteditable='true']")) return;
    if (event.key.toLowerCase() === "g") setAreaTransformMode("translate");
    else if (event.key.toLowerCase() === "r") setAreaTransformMode("rotate");
    else if (event.key.toLowerCase() === "s") setAreaTransformMode("scale");
    else return;
    event.preventDefault();
  }, { signal });
  undoButton.addEventListener("click", () => { curveDocument.undo(); renderPreviews(); updateMetrics(); queueEvaluation(); }, { signal });
  undoAreaButton.addEventListener("click", undoDrawingArea, { signal });
  clearButton.addEventListener("click", clearStrokes, { signal });
  for (const input of [spacing, size]) input.addEventListener("input", () => { spacingOutput.value = Number(spacing.value).toFixed(2); sizeOutput.value = Number(size.value).toFixed(3); queueEvaluation(); }, { signal });
  for (const [input, output, decimals] of [[thickness, thicknessOutput, 1], [peak, peakOutput, 1], [sigilize, sigilizeOutput, 0], [soften, softenOutput, 0], [resolution, resolutionOutput, 3], [spiro, spiroOutput, 0], [extrude, extrudeOutput, 1]] as const)
    input.addEventListener("input", () => { output.value = Number(input.value).toFixed(decimals); queueEvaluation(); }, { signal });
  flatten.addEventListener("change", queueEvaluation, { signal });
  function applyCrayonPreset(): void {
    const exact = crayonPreset.value === "exact";
    const values = exact
      ? [24.318, 404.742, 665, 0, .835, 3, 1]
      : [6, 10, 0, 3, .835, 1, 1];
    const controlsAndOutputs = [[thickness, thicknessOutput, 1], [peak, peakOutput, 1], [sigilize, sigilizeOutput, 0], [soften, softenOutput, 0], [resolution, resolutionOutput, 3], [spiro, spiroOutput, 0], [extrude, extrudeOutput, 1]] as const;
    controlsAndOutputs.forEach(([input, output, decimals], index) => { input.value = String(values[index]); input.disabled = exact; output.value = values[index].toFixed(decimals); });
    flatten.disabled = exact;
    queueEvaluation();
  }
  crayonPreset.addEventListener("change", applyCrayonPreset, { signal });
  sigilButton.addEventListener("click", () => {
    if (crayonPreset.value !== "adapted") { crayonPreset.value = "adapted"; applyCrayonPreset(); }
    thickness.value = "24.318"; thicknessOutput.value = "24.3";
    peak.value = "404.742"; peakOutput.value = "404.7";
    resolution.value = ".835"; resolutionOutput.value = ".835";
    sigilize.value = "665"; sigilizeOutput.value = "665";
    spiro.value = "3"; spiroOutput.value = "3";
    setStatus("Original unique-sigil preset enabled · Sigilize 665 · SPIRO 3");
    queueEvaluation();
  }, { signal });
  brushSelect.addEventListener("change", () => {
    const brush = brushSelect.value;
    brushLabel.textContent = brush === "crayon"
      ? "Chrome Crayon · draw anywhere"
      : brush === "periodic" ? "Periodic Brush · draw anywhere"
      : brush === "text" ? "Typewriter text · draw a baseline" : "Library stamp · draw a path";
    crayonControls.hidden = brush !== "crayon";
    periodicControls.hidden = brush !== "periodic";
    textControls.hidden = brush !== "text";
    stampControls.hidden = brush !== "stamp";
    clearObject(brushRoot); queueEvaluation();
  }, { signal });
  surfaceText.addEventListener("input", () => { if (brushSelect.value === "text") queueEvaluation(); }, { signal });
  textFit.addEventListener("change", () => {
    textSize.disabled = textFit.checked;
    if (brushSelect.value === "text") queueEvaluation();
  }, { signal });
  for (const [input, output, decimals] of [
    [textSize, textSizeOutput, 2],
    [textOffset, textOffsetOutput, 2],
  ] as const) input.addEventListener("input", () => {
    output.value = Number(input.value).toFixed(decimals);
    if (brushSelect.value === "text") queueEvaluation();
  }, { signal });
  stampAsset.addEventListener("change", () => { if (brushSelect.value === "stamp") queueEvaluation(); }, { signal });
  for (const [input, output, decimals] of [
    [stampSize, stampSizeOutput, 2],
    [stampSpacing, stampSpacingOutput, 2],
  ] as const) input.addEventListener("input", () => {
    output.value = Number(input.value).toFixed(decimals);
    if (brushSelect.value === "stamp") queueEvaluation();
  }, { signal });
  window.addEventListener("crayon-graph-change", (event) => {
    const nextDump = (event as CustomEvent<{ dump?: Dump }>).detail?.dump;
    if (!nextDump) return;
    crayonGraphReceived = true;
    dumps.crayon = nextDump;
    installedWorkerDump = null;
    installedWorkerId = "";
    setStatus("Chrome Crayon node graph updated · re-evaluating the canvas");
    queueEvaluation();
  }, { signal });
  // The canvas is a grid column of the studio shell, not the whole window.
  const stopObservingCanvas = observeCanvasBox(canvas, (width, height) => {
    sizeCameras(width, height);
    renderer.setSize(width, height, false);
    selectionGuideMaterial.resolution.set(width, height);
    selectionGuidesDirty = true;
  });
  signal.addEventListener("abort", stopObservingCanvas);
  renderer.setAnimationLoop(() => {
    controls.update();
    if (selectionGuidesDirty) updateSurfaceSelectionGuides();
    renderer.render(scene, camera);
  });

  syncSelectorUI();
  setMode("draw"); applyCrayonPreset(); demoSurface();
  loadBrushAssets()
    .then((assets) => {
      if (disposed) return;
      dumps.periodic = assets.periodic;
      if (!crayonGraphReceived) dumps.crayon = assets.crayon;
      authoredTemplate = assets.authored;
    })
    .catch((error) => setStatus(String(error)));

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      abort.abort();
      window.clearTimeout(updateTimer);
      requestId++; // invalidate any in-flight evaluation result
      activeWorker?.terminate(); activeWorker = null;
      if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
      renderer.setAnimationLoop(null);
      controls.removeEventListener("change", invalidateSelectionGuides);
      controls.dispose();
      removeDrawingArea();
      areaTransform.dispose();
      scene.remove(areaTransformHelper, areaAnchor, selectionGuideRoot);
      clearObject(targetRoot); clearObject(brushRoot); clearObject(previewRoot); clearObject(handleRoot); clearObject(selectorOverlayRoot);
      selectionGuideGeometry.dispose();
      envTexture.dispose();
      for (const material of [targetMaterial, inactiveTargetMaterial, flatTargetMaterial, brushMaterial, chromeMaterial, sigilMaterial, previewMaterial, selectedPreviewMaterial, areaGlowMaterial, areaFillMaterial, areaMaterial, sourceAreaMaterial, projectionRayMaterial, selectionGuideMaterial, handleMaterial, selectedHandleMaterial]) material.dispose();
      renderer.dispose();
      releaseToolContext(renderer);
      canvas.style.cursor = "";
      delete (window as typeof window & { __SURFACE_DRAW__?: unknown }).__SURFACE_DRAW__;
    },
  };
}
