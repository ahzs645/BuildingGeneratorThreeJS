import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Dump, TriSoup } from "../gnvm";
import type { BlendStudioSeed, BlendStudioTarget } from "./model";

export type BlendStudioRuntimeState = "idle" | "queued" | "evaluating" | "ready" | "error";

export type BlendStudioRuntimeSnapshot = {
  state: BlendStudioRuntimeState;
  message: string;
  lastValid: boolean;
  stats?: TriSoup["stats"];
  runtimeSeconds?: number;
  missingTypes?: { type: string; count: number }[];
  lineStats?: NonNullable<TriSoup["lines"]>["stats"];
};

export type BlendStudioEvaluation = {
  dump: Dump;
  target: BlendStudioTarget;
  overrides: Record<string, number | boolean>;
  seed?: BlendStudioSeed;
  geometryInput?: string;
  output?: string;
};

export type BlendStudioRuntimeController = {
  queue: (request: BlendStudioEvaluation) => void;
  evaluate: (request: BlendStudioEvaluation) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
};

type WorkerReply =
  | {
      id: number;
      ok: true;
      soup: TriSoup;
      coverage: { handled: number; missingTypes: { type: string; count: number }[] };
    }
  | { id: number; ok: false; error: string };

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

export function mountBlendStudioRuntime({
  canvas,
  onState,
}: MountOptions): BlendStudioRuntimeController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, .001, 100_000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, .04).texture;
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
  let worker: Worker | null = null;
  let runId = 0;
  let timeout = 0;
  let queueTimer = 0;
  let disposed = false;
  let lastValid = false;

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

  const disposeCurrent = (): void => {
    if (currentRoot) {
      scene.remove(currentRoot);
      currentRoot.traverse((object) => {
        const renderable = object as THREE.Mesh | THREE.LineSegments;
        renderable.geometry?.dispose();
        const materials = renderable.material
          ? Array.isArray(renderable.material) ? renderable.material : [renderable.material]
          : [];
        materials.forEach((material) => material.dispose());
      });
      currentRoot = null;
    }
    if (currentGrid) {
      scene.remove(currentGrid);
      currentGrid.geometry.dispose();
      (currentGrid.material as THREE.Material).dispose();
      currentGrid = null;
    }
  };

  const showSoup = (dump: Dump, soup: TriSoup): void => {
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
        materials.push(materialFor(dump, group.material));
      }
      if (!materials.length) materials.push(materialFor(dump, null));
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
    scene.add(currentRoot);
    currentRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(currentRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    currentRoot.position.sub(center);
    currentRoot.updateMatrixWorld(true);
    const radius = Math.max(size.length() * .5, .01);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * .5));
    camera.position.set(distance * .72, distance * .48, distance * .92);
    camera.near = Math.max(radius / 1_000, .0001);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    const gridSize = Math.max(size.x, size.z, radius) * 4;
    currentGrid = new THREE.GridHelper(gridSize, 30, 0x3a424d, 0x1d2229);
    (currentGrid.material as THREE.Material).transparent = true;
    (currentGrid.material as THREE.Material).opacity = .42;
    scene.add(currentGrid);
  };

  const cancel = (): void => {
    window.clearTimeout(queueTimer);
    window.clearTimeout(timeout);
    worker?.terminate();
    worker = null;
  };

  const evaluate = (request: BlendStudioEvaluation): Promise<void> => {
    cancel();
    if (disposed) return Promise.resolve();
    const id = ++runId;
    const started = performance.now();
    onState({
      state: "evaluating",
      message: `Evaluating ${request.target.label}…`,
      lastValid,
    });
    return new Promise((resolve, reject) => {
      worker = new Worker(new URL("../blend-import-worker.ts", import.meta.url), {
        type: "module",
        name: "blend-studio-gnvm",
      });
      timeout = window.setTimeout(() => {
        worker?.terminate();
        worker = null;
        const error = new Error("Evaluation stopped after the 180 second safety limit");
        onState({
          state: "error",
          message: `${error.message}${lastValid ? " · previous valid geometry retained" : ""}`,
          lastValid,
        });
        reject(error);
      }, 180_000);
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.id !== id) return;
        window.clearTimeout(timeout);
        worker?.terminate();
        worker = null;
        if (!event.data.ok) {
          const message = event.data.error.split("\n")[0];
          onState({
            state: "error",
            message: `${message}${lastValid ? " · previous valid geometry retained" : ""}`,
            lastValid,
          });
          reject(new Error(event.data.error));
          return;
        }
        showSoup(request.dump, event.data.soup);
        lastValid = true;
        const missing = event.data.coverage.missingTypes;
        onState({
          state: "ready",
          message: missing.length
            ? `Ready with ${missing.length} runtime fallback ${missing.length === 1 ? "type" : "types"}`
            : "Ready · all executed nodes handled",
          lastValid,
          stats: event.data.soup.stats,
          lineStats: event.data.soup.lines?.stats,
          runtimeSeconds: (performance.now() - started) / 1_000,
          missingTypes: missing,
        });
        resolve();
      };
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        worker?.terminate();
        worker = null;
        const message = event.message || "Evaluation worker failed";
        onState({
          state: "error",
          message: `${message}${lastValid ? " · previous valid geometry retained" : ""}`,
          lastValid,
        });
        reject(new Error(message));
      };
      worker.postMessage({
        id,
        dump: request.dump,
        object: request.target.kind === "object" ? request.target.objectName : undefined,
        group: request.target.groupName,
        targetKind: request.target.kind,
        overrides: request.overrides,
        seed: request.seed,
        geometryInput: request.geometryInput,
        output: request.output,
      });
    });
  };

  const queue = (request: BlendStudioEvaluation): void => {
    window.clearTimeout(queueTimer);
    onState({
      state: "queued",
      message: `Queued ${request.target.label}…`,
      lastValid,
    });
    queueTimer = window.setTimeout(() => {
      void evaluate(request).catch(() => {
        // The state callback already reports the actionable failure.
      });
    }, 250);
  };

  return {
    queue,
    evaluate,
    cancel,
    dispose() {
      disposed = true;
      cancel();
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      disposeCurrent();
      controls.dispose();
      renderer.dispose();
    },
  };
}
