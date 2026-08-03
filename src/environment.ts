/**
 * Cinematic studio lighting rig, ported from the rain-system project:
 *   - RoomEnvironment image-based lighting (soft, neutral reflections)
 *   - warm hard key light (casts the shadows) + cool fill + warm rim spotlight
 *   - dim ambient so nothing reads pure black
 *   - dark background with light exponential fog, AgX tone mapping at exposure 0.8
 * Light positions are fitted to the live building bounds so any size stays framed.
 */
import {
  Scene, WebGLRenderer, DirectionalLight, SpotLight, AmbientLight, Vector3, Color,
  PMREMGenerator, PCFSoftShadowMap, FogExp2, AgXToneMapping, ACESFilmicToneMapping,
  NoToneMapping, Texture,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type GUI from "lil-gui";
import type { Controller } from "lil-gui";
import { loadBlenderStudioEnvironment } from "./blender-studio-environment";

export interface Bounds {
  center: Vector3;
  radius: number;
}

const BG = 0x05060a;
const KEY_DIR = new Vector3(8, 12, 6).normalize();
const FILL_DIR = new Vector3(-9, 5, -4).normalize();
const RIM_DIR = new Vector3(-6, 8, -10).normalize();

export type ToneMappingMode = "AgX" | "ACES" | "None" | "Blender Standard (LUT)";
export type EnvironmentMode = "Studio (Room)" | "Blender studio EXR";

const BASE_AMBIENT_INTENSITY = 0.4;
const AO_AMBIENT_INTENSITY = 0.32;

export class Environment {
  readonly key = new DirectionalLight(0xfff1dd, 3.0);   // warm, hard, shadows
  readonly fill = new DirectionalLight(0x4a6cff, 0.6);  // cool fill
  readonly rim = new SpotLight(0xffd9a0, 120, 50, Math.PI * 0.25, 0.4, 1.2); // warm back light
  readonly ambient = new AmbientLight(0x223044, BASE_AMBIENT_INTENSITY);

  settings = {
    // AgX compresses the building's working range more than the former ACES setup.
    // 0.8 (up from the effective 0.5) keeps its practical midtones at a similar level.
    exposure: 0.8,
    toneMapping: "AgX" as ToneMappingMode,
    environment: "Studio (Room)" as EnvironmentMode,
    envIntensity: 0.35,
    fog: true,
    fogDensity: 0.006,
  };

  private scene: Scene;
  private renderer: WebGLRenderer;
  private roomEnvironment: Texture;
  private blenderEnvironment: Texture | null = null;
  private environmentRequest = 0;
  private blenderProfileAvailable = false;
  private blenderEnvironmentAvailable = false;
  private toneMappingController: Controller | null = null;
  private environmentController: Controller | null = null;
  private onBlenderProfileChange: (enabled: boolean) => void = () => {};
  private ambientOcclusionEnabled = false;
  private disposed = false;

  constructor(scene: Scene, renderer: WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;

    scene.background = new Color(BG);
    scene.fog = new FogExp2(BG, this.settings.fogDensity);

    // Image-based lighting: soft neutral studio reflections. Keep the generated
    // texture so the comparison EXR can be selected without losing the default.
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.roomEnvironment = pmrem.fromScene(room, 0.04).texture;
    scene.environment = this.roomEnvironment;
    room.dispose();
    pmrem.dispose();
    scene.environmentIntensity = this.settings.envIntensity;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;

    const s = this.key.shadow;
    this.key.castShadow = true;
    s.mapSize.set(2048, 2048);
    s.bias = -0.0002;
    s.normalBias = 0.02;

    scene.add(this.key, this.key.target);
    scene.add(this.fill);
    scene.add(this.rim, this.rim.target);
    scene.add(this.ambient);
  }

  /** fit the light positions + shadow frustum around the current building bounds */
  frame(b: Bounds): void {
    const dist = Math.max(b.radius * 2.4, 20);

    this.key.position.copy(b.center).addScaledVector(KEY_DIR, dist);
    this.key.target.position.copy(b.center);
    this.key.target.updateMatrixWorld();

    this.fill.position.copy(b.center).addScaledVector(FILL_DIR, dist);

    this.rim.position.copy(b.center).addScaledVector(RIM_DIR, dist);
    this.rim.target.position.copy(b.center);
    this.rim.target.updateMatrixWorld();
    this.rim.distance = dist * 2.4;
    this.rim.angle = Math.atan2(b.radius * 1.5, dist);

    const cam = this.key.shadow.camera;
    const r = b.radius * 1.3;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.5;
    cam.far = dist + b.radius * 3;
    cam.updateProjectionMatrix();
  }

  /** re-apply settings (used by the GUI + dev hook) */
  refresh(): void {
    this.applyToneMapping();
    this.renderer.toneMappingExposure = this.settings.exposure;
    this.scene.environmentIntensity = this.settings.envIntensity;
    this.ambient.intensity = this.ambientOcclusionEnabled
      ? AO_AMBIENT_INTENSITY
      : BASE_AMBIENT_INTENSITY;
    const fog = this.scene.fog as FogExp2 | null;
    if (fog) fog.density = this.settings.fog ? this.settings.fogDensity : 0;
  }

  /** Keep display-pass selection in sync without making Environment own PostFX. */
  setBlenderProfileHandler(handler: (enabled: boolean) => void): void {
    this.onBlenderProfileChange = handler;
    this.applyToneMapping();
  }

  /** Add/remove the LUT choice only after its asset has validated. */
  setBlenderProfileAvailable(available: boolean): void {
    this.blenderProfileAvailable = available;
    this.toneMappingController?.options(this.toneMappingOptions());
    if (!available && this.settings.toneMapping === "Blender Standard (LUT)") {
      this.settings.toneMapping = "AgX";
      this.applyToneMapping();
      this.toneMappingController?.updateDisplay();
    }
  }

  /** GTAO supplies local crevice shading, so trim the flat ambient fill by 20%. */
  setAmbientOcclusionEnabled(enabled: boolean): void {
    this.ambientOcclusionEnabled = enabled;
    this.ambient.intensity = enabled ? AO_AMBIENT_INTENSITY : BASE_AMBIENT_INTENSITY;
  }

  private toneMappingOptions(): ToneMappingMode[] {
    const modes: ToneMappingMode[] = ["AgX", "ACES", "None"];
    if (this.blenderProfileAvailable) modes.push("Blender Standard (LUT)");
    return modes;
  }

  private environmentOptions(): EnvironmentMode[] {
    const modes: EnvironmentMode[] = ["Studio (Room)"];
    if (this.blenderEnvironmentAvailable) modes.push("Blender studio EXR");
    return modes;
  }

  private applyToneMapping(): void {
    const useBlenderProfile = this.settings.toneMapping === "Blender Standard (LUT)"
      && this.blenderProfileAvailable;
    if (useBlenderProfile) this.renderer.toneMapping = NoToneMapping;
    else if (this.settings.toneMapping === "ACES") this.renderer.toneMapping = ACESFilmicToneMapping;
    else if (this.settings.toneMapping === "None") this.renderer.toneMapping = NoToneMapping;
    else this.renderer.toneMapping = AgXToneMapping;
    this.onBlenderProfileChange(useBlenderProfile);
  }

  private async applyEnvironment(): Promise<void> {
    const request = ++this.environmentRequest;
    if (this.settings.environment === "Studio (Room)") {
      this.scene.environment = this.roomEnvironment;
      return;
    }
    try {
      if (!this.blenderEnvironment) {
        const source = await loadBlenderStudioEnvironment();
        if (this.disposed) return;
        const pmrem = new PMREMGenerator(this.renderer);
        this.blenderEnvironment = pmrem.fromEquirectangular(source).texture;
        this.blenderEnvironment.name = "PMREM: Blender studio EXR";
        pmrem.dispose();
      }
      if (request === this.environmentRequest && !this.disposed) {
        this.scene.environment = this.blenderEnvironment;
      }
    } catch (error) {
      if (request !== this.environmentRequest || this.disposed) return;
      console.warn("Blender studio environment is unavailable; using RoomEnvironment.", error);
      this.blenderEnvironmentAvailable = false;
      this.settings.environment = "Studio (Room)";
      this.scene.environment = this.roomEnvironment;
      this.environmentController?.options(this.environmentOptions());
      this.environmentController?.updateDisplay();
    }
  }

  /** no per-frame work — the environment map is baked once */
  tick(): void {}

  addGui(gui: GUI): void {
    const f = gui.addFolder("lighting");
    this.toneMappingController = f.add(
      this.settings,
      "toneMapping",
      this.toneMappingOptions(),
    ).name("tone mapping").onChange(() => this.applyToneMapping());
    f.add(this.settings, "exposure", 0, 3, 0.01).name("exposure")
      .onChange((v: number) => (this.renderer.toneMappingExposure = v));
    this.environmentController = f.add(
      this.settings,
      "environment",
      this.environmentOptions(),
    ).name("environment").onChange(() => void this.applyEnvironment());
    f.add(this.key, "intensity", 0, 8, 0.01).name("key");
    f.add(this.fill, "intensity", 0, 4, 0.01).name("fill");
    f.add(this.rim, "intensity", 0, 400, 1).name("rim");
    f.add(this.settings, "envIntensity", 0, 2, 0.01).name("env / IBL")
      .onChange((v: number) => (this.scene.environmentIntensity = v));
    f.add(this.settings, "fog").name("fog").onChange(() => this.refresh());
    f.add(this.settings, "fogDensity", 0, 0.03, 0.0005).name("fog density")
      .onChange(() => this.refresh());
    f.close();

    // Parsing the bundled EXR is the availability check. A missing or invalid
    // asset never becomes a visible GUI option.
    void loadBlenderStudioEnvironment().then(() => {
      if (this.disposed) return;
      this.blenderEnvironmentAvailable = true;
      this.environmentController?.options(this.environmentOptions());
    }).catch(() => {
      // Graceful absence: RoomEnvironment remains the only visible choice.
    });
  }

  dispose(): void {
    this.disposed = true;
    this.environmentRequest++;
    if (this.scene.environment === this.roomEnvironment || this.scene.environment === this.blenderEnvironment) {
      this.scene.environment = null;
    }
    this.roomEnvironment.dispose();
    this.blenderEnvironment?.dispose();
  }
}
