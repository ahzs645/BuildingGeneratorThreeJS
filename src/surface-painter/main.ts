import * as THREE from 'three/webgpu';
import type { ToolHandle } from '../react/page-runtime';
import type { LibraryShapeInfo } from '../base-shape-catalog';
import type { Dump } from '../gnvm/index';
import {
  chromeCrayonAdapter,
  installChromeCrayonDump,
  periodicBrushAdapter,
  stampAdapter,
  typewriterAdapter,
} from '../surface-studio/blender-gn-adapters';
import type {
  DrawingAreaState,
  ProjectionTarget,
  SurfaceGeneratorId,
  SurfaceInteractionMode,
} from '../surface-studio/contracts';
import { DrawingAreaController } from '../surface-studio/drawing-area-controller';
import { DrawingAreaOverlay } from '../surface-studio/drawing-area-overlay';
import {
  DrawingAreaTransformGizmo,
  type DrawingAreaGizmoSpace,
} from '../surface-studio/drawing-area-transform-gizmo';
import { SurfaceSelectionGuides } from '../surface-studio/surface-selection-guides';
import { attachSurfaceStudioRuntime } from '../surface-studio/attach-app-host';
import { SelectionMaskDocument, type SelectionMaskOperation } from '../selection-mask-document';
import { relaxClothLattice } from '../cloth-lattice-relaxation';
import { App, type Generator, type ModelKind } from './app';

interface SurfaceControlOption {
  readonly value: string;
  readonly label: string;
}

const PROCEDURAL_GENERATOR: Readonly<Partial<Record<SurfaceGeneratorId, Generator>>> = {
  ivy: 'Ivy',
  tree: 'Tree',
  crystals: 'Crystals',
  molten: 'Molten fissures',
  aurora: 'Aurora silk',
  reef: 'Bioluminescent reef',
};

const BLENDER_GENERATORS = new Set<SurfaceGeneratorId>([
  'chrome-crayon',
  'periodic-brush',
  'typewriter',
  'stamp',
]);

const BLENDER_ADAPTERS = [
  chromeCrayonAdapter,
  periodicBrushAdapter,
  typewriterAdapter,
  stampAdapter,
] as const;

export interface SurfacePainterStudioSnapshot {
  readonly activeTool: SurfaceGeneratorId;
  readonly interactionMode: SurfaceInteractionMode;
  readonly modelPreset: ModelKind;
  readonly referenceObject: string;
  readonly projectionTarget: ProjectionTarget;
  readonly projectionTargets: readonly SurfaceControlOption[];
  readonly canUndo: boolean;
  readonly canClear: boolean;
  readonly hasDrawingArea: boolean;
  readonly areaCommitted: boolean;
  readonly areaContact: boolean;
  readonly areaClosestContactDistance: number | null;
  readonly areaSize: number;
  readonly projectionHeight: number;
  readonly projectionContactDepth: number;
  readonly projectionMaxAngle: number;
  readonly projectionSurfaceOffset: number;
  readonly projectionContactSoftness: number;
  readonly selectorLayers: readonly SurfaceSelectorLayerSnapshot[];
  readonly activeSelectorId: string;
  readonly contactLocked: boolean;
  readonly clothEnabled: boolean;
  readonly clothSag: number;
  readonly drapeStretch: number;
  readonly drapeIterations: number;
  readonly areaPosition: readonly [number, number, number];
  readonly areaRotation: readonly [number, number, number];
  readonly areaScale: readonly [number, number, number];
  readonly placementHover: SurfacePlacementHoverSnapshot | null;
  readonly gizmoSpace: DrawingAreaGizmoSpace;
  readonly gizmoSnap: boolean;
  readonly strokeCount: number;
  readonly surfaceRevision: number;
}

export interface SurfacePlacementHoverSnapshot {
  readonly x: number;
  readonly y: number;
  readonly hit: boolean;
  readonly label: string;
}

export interface SurfaceSelectorLayerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly operation: SelectionMaskOperation;
  readonly visible: boolean;
  readonly locked: boolean;
}

export interface SurfacePainterToolHandle extends ToolHandle {
  snapshot(): SurfacePainterStudioSnapshot;
  subscribe(listener: (snapshot: SurfacePainterStudioSnapshot) => void): () => void;
  setActiveTool(tool: SurfaceGeneratorId): Promise<void>;
  setInteractionMode(mode: SurfaceInteractionMode): void;
  setModelPreset(model: ModelKind): void;
  loadReferenceObject(info: LibraryShapeInfo): Promise<void>;
  importSurface(file: File): Promise<void>;
  setProjectionTarget(target: ProjectionTarget): void;
  setAreaSize(value: number): void;
  setProjectionHeight(value: number): void;
  setProjectionContactDepth(value: number): void;
  setProjectionMaxAngle(value: number): void;
  setProjectionSurfaceOffset(value: number): void;
  setProjectionContactSoftness(value: number): void;
  setGizmoSpace(space: DrawingAreaGizmoSpace): void;
  setGizmoSnap(enabled: boolean): void;
  createSelector(): void;
  deleteSelector(): void;
  setActiveSelector(id: string): void;
  setSelectorOperation(operation: SelectionMaskOperation): void;
  setSelectorVisible(visible: boolean): void;
  setSelectorLocked(locked: boolean): void;
  setContactLocked(locked: boolean): void;
  clearContactMask(): void;
  setClothEnabled(enabled: boolean): void;
  setClothSag(value: number): void;
  setDrapeStretch(value: number): void;
  setDrapeIterations(value: number): void;
  setAreaTransform(position: readonly number[], rotationDegrees: readonly number[], scale: readonly number[]): void;
  resetAreaTransform(): void;
  dropAreaToFirstContact(): void;
  pushAreaThrough(): void;
  nudgeArea(axis: 'u' | 'v', amount: number): void;
  rotateArea(degrees: number): void;
  projectArea(): void;
  removeArea(): void;
  undo(): void;
  clear(): void;
  settingsFor<Settings>(tool: SurfaceGeneratorId): Readonly<Settings> | undefined;
  setGeneratorSettings<Settings>(tool: SurfaceGeneratorId, settings: Readonly<Settings>): Promise<void>;
  setChromeCrayonDump(dump: Dump): Promise<void>;
}

export async function createTool(): Promise<SurfacePainterToolHandle> {
  const container = document.getElementById('surface-painter-app');
  if (!container) throw new Error('Surface Painter container was not found');

  const initialTool = toolFromLocation();
  const initialProcedural = PROCEDURAL_GENERATOR[initialTool] ?? 'Ivy';
  const app = new App(container, initialProcedural);
  await app.start();

  const host = app.getSurfaceStudioHost();
  let areaSize = 2.4;
  let projectionHeight = 0.85;
  let projectionContactDepth = 0.18;
  let projectionContactSoftness = 0.18;
  let projectionMaxAngle = 72;
  let projectionSurfaceOffset = 0.016;
  let areaController: DrawingAreaController;
  let notify = (): void => {};
  let placementHover: SurfacePlacementHoverSnapshot | null = null;

  const attached = attachSurfaceStudioRuntime(
    host,
    BLENDER_ADAPTERS,
    BLENDER_GENERATORS.has(initialTool) ? initialTool : 'chrome-crayon',
    {
      onPlaceArea({ hit }) {
        if (!hit) return;
        const layer = activeSelectorLayer();
        if (layer.locked) return;
        const placed = areaController.place(hit, { size: areaSize, projectionHeight });
        layer.area = cloneArea(placed);
        layer.initialArea = cloneArea(placed);
        layer.contactLocked = false;
        placementHover = null;
        selectorMasks.clearSelectorMask(layer.id, { history: false, force: true });
        runtime.setInteractionMode('orbit');
        interactionMode = 'orbit';
        notify();
      },
      onTargetPick({ hit }) {
        app.setSharedProjectionTarget(hit.targetId);
        runtime.setInteractionMode('place-area');
        interactionMode = 'place-area';
        notify();
      },
      onPointerMove({ event, hit, mode }) {
        if (mode !== 'place-area') return;
        const rect = host.canvas.getBoundingClientRect();
        const target = hit ? runtime.projector.targets.find(({ id }) => id === hit.targetId) : null;
        placementHover = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          hit: Boolean(hit),
          label: target?.label ?? 'SURFACE',
        };
        notify();
      },
      onModeChange(mode) {
        interactionMode = mode;
        if (mode !== 'place-area') placementHover = null;
        notify();
      },
      areaPosition(hit) {
        if (!BLENDER_GENERATORS.has(activeTool)) return undefined;
        const area = areaController.area;
        if (!area || !composedSelectionAtPoint(hit.worldPosition)) return null;
        const delta = hit.worldPosition.clone().sub(new THREE.Vector3().fromArray(area.center));
        const u = delta.dot(new THREE.Vector3().fromArray(area.u));
        const v = delta.dot(new THREE.Vector3().fromArray(area.v));
        if (Math.abs(u) > area.size[0] * 0.5 || Math.abs(v) > area.size[1] * 0.5) return null;
        return [u, v];
      },
    },
  );
  const { runtime } = attached;
  areaController = new DrawingAreaController(runtime.document, runtime.projector);
  const selectionGuides = new SurfaceSelectionGuides(host.camera, runtime.projector, host.scene);
  const patchDivisions = 18;
  const patchColumns = patchDivisions + 1;
  const selectorMasks = new SelectionMaskDocument({
    vertexCount: patchColumns * patchColumns,
    cellCount: patchDivisions * patchDivisions,
  });
  interface SelectorLayerState {
    id: string;
    name: string;
    operation: SelectionMaskOperation;
    visible: boolean;
    locked: boolean;
    contactLocked: boolean;
    clothEnabled: boolean;
    clothSag: number;
    drapeStretch: number;
    drapeIterations: number;
    area: DrawingAreaState | null;
    initialArea: DrawingAreaState | null;
    overlay: DrawingAreaOverlay;
  }
  const selectorLayers = new Map<string, SelectorLayerState>();
  let selectorCounter = 1;
  let activeSelectorId = 'selector-1';
  let refreshingArea = false;
  let batchingArea = false;
  const createSelectorLayer = (
    id: string,
    name: string,
    operation: SelectionMaskOperation,
  ): SelectorLayerState => {
    selectorMasks.createSelector(id, { name, operation, history: false });
    const layer: SelectorLayerState = {
      id,
      name,
      operation,
      visible: true,
      locked: false,
      contactLocked: false,
      clothEnabled: false,
      clothSag: 0.12,
      drapeStretch: 0.15,
      drapeIterations: 8,
      area: null,
      initialArea: null,
      overlay: new DrawingAreaOverlay({ parent: host.scene }),
    };
    selectorLayers.set(id, layer);
    return layer;
  };
  createSelectorLayer(activeSelectorId, 'Selector 1', 'replace');
  function activeSelectorLayer(): SelectorLayerState {
    const layer = selectorLayers.get(activeSelectorId);
    if (!layer) throw new Error(`Missing unified selector layer ${activeSelectorId}`);
    return layer;
  }
  const layerMaskContainsPoint = (layer: SelectorLayerState, point: THREE.Vector3): boolean => {
    const area = layer.area;
    if (!area) return false;
    const delta = point.clone().sub(new THREE.Vector3().fromArray(area.center));
    const normalizedU = delta.dot(new THREE.Vector3().fromArray(area.u)) / Math.max(area.size[0], 1e-6) + 0.5;
    const normalizedV = delta.dot(new THREE.Vector3().fromArray(area.v)) / Math.max(area.size[1], 1e-6) + 0.5;
    if (normalizedU < 0 || normalizedU > 1 || normalizedV < 0 || normalizedV > 1) return false;
    const mask = selectorMasks.getSelector(layer.id).mask;
    const column = Math.min(patchDivisions - 1, Math.floor(normalizedU * patchDivisions));
    const row = Math.min(patchDivisions - 1, Math.floor(normalizedV * patchDivisions));
    if (mask.cells.includes(row * patchDivisions + column)) return true;
    const vertexColumn = Math.min(patchDivisions, Math.round(normalizedU * patchDivisions));
    const vertexRow = Math.min(patchDivisions, Math.round(normalizedV * patchDivisions));
    return mask.vertices.includes(vertexRow * patchColumns + vertexColumn);
  };
  const composedSelectionAtPoint = (point: THREE.Vector3): boolean => {
    let selected = false;
    for (const layer of selectorLayers.values()) {
      if (!layer.visible) continue;
      const inside = layerMaskContainsPoint(layer, point);
      if (layer.operation === 'replace') selected = inside;
      else if (layer.operation === 'add') selected ||= inside;
      else if (layer.operation === 'subtract') selected &&= !inside;
      else selected &&= inside;
    }
    return selected;
  };
  let gizmoSpace: DrawingAreaGizmoSpace = 'local';
  let gizmoSnap = false;
  const areaGizmo = new DrawingAreaTransformGizmo({
    controller: areaController,
    parent: host.scene,
    space: gizmoSpace,
    onTranslate(increment) {
      const area = areaController.area;
      if (!area) return;
      if (gizmoSpace === 'world') {
        areaController.translate(increment);
        return;
      }
      const normal = new THREE.Vector3().fromArray(area.normal).normalize();
      const depthDelta = increment.dot(normal);
      const tangent = increment.clone().addScaledVector(normal, -depthDelta);
      if (tangent.lengthSq() > 1e-12) areaController.translate(tangent);
      if (Math.abs(depthDelta) > 1e-12) {
        const current = areaController.area?.projectionHeight ?? projectionHeight;
        areaController.setProjectionHeight(current + depthDelta);
        projectionHeight = areaController.area?.projectionHeight ?? current + depthDelta;
      }
    },
    onDragStateChange(dragging) {
      host.controls.enabled = dragging ? false : interactionMode === 'orbit';
    },
  });
  const listeners = new Set<(snapshot: SurfacePainterStudioSnapshot) => void>();
  let activeTool = initialTool;
  let interactionMode: SurfaceInteractionMode = BLENDER_GENERATORS.has(initialTool) ? 'place-area' : 'draw';
  let referenceObject = '';
  let disposed = false;
  const unregisterSelectionGuides = host.registerFrameTask(() => {
    const blender = BLENDER_GENERATORS.has(activeTool);
    selectionGuides.update(
      blender
      && interactionMode === 'place-area'
      && areaController.area === null,
    );
    const layer = activeSelectorLayer();
    const gizmoEnabled = blender && Boolean(layer.area) && layer.visible && !layer.locked;
    areaGizmo.setSpace(gizmoSpace);
    areaGizmo.setTranslationSnap(gizmoSnap ? 0.1 : null);
    areaGizmo.setEnabled(gizmoEnabled);
    areaGizmo.setVisible(gizmoEnabled);
    areaGizmo.sync(host.camera, host.canvas.clientHeight);
  });
  const clearPlacementHover = (): void => {
    if (!placementHover) return;
    placementHover = null;
    notify();
  };
  host.canvas.addEventListener('pointerleave', clearPlacementHover);
  const onGizmoPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const hit = areaGizmo.pointerDown(event, host.canvas, host.camera);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { host.canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
  };
  const onGizmoPointerMove = (event: PointerEvent): void => {
    const dragging = areaGizmo.dragging;
    areaGizmo.pointerMove(event, host.canvas, host.camera);
    if (!dragging && !areaGizmo.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const finishGizmoPointer = (event: PointerEvent, commit: boolean): void => {
    if (!areaGizmo.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    areaGizmo.pointerUp(commit);
    try { host.canvas.releasePointerCapture(event.pointerId); } catch { /* optional */ }
    refreshAreaOverlay();
    notify();
  };
  const onGizmoPointerUp = (event: PointerEvent): void => finishGizmoPointer(event, true);
  const onGizmoPointerCancel = (event: PointerEvent): void => finishGizmoPointer(event, false);
  host.canvas.addEventListener('pointerdown', onGizmoPointerDown, true);
  host.canvas.addEventListener('pointermove', onGizmoPointerMove, true);
  host.canvas.addEventListener('pointerup', onGizmoPointerUp, true);
  host.canvas.addEventListener('pointercancel', onGizmoPointerCancel, true);
  const projectionOptions = (layer = activeSelectorLayer()) => ({
    patchDivisions,
    contactDepth: projectionContactDepth
      + projectionContactSoftness * (Math.min(layer.area?.size[0] ?? areaSize, layer.area?.size[1] ?? areaSize) / patchDivisions) * 1.5,
    surfaceOffset: projectionSurfaceOffset,
    facingThreshold: Math.cos(THREE.MathUtils.degToRad(projectionMaxAngle)),
    forceProjection: layer.contactLocked || Boolean(layer.area?.committed),
  });
  let areaProjection = areaController.project(projectionOptions());

  const updateSelectorMask = (
    layer: SelectorLayerState,
    projection: ReturnType<DrawingAreaController['project']>,
    forceAdd = false,
  ): void => {
    if (layer.locked) return;
    const touching = projection.patch?.touching ?? [];
    const vertices: number[] = [];
    const cells: number[] = [];
    for (let index = 0; index < touching.length; index++) if (touching[index]) vertices.push(index);
    for (let row = 0; row < patchDivisions; row++) for (let column = 0; column < patchDivisions; column++) {
      const a = row * patchColumns + column;
      const b = a + 1;
      const c = a + patchColumns;
      const d = c + 1;
      if (touching[a] && touching[b] && touching[c] && touching[d]) cells.push(row * patchDivisions + column);
    }
    if (layer.contactLocked || forceAdd) {
      if (vertices.length || cells.length) selectorMasks.editMask(layer.id, { vertices, cells }, 'add', { history: false, force: true });
    } else {
      selectorMasks.setSelectorMask(layer.id, { vertices, cells }, { history: false, force: true });
    }
  };

  const filteredProjection = (
    layer: SelectorLayerState,
    projection: ReturnType<DrawingAreaController['project']>,
    pointSelected: (point: THREE.Vector3) => boolean,
    active: boolean,
  ): ReturnType<DrawingAreaController['project']> => {
    const patch = projection.patch;
    if (!patch) return { ...projection, source: active ? projection.source : null };
    const selected = patch.valid.map((valid, index) => (
      valid && pointSelected(new THREE.Vector3().fromArray(patch.positions[index]))
    ));
    let positions = patch.positions;
    if (layer.clothEnabled && patch.sourcePositions?.length === patch.positions.length && selected.some(Boolean)) {
      const sag = layer.clothSag * Math.min(layer.area?.size[0] ?? areaSize, layer.area?.size[1] ?? areaSize) * 0.32;
      const normal = new THREE.Vector3().fromArray(layer.area?.normal ?? [0, 0, 1]);
      const initial = patch.sourcePositions.flatMap((point, index) => {
        const row = Math.floor(index / patchColumns);
        const column = index % patchColumns;
        const fold = Math.sin(Math.PI * row / patchDivisions) * Math.sin(Math.PI * column / patchDivisions);
        const ripple = 0.72 + 0.28 * Math.sin(column * 1.7 + row * 0.45);
        return new THREE.Vector3().fromArray(point).addScaledVector(normal, -sag * fold * ripple).toArray();
      });
      const relaxed = relaxClothLattice({
        columns: patchColumns,
        rows: patchColumns,
        sourcePositions: patch.sourcePositions.flatMap((point) => [...point]),
        initialPositions: initial,
        contacts: selected.flatMap((isSelected, index) => isSelected && patch.touching?.[index]
          ? [{ index, position: patch.positions[index] }]
          : []),
        stretchIterations: layer.drapeIterations,
        stretchStrength: layer.drapeStretch,
        bendIterations: layer.drapeIterations,
        bendStrength: Math.min(0.6, projectionContactSoftness * 0.6),
      });
      positions = selected.map((_, index) => [
        relaxed.positions[index * 3],
        relaxed.positions[index * 3 + 1],
        relaxed.positions[index * 3 + 2],
      ] as const);
    }
    const indices: number[] = [];
    const lines: { points: readonly [readonly [number, number, number], readonly [number, number, number]] }[] = [];
    for (let row = 0; row < patchDivisions; row++) for (let column = 0; column < patchDivisions; column++) {
      const a = row * patchColumns + column;
      const b = a + 1;
      const c = a + patchColumns;
      const d = c + 1;
      if (selected[a] && selected[c] && selected[b]) indices.push(a, c, b);
      if (selected[b] && selected[c] && selected[d]) indices.push(b, c, d);
    }
    const addLine = (a: number, b: number): void => {
      if (selected[a] && selected[b]) lines.push({ points: [positions[a], positions[b]] });
    };
    for (let row = 0; row <= patchDivisions; row++) for (let column = 0; column < patchDivisions; column++) addLine(row * patchColumns + column, row * patchColumns + column + 1);
    for (let column = 0; column <= patchDivisions; column++) for (let row = 0; row < patchDivisions; row++) addLine(row * patchColumns + column, (row + 1) * patchColumns + column);
    return {
      ...projection,
      source: active && !(layer.contactLocked && projection.committed) ? projection.source : null,
      patch: { ...patch, positions, valid: selected, indices, lines },
    };
  };

  const projectionTargets = (): readonly SurfaceControlOption[] => [
    { value: '__pick__', label: 'Pick mesh in viewport' },
    { value: '__all__', label: 'All visible meshes' },
    ...runtime.projector.targets.map(({ id, label }) => ({ value: id, label })),
  ];
  const currentSnapshot = (): SurfacePainterStudioSnapshot => ({
    activeTool,
    interactionMode,
    modelPreset: app.settings.model,
    referenceObject,
    projectionTarget: runtime.document.snapshot.target,
    projectionTargets: projectionTargets(),
    canUndo: BLENDER_GENERATORS.has(activeTool) ? runtime.document.canUndo : true,
    canClear: BLENDER_GENERATORS.has(activeTool)
      ? runtime.document.snapshot.strokes.length > 0
      : true,
    hasDrawingArea: runtime.document.snapshot.drawingArea !== null,
    areaCommitted: Boolean(runtime.document.snapshot.drawingArea?.committed),
    areaContact: areaProjection.contact,
    areaClosestContactDistance: areaProjection.closestContactDistance,
    areaSize,
    projectionHeight,
    projectionContactDepth,
    projectionMaxAngle,
    projectionSurfaceOffset,
    projectionContactSoftness,
    selectorLayers: [...selectorLayers.values()].map(({ id, name, operation, visible, locked }) => ({ id, name, operation, visible, locked })),
    activeSelectorId,
    contactLocked: activeSelectorLayer().contactLocked,
    clothEnabled: activeSelectorLayer().clothEnabled,
    clothSag: activeSelectorLayer().clothSag,
    drapeStretch: activeSelectorLayer().drapeStretch,
    drapeIterations: activeSelectorLayer().drapeIterations,
    ...areaPose(activeSelectorLayer()),
    placementHover,
    gizmoSpace,
    gizmoSnap,
    strokeCount: runtime.document.snapshot.strokes.length,
    surfaceRevision: runtime.document.snapshot.surfaceRevision,
  });
  notify = () => {
    if (disposed) return;
    const value = currentSnapshot();
    for (const listener of listeners) listener(value);
  };
  const refreshAreaOverlay = (): void => {
    if (refreshingArea) return;
    refreshingArea = true;
    try {
      const activeLayer = activeSelectorLayer();
      const documentArea = areaController.area;
      if (!batchingArea) activeLayer.area = documentArea ? cloneArea(documentArea) : null;
      const rawById = new Map<string, ReturnType<DrawingAreaController['project']>>();
      for (const layer of selectorLayers.values()) {
        const raw = areaController.project(projectionOptions(layer), layer.area);
        rawById.set(layer.id, raw);
        if (layer.id === activeSelectorId) updateSelectorMask(layer, raw);
      }
      for (const layer of selectorLayers.values()) {
        const raw = rawById.get(layer.id)!;
        const filtered = filteredProjection(layer, raw, composedSelectionAtPoint, layer.id === activeSelectorId);
        layer.overlay.update(filtered);
        layer.overlay.setVisible(layer.visible && Boolean(layer.area) && BLENDER_GENERATORS.has(activeTool));
        if (layer.id === activeSelectorId) areaProjection = filtered;
      }
    } finally {
      refreshingArea = false;
    }
  };

  const unsubscribeDocument = runtime.document.subscribe((change) => {
    if (change.kind === 'target' || change.kind === 'surface') {
      for (const layer of selectorLayers.values()) {
        layer.area = null;
        layer.initialArea = null;
        layer.contactLocked = false;
        selectorMasks.clearSelectorMask(layer.id, { history: false, force: true });
      }
    }
    if (change.kind === 'area' || change.kind === 'target' || change.kind === 'surface') {
      if (!batchingArea) refreshAreaOverlay();
    }
    if (!batchingArea) notify();
  });
  const unsubscribeSurface = host.subscribeSurface(() => {
    // attachSurfaceStudioRuntime's listener runs first and refreshes the same
    // borrowed model root. Defer one microtask so the toolbar inventories the
    // replacement meshes after that refresh.
    queueMicrotask(() => {
      if (disposed) return;
      runtime.projector.selectTarget({ kind: 'all' });
      runtime.document.setProjectionTarget({ kind: 'all' });
      app.setSharedProjectionTarget(null);
      notify();
    });
  });

  const clickLegacyGenerator = (generator: Generator): void => {
    const button = document.querySelector<HTMLButtonElement>(
      `.paint-generator-option[data-generator="${CSS.escape(generator)}"]`,
    );
    if (button) button.click();
    else app.setGenerator(generator);
  };
  const hideBlenderOutputs = (hidden: boolean): void => {
    for (const tool of BLENDER_GENERATORS) {
      const root = runtime.generators.outputRoot(tool);
      if (root) root.visible = !hidden;
    }
  };
  const applyTool = async (tool: SurfaceGeneratorId): Promise<void> => {
    activeTool = tool;
    const procedural = PROCEDURAL_GENERATOR[tool];
    if (procedural) {
      runtime.setInteractionMode('orbit');
      clickLegacyGenerator(procedural);
      hideBlenderOutputs(tool === 'tree');
      app.setLegacyAuthoringEnabled(true);
      const supported: SurfaceInteractionMode[] = tool === 'tree'
        ? ['orbit', 'interact', 'flower']
        : tool === 'ivy' ? ['orbit', 'draw', 'flower'] : ['orbit', 'draw'];
      if (!supported.includes(interactionMode)) interactionMode = tool === 'tree' ? 'interact' : 'draw';
      app.setSharedInteractionMode(interactionMode as 'orbit' | 'draw' | 'interact' | 'flower');
    } else {
      if (app.settings.generator === 'Tree') clickLegacyGenerator('Ivy');
      hideBlenderOutputs(false);
      app.setLegacyAuthoringEnabled(false);
      await runtime.setActiveGenerator(tool);
      if (!runtime.input.supportsMode(interactionMode)) interactionMode = 'orbit';
      runtime.setInteractionMode(interactionMode);
    }
    refreshAreaOverlay();
    notify();
  };

  await applyTool(initialTool);

  return {
    snapshot: currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(currentSnapshot());
      return () => listeners.delete(listener);
    },
    setActiveTool: applyTool,
    setInteractionMode(mode) {
      if (BLENDER_GENERATORS.has(activeTool)) {
        if (!runtime.setInteractionMode(mode)) return;
      } else {
        const procedural = PROCEDURAL_GENERATOR[activeTool];
        if (!procedural || !['orbit', 'draw', 'interact', 'flower'].includes(mode)) return;
        app.setSharedInteractionMode(mode as 'orbit' | 'draw' | 'interact' | 'flower');
      }
      interactionMode = mode;
      notify();
    },
    setModelPreset(model) {
      referenceObject = '';
      app.setModel(model);
      notify();
    },
    async loadReferenceObject(info) {
      referenceObject = info.id;
      await app.loadLibraryModel(info);
      notify();
    },
    async importSurface(file) {
      referenceObject = '';
      await app.loadGlbFile(file);
      notify();
    },
    setProjectionTarget(target) {
      if (!runtime.projector.selectTarget(target)) return;
      runtime.document.setProjectionTarget(target);
      app.setSharedProjectionTarget(target.kind === 'mesh' ? target.targetId : null);
      notify();
    },
    setAreaSize(value) {
      if (activeSelectorLayer().locked) return;
      const next = Math.max(0.6, Math.min(4, value));
      const area = areaController.area;
      if (area) areaController.scale(next / Math.max(area.size[0], 1e-6));
      areaSize = next;
      refreshAreaOverlay();
      notify();
    },
    setProjectionHeight(value) {
      if (activeSelectorLayer().locked) return;
      projectionHeight = Math.max(-2.5, Math.min(2.5, value));
      areaController.setProjectionHeight(projectionHeight);
      refreshAreaOverlay();
      notify();
    },
    setProjectionContactDepth(value) {
      projectionContactDepth = Math.max(0.01, Math.min(0.75, value));
      refreshAreaOverlay();
      notify();
    },
    setProjectionMaxAngle(value) {
      projectionMaxAngle = Math.max(0, Math.min(90, value));
      refreshAreaOverlay();
      notify();
    },
    setProjectionSurfaceOffset(value) {
      projectionSurfaceOffset = Math.max(0, Math.min(0.12, value));
      refreshAreaOverlay();
      notify();
    },
    setProjectionContactSoftness(value) {
      projectionContactSoftness = Math.max(0, Math.min(1, value));
      refreshAreaOverlay();
      notify();
    },
    setGizmoSpace(space) {
      gizmoSpace = space;
      areaGizmo.setSpace(space);
      notify();
    },
    setGizmoSnap(enabled) {
      gizmoSnap = enabled;
      areaGizmo.setTranslationSnap(enabled ? 0.1 : null);
      notify();
    },
    createSelector() {
      const previous = activeSelectorLayer();
      previous.area = areaController.area ? cloneArea(areaController.area) : previous.area;
      const id = `selector-${++selectorCounter}`;
      const layer = createSelectorLayer(id, `Selector ${selectorCounter}`, 'add');
      activeSelectorId = id;
      selectorMasks.setActiveSelector(id, false);
      areaSize = 2.4;
      projectionHeight = 0.85;
      batchingArea = true;
      runtime.document.setDrawingArea(null);
      batchingArea = false;
      layer.area = null;
      runtime.setInteractionMode('place-area');
      interactionMode = 'place-area';
      refreshAreaOverlay();
      notify();
    },
    deleteSelector() {
      if (selectorLayers.size <= 1) return;
      const layer = activeSelectorLayer();
      layer.overlay.dispose();
      selectorLayers.delete(layer.id);
      selectorMasks.removeSelector(layer.id, { force: true });
      activeSelectorId = selectorLayers.keys().next().value as string;
      selectorMasks.setActiveSelector(activeSelectorId, false);
      const next = activeSelectorLayer();
      areaSize = next.area?.size[0] ?? 2.4;
      projectionHeight = next.area?.projectionHeight ?? 0.85;
      batchingArea = true;
      runtime.document.setDrawingArea(next.area ? cloneArea(next.area) : null);
      batchingArea = false;
      refreshAreaOverlay();
      notify();
    },
    setActiveSelector(id) {
      if (id === activeSelectorId || !selectorLayers.has(id)) return;
      const previous = activeSelectorLayer();
      previous.area = areaController.area ? cloneArea(areaController.area) : previous.area;
      activeSelectorId = id;
      selectorMasks.setActiveSelector(id, false);
      const next = activeSelectorLayer();
      areaSize = next.area?.size[0] ?? 2.4;
      projectionHeight = next.area?.projectionHeight ?? 0.85;
      batchingArea = true;
      runtime.document.setDrawingArea(next.area ? cloneArea(next.area) : null);
      batchingArea = false;
      refreshAreaOverlay();
      notify();
    },
    setSelectorOperation(operation) {
      const layer = activeSelectorLayer();
      layer.operation = operation;
      selectorMasks.updateSelector(layer.id, { operation }, false);
      refreshAreaOverlay();
      notify();
    },
    setSelectorVisible(visible) {
      const layer = activeSelectorLayer();
      layer.visible = visible;
      selectorMasks.updateSelector(layer.id, { visible }, false);
      refreshAreaOverlay();
      notify();
    },
    setSelectorLocked(locked) {
      const layer = activeSelectorLayer();
      layer.locked = locked;
      selectorMasks.updateSelector(layer.id, { locked }, false);
      notify();
    },
    setContactLocked(locked) {
      const layer = activeSelectorLayer();
      layer.contactLocked = locked;
      if (areaController.area?.committed !== locked) {
        areaController.setCommitted(locked, projectionHeight);
        layer.area = areaController.area ? cloneArea(areaController.area) : layer.area;
      }
      refreshAreaOverlay();
      notify();
    },
    clearContactMask() {
      const layer = activeSelectorLayer();
      selectorMasks.clearSelectorMask(layer.id, { history: false, force: true });
      layer.contactLocked = false;
      if (areaController.area?.committed) areaController.setCommitted(false);
      refreshAreaOverlay();
      notify();
    },
    setClothEnabled(enabled) {
      activeSelectorLayer().clothEnabled = enabled;
      refreshAreaOverlay();
      notify();
    },
    setClothSag(value) {
      activeSelectorLayer().clothSag = Math.max(0, Math.min(1, value));
      refreshAreaOverlay();
      notify();
    },
    setDrapeStretch(value) {
      activeSelectorLayer().drapeStretch = Math.max(0, Math.min(1, value));
      refreshAreaOverlay();
      notify();
    },
    setDrapeIterations(value) {
      activeSelectorLayer().drapeIterations = Math.max(1, Math.min(32, Math.round(value)));
      refreshAreaOverlay();
      notify();
    },
    setAreaTransform(position, rotationDegrees, scale) {
      const layer = activeSelectorLayer();
      const area = layer.area;
      if (!area || layer.locked) return;
      const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(rotationDegrees[0] ?? 0),
        THREE.MathUtils.degToRad(rotationDegrees[1] ?? 0),
        THREE.MathUtils.degToRad(rotationDegrees[2] ?? 0),
        'XYZ',
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const baseSize = layer.initialArea?.size ?? area.size;
      const next: DrawingAreaState = {
        ...area,
        center: [position[0] ?? area.center[0], position[1] ?? area.center[1], position[2] ?? area.center[2]],
        u: new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).toArray(),
        v: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).toArray(),
        normal: new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).toArray(),
        size: [Math.max(0.15, baseSize[0] * Math.abs(scale[0] ?? 1)), Math.max(0.15, baseSize[1] * Math.abs(scale[1] ?? 1))],
      };
      runtime.document.setDrawingArea(next);
      layer.area = cloneArea(next);
      areaSize = (next.size[0] + next.size[1]) * 0.5;
      refreshAreaOverlay();
      notify();
    },
    resetAreaTransform() {
      const layer = activeSelectorLayer();
      if (!layer.initialArea || layer.locked) return;
      const next = cloneArea(layer.initialArea);
      runtime.document.setDrawingArea(next);
      layer.area = cloneArea(next);
      areaSize = next.size[0];
      projectionHeight = next.projectionHeight;
      refreshAreaOverlay();
      notify();
    },
    dropAreaToFirstContact() {
      const layer = activeSelectorLayer();
      if (!layer.area || layer.locked) return;
      layer.contactLocked = false;
      selectorMasks.clearSelectorMask(layer.id, { history: false, force: true });
      const step = Math.max(0.02, projectionContactDepth * 0.45);
      batchingArea = true;
      for (let height = layer.area.projectionHeight; height >= -0.5; height -= step) {
        areaController.setProjectionHeight(height);
        layer.area = areaController.area ? cloneArea(areaController.area) : layer.area;
        const projection = areaController.project(projectionOptions(layer), layer.area);
        updateSelectorMask(layer, projection);
        if (projection.contact && selectorMasks.getSelector(layer.id).mask.vertices.length > 0) break;
      }
      batchingArea = false;
      projectionHeight = layer.area.projectionHeight;
      refreshAreaOverlay();
      notify();
    },
    pushAreaThrough() {
      const layer = activeSelectorLayer();
      if (!layer.area || layer.locked) return;
      layer.contactLocked = true;
      const step = Math.max(0.025, projectionContactDepth * 0.65);
      const finalHeight = -1.25;
      batchingArea = true;
      for (let height = layer.area.projectionHeight - step; height > finalHeight; height -= step) {
        areaController.setProjectionHeight(height);
        layer.area = areaController.area ? cloneArea(areaController.area) : layer.area;
        updateSelectorMask(layer, areaController.project(projectionOptions(layer), layer.area), true);
      }
      areaController.setProjectionHeight(finalHeight);
      areaController.setCommitted(true, finalHeight);
      layer.area = areaController.area ? cloneArea(areaController.area) : layer.area;
      projectionHeight = finalHeight;
      batchingArea = false;
      runtime.setInteractionMode('draw');
      interactionMode = 'draw';
      refreshAreaOverlay();
      notify();
    },
    nudgeArea(axis, amount) {
      const area = areaController.area;
      if (!area || activeSelectorLayer().locked) return;
      const direction = new THREE.Vector3().fromArray(axis === 'u' ? area.u : area.v);
      areaController.translate(direction.multiplyScalar(amount));
      refreshAreaOverlay();
      notify();
    },
    rotateArea(degrees) {
      const area = areaController.area;
      if (!area || activeSelectorLayer().locked) return;
      areaController.rotate(
        new THREE.Vector3().fromArray(area.normal),
        THREE.MathUtils.degToRad(degrees),
      );
      refreshAreaOverlay();
      notify();
    },
    projectArea() {
      activeSelectorLayer().contactLocked = true;
      areaController.setCommitted(true, projectionHeight);
      if (BLENDER_GENERATORS.has(activeTool)) {
        runtime.setInteractionMode('draw');
        interactionMode = 'draw';
      }
      refreshAreaOverlay();
      notify();
    },
    removeArea() {
      const layer = activeSelectorLayer();
      areaController.remove();
      layer.area = null;
      layer.initialArea = null;
      layer.contactLocked = false;
      selectorMasks.clearSelectorMask(layer.id, { history: false, force: true });
      refreshAreaOverlay();
      notify();
    },
    undo() {
      if (BLENDER_GENERATORS.has(activeTool)) runtime.undo();
      else app.undoLast();
      notify();
    },
    clear() {
      if (BLENDER_GENERATORS.has(activeTool)) runtime.clear();
      else app.clearAll();
      notify();
    },
    settingsFor(tool) {
      return runtime.generators.settingsFor(tool);
    },
    setGeneratorSettings(tool, settings) {
      return runtime.setGeneratorSettings(tool, settings);
    },
    setChromeCrayonDump(dump) {
      installChromeCrayonDump(dump);
      const settings = runtime.generators.settingsFor('chrome-crayon');
      return settings
        ? runtime.setGeneratorSettings('chrome-crayon', settings)
        : Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribeSurface();
      unsubscribeDocument();
      unregisterSelectionGuides();
      host.canvas.removeEventListener('pointerleave', clearPlacementHover);
      host.canvas.removeEventListener('pointerdown', onGizmoPointerDown, true);
      host.canvas.removeEventListener('pointermove', onGizmoPointerMove, true);
      host.canvas.removeEventListener('pointerup', onGizmoPointerUp, true);
      host.canvas.removeEventListener('pointercancel', onGizmoPointerCancel, true);
      areaGizmo.dispose();
      selectionGuides.dispose();
      for (const layer of selectorLayers.values()) layer.overlay.dispose();
      areaController.dispose();
      attached.dispose();
      app.dispose();
    },
  };
}

function cloneArea(area: DrawingAreaState): DrawingAreaState {
  return {
    ...area,
    target: area.target.kind === 'mesh'
      ? { kind: 'mesh', targetId: area.target.targetId }
      : { kind: area.target.kind },
    center: [...area.center],
    normal: [...area.normal],
    u: [...area.u],
    v: [...area.v],
    size: [...area.size],
  };
}

function areaPose(layer: {
  readonly area: DrawingAreaState | null;
  readonly initialArea: DrawingAreaState | null;
}): Pick<SurfacePainterStudioSnapshot, 'areaPosition' | 'areaRotation' | 'areaScale'> {
  const area = layer.area;
  if (!area) {
    return {
      areaPosition: [0, 0, 0],
      areaRotation: [0, 0, 0],
      areaScale: [1, 1, 1],
    };
  }
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().fromArray(area.u),
    new THREE.Vector3().fromArray(area.v),
    new THREE.Vector3().fromArray(area.normal),
  );
  const rotation = new THREE.Euler().setFromRotationMatrix(basis, 'XYZ');
  const initialSize = layer.initialArea?.size ?? area.size;
  return {
    areaPosition: [...area.center],
    areaRotation: [
      THREE.MathUtils.radToDeg(rotation.x),
      THREE.MathUtils.radToDeg(rotation.y),
      THREE.MathUtils.radToDeg(rotation.z),
    ],
    areaScale: [
      area.size[0] / Math.max(initialSize[0], 1e-6),
      area.size[1] / Math.max(initialSize[1], 1e-6),
      1,
    ],
  };
}

function toolFromLocation(): SurfaceGeneratorId {
  const params = new URLSearchParams(window.location.search);
  if (params.get('engine') === 'blender') {
    const brush = params.get('brush');
    if (brush === 'periodic') return 'periodic-brush';
    if (brush === 'text') return 'typewriter';
    if (brush === 'stamp') return 'stamp';
    return 'chrome-crayon';
  }
  const mode = params.get('mode');
  if (mode === 'tree') return 'tree';
  if (mode === 'crystals') return 'crystals';
  if (mode === 'fissures') return 'molten';
  if (mode === 'aurora') return 'aurora';
  if (mode === 'reef') return 'reef';
  return 'ivy';
}

/** Converts the controlled toolbar value back to the canonical document type. */
export function projectionTargetFromValue(value: string): ProjectionTarget {
  if (value === '__pick__') return { kind: 'pick' };
  if (value === '__all__') return { kind: 'all' };
  return { kind: 'mesh', targetId: value };
}

/** Useful to controlled UI consumers without leaking the document union. */
export function projectionTargetValue(target: ProjectionTarget): string {
  return target.kind === 'mesh' ? target.targetId : target.kind === 'all' ? '__all__' : '__pick__';
}
