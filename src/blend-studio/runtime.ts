import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitDistanceForRadius } from "../camera-fit";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { Dump, RunDetail, TriSoup } from "../gnvm";
import {
  summarizeBlendStudioRuntimeDetails,
  type BlendStudioSeed,
  type BlendStudioTarget,
} from "./model";
import {
  authoredValueFromMeasurementDistance,
  type BlendStudioLinearMeasurementContract,
} from "./measurement";
import type { BlendStudioGizmoContract } from "./gizmos";
import { preferredCanvasPixelRatio } from "../canvas-viewport";

export type BlendStudioRuntimeState = "idle" | "queued" | "evaluating" | "ready" | "error";

export type BlendStudioRuntimeSnapshot = {
  state: BlendStudioRuntimeState;
  message: string;
  lastValid: boolean;
  /** The displayed result is a low-resolution progressive preview. */
  preview?: boolean;
  stats?: TriSoup["stats"];
  runtimeSeconds?: number;
  missingTypes?: { type: string; count: number }[];
  approximateTypes?: { type: string; count: number }[];
  details?: RunDetail[];
  lineStats?: NonNullable<TriSoup["lines"]>["stats"];
  pointStats?: NonNullable<TriSoup["points"]>["stats"];
};

export type BlendStudioProgressivePreview = {
  /** Interface identifier of the resolution-class input to lower for phase 1. */
  identifier: string;
  /** Display name of that input, used in the preview status message. */
  name: string;
  /** Cheap phase-1 value; phase 2 re-evaluates with the caller's overrides. */
  previewValue: number;
};

export type BlendStudioEvaluation = {
  dump: Dump;
  target: BlendStudioTarget;
  overrides: Record<string, unknown>;
  frame?: number;
  seed?: BlendStudioSeed;
  geometryInput?: string;
  output?: string;
  volumeSampleBudget?: number;
  /**
   * Two-phase evaluation: run once with the resolution-class input lowered to
   * previewValue (shown as a marked low-res preview), then—after the user has
   * stayed idle—re-run at full quality and replace the result silently.
   * Callers that omit this get exactly the single-phase behavior.
   */
  progressive?: BlendStudioProgressivePreview;
};

export type BlendStudioRuntimeController = {
  queue: (request: BlendStudioEvaluation) => void;
  evaluate: (request: BlendStudioEvaluation) => Promise<void>;
  cancel: () => void;
  configureMeasurement: (configuration: BlendStudioMeasurementConfiguration | null) => void;
  configureGizmos: (configuration: BlendStudioGizmoConfiguration | null) => void;
  loadMeasurementSubject: (
    file: File,
    millimetersPerUnit: number,
  ) => Promise<BlendStudioMeasurementSubjectSnapshot>;
  clearMeasurementSubject: () => void;
  dispose: () => void;
};

export const BLEND_STUDIO_EVALUATION_TIMEOUT_MS = 180_000;
/** Idle time after a low-res preview before the full-quality refinement runs. */
export const BLEND_STUDIO_REFINEMENT_IDLE_MS = 500;

function formatPreviewValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * "graph" measures the node canvas itself: picks arrive from the node editor
 * rather than the viewport, so the runtime keeps the jaw handle visible but
 * inert (neither the jaw-drag nor the point-pick pointer paths match).
 */
export type BlendStudioMeasurementMode = "jaw" | "points" | "graph";

export type BlendStudioPointMeasurementSnapshot = {
  points: Array<[number, number, number]>;
  distanceMm?: number;
  missed?: boolean;
};

export type BlendStudioMeasurementConfiguration = {
  contract: BlendStudioLinearMeasurementContract;
  authoredValue: number;
  mode: BlendStudioMeasurementMode;
  onAuthoredValue: (value: number) => void;
  onPointMeasurement: (snapshot: BlendStudioPointMeasurementSnapshot) => void;
};

export type BlendStudioGizmoConfiguration = {
  contracts: BlendStudioGizmoContract[];
  values: Record<string, unknown>;
  onValue: (contract: BlendStudioGizmoContract, value: number) => void;
};

export type BlendStudioMeasurementSubjectSnapshot = {
  name: string;
  dimensionsMm: [number, number, number];
  triangles: number;
  millimetersPerUnit: number;
};

export class BlendStudioEvaluationCancelledError extends Error {
  constructor() {
    super("Evaluation cancelled");
    this.name = "BlendStudioEvaluationCancelledError";
  }
}

type WorkerReply =
  | {
      id: number;
      ok: true;
      soup: TriSoup;
      coverage: {
        handled: number;
        missingTypes: { type: string; count: number }[];
        approximateTypes: { type: string; count: number }[];
      };
      details: RunDetail[];
    }
  | { id: number; ok: false; error: string; unknownInstall?: boolean }
  | { id?: undefined; ok: true; installed: string };

type MountOptions = {
  canvas: HTMLCanvasElement;
  onState: (snapshot: BlendStudioRuntimeSnapshot) => void;
};

function inputValue(
  node: Dump["node_groups"][string]["nodes"][number] | undefined,
  identifier: string,
  fallback: unknown,
): unknown {
  return node?.inputs?.find((socket) =>
    socket.identifier === identifier || socket.name === identifier)?.value ?? fallback;
}

function color(value: unknown, fallback: [number, number, number]): THREE.Color {
  const components = Array.isArray(value) ? value : fallback;
  return new THREE.Color().setRGB(
    Number(components[0] ?? fallback[0]),
    Number(components[1] ?? fallback[1]),
    Number(components[2] ?? fallback[2]),
  );
}

function materialFor(dump: Dump, name: string | null): THREE.Material {
  const tree = name && dump.materials ? dump.materials[name] : undefined;
  const principled = tree?.nodes?.find((node) => node.type === "ShaderNodeBsdfPrincipled");
  const emission = tree?.nodes?.find((node) => node.type === "ShaderNodeEmission");
  if (emission) {
    const emissive = color(inputValue(emission, "Color", [1, 1, 1, 1]), [1, 1, 1]);
    return new THREE.MeshStandardMaterial({
      color: emissive,
      emissive,
      emissiveIntensity: Number(inputValue(emission, "Strength", 1)),
      roughness: 1,
      side: THREE.DoubleSide,
    });
  }
  const alpha = Number(inputValue(principled, "Alpha", 1));
  return new THREE.MeshStandardMaterial({
    color: color(inputValue(principled, "Base Color", [.58, .66, .73, 1]), [.58, .66, .73]),
    metalness: Number(inputValue(principled, "Metallic", .08)),
    roughness: Number(inputValue(principled, "Roughness", .42)),
    emissive: color(inputValue(principled, "Emission Color", [0, 0, 0, 1]), [0, 0, 0]),
    emissiveIntensity: Number(inputValue(principled, "Emission Strength", 1)),
    opacity: alpha,
    transparent: alpha < 1,
    side: THREE.DoubleSide,
  });
}

function disposeObject(root: THREE.Object3D, keepMaterials?: ReadonlySet<THREE.Material>): void {
  root.traverse((object) => {
    const renderable = object as THREE.Mesh | THREE.Line | THREE.Points;
    renderable.geometry?.dispose();
    const materials = renderable.material
      ? Array.isArray(renderable.material) ? renderable.material : [renderable.material]
      : [];
    materials.forEach((material) => {
      if (!keepMaterials?.has(material)) material.dispose();
    });
  });
}

function measurementSubjectMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0x78d8ff,
    emissive: 0x061d28,
    metalness: .06,
    roughness: .32,
    transparent: true,
    opacity: .58,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

async function measurementSubjectFromFile(file: File): Promise<THREE.Object3D> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "glb") {
    return (await new GLTFLoader().parseAsync(await file.arrayBuffer(), "")).scene;
  }
  if (extension === "obj") return new OBJLoader().parse(await file.text());
  if (extension === "stl") {
    return new THREE.Mesh(
      new STLLoader().parse(await file.arrayBuffer()),
      measurementSubjectMaterial(),
    );
  }
  throw new Error("Choose a GLB, OBJ, or STL workpiece");
}

export function mountBlendStudioRuntime({
  canvas,
  onState,
}: MountOptions): BlendStudioRuntimeController {
  const captureMode = new URLSearchParams(window.location.search).get("capture") === "font-parity";
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: captureMode,
  });
  renderer.setPixelRatio(preferredCanvasPixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  if (captureMode) renderer.setClearColor(0xff00ff, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, .001, 100_000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environmentTexture = pmrem.fromScene(room, .04).texture;
  scene.environment = environmentTexture;
  scene.environmentIntensity = .75;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x171b25, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 7, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x80a8ff, 1.25);
  rim.position.set(-5, 3, -4);
  scene.add(rim);

  let currentRoot: THREE.Group | null = null;
  let currentGrid: THREE.GridHelper | null = null;
  const referenceRoot = new THREE.Group();
  referenceRoot.rotation.x = -Math.PI / 2;
  scene.add(referenceRoot);
  const measurementOverlay = new THREE.Group();
  scene.add(measurementOverlay);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let measurementConfiguration: BlendStudioMeasurementConfiguration | null = null;
  let gizmoConfiguration: BlendStudioGizmoConfiguration | null = null;
  let gizmoRoot: THREE.Group | null = null;
  let gizmoHandles: Array<{
    contract: BlendStudioGizmoContract;
    hit: THREE.Object3D;
    group: THREE.Group;
    basePosition: THREE.Vector3;
    axisLocal: THREE.Vector3;
  }> = [];
  let measurementHandle: THREE.Mesh | null = null;
  let measurementArrow: THREE.ArrowHelper | null = null;
  let measurementRadius = 1;
  let measurementSubjectObject: THREE.Object3D | null = null;
  let measurementSubjectBasePosition = new THREE.Vector3();
  let assemblyCenter: THREE.Vector3 | null = null;
  let currentTargetId = "";
  let pointMeasurements: THREE.Vector3[] = [];
  let lastPointPickAt = 0;
  let draggedMeasurement: {
    pointerId: number;
    startValue: number;
    startPoint: THREE.Vector3;
    axisWorld: THREE.Vector3;
    plane: THREE.Plane;
  } | null = null;
  let draggedGizmo: {
    pointerId: number;
    contract: BlendStudioGizmoContract;
    handle: (typeof gizmoHandles)[number];
    startValue: number;
    startPoint: THREE.Vector3;
    axisWorld: THREE.Vector3;
    plane: THREE.Plane;
    dialVector?: THREE.Vector3;
  } | null = null;
  let worker: Worker | null = null;
  let runId = 0;
  let timeout = 0;
  let queueTimer = 0;
  let disposed = false;
  let lastValid = false;
  type ActiveEvaluation = {
    id: number;
    request: BlendStudioEvaluation;
    // "preview" runs the request with its progressive low-res override applied;
    // the same run object is then re-armed as "full" for the refinement pass.
    phase: "preview" | "full";
    started: number;
    posted: boolean;
    retriedInstall: boolean;
    resolve: () => void;
    reject: (reason?: unknown) => void;
  };
  let activeEvaluation: ActiveEvaluation | null = null;
  // Pending phase-2 (full quality) dispatch after a low-res preview landed.
  let refineTimer = 0;
  // The run currently executing inside the persistent worker; superseded runs
  // stay in flight (their replies are dropped by id) so the warm worker and
  // its JIT state survive slider drags.
  let postedRunId: number | null = null;
  // True while queue()'s debounce timer is pending, i.e. a newer evaluation
  // request is about to supersede the active one.
  let queuedEvaluationPending = false;
  // Dump installed in the persistent worker, tracked by object identity.
  let installedDump: Dump | null = null;
  let installedId = "";
  let installCounter = 0;
  // Materials built per dump, keyed by material name; reused across results.
  const materialCache = new Map<string | null, THREE.Material>();
  let materialCacheDump: Dump | null = null;
  let lastGridBox: { size: THREE.Vector3; minY: number } | null = null;

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  const clearMeasurementOverlay = (): void => {
    for (const child of [...measurementOverlay.children]) {
      measurementOverlay.remove(child);
      disposeObject(child);
    }
    pointMeasurements = [];
  };

  const clearMeasurementHandle = (): void => {
    if (measurementHandle?.parent) measurementHandle.parent.remove(measurementHandle);
    if (measurementHandle) disposeObject(measurementHandle);
    if (measurementArrow?.parent) measurementArrow.parent.remove(measurementArrow);
    if (measurementArrow) disposeObject(measurementArrow);
    measurementHandle = null;
    measurementArrow = null;
  };

  const clearGizmoHandles = (): void => {
    if (gizmoRoot?.parent) gizmoRoot.parent.remove(gizmoRoot);
    if (gizmoRoot) disposeObject(gizmoRoot);
    gizmoRoot = null;
    gizmoHandles = [];
  };

  const configuredGizmoValue = (contract: BlendStudioGizmoContract): number => {
    const raw = gizmoConfiguration?.values[contract.rootInputIdentifier] ?? contract.rootValue;
    const value = contract.component === undefined
      ? Number(raw)
      : Number(Array.isArray(raw) ? raw[contract.component] : contract.value);
    return Number.isFinite(value) ? value : contract.value;
  };

  const gizmoColor = (contract: BlendStudioGizmoContract): number => {
    let hash = 0;
    for (const character of `${contract.colorId}:${contract.id}`)
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    const colors = [0x65d9ff, 0xffbd66, 0xd78cff, 0x72e6a8, 0xff7996];
    return colors[Math.abs(hash) % colors.length];
  };

  const rebuildGizmoHandles = (): void => {
    clearGizmoHandles();
    if (!currentRoot || !gizmoConfiguration?.contracts.length) return;
    currentRoot.updateMatrixWorld(true);
    const geometryBox = new THREE.Box3().setFromObject(currentRoot);
    const worldCenter = geometryBox.isEmpty()
      ? currentRoot.getWorldPosition(new THREE.Vector3())
      : geometryBox.getCenter(new THREE.Vector3());
    const localCenter = currentRoot.worldToLocal(worldCenter.clone());
    const visualRadius = Math.max(measurementRadius, .01);
    const collisionCounts = new Map<string, number>();
    gizmoRoot = new THREE.Group();
    gizmoRoot.name = "__BLEND_STUDIO_GIZMOS";
    currentRoot.add(gizmoRoot);

    for (const contract of gizmoConfiguration.contracts) {
      const axis = new THREE.Vector3(...contract.direction);
      if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
      axis.normalize();
      const authoredPosition = new THREE.Vector3(...contract.position);
      const base = authoredPosition.lengthSq() > 1e-14 ? authoredPosition : localCenter.clone();
      const collisionKey = base.toArray().map((value) => value.toFixed(5)).join(",");
      const collisionIndex = collisionCounts.get(collisionKey) ?? 0;
      collisionCounts.set(collisionKey, collisionIndex + 1);
      if (collisionIndex) {
        const tangent = Math.abs(axis.y) < .9
          ? axis.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()
          : axis.clone().cross(new THREE.Vector3(1, 0, 0)).normalize();
        base.addScaledVector(tangent, visualRadius * .055 * collisionIndex);
      }

      const group = new THREE.Group();
      group.position.copy(base);
      const colorValue = gizmoColor(contract);
      let hit: THREE.Object3D;
      if (contract.kind === "linear") {
        const length = Math.max(visualRadius * .18, .02);
        const arrow = new THREE.ArrowHelper(
          axis,
          new THREE.Vector3(),
          length,
          colorValue,
          length * .28,
          length * .18,
        );
        arrow.renderOrder = 70;
        group.add(arrow);
        const handle = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(visualRadius * .022, .004), 18, 12),
          new THREE.MeshBasicMaterial({ color: colorValue, depthTest: false }),
        );
        handle.position.copy(axis).multiplyScalar(length);
        hit = handle;
        group.add(handle);
      } else {
        const radius = Math.max(visualRadius * .085, .012);
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius, Math.max(radius * .12, .002), 12, 48),
          new THREE.MeshBasicMaterial({ color: colorValue, depthTest: false }),
        );
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
        hit = ring;
        group.add(ring);
      }
      hit.renderOrder = 71;
      hit.userData.gizmoContractId = contract.id;
      group.userData.gizmoLabel = `${contract.rootInputName} · ${contract.kind}`;
      gizmoRoot.add(group);
      gizmoHandles.push({
        contract,
        hit,
        group,
        basePosition: base.clone(),
        axisLocal: axis,
      });
    }
  };

  const measurementLocalPosition = (
    configuration: BlendStudioMeasurementConfiguration,
    authoredValue = configuration.authoredValue,
  ): THREE.Vector3 => new THREE.Vector3(
    ...configuration.contract.positionAxis,
  ).multiplyScalar(authoredValue * configuration.contract.positionScale);

  const updateMeasurementHandle = (authoredValue: number): void => {
    if (!measurementConfiguration || !measurementHandle || !measurementArrow) return;
    const position = measurementLocalPosition(measurementConfiguration, authoredValue);
    measurementHandle.position.copy(position);
    measurementArrow.position.copy(position);
  };

  const rebuildMeasurementHandle = (): void => {
    clearMeasurementHandle();
    if (!currentRoot || !measurementConfiguration) return;
    const handleGeometry = new THREE.SphereGeometry(
      Math.max(measurementRadius / 35, .75),
      24,
      16,
    );
    const handleMaterial = new THREE.MeshBasicMaterial({
      color: 0x7de2c2,
      depthTest: false,
    });
    measurementHandle = new THREE.Mesh(handleGeometry, handleMaterial);
    measurementHandle.name = "__BLEND_STUDIO_MEASUREMENT_HANDLE";
    measurementHandle.userData.measurementHandle = true;
    measurementHandle.renderOrder = 50;
    const direction = new THREE.Vector3(
      ...measurementConfiguration.contract.direction,
    ).normalize();
    measurementArrow = new THREE.ArrowHelper(
      direction,
      new THREE.Vector3(),
      Math.max(measurementRadius / 7, 4),
      0x7de2c2,
      Math.max(measurementRadius / 35, 1),
      Math.max(measurementRadius / 50, .7),
    );
    measurementArrow.renderOrder = 49;
    currentRoot.add(measurementArrow, measurementHandle);
    updateMeasurementHandle(measurementConfiguration.authoredValue);
  };

  const pointerRay = (event: MouseEvent): THREE.Raycaster => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster;
  };

  const renderPointMeasurement = (): void => {
    const points = pointMeasurements.map((point) => point.clone());
    clearMeasurementOverlay();
    pointMeasurements = points;
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      depthTest: false,
    });
    for (const point of points) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(measurementRadius / 90, .15), 18, 12),
        markerMaterial.clone(),
      );
      marker.position.copy(point);
      marker.renderOrder = 60;
      measurementOverlay.add(marker);
    }
    if (points.length === 2) {
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(
        lineGeometry,
        new THREE.LineBasicMaterial({
          color: 0xffd166,
          depthTest: false,
          transparent: true,
          opacity: .95,
        }),
      );
      line.renderOrder = 59;
      measurementOverlay.add(line);
    }
  };

  const pickMeasurementPoint = (event: MouseEvent): boolean => {
    if (!measurementConfiguration || !currentRoot) return false;
    const subjects = referenceRoot.children.length
      ? [referenceRoot, currentRoot]
      : [currentRoot];
    const intersections = pointerRay(event).intersectObjects(subjects, true);
    const hit = intersections.find((candidate) =>
      !(candidate.object.userData.measurementHandle));
    if (!hit) {
      measurementConfiguration.onPointMeasurement({
        points: pointMeasurements.map((point) =>
          point.toArray() as [number, number, number]),
        missed: true,
      });
      return false;
    }
    lastPointPickAt = performance.now();
    if (pointMeasurements.length === 2) pointMeasurements = [];
    pointMeasurements.push(hit.point.clone());
    renderPointMeasurement();
    const serialized = pointMeasurements.map((point) =>
      point.toArray() as [number, number, number]);
    if (pointMeasurements.length === 2) {
      const distance = pointMeasurements[0].distanceTo(pointMeasurements[1]);
      measurementConfiguration.onPointMeasurement({
        points: serialized,
        distanceMm: distance,
      });
      measurementConfiguration.onAuthoredValue(
        authoredValueFromMeasurementDistance(
          measurementConfiguration.contract,
          distance,
        ),
      );
    } else {
      measurementConfiguration.onPointMeasurement({ points: serialized });
    }
    return true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!currentRoot) return;
    const ray = pointerRay(event);
    if (measurementConfiguration?.mode === "jaw" && measurementHandle) {
      const hit = ray.intersectObject(measurementHandle, false)[0];
      if (!hit) return;
      currentRoot.updateMatrixWorld(true);
      const axisWorld = new THREE.Vector3(
        ...measurementConfiguration.contract.positionAxis,
      ).transformDirection(currentRoot.matrixWorld).normalize();
      const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
      const planeNormal = cameraDirection
        .clone()
        .addScaledVector(axisWorld, -cameraDirection.dot(axisWorld));
      if (planeNormal.lengthSq() < 1e-8)
        planeNormal.copy(camera.up).addScaledVector(axisWorld, -camera.up.dot(axisWorld));
      planeNormal.normalize();
      const handleWorld = measurementHandle.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        planeNormal,
        handleWorld,
      );
      const startPoint = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!startPoint) return;
      draggedMeasurement = {
        pointerId: event.pointerId,
        startValue: measurementConfiguration.authoredValue,
        startPoint,
        axisWorld,
        plane,
      };
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const gizmoHits = ray.intersectObjects(gizmoHandles.map((entry) => entry.hit), false);
    const gizmoHandle = gizmoHits.length
      ? gizmoHandles.find((entry) => entry.hit === gizmoHits[0].object)
      : undefined;
    if (gizmoHandle && gizmoConfiguration) {
      currentRoot.updateMatrixWorld(true);
      const axisWorld = gizmoHandle.axisLocal
        .clone()
        .transformDirection(currentRoot.matrixWorld)
        .normalize();
      const handleWorld = gizmoHandle.group.getWorldPosition(new THREE.Vector3());
      const startValue = configuredGizmoValue(gizmoHandle.contract);
      let planeNormal: THREE.Vector3;
      if (gizmoHandle.contract.kind === "dial" && !gizmoHandle.contract.screenSpace) {
        planeNormal = axisWorld.clone();
      } else {
        const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
        planeNormal = cameraDirection
          .clone()
          .addScaledVector(axisWorld, -cameraDirection.dot(axisWorld));
        if (planeNormal.lengthSq() < 1e-8)
          planeNormal.copy(camera.up).addScaledVector(axisWorld, -camera.up.dot(axisWorld));
        planeNormal.normalize();
      }
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, handleWorld);
      const startPoint = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!startPoint) return;
      const dialVector = gizmoHandle.contract.kind === "dial"
        ? startPoint.clone().sub(handleWorld).normalize()
        : undefined;
      draggedGizmo = {
        pointerId: event.pointerId,
        contract: gizmoHandle.contract,
        handle: gizmoHandle,
        startValue,
        startPoint,
        axisWorld,
        plane,
        ...(dialVector ? { dialVector } : {}),
      };
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
      event.preventDefault();
      return;
    }
    if (measurementConfiguration?.mode === "points" && pickMeasurementPoint(event))
      event.preventDefault();
  };

  const onClick = (event: MouseEvent): void => {
    if (
      measurementConfiguration?.mode !== "points"
      || performance.now() - lastPointPickAt < 100
    ) return;
    if (pickMeasurementPoint(event)) event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (
      draggedGizmo
      && draggedGizmo.pointerId === event.pointerId
      && gizmoConfiguration
    ) {
      const point = pointerRay(event).ray.intersectPlane(
        draggedGizmo.plane,
        new THREE.Vector3(),
      );
      if (!point) return;
      let next = draggedGizmo.startValue;
      if (draggedGizmo.contract.kind === "linear") {
        next += point.clone()
          .sub(draggedGizmo.startPoint)
          .dot(draggedGizmo.axisWorld);
      } else {
        const center = draggedGizmo.handle.group.getWorldPosition(new THREE.Vector3());
        const vector = point.sub(center).normalize();
        const start = draggedGizmo.dialVector;
        if (start && vector.lengthSq() > 1e-12) {
          next += Math.atan2(
            draggedGizmo.axisWorld.dot(start.clone().cross(vector)),
            THREE.MathUtils.clamp(start.dot(vector), -1, 1),
          );
        }
      }
      next = THREE.MathUtils.clamp(
        next,
        Math.min(draggedGizmo.contract.min, draggedGizmo.contract.max),
        Math.max(draggedGizmo.contract.min, draggedGizmo.contract.max),
      );
      gizmoConfiguration.onValue(draggedGizmo.contract, next);
      event.preventDefault();
      return;
    }
    if (
      !draggedMeasurement
      || draggedMeasurement.pointerId !== event.pointerId
      || !measurementConfiguration
    ) return;
    const point = pointerRay(event).ray.intersectPlane(
      draggedMeasurement.plane,
      new THREE.Vector3(),
    );
    if (!point) return;
    const delta = point
      .sub(draggedMeasurement.startPoint)
      .dot(draggedMeasurement.axisWorld)
      / (Math.abs(measurementConfiguration.contract.positionScale) < 1e-9
        ? 1
        : measurementConfiguration.contract.positionScale);
    const authored = THREE.MathUtils.clamp(
      draggedMeasurement.startValue + delta,
      Math.min(
        measurementConfiguration.contract.authoredMin,
        measurementConfiguration.contract.authoredMax,
      ),
      Math.max(
        measurementConfiguration.contract.authoredMin,
        measurementConfiguration.contract.authoredMax,
      ),
    );
    updateMeasurementHandle(authored);
    measurementConfiguration.onAuthoredValue(authored);
    event.preventDefault();
  };

  const finishMeasurementDrag = (event: PointerEvent): void => {
    const measurementFinished =
      draggedMeasurement?.pointerId === event.pointerId;
    const gizmoFinished = draggedGizmo?.pointerId === event.pointerId;
    if (!measurementFinished && !gizmoFinished) return;
    if (measurementFinished) draggedMeasurement = null;
    if (gizmoFinished) draggedGizmo = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", finishMeasurementDrag);
  canvas.addEventListener("pointercancel", finishMeasurementDrag);

  const disposeMaterialCache = (): void => {
    for (const material of materialCache.values()) material.dispose();
    materialCache.clear();
    materialCacheDump = null;
  };

  const cachedMaterialFor = (dump: Dump, name: string | null): THREE.Material => {
    if (materialCacheDump !== dump) {
      disposeMaterialCache();
      materialCacheDump = dump;
    }
    let material = materialCache.get(name);
    if (!material) {
      material = materialFor(dump, name);
      materialCache.set(name, material);
    }
    return material;
  };

  const disposeCurrent = (): void => {
    // Gizmos are children of the evaluated root. Detach and dispose them
    // before disposing that root so a later rebuild cannot retain a stale
    // parent or traverse already-disposed GPU resources.
    clearGizmoHandles();
    if (currentRoot) {
      scene.remove(currentRoot);
      // Cached per-material-name materials outlive individual results; they
      // are disposed on dump change and in dispose() instead.
      disposeObject(currentRoot, new Set(materialCache.values()));
      currentRoot = null;
      measurementHandle = null;
      measurementArrow = null;
    }
  };

  const disposeGrid = (): void => {
    if (!currentGrid) return;
    scene.remove(currentGrid);
    currentGrid.geometry.dispose();
    (currentGrid.material as THREE.Material).dispose();
    currentGrid = null;
    lastGridBox = null;
  };

  const rebuildGrid = (box: THREE.Box3, size: THREE.Vector3, radius: number): void => {
    disposeGrid();
    if (captureMode) return;
    const gridSize = Math.max(size.x, size.z, radius) * 4;
    currentGrid = new THREE.GridHelper(gridSize, 30, 0x3a424d, 0x1d2229);
    (currentGrid.material as THREE.Material).transparent = true;
    (currentGrid.material as THREE.Material).opacity = .42;
    currentGrid.position.y = box.min.y;
    scene.add(currentGrid);
    lastGridBox = { size: size.clone(), minY: box.min.y };
  };

  const frameAssembly = (): void => {
    const box = new THREE.Box3();
    if (currentRoot) box.expandByObject(currentRoot);
    if (referenceRoot.children.length) box.expandByObject(referenceRoot);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * .5, .01);
    measurementRadius = radius;
    const distance = fitDistanceForRadius(camera, radius);
    camera.position.copy(center).add(new THREE.Vector3(
      distance * .72,
      distance * .48,
      distance * .92,
    ));
    camera.near = Math.max(radius / 1_000, .0001);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    if (captureMode) {
      document.documentElement.dataset.blendStudioCaptureCamera = JSON.stringify({
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        up: camera.up.toArray(),
        fov: camera.fov,
        aspect: camera.aspect,
        radius,
        size: size.toArray(),
      });
    }
    rebuildGrid(box, size, radius);
  };

  // Refresh the grid without touching the camera; rebuild only when the
  // assembly bounds changed materially (>20% along an axis or the floor
  // moved), so slider nudges keep both the orbit and the grid stable.
  const updateGridForCurrentBounds = (): void => {
    const box = new THREE.Box3();
    if (currentRoot) box.expandByObject(currentRoot);
    if (referenceRoot.children.length) box.expandByObject(referenceRoot);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * .5, .01);
    const previous = lastGridBox;
    const grewMaterially = !previous
      || (["x", "y", "z"] as const).some((axis) =>
        Math.abs(size[axis] - previous.size[axis]) > Math.max(previous.size[axis], 1e-6) * .2)
      || Math.abs(box.min.y - previous.minY) > radius * 1e-3;
    if (grewMaterially) rebuildGrid(box, size, radius);
  };

  const clearMeasurementSubject = (): void => {
    for (const child of [...referenceRoot.children]) {
      referenceRoot.remove(child);
      disposeObject(child);
    }
    measurementSubjectObject = null;
    measurementSubjectBasePosition.set(0, 0, 0);
    clearMeasurementOverlay();
    if (currentRoot) frameAssembly();
  };

  const showSoup = (dump: Dump, soup: TriSoup, targetId: string): void => {
    const targetChanged = currentTargetId !== targetId;
    const hadPreviousResult = currentRoot !== null;
    if (targetChanged) {
      currentTargetId = targetId;
      assemblyCenter = null;
      clearMeasurementSubject();
    }
    disposeCurrent();
    currentRoot = new THREE.Group();
    currentRoot.rotation.x = -Math.PI / 2;
    if (soup.positions.length || soup.indices.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
      for (const [name, attribute] of Object.entries(soup.attributes ?? {})) {
        geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
      }
      const materials: THREE.Material[] = [];
      for (const [index, group] of soup.groups.entries()) {
        geometry.addGroup(group.start, group.count, index);
        materials.push(cachedMaterialFor(dump, group.material));
      }
      if (!materials.length) materials.push(cachedMaterialFor(dump, null));
      currentRoot.add(new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials));
    }
    if (soup.lines?.positions.length) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(soup.lines.positions, 3));
      currentRoot.add(new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: 0x7de2c2, transparent: true, opacity: .94 }),
      ));
    }
    if (soup.points?.positions.length) {
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute("position", new THREE.BufferAttribute(soup.points.positions, 3));
      currentRoot.add(new THREE.Points(
        pointGeometry,
        new THREE.PointsMaterial({
          color: 0xf2bd67,
          size: .04,
          sizeAttenuation: true,
          transparent: true,
          opacity: .96,
        }),
      ));
    }
    scene.add(currentRoot);
    currentRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(currentRoot);
    const size = box.getSize(new THREE.Vector3());
    if (!assemblyCenter) assemblyCenter = box.getCenter(new THREE.Vector3());
    currentRoot.position.copy(assemblyCenter).multiplyScalar(-1);
    referenceRoot.position.copy(assemblyCenter).multiplyScalar(-1);
    currentRoot.updateMatrixWorld(true);
    const radius = Math.max(size.length() * .5, .01);
    measurementRadius = radius;
    currentRoot.traverse((object) => {
      const pointMaterial = (object as THREE.Points).material;
      if (pointMaterial instanceof THREE.PointsMaterial)
        pointMaterial.size = Math.max(radius / 80, .0005);
    });
    rebuildMeasurementHandle();
    rebuildGizmoHandles();
    // Full re-framing resets the user's orbit, so reserve it for the first
    // result of a target (or after the previous result was torn down). Capture
    // runs still frame every result so their dataset export stays intact.
    if (targetChanged || !hadPreviousResult || !lastValid || captureMode) frameAssembly();
    else updateGridForCurrentBounds();
  };

  // Tear down the persistent worker. Only the timeout path, fatal worker
  // errors, and dispose() reach this; ordinary cancellation and superseded
  // runs keep the warm worker (and its installed dump + JIT state) alive.
  const teardownWorker = (): void => {
    worker?.terminate();
    worker = null;
    postedRunId = null;
    installedDump = null;
    installedId = "";
  };

  const failActiveEvaluation = (error: Error): void => {
    const active = activeEvaluation;
    if (!active) return;
    activeEvaluation = null;
    window.clearTimeout(timeout);
    window.clearTimeout(refineTimer);
    onState({
      state: "error",
      message: `${error.message.split("\n")[0]}${lastValid ? " · previous valid geometry retained" : ""}`,
      lastValid,
      // A failed low-res pass measures the preview, not the target's cost.
      ...(active.phase === "preview" ? { preview: true } : {}),
    });
    active.reject(error);
  };

  // Post an evaluation to the persistent worker, installing the dump first
  // whenever its identity changed since the last install (or after respawn).
  const postEvaluation = (run: ActiveEvaluation): void => {
    const evaluationWorker = ensureWorker();
    if (installedDump !== run.request.dump) {
      installedDump = run.request.dump;
      installedId = `install-${++installCounter}`;
      evaluationWorker.postMessage({
        kind: "install",
        installId: installedId,
        dump: run.request.dump,
      });
    }
    run.posted = true;
    postedRunId = run.id;
    evaluationWorker.postMessage({
      kind: "evaluate",
      id: run.id,
      installId: installedId,
      object: run.request.target.kind === "object" ? run.request.target.objectName : undefined,
      group: run.request.target.groupName,
      modifierIndex: run.request.target.kind === "object"
        ? run.request.target.modifierIndex
        : undefined,
      targetKind: run.request.target.kind,
      overrides: run.phase === "preview" && run.request.progressive
        ? {
            ...run.request.overrides,
            [run.request.progressive.identifier]: run.request.progressive.previewValue,
          }
        : run.request.overrides,
      frame: run.request.frame,
      seed: run.request.seed,
      geometryInput: run.request.geometryInput,
      output: run.request.output,
      volumeSampleBudget: run.request.volumeSampleBudget,
    });
  };

  // The only path that kills the warm worker: a runaway evaluation. The
  // respawned worker starts empty, so the install tracking resets too.
  const armSafetyTimeout = (run: ActiveEvaluation): void => {
    const id = run.id;
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      if (activeEvaluation?.id !== id) return;
      teardownWorker();
      failActiveEvaluation(new Error("Evaluation stopped after the 180 second safety limit"));
    }, BLEND_STUDIO_EVALUATION_TIMEOUT_MS);
  };

  // Phase 1 of a progressive run landed: show the low-res result immediately,
  // then—once the user has stayed idle—re-arm the same run at full quality.
  // Its promise resolves with phase 2; a supersede in between rejects it and
  // skips the refinement entirely.
  const handlePreviewReply = (
    active: ActiveEvaluation,
    reply: Extract<WorkerReply, { soup: TriSoup }>,
  ): void => {
    window.clearTimeout(timeout);
    showSoup(active.request.dump, reply.soup, active.request.target.id);
    lastValid = true;
    const progressive = active.request.progressive!;
    onState({
      state: "ready",
      preview: true,
      message: `Low-res preview (${progressive.name} ${formatPreviewValue(progressive.previewValue)}) · refining…`,
      lastValid,
      stats: reply.soup.stats,
      lineStats: reply.soup.lines?.stats,
      pointStats: reply.soup.points?.stats,
      runtimeSeconds: (performance.now() - active.started) / 1_000,
      missingTypes: reply.coverage.missingTypes,
      approximateTypes: reply.coverage.approximateTypes,
      details: reply.details ?? [],
    });
    window.clearTimeout(refineTimer);
    refineTimer = window.setTimeout(() => {
      // A queued edit is about to supersede this run anyway; when it does,
      // cancel() rejects the run and no refinement is dispatched.
      if (activeEvaluation !== active || queuedEvaluationPending) return;
      active.phase = "full";
      active.id = ++runId;
      active.started = performance.now();
      active.posted = false;
      active.retriedInstall = false;
      armSafetyTimeout(active);
      // If a superseded stale run still occupies the worker, the stale-reply
      // handler dispatches this run as soon as the worker frees up.
      if (postedRunId === null) postEvaluation(active);
    }, BLEND_STUDIO_REFINEMENT_IDLE_MS);
  };

  const handleWorkerReply = (reply: WorkerReply): void => {
    if (reply.id === undefined) return; // install acknowledgement
    if (reply.id === postedRunId) postedRunId = null;
    const active = activeEvaluation;
    if (!active || reply.id !== active.id) {
      // Stale (superseded) run finished. If its install went missing the
      // current install bookkeeping is wrong too, so force a re-install.
      if (!reply.ok && reply.unknownInstall) {
        installedDump = null;
        installedId = "";
      }
      // The worker is free again; dispatch the latest run if it is waiting.
      // When the queue debounce is about to replace it anyway (the user is
      // still dragging), hold off so the worker is not burned on a run that
      // is already known to be obsolete.
      if (active && !active.posted && postedRunId === null && !queuedEvaluationPending)
        postEvaluation(active);
      return;
    }
    if (!reply.ok) {
      if (reply.unknownInstall && !active.retriedInstall) {
        // The worker was respawned since this dump was installed (timeout
        // path). Re-install once and retry the same run.
        active.retriedInstall = true;
        installedDump = null;
        installedId = "";
        postEvaluation(active);
        return;
      }
      failActiveEvaluation(new Error(reply.error));
      return;
    }
    if (active.phase === "preview" && active.request.progressive) {
      handlePreviewReply(active, reply);
      return;
    }
    activeEvaluation = null;
    window.clearTimeout(timeout);
    showSoup(active.request.dump, reply.soup, active.request.target.id);
    lastValid = true;
    const missing = reply.coverage.missingTypes;
    const approximations = reply.coverage.approximateTypes;
    const details = reply.details ?? [];
    const { warningCount } = summarizeBlendStudioRuntimeDetails(details);
    const coverageMessage = missing.length
      ? `Ready with ${missing.length} runtime fallback ${missing.length === 1 ? "type" : "types"}`
      : approximations.length
        ? `Ready with ${approximations.length} bounded approximation ${approximations.length === 1 ? "type" : "types"}`
        : "Ready · all executed nodes handled";
    onState({
      state: "ready",
      message: warningCount
        ? `${coverageMessage} · ${warningCount} runtime ${warningCount === 1 ? "warning" : "warnings"}`
        : coverageMessage,
      lastValid,
      stats: reply.soup.stats,
      lineStats: reply.soup.lines?.stats,
      pointStats: reply.soup.points?.stats,
      runtimeSeconds: (performance.now() - active.started) / 1_000,
      missingTypes: missing,
      approximateTypes: approximations,
      details,
    });
    active.resolve();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const evaluationWorker = new Worker(new URL("../blend-import-worker.ts", import.meta.url), {
      type: "module",
      name: "blend-studio-gnvm",
    });
    evaluationWorker.onmessage = (event: MessageEvent<WorkerReply>) =>
      handleWorkerReply(event.data);
    evaluationWorker.onerror = (event) => {
      // A worker-level error is unrecoverable for anything already queued in
      // it; respawn lazily on the next evaluation.
      teardownWorker();
      failActiveEvaluation(new Error(event.message || "Evaluation worker failed"));
    };
    worker = evaluationWorker;
    return evaluationWorker;
  };

  const cancel = (): void => {
    window.clearTimeout(queueTimer);
    queuedEvaluationPending = false;
    window.clearTimeout(timeout);
    // Superseding a progressive run between its phases skips the refinement.
    window.clearTimeout(refineTimer);
    const active = activeEvaluation;
    activeEvaluation = null;
    active?.reject(new BlendStudioEvaluationCancelledError());
  };

  const evaluate = (request: BlendStudioEvaluation): Promise<void> => {
    cancel();
    if (disposed) return Promise.resolve();
    const id = ++runId;
    onState({
      state: "evaluating",
      message: `Evaluating ${request.target.label}…`,
      lastValid,
    });
    return new Promise((resolve, reject) => {
      const run: ActiveEvaluation = {
        id,
        request,
        phase: request.progressive ? "preview" : "full",
        started: performance.now(),
        posted: false,
        retriedInstall: false,
        resolve,
        reject,
      };
      activeEvaluation = run;
      armSafetyTimeout(run);
      // If a superseded run is still executing, wait for its reply; the reply
      // handler dispatches this run as soon as the worker frees up.
      if (postedRunId === null) postEvaluation(run);
    });
  };

  const queue = (request: BlendStudioEvaluation): void => {
    window.clearTimeout(queueTimer);
    queuedEvaluationPending = true;
    onState({
      state: "queued",
      message: `Queued ${request.target.label}…`,
      lastValid,
    });
    queueTimer = window.setTimeout(() => {
      queuedEvaluationPending = false;
      void evaluate(request).catch(() => {
        // The state callback already reports the actionable failure.
      });
    }, 250);
  };

  return {
    queue,
    evaluate,
    cancel,
    configureMeasurement(configuration) {
      const previousMode = measurementConfiguration?.mode;
      const previousKey = measurementConfiguration
        ? `${measurementConfiguration.contract.groupName}:${measurementConfiguration.contract.gizmoNodeName}`
        : "";
      measurementConfiguration = configuration;
      if (!configuration) {
        clearMeasurementHandle();
        clearMeasurementOverlay();
        return;
      }
      const nextKey = `${configuration.contract.groupName}:${configuration.contract.gizmoNodeName}`;
      if (previousMode !== configuration.mode) clearMeasurementOverlay();
      if (!measurementHandle || previousKey !== nextKey) rebuildMeasurementHandle();
      else updateMeasurementHandle(configuration.authoredValue);
      if (measurementSubjectObject) {
        measurementSubjectObject.position.copy(measurementSubjectBasePosition);
        measurementSubjectObject.position.x += configuration.authoredValue / 2;
        referenceRoot.updateMatrixWorld(true);
      }
    },
    configureGizmos(configuration) {
      const previousIds = gizmoConfiguration?.contracts.map((contract) => contract.id).join("\0") ?? "";
      const nextIds = configuration?.contracts.map((contract) => contract.id).join("\0") ?? "";
      gizmoConfiguration = configuration;
      if (!configuration) {
        clearGizmoHandles();
        return;
      }
      if (!gizmoRoot || previousIds !== nextIds) rebuildGizmoHandles();
    },
    async loadMeasurementSubject(file, millimetersPerUnit) {
      if (!Number.isFinite(millimetersPerUnit) || millimetersPerUnit <= 0)
        throw new Error("Workpiece scale must be a positive number");
      const subject = await measurementSubjectFromFile(file);
      clearMeasurementSubject();
      subject.scale.multiplyScalar(millimetersPerUnit);
      subject.updateMatrixWorld(true);
      let triangles = 0;
      subject.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        triangles += mesh.geometry.index
          ? Math.floor(mesh.geometry.index.count / 3)
          : Math.floor((mesh.geometry.getAttribute("position")?.count ?? 0) / 3);
        const oldMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        oldMaterials.filter(Boolean).forEach((material) => material.dispose());
        mesh.material = measurementSubjectMaterial();
      });
      const box = new THREE.Box3().setFromObject(subject);
      const dimensions = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const authoredCenter = measurementConfiguration?.authoredValue
        ? measurementConfiguration.authoredValue / 2
        : 0;
      measurementSubjectBasePosition.set(
        -center.x,
        -center.y,
        -center.z,
      );
      subject.position.copy(measurementSubjectBasePosition);
      subject.position.x += authoredCenter;
      measurementSubjectObject = subject;
      referenceRoot.add(subject);
      referenceRoot.position.copy(assemblyCenter ?? new THREE.Vector3()).multiplyScalar(-1);
      referenceRoot.updateMatrixWorld(true);
      frameAssembly();
      return {
        name: file.name,
        dimensionsMm: dimensions.toArray() as [number, number, number],
        triangles,
        millimetersPerUnit,
      };
    },
    clearMeasurementSubject,
    dispose() {
      disposed = true;
      cancel();
      teardownWorker();
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", finishMeasurementDrag);
      canvas.removeEventListener("pointercancel", finishMeasurementDrag);
      canvas.style.cursor = "";
      disposeCurrent();
      disposeGrid();
      disposeMaterialCache();
      clearGizmoHandles();
      clearMeasurementSubject();
      scene.remove(referenceRoot, measurementOverlay);
      scene.environment = null;
      environmentTexture.dispose();
      controls.dispose();
      renderer.dispose();
      if (captureMode) delete document.documentElement.dataset.blendStudioCaptureCamera;
    },
  };
}
