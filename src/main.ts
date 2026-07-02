import {
  ACESFilmicToneMapping, BoxGeometry, Clock, Group, Mesh,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import GUI from "lil-gui";
import { defaultParams, type BuildingParams } from "./params";
import { generateBuilding } from "./generator";
import { Kit } from "./kit";
import { Environment, type Bounds } from "./environment";
import { CinematicCamera, type PresetName } from "./cinematicCamera";
import { PostFX } from "./postfx";

const app = document.getElementById("app")!;
const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new Scene();

const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(12, 7, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.54; // keep the camera above the ground plane
controls.minDistance = 3;
controls.maxDistance = 120;

// realistic lighting + sky + PBR environment
const env = new Environment(scene, renderer);

// ground
const ground = new Mesh(
  new PlaneGeometry(600, 600),
  new MeshStandardMaterial({ color: 0x2b2926, roughness: 0.96, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Blender is Z-up: build everything in Blender space inside a rotated root.
// rotation.z (Blender up axis) spins the whole building 180°; with the default XYZ
// Euler order it is applied before the -90° X tilt, so it reads as a world-Y turn.
const root = new Group();
root.rotation.set(-Math.PI / 2, 0, Math.PI);
scene.add(root);

const kit = new Kit();
const params: BuildingParams = defaultParams();
let building: Group | null = null;

const shellMat = new MeshStandardMaterial({ color: 0x8d8577, roughness: 0.9 });

function buildLowPolyShell(p: BuildingParams): Group {
  const g = new Group();
  const body = new Mesh(new BoxGeometry(p.length, p.width, p.floor), shellMat);
  body.position.set(0, 0, p.floor / 2);
  const roofSlab = new Mesh(new BoxGeometry(p.length + 0.4, p.width + 1.0, 0.4), shellMat);
  roofSlab.position.set(0, 0, p.floor + 0.15);
  for (const m of [body, roofSlab]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/** world-space bounds of the current building, for camera framing + shadow fitting */
function getBounds(): Bounds {
  const h = params.floor + 0.4;
  return { center: new Vector3(0, h / 2, 0), radius: 0.5 * Math.hypot(params.length, params.width, h) };
}

function regenerate(): void {
  if (building) {
    root.remove(building);
    building.traverse(o => {
      const im = o as { isInstancedMesh?: boolean; dispose?: () => void };
      if (im.isInstancedMesh) im.dispose?.();
    });
  }
  building = params.lowPoly
    ? buildLowPolyShell(params)
    : kit.buildGroup(generateBuilding(params, kit));
  root.add(building);
  env.frame(getBounds());
}

// cinematic camera + post fx
const cine = new CinematicCamera(camera, controls, getBounds);
const post = new PostFX(renderer, scene, camera);
post.setFocusSource(() => camera.position.distanceTo(controls.target));

// ---- GUI ----
const gui = new GUI({ title: "hong kong building" });

const cam = gui.addFolder("camera");
const camActions = {
  view: "hero" as PresetName,
  autoOrbit: false,
};
cam.add(camActions, "view", ["hero", "front", "street", "aerial", "corner"])
  .name("shot").onChange((v: PresetName) => cine.goTo(v));
const orbitCtrl = cam.add(camActions, "autoOrbit").name("auto-orbit")
  .onChange((v: boolean) => (cine.auto = v));
cam.add(cine, "autoSpeed", 1, 30, 1).name("orbit speed");
cine.onUserInteract = () => {
  camActions.autoOrbit = false;
  orbitCtrl.updateDisplay();
};

env.addGui(gui);
post.addGui(gui);

const dims = gui.addFolder("dimensions");
dims.add(params, "floor", 3, 14, 1);
dims.add(params, "length", 2, 16, 1);
dims.add(params, "width", 2, 10, 1);
const probs = gui.addFolder("probabilities");
probs.add(params, "acUnit", 0, 1, 0.01).name("AC unit");
probs.add(params, "roofProbability", 0, 1, 0.01).name("window awning");
probs.add(params, "clothlineProbability", 0, 1, 0.01).name("clothline");
probs.add(params, "lights", 0, 1, 0.01);
probs.add(params, "windowType", 0, 1, 0.01).name("window type");
probs.add(params, "windowOpenAmount", 0, 1, 0.01).name("window open");
probs.add(params, "curtainClose", 0, 1, 0.01).name("curtain close");
probs.add(params, "closedOpenStore", 0, 1, 0.01).name("open store");
probs.add(params, "roofOnStore", 0, 1, 0.01).name("roof on store");
probs.add(params, "objectOnGround", 0, 1, 0.01).name("ground objects");
probs.add(params, "storeSign", 0, 1, 0.01).name("store sign");
probs.add(params, "objectOnRoof", 0, 1, 0.01).name("roof objects");
probs.close();
const misc = gui.addFolder("misc");
misc.add(params, "randomise", 0, 1000, 1).name("seed");
misc.add(params, "lowPoly").name("low poly");
misc.close();

// regenerate only for build-parameter folders (camera/lighting/post have their own handlers)
for (const folder of [dims, probs, misc]) folder.onChange(() => regenerate());

// dev hooks for headless verification
const devWindow = window as unknown as {
  __setParams?: (p: Partial<BuildingParams>) => void;
  __setCamera?: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
  __shot?: (name: PresetName) => void;
  __setEnv?: (s: Partial<Environment["settings"]>) => void;
};
devWindow.__setParams = p => {
  Object.assign(params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  regenerate();
};
devWindow.__setCamera = (px, py, pz, tx, ty, tz) => {
  cine.auto = false;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  controls.update();
};
devWindow.__shot = name => cine.snap(name);
devWindow.__setEnv = s => {
  Object.assign(env.settings, s);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  env.refresh();
  env.frame(getBounds());
};

kit.load("/assets/kit.glb", "/assets/kit_manifest.json").then(() => {
  document.getElementById("loading")?.remove();
  regenerate();
  cine.snap("hero");
}).catch(err => {
  const el = document.getElementById("loading");
  if (el) el.textContent = `FAILED TO LOAD KIT: ${err}`;
  console.error(err);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

const clock = new Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  cine.update(dt);
  env.tick();
  post.render();
});
