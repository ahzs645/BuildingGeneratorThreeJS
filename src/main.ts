import {
  ACESFilmicToneMapping, BoxGeometry, Clock, DoubleSide, Group, Material, Mesh,
  MeshBasicMaterial, MeshNormalMaterial, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import GUI from "lil-gui";
import { defaultParams, type BuildingParams } from "./params";
import { generateBuilding } from "./generator";
import { Kit } from "./kit";
import { Environment, type Bounds } from "./environment";
import { CinematicCamera, type PresetName } from "./cinematicCamera";
import { PostFX } from "./postfx";
import { createSnow } from "./snow";
import { createSnowAccumUniforms, createSnowShellMaterial } from "./snowAccum";

const app = document.getElementById("app")!;
// logarithmicDepthBuffer spreads depth precision so near-coplanar surfaces (posters
// on walls, glass in frames, awnings flush to the facade) stop z-fighting
const renderer = new WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new Scene();

// tight near/far ratio = far more usable depth precision (building is ~15u, orbit
// distance is clamped to [3, 120] below), which kills most of the z-fighting
const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 600);
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
ground.visible = false; // ground plane hidden for now
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

// ---- snow: falling flakes (world space) + accumulation shell on the building ----
const snowShared = { uTime: { value: 0 }, uWind: { value: new Vector3(2, 0, 1) } };
const accumU = createSnowAccumUniforms(snowShared.uTime);
kit.snowShellMaterial = createSnowShellMaterial(accumU);
const snow = createSnow({ camera, shared: snowShared });
snow.mesh.visible = false;
scene.add(snow.mesh);

const snowState = { enabled: false, density: 0.5 };
const wind = { strength: 2, direction: 20 };
function applyWind(): void {
  const a = (wind.direction * Math.PI) / 180;
  snowShared.uWind.value.set(Math.cos(a) * wind.strength, 0, Math.sin(a) * wind.strength);
}
applyWind();
function applySnowEnabled(v: boolean): void {
  snow.mesh.visible = v;
  const shell = building?.getObjectByName("snowShell");
  if (shell) shell.visible = v;
}

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

// ---- debug isolation modes (root-cause hunting, driven via window.__debug) ----
// "albedo":  unlit textures — if facades differ here, the difference is in the texture
// "normals": MeshNormalMaterial — visualizes geometry normals; inverted/mirrored
//            normals show up as wrong colors
// "uniform": white uniform ambient only — if facades match here, the difference is
//            the directional/colored light rig
type DebugMode = "off" | "albedo" | "normals" | "uniform";
let debugMode: DebugMode = "off";
const albedoCache = new Map<Material, Material>();
const normalViewMat = new MeshNormalMaterial({ side: DoubleSide });
const lightDefaults = {
  key: 3.0, fill: 0.6, rim: 120, ambColor: 0x223044, amb: 0.4,
};

function applyDebugMaterials(g: Group): void {
  if (debugMode !== "albedo" && debugMode !== "normals") return;
  g.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (debugMode === "normals") {
      mesh.material = normalViewMat;
      return;
    }
    const orig = mesh.material as MeshStandardMaterial;
    let dbg = albedoCache.get(orig);
    if (!dbg) {
      dbg = new MeshBasicMaterial({
        map: orig.map ?? null,
        color: orig.map ? 0xffffff : (orig.color?.getHex() ?? 0xffffff),
        side: DoubleSide,
        transparent: orig.transparent,
        opacity: orig.opacity,
        alphaTest: orig.alphaTest,
      });
      albedoCache.set(orig, dbg);
    }
    mesh.material = dbg;
  });
}

function applyDebugLighting(): void {
  if (debugMode === "uniform") {
    env.key.intensity = 0;
    env.fill.intensity = 0;
    env.rim.intensity = 0;
    env.ambient.color.set(0xffffff);
    env.ambient.intensity = 3.0;
    scene.environmentIntensity = 0;
    scene.fog = null;
  } else {
    env.key.intensity = lightDefaults.key;
    env.fill.intensity = lightDefaults.fill;
    env.rim.intensity = lightDefaults.rim;
    env.ambient.color.set(lightDefaults.ambColor);
    env.ambient.intensity = lightDefaults.amb;
    env.refresh();
  }
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
  applyDebugMaterials(building);
  root.add(building);
  applySnowEnabled(snowState.enabled); // new snowShell group starts hidden
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

// cinematic letterbox bars (styled in index.html)
const barTop = document.getElementById("bar-top") as HTMLElement | null;
const barBottom = document.getElementById("bar-bottom") as HTMLElement | null;
const cinePrefs = { letterbox: false };
function applyLetterbox(): void {
  const h = cinePrefs.letterbox ? "7vh" : "0";
  if (barTop) barTop.style.height = h;
  if (barBottom) barBottom.style.height = h;
}
cam.add(cinePrefs, "letterbox").name("letterbox").onChange(applyLetterbox);

env.addGui(gui);
post.addGui(gui);

// ---- snow GUI (one master toggle, ported params from SnowSystemThreeJS) ----
const fSnow = gui.addFolder("snow");
fSnow.add(snowState, "enabled").name("enabled").onChange(applySnowEnabled);
const fFall = fSnow.addFolder("snowfall");
fFall.add(snowState, "density", 0, 1, 0.01).name("density").onChange((v: number) => snow.setDensity(v));
fFall.add(snow.uniforms.uSpeed, "value", 0.5, 12, 0.1).name("fall speed");
fFall.add(snow.uniforms.uSize, "value", 0.01, 0.25, 0.001).name("flake size");
fFall.add(snow.uniforms.uSway, "value", 0, 3, 0.01).name("sway");
fFall.add(snow.uniforms.uOpacity, "value", 0, 1, 0.01).name("opacity");
fFall.addColor({ c: "#ffffff" }, "c").name("color").onChange((v: string) => snow.uniforms.uColor.value.set(v));
fFall.add(snow.uniforms.uVolume.value, "y", 10, 80, 1).name("fall height");
fFall.add(wind, "strength", 0, 25, 0.1).name("wind").onChange(applyWind);
fFall.add(wind, "direction", 0, 360, 1).name("wind dir").onChange(applyWind);
fFall.close();
const fAccum = fSnow.addFolder("accumulation");
fAccum.add(accumU.uSnowCoverage, "value", 0, 1, 0.01).name("coverage");
fAccum.add(accumU.uSnowThickness, "value", 0, 0.3, 0.001).name("thickness");
fAccum.add(accumU.uSnowScale, "value", 0.1, 4, 0.01).name("patch scale");
fAccum.add(accumU.uSnowEdge, "value", 0.01, 0.4, 0.005).name("patch softness");
fAccum.add(accumU.uSnowSeed.value, "x", -50, 50, 0.1).name("seed x");
fAccum.add(accumU.uSnowSeed.value, "y", -50, 50, 0.1).name("seed y");
fAccum.add(accumU.uSnowFlatThreshold, "value", 0, 1, 0.01).name("flatness");
fAccum.addColor({ c: "#eaf1ff" }, "c").name("color").onChange((v: string) => accumU.uSnowColor.value.set(v));
fAccum.add(accumU.uSnowRoughness, "value", 0.3, 1, 0.01).name("roughness");
fAccum.add(accumU.uSnowBump, "value", 0, 1.5, 0.01).name("relief strength");
fAccum.add(accumU.uSnowBumpScale, "value", 0.5, 8, 0.05).name("relief scale");
fAccum.add(accumU.uSnowSparkle, "value", 0, 1, 0.01).name("sparkle");
fAccum.add(accumU.uSnowSparkleScale, "value", 30, 300, 1).name("sparkle density");
fAccum.close();
fSnow.close();

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
(devWindow as { __debug?: (m: DebugMode) => void }).__debug = m => {
  debugMode = m;
  applyDebugLighting();
  regenerate();
};
(devWindow as { __snow?: (on: boolean) => void }).__snow = on => {
  snowState.enabled = on;
  applySnowEnabled(on);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
};
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
  if (snowState.enabled) {
    snowShared.uTime.value += dt; // drives flake fall + sparkle twinkle
    snow.update();
  }
  post.render();
});
