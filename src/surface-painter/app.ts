import * as THREE from 'three/webgpu';
import { float, pass, screenUV, smoothstep, vec2 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type GUI from 'lil-gui';
import { bindStatusLine } from '../status-line';
import { evaluateLibraryShape, type LibraryShapeInfo } from '../base-shape-catalog';
import { disposeRaycastIndex, firstHitOnly, indexForRaycasts } from '../geometry-painter/bvh';
import { SurfacePainter } from '../geometry-painter/surfacePainter';
import type { PaintMode, StrokeInstance, SurfaceSample } from '../geometry-painter/modes/mode';
import {
  crystalMode,
  defaultCrystalSettings,
  setCrystalGlow,
  type CrystalSettings,
} from '../geometry-painter/modes/crystals';
import { defaultFissureSettings, fissureMode, type FissureSettings } from '../geometry-painter/modes/fissures';
import { auroraMode, defaultAuroraSettings, type AuroraSettings } from '../geometry-painter/modes/aurora';
import { defaultReefSettings, reefMode, type ReefSettings } from '../geometry-painter/modes/reef';
import { IvyPlant, defaultIvySettings, type IvySettings } from '../vegetation-generator/ivy';
import { TreePlant, defaultTreeSettings, type TreeSettings } from '../vegetation-generator/tree';
import {
  SurfaceStudioHostController,
  type SurfaceStudioHost,
} from '../surface-studio/app-host';
import { buildGui } from './ui';

/**
 * The unified Surface Painter: every stroke-driven generator from the former
 * Vegetation Generator (ivy, banyan tree) and Geometry Painter (crystals,
 * molten fissures, aurora silk, bioluminescent reef) behind ONE app with ONE
 * option set — model presets, .glb import, and model scale now apply to every
 * generator, and the studio post pipeline (bloom, vignette) comes along for
 * the decor family.
 *
 * The generator code itself still lives in its original directories
 * (vegetation-generator/, geometry-painter/) beside its LICENSE files; this
 * app replaces only the two duplicated App/GUI shells.
 */

export type ModelKind = 'Sphere' | 'Torus Knot' | 'Box' | 'Cylinder';
export type DecorGenerator = 'Crystals' | 'Molten fissures' | 'Aurora silk' | 'Bioluminescent reef';
export type Generator = 'Ivy' | 'Tree' | DecorGenerator;

export const GENERATORS: Generator[] = [
  'Ivy',
  'Tree',
  'Crystals',
  'Molten fissures',
  'Aurora silk',
  'Bioluminescent reef',
];

export function generatorFamily(g: Generator): 'vegetation' | 'decor' {
  return g === 'Ivy' || g === 'Tree' ? 'vegetation' : 'decor';
}

type Stage = 'garden' | 'studio';

// Each family keeps its authored staging: the vegetation daylight garden and the
// decor macro studio, switched with the generator so neither look degrades.
const GARDEN_GROUND_Y = -1.4;
const STUDIO_GROUND_Y = -1.55;
const MAX_DECOR_STROKES = 18;
const POST_SAMPLES = 2;

interface IvyStroke {
  samples: SurfaceSample[];
  index: number; // stable per-stroke id; combined with the global seed to vary each plant
}

interface DecorStroke extends IvyStroke {
  mode: DecorGenerator; // strokes rebuild through the mode that authored them
}

export class App {
  readonly settings: IvySettings & {
    drawMode: boolean;
    model: ModelKind;
    seed: number;
    generator: Generator;
    pushForce: number;
    flowerBrush: number;
    modelScale: number;
    exposure: number;
    envIntensity: number;
    backlight: number;
    bloomStrength: number;
    bloomThreshold: number;
  } = {
    ...defaultIvySettings,
    drawMode: true,
    model: 'Sphere',
    seed: 1,
    generator: 'Ivy',
    pushForce: 1,      // multiplier on the tree branch push interaction
    flowerBrush: 0.28, // radius of the F-brush that blooms flowers / ripens figs
    modelScale: 1,     // user multiplier over the model's fit-to-view scale
    exposure: 1,
    envIntensity: 0.9,
    backlight: 1,      // scales the studio kickers that stream light through the crystals
    bloomStrength: 0.4,
    bloomThreshold: 0.75,
  };

  /** Banyan parameters, edited by the GUI (quality/speed come from `settings`). */
  readonly treeParams: TreeSettings = { ...defaultTreeSettings };
  readonly crystal: CrystalSettings = { ...defaultCrystalSettings };
  readonly fissure: FissureSettings = { ...defaultFissureSettings };
  readonly aurora: AuroraSettings = { ...defaultAuroraSettings };
  readonly reef: ReefSettings = { ...defaultReefSettings };

  /** Registry of decor painting modes — new modes plug in here. */
  private decorModes: Record<DecorGenerator, PaintMode<unknown>> = {
    'Crystals': crystalMode as PaintMode<unknown>,
    'Molten fissures': fissureMode as PaintMode<unknown>,
    'Aurora silk': auroraMode as PaintMode<unknown>,
    'Bioluminescent reef': reefMode as PaintMode<unknown>,
  };

  /** Snapshot of the settings object a given decor mode consumes. */
  private settingsFor(mode: DecorGenerator): unknown {
    switch (mode) {
      case 'Crystals': return { ...this.crystal };
      case 'Molten fissures': return { ...this.fissure };
      case 'Aurora silk': return { ...this.aurora };
      case 'Bioluminescent reef': return { ...this.reef };
    }
  }

  private renderer!: THREE.WebGPURenderer;
  private post: THREE.RenderPipeline | null = null;
  private bloomNode: ReturnType<typeof bloom> | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);
  private controls!: OrbitControls;
  private painter!: SurfacePainter;
  private gui: GUI | null = null;
  private studioHostController: SurfaceStudioHostController | null = null;

  // Model + paint roots. paintAnchor is static, so anchor-local decor samples
  // equal world coordinates; ivy consumes world-space samples directly.
  private modelRoot = new THREE.Group();
  private ivyRoot = new THREE.Group();
  private paintAnchor = new THREE.Group();
  private decorRoot = new THREE.Group();

  private plants: IvyPlant[] = [];
  private ivyStrokes: IvyStroke[] = [];
  private decorStrokes: DecorStroke[] = [];
  private decorLive: StrokeInstance[] = [];
  private tree: TreePlant | null = null;
  private treeReady = false;
  private treeCompilePromise: Promise<void> | null = null;
  private strokeCounter = 0;

  // Current model placement (see installModel).
  private modelContainer: THREE.Group | null = null;
  private modelFitScale = 1;
  private modelCenter = new THREE.Vector3();
  private modelMinY = 0;
  private modelGrounded = false;
  private primitiveMesh: THREE.Mesh | null = null;
  private gardenPrimitiveMat!: THREE.MeshStandardMaterial;
  private studioPrimitiveMat!: THREE.MeshPhysicalMaterial;

  // Staging.
  private stage: Stage = 'garden';
  private gardenGroup = new THREE.Group();
  private studioGroup = new THREE.Group();
  private envTexture: THREE.Texture | null = null;
  private dust: THREE.Points | null = null;
  private dustVel: number[] = [];
  private backLights: { light: THREE.DirectionalLight; base: number }[] = [];

  private setStatus = bindStatusLine('#paint-status');
  private metricsEl = document.getElementById('paint-metrics')!;
  private lastTime = 0;
  private hovering = false;
  private toastTimer = 0;
  /** Tree mode: brushing the pointer over limbs or foliage pushes them (toggled with D). */
  private interactMode = true;
  /** Vegetation family: hover the F-brush to bloom flowers / ripen figs. */
  private flowerMode = false;
  private branchMarker!: THREE.Mesh;
  private flowerMarker!: THREE.Mesh;
  private lastPX = 0;
  private lastPY = 0;
  private branchRay = firstHitOnly(new THREE.Raycaster());
  private regrowPending: { mode: 'instant' | 'animate'; ivy: boolean; tree: boolean; decor: boolean } | null = null;
  private lastRegrowAt = 0;
  private regrowCost = 0;
  private modeBtn: HTMLElement | null = null;
  private flowerModeBtn: HTMLButtonElement | null = null;
  private disposed = false;

  /** Adaptive render scale: protect frame rate on Retina/4K displays, recover gradually. */
  private pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  private readonly minPixelRatio = Math.min(window.devicePixelRatio, 0.75);
  private readonly maxPixelRatio = Math.min(window.devicePixelRatio, 1.75);
  private frameTimeEma = 16.7;
  private qualityElapsed = 0;
  private recoveryWindows = 0;

  constructor(private container: HTMLElement, initialGenerator: Generator = 'Ivy') {
    this.settings.generator = initialGenerator;
  }

  /** Available after start() resolves; shared Studio systems never receive App itself. */
  getSurfaceStudioHost(): SurfaceStudioHost {
    if (!this.studioHostController) throw new Error('Surface Painter has not started');
    return this.studioHostController.host;
  }

  async start(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    if (this.disposed) {
      // dispose() ran while the backend was initializing — release it and stop here.
      renderer.dispose();
      return;
    }
    renderer.setPixelRatio(this.pixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera.position.set(2.6, 1.5, 3.2);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 12;
    this.controls.target.set(0, -0.05, 0);
    // Keep the camera above the horizon so you can't tumble under the floor.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.studioHostController = new SurfaceStudioHostController({
      scene: this.scene,
      camera: this.camera,
      canvas: renderer.domElement,
      controls: this.controls,
      modelRoot: this.modelRoot,
      // Shared generator roots use world space. Existing decor still keeps its
      // paintAnchor until the final adapter cutover.
      outputParent: this.scene,
      compile: (object) => renderer.compileAsync(object, this.camera, this.scene),
      setStatus: (state, message) => this.setStatus(state, message),
    });

    this.gardenPrimitiveMat = new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.9 });
    // The decor stage's satin basalt canvas — a quiet stage that lets the strokes star.
    this.studioPrimitiveMat = new THREE.MeshPhysicalMaterial({
      color: 0x1b1d24,
      metalness: 0.05,
      roughness: 0.52,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
      sheen: 0.15,
      sheenColor: new THREE.Color(0x5a6bb0),
      sheenRoughness: 0.7,
      envMapIntensity: 0.55,
    });

    this.setupGardenStage();
    this.setupStudioStage();
    this.setupPost();
    this.paintAnchor.add(this.decorRoot);
    this.scene.add(this.modelRoot, this.ivyRoot, this.paintAnchor);
    this.applyStage(this.stage);
    this.setModel(this.settings.model);

    this.painter = new SurfacePainter(
      renderer.domElement,
      this.camera,
      this.scene,
      () => this.paintTargets(),
      this.paintAnchor,
    );
    this.painter.onStroke = (samples) => this.addStroke(samples);
    this.painter.onActiveChange = (active) => {
      this.controls.enabled = !active;
    };
    this.painter.onHoverChange = (over) => {
      this.hovering = over;
      this.updateHud();
    };

    this.branchMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xc6ff5e, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.branchMarker.renderOrder = 12;
    this.branchMarker.visible = false;
    this.scene.add(this.branchMarker);

    // The flower brush: a soft translucent sphere showing the bloom radius.
    this.flowerMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xf2ffcf, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    this.flowerMarker.renderOrder = 11;
    this.flowerMarker.visible = false;
    this.scene.add(this.flowerMarker);

    renderer.domElement.addEventListener('pointermove', this.onPointerMove);

    this.modeBtn = document.getElementById('modeBtn')!;
    this.flowerModeBtn = document.getElementById('flowerModeBtn') as HTMLButtonElement;
    this.setGenerator(this.settings.generator);
    this.gui = buildGui(this);

    this.modeBtn.addEventListener('click', this.onModeBtnClick);
    this.flowerModeBtn.addEventListener('click', this.onFlowerModeBtnClick);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.onResize();

    this.lastTime = performance.now();
    renderer.setAnimationLoop(this.animationLoop);
  }

  // ---------- staging ----------

  /** The vegetation family's daylight garden: soft hemisphere, warm key, dark ground disc. */
  private setupGardenStage(): void {
    const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x445566, 0.6);

    const key = new THREE.DirectionalLight(0xfff2dd, 2.2);
    key.position.set(4, 6, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = key.shadow.camera.bottom = -4;
    key.shadow.camera.right = key.shadow.camera.top = 4;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;

    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-4, 2, -4);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GARDEN_GROUND_Y;
    ground.receiveShadow = true;

    this.gardenGroup.add(hemi, key, key.target, rim, ground);
    this.scene.add(this.gardenGroup);
  }

  /**
   * The decor family's dark macro studio: a PMREM-prefiltered "black studio" environment,
   * a cinematic three-point rig whose backlights make transmissive crystals glow, a satin
   * floor, an out-of-focus backdrop, and a whisper of drifting dust.
   */
  private setupStudioStage(): void {
    const env = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(1, 1);
    const panel = (
      color: number,
      intensity: number,
      w: number,
      h: number,
      pos: [number, number, number],
    ): void => {
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      mat.color.set(color).multiplyScalar(intensity); // HDR: >1 colors become light sources
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(w, h, 1);
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(0xfff6ea, 9, 4.5, 3, [1.5, 8, 2]);      // overhead softbox, biased toward camera
    panel(0xffffff, 22, 0.7, 4.5, [-2.5, 5, -6]); // hard top-back strip — facet glints
    panel(0x9db8ff, 5, 1.2, 7, [-7, 2, -2]);      // cool strip, camera-left
    panel(0xffd9b0, 3.5, 1.6, 5, [6, 1.5, 3]);    // warm strip, camera-right
    panel(0x8a5cff, 4, 6, 3.5, [0, 2.5, -8]);     // violet wash behind the subject
    panel(0x2e3c58, 1.2, 9, 9, [0, -5, 0]);       // dim floor bounce

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose();
    geo.dispose();
    for (const child of env.children) {
      ((child as THREE.Mesh).material as THREE.Material)?.dispose?.();
    }

    const hemi = new THREE.HemisphereLight(0x8ea0c8, 0x0c0a14, 0.15);

    const key = new THREE.SpotLight(0xfff2e2, 70, 0, Math.PI / 5, 0.55, 1.8);
    key.position.set(3.4, 5.6, 2.6);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5;

    const back = new THREE.DirectionalLight(0xa9b8ff, 2.4);
    back.position.set(-3, 3.2, -4.5);
    const kick = new THREE.DirectionalLight(0xcaa6ff, 1.2);
    kick.position.set(4.5, 1.2, -3);
    this.backLights = [
      { light: back, base: 2.4 },
      { light: kick, base: 1.2 },
    ];

    const under = new THREE.PointLight(0x6a4bd6, 0.4, 6, 1.6);
    under.position.set(0, STUDIO_GROUND_Y + 0.25, 0);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshPhysicalMaterial({
        map: makeFloorTexture(),
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0,
        specularIntensity: 0.15,
        envMapIntensity: 0.15,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = STUDIO_GROUND_Y;
    ground.receiveShadow = true;

    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(30, 32, 16),
      new THREE.MeshBasicMaterial({ map: makeBackdropTexture(), side: THREE.BackSide, fog: false }),
    );

    // Drifting dust — depth cue and atmosphere, kept deliberately subtle.
    const N = 320;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 1.9 + Math.random() * 4.5;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = STUDIO_GROUND_Y + 0.1 + Math.random() * 4.2;
      positions[i * 3 + 2] = Math.sin(a) * r;
      this.dustVel.push(0.02 + Math.random() * 0.05);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        color: 0x9db4e8,
        size: 0.02,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.dust.frustumCulled = false;

    this.studioGroup.add(hemi, key, key.target, back, kick, under, ground, backdrop, this.dust);
    this.scene.add(this.studioGroup);
  }

  /** Post (decor stage only): MSAA scene pass + bloom + a gentle lens vignette. */
  private setupPost(): void {
    const scenePass = pass(this.scene, this.camera, { samples: POST_SAMPLES });
    const color = scenePass.getTextureNode();
    this.bloomNode = bloom(color, this.settings.bloomStrength, 0.6, this.settings.bloomThreshold);
    const vignette = float(1).sub(smoothstep(0.5, 0.92, screenUV.distance(vec2(0.5, 0.5))).mul(0.35));
    this.post = new THREE.RenderPipeline(this.renderer);
    this.post.outputNode = color.add(this.bloomNode).mul(vignette);
  }

  private groundY(): number {
    return this.stage === 'garden' ? GARDEN_GROUND_Y : STUDIO_GROUND_Y;
  }

  /** Swap the visible stage. Existing strokes stay — only lighting/backdrop change. */
  private applyStage(stage: Stage): void {
    this.stage = stage;
    const studio = stage === 'studio';
    this.gardenGroup.visible = !studio;
    this.studioGroup.visible = studio;
    this.scene.background = new THREE.Color(studio ? 0x0a0b10 : 0x14181d);
    this.scene.fog = studio ? new THREE.Fog(0x0a0b10, 9, 22) : new THREE.Fog(0x14181d, 8, 20);
    this.scene.environment = studio ? this.envTexture : null;
    this.scene.environmentIntensity = this.settings.envIntensity;
    if (this.primitiveMesh) {
      this.primitiveMesh.material = studio ? this.studioPrimitiveMat : this.gardenPrimitiveMat;
    }
    this.applyModelScale(); // the two stages ground GLBs at different heights
  }

  private setStage(stage: Stage): void {
    if (stage === this.stage) return;
    this.applyStage(stage);
  }

  // ---------- strokes ----------

  addStroke(samples: SurfaceSample[]): void {
    const g = this.settings.generator;
    if (generatorFamily(g) === 'decor') {
      const mode = g as DecorGenerator;
      const retiredOldest = this.decorStrokes.length >= MAX_DECOR_STROKES;
      if (retiredOldest) {
        this.decorStrokes.shift();
        this.decorLive.shift()?.dispose();
      }
      const stroke: DecorStroke = { samples, index: this.strokeCounter++, mode };
      this.decorStrokes.push(stroke);
      this.buildDecorStroke(stroke, true);
      const toasts: Record<DecorGenerator, string> = {
        'Crystals': '💎 crystals seeded — watch them grow',
        'Molten fissures': '🔥 fissure torn open — stand back',
        'Aurora silk': '🌌 aurora silk unfurling — look up',
        'Bioluminescent reef': '🪸 reef colony seeded — watch it come alive',
      };
      this.showToast(`${toasts[mode]}${retiredOldest ? ' · oldest stroke retired' : ''}`);
    } else {
      const stroke: IvyStroke = { samples, index: this.strokeCounter++ };
      this.ivyStrokes.push(stroke);
      this.growPlant(stroke, true);
      this.showToast('🌱 ivy planted — watch it grow');
    }
    this.updateHud();
  }

  private growPlant(stroke: IvyStroke, animate: boolean): void {
    const seed = this.effectiveSeed(stroke.index);
    const plant = new IvyPlant(stroke.samples, seed, { ...this.settings }, this.paintTargets());
    this.ivyRoot.add(plant.group);
    this.plants.push(plant);
    if (!animate) plant.finishGrowth();
  }

  private buildDecorStroke(stroke: DecorStroke, animate: boolean): void {
    const seed = this.effectiveSeed(stroke.index);
    const instance = this.decorModes[stroke.mode].createStroke(stroke.samples, seed, this.settingsFor(stroke.mode));
    this.decorRoot.add(instance.group);
    this.decorLive.push(instance);
    if (!animate) instance.finishGrowth();
  }

  private regrowIvy(animate: boolean): void {
    for (const p of this.plants) p.dispose();
    this.plants = [];
    for (const stroke of this.ivyStrokes) this.growPlant(stroke, animate);
  }

  private regrowDecor(animate: boolean): void {
    for (const s of this.decorLive) s.dispose();
    this.decorLive = [];
    for (const stroke of this.decorStrokes) this.buildDecorStroke(stroke, animate);
  }

  private rebuildTree(animate: boolean): void {
    this.tree?.dispose();
    const settings: TreeSettings = {
      ...this.treeParams,
      quality: this.settings.quality,
      growthSpeed: this.settings.growthSpeed,
    };
    this.tree = new TreePlant(settings, this.effectiveSeed(7777));
    this.tree.group.position.set(0, GARDEN_GROUND_Y, 0); // rooted on the garden ground disc
    this.tree.group.visible = this.settings.generator === 'Tree';
    if (!this.treeReady && this.treeCompilePromise) this.tree.group.visible = false;
    this.scene.add(this.tree.group);
    if (!animate) this.tree.finishGrowth();
  }

  /**
   * The first Tree frame used to synchronously prepare every bark, foliage, fig,
   * and shadow pipeline, freezing the UI for more than a second on WebGPU. Build
   * the CPU geometry once, then let compileAsync upload/compile it while the
   * previous surface remains visible. Renderer.compileAsync yields between
   * objects, so the selector and camera stay responsive during the warm-up.
   */
  private prepareTree(): void {
    if (this.treeReady) {
      this.showTree();
      return;
    }

    if (!this.tree) this.rebuildTree(true);
    const tree = this.tree!;
    tree.group.visible = true;

    if (!this.treeCompilePromise) {
      const compilation = this.renderer.compileAsync(tree.group, this.camera, this.scene);
      // compileAsync collects the visible objects synchronously before its first
      // yield, so it is safe to keep the tree out of normal renders immediately.
      tree.group.visible = false;
      this.treeCompilePromise = compilation;
      void compilation
        .then(() => {
          if (this.treeCompilePromise === compilation) this.treeCompilePromise = null;
          if (this.disposed) return;
          // A live Tree slider can replace the geometry while the previous tree
          // is compiling. Warm the replacement instead of leaving preparation
          // permanently attached to the disposed tree.
          if (this.tree !== tree) {
            if (this.settings.generator === 'Tree') this.prepareTree();
            return;
          }
          this.treeReady = true;
          if (this.settings.generator === 'Tree') this.showTree();
        })
        .catch((error: unknown) => {
          if (this.treeCompilePromise === compilation) this.treeCompilePromise = null;
          if (this.disposed) return;
          if (this.tree !== tree) {
            if (this.settings.generator === 'Tree') this.prepareTree();
            return;
          }
          console.warn('Tree pipeline preparation failed; falling back to normal rendering.', error);
          this.treeReady = true;
          if (this.settings.generator === 'Tree') this.showTree();
        });
    } else {
      tree.group.visible = false;
    }

    // Do not blank the viewport while the tree prepares.
    this.modelRoot.visible = true;
    this.ivyRoot.visible = true;
    this.paintAnchor.visible = true;
    this.setStatus('busy', 'Preparing the banyan tree… You can keep orbiting while it loads.');
  }

  private showTree(): void {
    if (!this.tree) return;
    this.modelRoot.visible = false;
    this.ivyRoot.visible = false;
    this.paintAnchor.visible = false;
    this.tree.group.visible = true;
    this.applyModes();
  }

  /**
   * Ask for a rebuild. Requests are coalesced and throttled in the tick (slider drags fire
   * onChange dozens of times a second). `scope` limits the work to the generators whose
   * sliders actually moved. 'instant' snaps to fully grown; 'animate' replays the growth.
   */
  scheduleRegrow(
    mode: 'instant' | 'animate',
    scope: 'ivy' | 'tree' | 'decor' | 'vegetation' | 'all' = 'all',
  ): void {
    const p = this.regrowPending ?? { mode, ivy: false, tree: false, decor: false };
    if (mode === 'animate') p.mode = 'animate'; // an animate request always wins
    if (scope === 'ivy' || scope === 'vegetation' || scope === 'all') p.ivy = true;
    if (scope === 'tree' || scope === 'vegetation' || scope === 'all') p.tree = true;
    if (scope === 'decor' || scope === 'all') p.decor = true;
    this.regrowPending = p;
  }

  /** New random global seed, applied live to every generator. */
  randomizeSeed(): void {
    this.settings.seed = Math.floor(Math.random() * 1000);
    this.scheduleRegrow('instant');
  }

  /** Undo removes the last stroke of the generator family you are currently in. */
  undoLast(): void {
    if (generatorFamily(this.settings.generator) === 'decor') {
      this.decorStrokes.pop();
      this.decorLive.pop()?.dispose();
    } else {
      this.ivyStrokes.pop();
      this.plants.pop()?.dispose();
    }
    this.updateHud();
  }

  clearAll(): void {
    for (const p of this.plants) p.dispose();
    this.plants = [];
    this.ivyStrokes = [];
    for (const s of this.decorLive) s.dispose();
    this.decorLive = [];
    this.decorStrokes = [];
    this.regrowPending = null;
    this.updateHud();
  }

  /** Mix the global seed with a stroke's stable id so strokes stay distinct but reseed together. */
  private effectiveSeed(index: number): number {
    return ((this.settings.seed * 2654435761) ^ (index * 40503 + 1)) >>> 0;
  }

  // ---------- live (no-rebuild) setting paths ----------

  /** Push a decor mode's current settings into its live strokes IN PLACE. */
  updateModeSettings(mode: DecorGenerator): void {
    let needRebuild = false;
    for (let i = 0; i < this.decorLive.length; i++) {
      if (this.decorStrokes[i].mode !== mode) continue;
      const s = this.decorLive[i];
      if (s.applySettings) s.applySettings(this.settingsFor(mode));
      else needRebuild = true;
    }
    if (needRebuild) this.scheduleRegrow('instant', 'decor');
  }

  setGlow(v: number): void {
    this.crystal.glow = v;
    setCrystalGlow(v);
  }

  setExposure(v: number): void {
    this.settings.exposure = v;
    this.renderer.toneMappingExposure = v;
  }

  setEnvIntensity(v: number): void {
    this.settings.envIntensity = v;
    if (this.stage === 'studio') this.scene.environmentIntensity = v;
  }

  /** Backlight slider: scales the studio's rear rig — how hard light streams through crystals. */
  setBacklight(v: number): void {
    this.settings.backlight = v;
    for (const { light, base } of this.backLights) light.intensity = base * v;
  }

  setBloomStrength(v: number): void {
    this.settings.bloomStrength = v;
    if (this.bloomNode) this.bloomNode.strength.value = v;
  }

  setBloomThreshold(v: number): void {
    this.settings.bloomThreshold = v;
    if (this.bloomNode) this.bloomNode.threshold.value = v;
  }

  bloomAll(): void {
    for (const p of this.plants) p.bloomAll();
  }

  resetBlooms(): void {
    for (const p of this.plants) p.resetBlooms();
  }

  ripenAll(): void {
    this.tree?.ripenAll();
  }

  resetRipe(): void {
    this.tree?.resetRipe();
  }

  setIvyLeafSize(v: number): void {
    for (const p of this.plants) p.setLeafSize(v);
  }

  setIvyFlowerSize(v: number): void {
    for (const p of this.plants) p.setFlowerSize(v);
  }

  setTreeLeafSize(v: number): void {
    this.tree?.setLeafSize(v);
  }

  setTreeClumpSize(v: number): void {
    this.tree?.setClumpSize(v);
  }

  setTreeLeafHue(v: number): void {
    this.tree?.setLeafHue(v);
  }

  setTreeFigSize(v: number): void {
    this.tree?.setFigSize(v);
  }

  // ---------- generator switching ----------

  setGenerator(g: Generator): void {
    this.settings.generator = g;
    const tree = g === 'Tree';
    document.body.classList.toggle('tree', tree);
    this.setStage(generatorFamily(g) === 'decor' ? 'studio' : 'garden');
    // The banyan replaces the paintable model; every paint generator shares it.
    if (tree) {
      this.prepareTree();
    } else if (this.tree) {
      this.tree.group.visible = false;
      this.modelRoot.visible = true;
      this.ivyRoot.visible = true;
      this.paintAnchor.visible = true;
    } else {
      this.modelRoot.visible = true;
      this.ivyRoot.visible = true;
      this.paintAnchor.visible = true;
    }
    this.applyModes();
    if (tree && !this.treeReady) {
      this.setStatus('busy', 'Preparing the banyan tree… You can keep orbiting while it loads.');
    }
  }

  // ---------- vegetation brushes (F) and tree pushing ----------

  private onPointerMove = (e: PointerEvent): void => {
    this.onTreePointerMove(e);
    this.onFlowerPointerMove(e);
  };

  /** Hovering the brush blooms ivy flowers / ripens banyan figs within its radius. */
  private onFlowerPointerMove(e: PointerEvent): void {
    if (!this.flowerMode || generatorFamily(this.settings.generator) !== 'vegetation') {
      this.flowerMarker.visible = false;
      return;
    }
    const tree = this.settings.generator === 'Tree';
    if (tree && !this.tree) {
      this.flowerMarker.visible = false;
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.branchRay.setFromCamera(new THREE.Vector2(px, py), this.camera);
    const hit = tree
      ? this.branchRay.intersectObjects(this.tree!.interactMeshes, false)[0]
      : this.branchRay.intersectObjects(this.paintTargets(), true)[0];

    if (!hit) {
      this.flowerMarker.visible = false;
      return;
    }

    const radius = this.settings.flowerBrush;
    this.flowerMarker.visible = true;
    this.flowerMarker.position.copy(hit.point);
    this.flowerMarker.scale.setScalar(radius);
    if (tree) this.tree!.ripenAt(hit.point, radius);
    else for (const p of this.plants) p.bloomAt(hit.point, radius);
  }

  private treeInteractActive(): boolean {
    return this.settings.generator === 'Tree' && this.interactMode && this.tree !== null;
  }

  /** Brushing the pointer over a limb or foliage clump pushes it aside — no clicking. */
  private onTreePointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.lastPX;
    const dy = e.clientY - this.lastPY;
    this.lastPX = e.clientX;
    this.lastPY = e.clientY;

    if (!this.treeInteractActive()) {
      this.branchMarker.visible = false;
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.branchRay.setFromCamera(new THREE.Vector2(px, py), this.camera);
    const hit = this.branchRay.intersectObjects(this.tree!.interactMeshes, false)[0];

    if (!hit) {
      this.branchMarker.visible = false;
      this.renderer.domElement.style.cursor = '';
      return;
    }

    this.branchMarker.visible = true;
    this.branchMarker.position.copy(hit.point);
    this.renderer.domElement.style.cursor = 'grab';

    if (dx !== 0 || dy !== 0) {
      const strength = this.settings.pushForce;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const force = right.multiplyScalar(dx).addScaledVector(up, -dy)
        .multiplyScalar(0.0035 * strength);
      const cap = 0.25 * strength;
      if (force.lengthSq() > cap * cap) force.normalize().multiplyScalar(cap);
      this.tree!.pushAt(hit.object, hit.point, force);
    }
  }

  // ---------- model management (shared by every paint generator) ----------

  setModel(kind: ModelKind): void {
    this.clearAll();
    this.disposeModel();
    this.settings.modelScale = 1; // a fresh model starts at its fit scale

    let geo: THREE.BufferGeometry;
    switch (kind) {
      case 'Torus Knot':
        geo = new THREE.TorusKnotGeometry(0.65, 0.26, 200, 28);
        break;
      case 'Box':
        geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
        break;
      case 'Cylinder':
        geo = new THREE.CylinderGeometry(0.7, 0.7, 1.8, 48);
        break;
      default:
        geo = new THREE.SphereGeometry(1, 96, 64);
    }
    const mesh = new THREE.Mesh(
      geo,
      this.stage === 'studio' ? this.studioPrimitiveMat : this.gardenPrimitiveMat,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.primitiveMesh = mesh;
    // Primitives are authored centered at the origin — keep them there (grounded = false).
    this.installModel(mesh, 1, false);
  }

  /**
   * Wrap a model (primitive or GLB) in a container we own, record its fit info, and place
   * it. `fitScale` is the base scale that frames it; the Model-scale slider multiplies it.
   * `grounded` rests the box bottom on the active stage's ground; otherwise it centers.
   */
  private installModel(model: THREE.Object3D, fitScale: number, grounded: boolean): void {
    const container = new THREE.Group();
    container.add(model);
    container.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(this.modelCenter);
    this.modelMinY = box.min.y;
    this.modelFitScale = fitScale;
    this.modelGrounded = grounded;
    this.modelContainer = container;

    this.modelRoot.add(container);
    this.applyModelScale();
    indexForRaycasts(this.modelRoot); // BVH indexes local geometry; scaling won't invalidate it
    this.studioHostController?.notifySurfaceChanged();
  }

  /** Re-place the current model for the fit scale × the user's Model-scale slider. */
  private applyModelScale(): void {
    const c = this.modelContainer;
    if (!c) return;
    const s = this.modelFitScale * this.settings.modelScale;
    c.scale.setScalar(s);
    c.position.set(
      -this.modelCenter.x * s,
      this.modelGrounded ? this.groundY() - this.modelMinY * s : -this.modelCenter.y * s,
      -this.modelCenter.z * s,
    );
    c.updateMatrixWorld(true);
  }

  /** Model-scale slider: rescale live and clear the strokes (their surface just moved). */
  setModelScale(v: number): void {
    this.settings.modelScale = v;
    this.applyModelScale();
    this.clearAll();
    this.studioHostController?.notifySurfaceChanged();
  }

  /**
   * Evaluate a ported reference object through the GN-VM and install its
   * result as the paint surface, exactly like a primitive preset (it shares
   * the stage's primitive material and the fit/ground placement of a GLB).
   */
  async loadLibraryModel(info: LibraryShapeInfo): Promise<void> {
    try {
      this.setStatus('busy', `Evaluating ${info.title} through the GN-VM…`);
      const soup = await evaluateLibraryShape(info);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(soup.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(soup.indices, 1));
      const mesh = new THREE.Mesh(
        geo,
        this.stage === 'studio' ? this.studioPrimitiveMat : this.gardenPrimitiveMat,
      );
      mesh.name = info.title;
      // GN-VM output is Blender Z-up; the paint stages are Y-up.
      mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const probe = new THREE.Group();
      probe.add(mesh);
      probe.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const size = box.getSize(new THREE.Vector3());
      const fitScale = 2.6 / Math.max(size.x, size.y, size.z, 1e-3);
      probe.remove(mesh);

      this.clearAll();
      this.disposeModel();
      this.settings.modelScale = 1;
      this.primitiveMesh = mesh; // shares the swap-on-stage primitive material
      this.installModel(mesh, fitScale, true);
      this.setStatus('ready', `${info.title} ready to paint`);
    } catch (err) {
      console.error('Failed to evaluate library shape:', err);
      this.setStatus('error', `${info.title} could not be evaluated`);
    }
  }

  async loadGlbFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const model = gltf.scene;
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      // Fit to view on a WRAPPER (installModel), so the model keeps its own authored
      // transforms. We only uniform-scale + place the wrapper, and rest it on the ground
      // so it doesn't float. A fresh import resets the Model-scale slider to 1×.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const fitScale = 2.6 / Math.max(size.x, size.y, size.z, 1e-3);

      this.clearAll();
      this.disposeModel();
      this.settings.modelScale = 1;
      this.installModel(model, fitScale, true);
    } catch (err) {
      console.error('Failed to load model:', err);
      alert('Could not load that file. Self-contained .glb files work best (no Draco compression).');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private disposeModel(): void {
    this.modelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      disposeRaycastIndex(mesh.geometry);
      mesh.geometry.dispose();
      // The shared primitive materials outlive their mesh (they swap with the stage).
      if (mesh === this.primitiveMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    });
    this.modelRoot.clear();
    this.modelContainer = null;
    this.primitiveMesh = null;
  }

  private paintTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    this.modelRoot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) targets.push(o);
    });
    return targets;
  }

  // ---------- modes / hud ----------

  toggleMode(): void {
    if (this.settings.generator === 'Tree') {
      this.interactMode = !this.interactMode;
      if (this.interactMode) this.flowerMode = false; // D and F are exclusive
    } else {
      this.settings.drawMode = !this.settings.drawMode;
      if (this.settings.drawMode) this.flowerMode = false;
    }
    this.applyModes();
  }

  /** F: the bloom brush — flowers on the ivy, figs on the banyan. Vegetation family only. */
  toggleFlowerMode(): void {
    if (generatorFamily(this.settings.generator) !== 'vegetation') return;
    this.flowerMode = !this.flowerMode;
    if (this.flowerMode) {
      if (this.settings.generator === 'Ivy') this.settings.drawMode = false;
      else this.interactMode = false;
    }
    this.applyModes();
  }

  applyModes(): void {
    const g = this.settings.generator;
    const draw = g !== 'Tree' && this.settings.drawMode;
    const flower = this.flowerMode && generatorFamily(g) === 'vegetation';
    const interact = g === 'Tree' && this.interactMode && !flower;
    this.painter.setEnabled(draw);
    // Hover-based modes (flower brush, tree interact) keep orbiting available.
    this.controls.enableRotate = !draw;
    document.body.classList.toggle('draw', draw || interact);
    document.body.classList.toggle('flower', flower);
    document.body.classList.toggle('orbit', !(draw || interact || flower));

    const btn = this.modeBtn ?? document.getElementById('modeBtn')!;
    // This pill names the mode *it* toggles (D), never the brush the pill
    // beside it toggles (F) — labelling it "Flower brush" while the brush is up
    // put the same word on both pills. With the brush up, drawing is off and
    // rotation is live, so this really is orbit.
    btn.querySelector('.label')!.textContent =
      draw ? (generatorFamily(g) === 'decor' ? 'Paint mode' : 'Draw mode')
        : interact ? 'Interact mode' : 'Orbit mode';
    const key = btn.querySelector('.key') as HTMLElement;
    key.textContent = 'D';
    const touchUi = window.matchMedia('(pointer: coarse), (max-width: 820px)').matches;
    key.style.display = !touchUi && (draw || interact) ? '' : 'none';

    if (this.flowerModeBtn) {
      const vegetation = generatorFamily(g) === 'vegetation';
      this.flowerModeBtn.hidden = !vegetation;
      this.flowerModeBtn.setAttribute('aria-pressed', String(flower));
      this.flowerModeBtn.setAttribute(
        'aria-label',
        `${flower ? 'Disable' : 'Enable'} ${g === 'Tree' ? 'fig' : 'flower'} brush`,
      );
      this.flowerModeBtn.querySelector('.label')!.textContent = g === 'Tree'
        ? 'Fig brush'
        : 'Flower brush';
    }

    if (!draw) this.hovering = false;
    if (!interact) {
      if (this.branchMarker) this.branchMarker.visible = false;
      this.renderer.domElement.style.cursor = '';
    }
    if (!flower && this.flowerMarker) this.flowerMarker.visible = false;
    this.updateHud();
  }

  private updateHud(): void {
    const backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'WebGPU'
      : 'WebGL2 (fallback)';
    const g = this.settings.generator;
    const touchUi = window.matchMedia('(pointer: coarse), (max-width: 820px)').matches;
    let mode: string;
    if (g === 'Tree') {
      mode = this.flowerMode
        ? touchUi
          ? '<b>Fig brush</b> — drag across the twigs to ripen figs; tap <b>Fig brush</b> to put it away.'
          : '<b>Fig brush</b> — hover the twigs and watch the green figs swell and ripen red. Drag to orbit as usual. Press <b>F</b> to put the brush away.'
        : this.interactMode
          ? '<b>Interact mode</b> — sweep the cursor through branches or leaves to brush them aside; ' +
            (touchUi ? 'they spring back behind you. Use the buttons below to orbit or ripen figs.' : 'they spring back behind you. Drag to orbit as usual. Press <b>D</b> to switch off, <b>F</b> to ripen figs.')
          : touchUi
            ? '<b>Orbit mode</b> — drag to rotate and pinch to zoom. Use the buttons below to brush the tree or ripen its figs. <b>▶ Redraw</b> replays the growth.'
            : '<b>Orbit mode</b> — drag to rotate, scroll to zoom. Press <b>D</b> to brush the tree around, <b>F</b> to ripen its figs. <b>▶ Redraw</b> replays the growth.';
    } else if (this.flowerMode && g === 'Ivy') {
      mode = touchUi
        ? '<b>Flower brush</b> — drag across the ivy to bloom it; tap <b>Flower brush</b> to put the brush away.'
        : '<b>Flower brush</b> — hover over the ivy and watch the buds pop into bloom. Drag to orbit as usual. Press <b>F</b> to put the brush away.';
    } else if (this.settings.drawMode) {
      const nouns: Record<string, string> = {
        'Ivy': 'an ivy path',
        'Crystals': 'a crystal vein',
        'Molten fissures': 'a molten fissure',
        'Aurora silk': 'a silk of aurora',
        'Bioluminescent reef': 'a reef colony',
      };
      const noun = nouns[g];
      mode = this.hovering
        ? `<b>Drag now</b> to paint ${noun} along the surface — it grows when you let go.`
        : `Move over the model, then <b>drag</b> to paint ${noun}. ` +
          (touchUi
            ? `Use the buttons below to orbit${g === 'Ivy' ? ' or bloom flowers.' : '.'}`
            : `Press <b>D</b> to orbit${g === 'Ivy' ? ', <b>F</b> to bloom flowers.' : '.'}`);
    } else {
      mode = touchUi
        ? '<b>Orbit mode</b> — drag to rotate and pinch to zoom. Tap <b>Orbit mode</b> below to return to painting.'
        : '<b>Orbit mode</b> — drag to rotate, scroll to zoom, right-drag to pan. Press <b>D</b> to paint.';
    }
    const decorCount = generatorFamily(g) === 'decor'
      ? ` · Strokes: ${this.decorLive.length}/${MAX_DECOR_STROKES}`
      : '';
    // The strip is the tool's only readout, so the guidance goes in the state
    // slot and the runtime facts ride the muted trailing slot. `mode` is
    // authored with <b> around the mode name and the key hints; the strip is
    // one weight, so they come out as plain text.
    this.setStatus('ready', mode.replace(/<\/?b>/g, ''));
    this.metricsEl.textContent =
      `Generator: ${g} · Renderer: ${backend}${decorCount} · Scale: ${this.pixelRatio.toFixed(2)}×`;
  }

  private showToast(msg: string): void {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- frame loop ----------

  private onModeBtnClick = (): void => {
    this.toggleMode();
  };

  private onFlowerModeBtnClick = (): void => {
    this.toggleFlowerMode();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    if (key === 'd') this.toggleMode();
    else if (key === 'f') this.toggleFlowerMode();
  };

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animationLoop = (time: number): void => {
    if (!this.disposed) this.tick(time);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.renderer.setAnimationLoop(null);
      return;
    }
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(this.animationLoop);
  };

  private adaptRenderQuality(dt: number): void {
    if (dt <= 0 || dt > 0.1) return;
    this.frameTimeEma += (dt * 1000 - this.frameTimeEma) * 0.08;
    this.qualityElapsed += dt;
    if (this.qualityElapsed < 2) return;
    this.qualityElapsed = 0;

    if (this.frameTimeEma > 20 && this.pixelRatio > this.minPixelRatio + 0.04) {
      this.recoveryWindows = 0;
      this.setPixelRatio(this.pixelRatio - 0.15);
      return;
    }

    if (this.frameTimeEma < 15 && this.pixelRatio < this.maxPixelRatio - 0.04) {
      this.recoveryWindows += 1;
      if (this.recoveryWindows >= 2) {
        this.recoveryWindows = 0;
        this.setPixelRatio(this.pixelRatio + 0.1);
      }
      return;
    }

    this.recoveryWindows = 0;
  }

  private setPixelRatio(value: number): void {
    const next = THREE.MathUtils.clamp(value, this.minPixelRatio, this.maxPixelRatio);
    if (Math.abs(next - this.pixelRatio) < 0.04) return;
    this.pixelRatio = next;
    this.renderer.setPixelRatio(next);
    this.onResize();
    this.updateHud();
  }

  private tick(time: number): void {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    const tSec = time / 1000;
    this.adaptRenderQuality(dt);

    if (this.regrowPending) {
      // Adaptive throttle: the heavier the last rebuild, the longer we wait before the
      // next one, so slider drags stay smooth whatever the scene costs. The final
      // pending request always runs, so releasing the slider lands on the exact value.
      const now = performance.now();
      const interval = this.regrowPending.mode === 'animate'
        ? 0
        : THREE.MathUtils.clamp(this.regrowCost * 3, 60, 400);
      if (now - this.lastRegrowAt >= interval) {
        const req = this.regrowPending;
        this.regrowPending = null;
        const animate = req.mode === 'animate';
        const t0 = performance.now();
        if (req.ivy) this.regrowIvy(animate);
        if (req.tree && this.tree) this.rebuildTree(animate);
        if (req.decor) this.regrowDecor(animate);
        this.regrowCost = performance.now() - t0;
        this.lastRegrowAt = performance.now();
      }
    }

    // Dust drifts upward and wraps (studio stage only).
    if (this.dust && this.studioGroup.visible) {
      const posAttr = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < this.dustVel.length; i++) {
        arr[i * 3 + 1] += this.dustVel[i] * dt;
        if (arr[i * 3 + 1] > STUDIO_GROUND_Y + 4.4) arr[i * 3 + 1] = STUDIO_GROUND_Y + 0.1;
      }
      posAttr.needsUpdate = true;
    }

    this.controls.update();
    this.painter.update(dt);
    if (this.ivyRoot.visible) {
      for (const plant of this.plants) {
        plant.update(dt);
        plant.updateLeaves(tSec);
      }
    }
    if (this.tree?.group.visible) {
      this.tree.update(dt);
      this.tree.updateLeaves(tSec);
    }
    if (this.paintAnchor.visible) {
      for (const s of this.decorLive) s.update(dt, tSec);
    }
    this.studioHostController?.runFrameTasks(dt, tSec);

    // Garden renders directly (the vegetation look was authored without post);
    // the studio renders through bloom + vignette.
    if (this.stage === 'studio' && this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Tear down everything start() built, returning the document to its pre-start state
   * so the tool can be mounted again later (SPA navigation) as if freshly loaded.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.modeBtn?.removeEventListener('click', this.onModeBtnClick);
    this.flowerModeBtn?.removeEventListener('click', this.onFlowerModeBtnClick);
    this.modeBtn = null;
    this.flowerModeBtn = null;

    this.gui?.destroy();
    this.gui = null;
    this.studioHostController?.dispose();
    this.studioHostController = null;

    if (this.painter) this.painter.dispose();
    if (this.controls) this.controls.dispose();
    window.clearTimeout(this.toastTimer);

    for (const p of this.plants) p.dispose();
    this.plants = [];
    this.ivyStrokes = [];
    for (const s of this.decorLive) s.dispose();
    this.decorLive = [];
    this.decorStrokes = [];
    this.regrowPending = null;
    this.tree?.dispose();
    this.tree = null;
    this.disposeModel();

    document.body.classList.remove('draw', 'flower', 'orbit', 'tree');

    if (this.renderer) {
      this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
      this.renderer.setAnimationLoop(null);
      this.post?.dispose();

      const materials = new Set<THREE.Material>();
      this.scene.traverse((object) => {
        if ((object as THREE.Light).isLight) (object as THREE.Light).dispose();
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const item of material) materials.add(item);
        } else if (material) {
          materials.add(material);
        }
      });
      materials.add(this.gardenPrimitiveMat);
      materials.add(this.studioPrimitiveMat);
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            (value as THREE.Texture).dispose();
          }
        }
        material.dispose();
      }
      this.envTexture?.dispose();
      this.renderer.domElement.remove();
      this.renderer.dispose();
    }
    this.metricsEl.textContent = '';
  }
}

/** The out-of-focus studio behind the decor subject (see geometry-painter's original). */
function makeBackdropTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#06070b';
  ctx.fillRect(0, 0, w, h);

  const blob = (x: number, y: number, r: number, rgba: string): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(w * 0.3, h * 0.38, 280, 'rgba(74, 52, 138, 0.34)');
  blob(w * 0.78, h * 0.45, 220, 'rgba(40, 58, 118, 0.22)');
  blob(w * 0.55, h * 0.2, 180, 'rgba(120, 100, 190, 0.10)');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Near-black satin floor with a soft radial sheen — a quiet stage for the model's shadow. */
function makeFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#0f1118');
  g.addColorStop(0.45, '#0b0c12');
  g.addColorStop(1, '#08090d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
