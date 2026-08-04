import GUI from 'lil-gui';
import type { CrystalPaletteName } from '../geometry-painter/modes/crystals';
import type { AuroraPaletteName } from '../geometry-painter/modes/aurora';
import type { ReefPaletteName } from '../geometry-painter/modes/reef';
import { windSettings } from '../vegetation-generator/wind';
import { listLibraryShapes } from '../base-shape-catalog';
import { GENERATORS, type App, type Generator, type ModelKind } from './app';

const GENERATOR_PRESENTATION: Record<Generator, {
  code: string;
  shortLabel: string;
  family: string;
  description: string;
}> = {
  Ivy: {
    code: 'IV',
    shortLabel: 'Ivy',
    family: 'Growth painter',
    description: 'Paint branching ivy across the active surface.',
  },
  Tree: {
    code: 'TR',
    shortLabel: 'Tree',
    family: 'Ground generator',
    description: 'Grow and shape a procedural banyan from the ground.',
  },
  Crystals: {
    code: 'CR',
    shortLabel: 'Crystals',
    family: 'Surface growth',
    description: 'Paint animated crystal clusters onto the model.',
  },
  'Molten fissures': {
    code: 'MF',
    shortLabel: 'Molten',
    family: 'Surface effect',
    description: 'Draw branching, emissive cracks through the surface.',
  },
  'Aurora silk': {
    code: 'AU',
    shortLabel: 'Aurora',
    family: 'Flow painter',
    description: 'Unfurl luminous curtains along painted paths.',
  },
  'Bioluminescent reef': {
    code: 'RF',
    shortLabel: 'Bio reef',
    family: 'Colony painter',
    description: 'Grow pulsing reef colonies over the model.',
  },
};

/**
 * One GUI for every generator. Folders scope to the active generator; the
 * Model, Drawing, Look, and Growth folders are shared by all of them (the
 * banyan hides the model/drawing folders — it grows from the ground, not
 * from strokes).
 */
export function buildGui(app: App): GUI {
  // The generator choices and active options flank the viewport as separate
  // Studio docks. On mobile, the shell presents the same two containers as tabs.
  const selectorDock = document.getElementById('surface-painter-generator-dock');
  const optionsDock = document.getElementById('surface-painter-gui-dock');
  const shell = selectorDock && optionsDock
    ? buildGeneratorShell(selectorDock, optionsDock)
    : null;
  const gui = new GUI({ title: 'Surface Painter', ...(shell ? { container: shell.options } : {}) });
  gui.domElement.classList.add('surface-painter-gui');
  const s = app.settings;
  const t = app.treeParams;
  const c = app.crystal;
  const f = app.fissure;
  const a = app.aurora;
  const r = app.reef;

  // Live edits snap existing strokes to fully grown / update them in place, scoped so
  // dragging one generator's slider never rebuilds another's output.
  const liveIvy = () => app.scheduleRegrow('instant', 'ivy');
  const liveTree = () => app.scheduleRegrow('instant', 'tree');
  const liveVegetation = () => app.scheduleRegrow('instant', 'vegetation');
  const liveCrystal = () => app.updateModeSettings('Crystals');
  const liveFissure = () => app.updateModeSettings('Molten fissures');
  const liveAurora = () => app.updateModeSettings('Aurora silk');
  const liveReef = () => app.updateModeSettings('Bioluminescent reef');

  const paintFolders: GUI[] = [];  // shared by every stroke generator (hidden for Tree)
  const perGenerator: Partial<Record<Generator, GUI[]>> = {};
  const folderFor = (g: Generator, folder: GUI): void => {
    (perGenerator[g] ??= []).push(folder);
  };

  const generatorController = gui.add(s, 'generator', GENERATORS).name('Generator').onChange((g: Generator) => {
    app.setGenerator(g);
    syncFolders(g);
  });
  generatorController.domElement.classList.add('paint-generator-controller');
  generatorController.domElement.hidden = Boolean(shell);

  if (shell) {
    for (const generator of GENERATORS) {
      const button = shell.buttons.get(generator);
      button?.addEventListener('click', () => generatorController.setValue(generator));
    }
  }

  // ---------- shared: model + drawing ----------

  const fModel = gui.addFolder('Model');
  fModel.domElement.classList.add('paint-shared-model-node');
  fModel
    .add(s, 'model', ['Sphere', 'Torus Knot', 'Box', 'Cylinder'] satisfies ModelKind[])
    .name('Preset')
    .onChange((v: ModelKind) => app.setModel(v));
  // The ported reference-object catalog loads async; the dropdown appears once known.
  const libraryState = { reference: 'None' };
  void listLibraryShapes()
    .then((shapes) => {
      fModel
        .add(libraryState, 'reference', ['None', ...shapes.map((shape) => shape.title)])
        .name('Reference object')
        .onChange((title: string) => {
          const info = shapes.find((shape) => shape.title === title);
          if (info) void app.loadLibraryModel(info);
        });
    })
    .catch(() => { /* catalog unavailable — presets and GLB upload remain */ });
  fModel.add({ load: () => pickGlb(app) }, 'load').name('Load .glb…');
  // Rescaling the surface invalidates painted strokes, so this clears them on change.
  const modelScaleController = fModel.add(s, 'modelScale', 0.2, 3).name('Model scale').listen()
    .onChange((v: number) => app.setModelScale(v));
  modelScaleController.domElement.title = 'Changing the model scale clears painted strokes.';
  paintFolders.push(fModel);

  const fDraw = gui.addFolder('Drawing');
  fDraw.domElement.classList.add('paint-shared-drawing-node');
  fDraw.add(s, 'drawMode').name('Draw mode (D)').listen().onChange(() => app.applyModes());
  fDraw.add({ undo: () => app.undoLast() }, 'undo').name('Undo last stroke');
  const clearController = fDraw.add({ clear: () => app.clearAll() }, 'clear').name('Clear all strokes');
  clearController.domElement.classList.add('paint-destructive-action');
  paintFolders.push(fDraw);

  // ---------- ivy ----------

  const fShape = gui.addFolder('Ivy shape (live)');
  fShape.add(s, 'stemRadius', 0.003, 0.03).name('Stem radius').onChange(liveIvy);
  fShape.add(s, 'branchDensity', 0, 14, 1).name('Branches / unit').onChange(liveIvy);
  fShape.add(s, 'branchLength', 0.1, 1.5).name('Branch length').onChange(liveIvy);
  fShape.add(s, 'wander', 0, 1).name('Wildness').onChange(liveIvy);
  fShape.add(s, 'extend', 0, 3).name('Overgrow past stroke').onChange(liveIvy);
  folderFor('Ivy', fShape);

  const fIvyLeaves = gui.addFolder('Ivy leaves (live)');
  fIvyLeaves.add(s, 'leafDensity', 0, 30).name('Density').onChange(liveIvy);
  // Size is a pure rescale of existing instances — instant, no regrow.
  fIvyLeaves.add(s, 'leafSize', 0.03, 0.25).name('Size').onChange((v: number) => app.setIvyLeafSize(v));
  folderFor('Ivy', fIvyLeaves);

  // Flower sites regrow live; blooming itself happens with the F brush (hover the ivy).
  const fFlowers = gui.addFolder('Flowers (F to brush)');
  fFlowers.add(s, 'flowerDensity', 0, 8).name('Bud sites / unit').onChange(liveIvy);
  fFlowers.add(s, 'flowerSize', 0.05, 0.3).name('Size').onChange((v: number) => app.setIvyFlowerSize(v));
  fFlowers.add(s, 'flowerBrush', 0.08, 0.6).name('Brush radius');
  fFlowers.add({ bloom: () => app.bloomAll() }, 'bloom').name('🌼 Bloom all');
  fFlowers.add({ reset: () => app.resetBlooms() }, 'reset').name('Reset blooms');
  folderFor('Ivy', fFlowers);

  // ---------- banyan tree ----------

  const fTrunk = gui.addFolder('Trunk & limbs (live)');
  fTrunk.add(t, 'trunkHeight', 0.4, 2).name('Trunk height').onChange(liveTree);
  fTrunk.add(t, 'trunkGirth', 0.08, 0.4).name('Trunk girth').onChange(liveTree);
  fTrunk.add(t, 'buttress', 0, 1).name('Buttress roots').onChange(liveTree);
  fTrunk.add(t, 'limbs', 2, 8, 1).name('Main limbs').onChange(liveTree);
  fTrunk.add(t, 'limbLength', 0.6, 2.4).name('Limb length').onChange(liveTree);
  fTrunk.add(t, 'spread', 0, 1).name('Crown spread').onChange(liveTree);
  fTrunk.add(t, 'gnarl', 0, 1).name('Gnarl').onChange(liveTree);
  fTrunk.add(t, 'splits', 1, 3, 1).name('Fork generations').onChange(liveTree);
  folderFor('Tree', fTrunk);

  const fCanopy = gui.addFolder('Canopy (live)');
  fCanopy.add(t, 'clumpSize', 0.15, 0.8).name('Clump size').onChange((v: number) => app.setTreeClumpSize(v));
  fCanopy.add(t, 'clumpDensity', 0, 140, 1).name('Sprigs per clump').onChange(liveTree);
  // Size and hue update existing instances in place — instant, no regrow.
  fCanopy.add(t, 'leafSize', 0.06, 0.35).name('Sprig size').onChange((v: number) => app.setTreeLeafSize(v));
  fCanopy.add(t, 'leafHue', 0.05, 0.35).name('Hue (autumn ↔ green)').onChange((v: number) => app.setTreeLeafHue(v));
  folderFor('Tree', fCanopy);

  const fVines = gui.addFolder('Hanging vines (live)');
  fVines.add(t, 'vineCount', 0, 60, 1).name('Count').onChange(liveTree);
  fVines.add(t, 'vineLength', 0.2, 2).name('Length').onChange(liveTree);
  folderFor('Tree', fVines);

  // A banyan is a ficus — its flowers ARE the figs. F-brush the twigs to ripen them.
  const fFigs = gui.addFolder('Figs (F to brush)');
  fFigs.add(t, 'figDensity', 0, 8, 1).name('Figs per twig').onChange(liveTree);
  fFigs.add(t, 'figSize', 0.02, 0.12).name('Size').onChange((v: number) => app.setTreeFigSize(v));
  fFigs.add(s, 'flowerBrush', 0.08, 0.6).name('Brush radius');
  fFigs.add({ ripen: () => app.ripenAll() }, 'ripen').name('🍈 Ripen all');
  fFigs.add({ reset: () => app.resetRipe() }, 'reset').name('Reset figs');
  folderFor('Tree', fFigs);

  // Read at pointer-time — no regrow, acts immediately on the next push.
  const fInteract = gui.addFolder('Interaction (live)');
  fInteract.add(s, 'pushForce', 0.1, 4).name('Push force');
  folderFor('Tree', fInteract);

  // ---------- crystals ----------

  const fCrystal = gui.addFolder('Crystals (live)');
  const palettes: CrystalPaletteName[] = ['Amethyst', 'Ice', 'Emerald', 'Citrine', 'Rose', 'Prism'];
  fCrystal.add(c, 'palette', palettes).name('Palette').onChange(liveCrystal);
  fCrystal.add(c, 'clusterDensity', 1, 16).name('Clusters / unit').onChange(liveCrystal);
  fCrystal.add(c, 'crystalSize', 0.06, 0.4).name('Crystal size').onChange(liveCrystal);
  fCrystal.add(c, 'shards', 0, 16, 1).name('Shards / cluster').onChange(liveCrystal);
  fCrystal.add(c, 'spread', 0.3, 2.5).name('Cluster spread').onChange(liveCrystal);
  fCrystal.add(c, 'tilt', 0, 1).name('Lean / wildness').onChange(liveCrystal);
  fCrystal.add(c, 'sizeJitter', 0, 1).name('Size variety').onChange(liveCrystal);
  fCrystal.add(c, 'clearMix', 0, 1).name('Clear crystal mix').onChange(liveCrystal);
  // Glow retints shared materials in place — instant, no regrow.
  fCrystal.add(c, 'glow', 0, 2).name('Inner glow').onChange((v: number) => app.setGlow(v));
  fCrystal.add(c, 'growthSpeed', 0.2, 4).name('Growth speed').onChange(liveCrystal);
  folderFor('Crystals', fCrystal);

  // ---------- molten fissures ----------

  const fFissure = gui.addFolder('Molten fissures (live)');
  fFissure.add(f, 'width', 0.02, 0.16).name('Crack width').onChange(liveFissure);
  fFissure.add(f, 'heat', 0.2, 3).name('Heat').onChange(liveFissure);
  fFissure.add(f, 'pulseSpeed', 0, 3).name('Pulse speed').onChange(liveFissure);
  fFissure.add(f, 'branchDensity', 0, 8).name('Branches / unit').onChange(liveFissure);
  fFissure.add(f, 'branchLength', 0.05, 0.6).name('Branch length').onChange(liveFissure);
  fFissure.add(f, 'emberRate', 0, 80).name('Embers').onChange(liveFissure);
  fFissure.add(f, 'rockDensity', 0, 30).name('Rock lips / unit').onChange(liveFissure);
  fFissure.add(f, 'rockSize', 0.03, 0.2).name('Rock size').onChange(liveFissure);
  fFissure.add(f, 'lightSpill', 0, 3).name('Light spill').onChange(liveFissure);
  fFissure.add(f, 'growthSpeed', 0.5, 6).name('Crack speed').onChange(liveFissure);
  folderFor('Molten fissures', fFissure);

  // ---------- aurora silk ----------

  const fAurora = gui.addFolder('Aurora silk (live)');
  const auroraPalettes: AuroraPaletteName[] = ['Borealis', 'Twilight', 'Ember', 'Spectrum'];
  fAurora.add(a, 'palette', auroraPalettes).name('Palette').onChange(liveAurora);
  fAurora.add(a, 'height', 0.15, 1.3).name('Curtain height').onChange(liveAurora);
  fAurora.add(a, 'wave', 0, 1).name('Billow').onChange(liveAurora);
  fAurora.add(a, 'flow', 0, 3).name('Flow speed').onChange(liveAurora);
  fAurora.add(a, 'rays', 0, 1).name('Ray streaks').onChange(liveAurora);
  fAurora.add(a, 'brightness', 0.2, 2.5).name('Brightness').onChange(liveAurora);
  fAurora.add(a, 'sparkles', 0, 240, 1).name('Star motes').onChange(liveAurora);
  fAurora.add(a, 'lightSpill', 0, 3).name('Light spill').onChange(liveAurora);
  fAurora.add(a, 'growthSpeed', 0.3, 4).name('Unfurl speed').onChange(liveAurora);
  folderFor('Aurora silk', fAurora);

  // ---------- bioluminescent reef ----------

  const fReef = gui.addFolder('Bioluminescent reef (live)');
  const reefPalettes: ReefPaletteName[] = ['Abyss', 'Tropic', 'Ghost', 'Toxic'];
  fReef.add(r, 'palette', reefPalettes).name('Palette').onChange(liveReef);
  fReef.add(r, 'colonySize', 0.08, 0.35).name('Colony size').onChange(liveReef);
  fReef.add(r, 'density', 2, 14).name('Colonies / unit').onChange(liveReef);
  fReef.add(r, 'branching', 0, 1).name('Branching').onChange(liveReef);
  fReef.add(r, 'tendrils', 0, 14, 1).name('Anemone arms').onChange(liveReef);
  fReef.add(r, 'glow', 0, 2.5).name('Bioluminescence').onChange(liveReef);
  fReef.add(r, 'pulseSpeed', 0, 3).name('Pulse speed').onChange(liveReef);
  fReef.add(r, 'sway', 0, 1).name('Current sway').onChange(liveReef);
  fReef.add(r, 'plankton', 0, 220, 1).name('Plankton').onChange(liveReef);
  fReef.add(r, 'lightSpill', 0, 3).name('Light spill').onChange(liveReef);
  fReef.add(r, 'growthSpeed', 0.3, 4).name('Bloom speed').onChange(liveReef);
  folderFor('Bioluminescent reef', fReef);

  // ---------- shared: wind (vegetation), look, growth ----------

  // Wind is read by every plant each frame — sliders act immediately, no regrow needed.
  const fWind = gui.addFolder('Wind (live)');
  fWind.add(windSettings, 'strength', 0, 1).name('Strength');
  fWind.add(windSettings, 'speed', 0.1, 3).name('Speed');
  fWind.add(windSettings, 'directionDeg', 0, 360, 1).name('Direction (°)');
  folderFor('Ivy', fWind);
  folderFor('Tree', fWind);

  const fLook = gui.addFolder('Look (live)');
  fLook
    .add(s, 'quality', { 'Low poly': 'low', 'Realistic (high poly)': 'high' })
    .name('Vegetation style')
    .onChange(liveVegetation);
  fLook.add(s, 'exposure', 0.4, 2.2).name('Exposure').onChange((v: number) => app.setExposure(v));
  fLook.add(s, 'seed', 0, 999, 1).name('Seed').listen().onChange(() => app.scheduleRegrow('instant'));
  fLook.add({ random: () => app.randomizeSeed() }, 'random').name('🎲 Random seed');

  // The decor family renders on the dark studio stage with a bloom pass — these
  // sliders drive that stage's rig and post chain.
  const fStudio = gui.addFolder('Studio light & bloom (live)');
  fStudio.add(s, 'envIntensity', 0, 2.5).name('Studio light').onChange((v: number) => app.setEnvIntensity(v));
  fStudio.add(s, 'backlight', 0, 2.5).name('Backlight').onChange((v: number) => app.setBacklight(v));
  fStudio.add(s, 'bloomStrength', 0, 1.5).name('Bloom').onChange((v: number) => app.setBloomStrength(v));
  fStudio.add(s, 'bloomThreshold', 0.2, 1.5).name('Bloom threshold').onChange((v: number) => app.setBloomThreshold(v));
  folderFor('Crystals', fStudio);
  folderFor('Molten fissures', fStudio);
  folderFor('Aurora silk', fStudio);
  folderFor('Bioluminescent reef', fStudio);

  // Growth speed only shows while a plant animates, so it is NOT live — press Replay to preview.
  const fGrowth = gui.addFolder('Growth animation');
  fGrowth.add(s, 'growthSpeed', 0.1, 3).name('Vegetation speed');
  fGrowth.add({ redraw: () => app.scheduleRegrow('animate') }, 'redraw').name('▶ Replay growth');

  // These settings are implemented as procedural stages rather than a
  // Blender-authored Geometry Nodes graph. Present each stage as a compact
  // node card so the inspector shares the Studio visual language while the
  // existing lil-gui controllers keep their proven live-update behavior.
  decorateNode(fModel, 'Model', 'INPUT', 'source');
  decorateNode(fDraw, 'Drawing', 'TOOLS', 'interaction');
  decorateNode(fShape, 'Ivy shape', 'LIVE', 'generator');
  decorateNode(fIvyLeaves, 'Ivy leaves', 'LIVE', 'generator');
  decorateNode(fFlowers, 'Flowers', 'BRUSH', 'interaction');
  decorateNode(fTrunk, 'Trunk & limbs', 'LIVE', 'generator');
  decorateNode(fCanopy, 'Canopy', 'LIVE', 'generator');
  decorateNode(fVines, 'Hanging vines', 'LIVE', 'generator');
  decorateNode(fFigs, 'Figs', 'BRUSH', 'interaction');
  decorateNode(fInteract, 'Interaction', 'LIVE', 'interaction');
  decorateNode(fCrystal, 'Crystals', 'LIVE', 'generator');
  decorateNode(fFissure, 'Molten fissures', 'LIVE', 'generator');
  decorateNode(fAurora, 'Aurora silk', 'LIVE', 'generator');
  decorateNode(fReef, 'Bioluminescent reef', 'LIVE', 'generator');
  decorateNode(fWind, 'Wind', 'LIVE', 'simulation');
  decorateNode(fLook, 'Look', 'LIVE', 'render');
  decorateNode(fStudio, 'Studio light & bloom', 'LIVE', 'render');
  decorateNode(fGrowth, 'Growth animation', 'PLAYBACK', 'animation');

  // Keep the primary construction stages open and tuck secondary/detail
  // stages away. Their state remains user-controlled after first render.
  [fIvyLeaves, fFlowers, fCanopy, fVines, fFigs, fInteract, fWind, fLook, fStudio, fGrowth]
    .forEach((folder) => folder.close());

  function syncFolders(active: Generator): void {
    for (const folder of paintFolders) (active === 'Tree' ? folder.hide() : folder.show());
    const shown = new Set(perGenerator[active] ?? []);
    for (const g of GENERATORS) {
      for (const folder of perGenerator[g] ?? []) {
        if (shown.has(folder)) folder.show();
        else folder.hide();
      }
    }
    shell?.select(active);
  }
  syncFolders(s.generator);

  return gui;
}

function buildGeneratorShell(selectorDock: HTMLElement, optionsDock: HTMLElement): {
  options: HTMLDivElement;
  buttons: Map<Generator, HTMLButtonElement>;
  select: (generator: Generator) => void;
} {
  selectorDock.replaceChildren();
  optionsDock.replaceChildren();

  const selector = document.createElement('nav');
  selector.className = 'paint-generator-selector';
  selector.setAttribute('aria-label', 'Surface generator');

  const selectorLabel = document.createElement('span');
  selectorLabel.className = 'paint-generator-selector-label';
  selectorLabel.textContent = 'Generators';
  selector.appendChild(selectorLabel);

  const buttons = new Map<Generator, HTMLButtonElement>();
  for (const generator of GENERATORS) {
    const presentation = GENERATOR_PRESENTATION[generator];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paint-generator-option';
    button.dataset.generator = generator;
    button.setAttribute('aria-label', generator);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', 'paint-generator-options');

    const glyph = document.createElement('span');
    glyph.className = 'paint-generator-glyph';
    glyph.textContent = presentation.code;
    glyph.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'paint-generator-label';
    label.textContent = presentation.shortLabel;

    button.append(glyph, label);
    selector.appendChild(button);
    buttons.set(generator, button);
  }

  const panel = document.createElement('section');
  panel.id = 'paint-generator-options';
  panel.className = 'paint-generator-panel';

  const context = document.createElement('header');
  context.className = 'paint-generator-context';
  context.setAttribute('aria-live', 'polite');

  const contextCopy = document.createElement('span');
  const family = document.createElement('small');
  family.className = 'paint-generator-family';
  const title = document.createElement('strong');
  title.className = 'paint-generator-active-title';
  const description = document.createElement('span');
  description.className = 'paint-generator-description';
  contextCopy.append(family, title, description);

  const live = document.createElement('span');
  live.className = 'paint-generator-live';
  live.textContent = 'Live';
  context.append(contextCopy, live);

  const options = document.createElement('div');
  options.className = 'paint-generator-options';
  panel.append(context, options);
  selectorDock.appendChild(selector);
  optionsDock.appendChild(panel);

  return {
    options,
    buttons,
    select(generator: Generator): void {
      const presentation = GENERATOR_PRESENTATION[generator];
      family.textContent = presentation.family;
      title.textContent = generator;
      description.textContent = presentation.description;
      panel.setAttribute('aria-label', `${generator} options`);
      for (const [value, button] of buttons) {
        const active = value === generator;
        button.setAttribute('aria-pressed', String(active));
        button.toggleAttribute('data-active', active);
      }
    },
  };
}

function decorateNode(
  folder: GUI,
  title: string,
  tag: string,
  tone: 'source' | 'interaction' | 'generator' | 'simulation' | 'render' | 'animation',
): void {
  folder.title(title);
  folder.domElement.classList.add('paint-node', `paint-node-${tone}`);

  const label = document.createElement('span');
  label.className = 'paint-node-title';
  label.textContent = title;

  const badge = document.createElement('span');
  badge.className = 'paint-node-badge';
  badge.textContent = tag;
  badge.setAttribute('aria-hidden', 'true');

  folder.$title.replaceChildren(label, badge);
}

function pickGlb(app: App): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.glb,.gltf';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void app.loadGlbFile(file);
  };
  input.click();
}
