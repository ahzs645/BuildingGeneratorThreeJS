import type {
  DrawingAreaState,
  ProjectionTarget,
  SurfaceChangeKind,
  SurfaceDocumentChange,
  SurfaceDocumentSnapshot,
  SurfaceGeneratorId,
  SurfacePointId,
  SurfacePointRecord,
  SurfaceSelection,
  SurfaceStrokeId,
  SurfaceStrokeRecord,
  Vec2,
  Vec3,
} from "./contracts";

export type NewSurfacePoint = Omit<SurfacePointRecord, "id">;

type Listener = (change: SurfaceDocumentChange) => void;

interface HistoryEntry {
  readonly label: string;
  readonly kind: SurfaceChangeKind;
  readonly before: SurfaceDocumentSnapshot;
  readonly after: SurfaceDocumentSnapshot;
  readonly affectedStrokeIds: readonly SurfaceStrokeId[];
}

interface OpenHistoryGroup {
  readonly label: string;
  readonly before: SurfaceDocumentSnapshot;
  kind: SurfaceChangeKind | null;
  dirty: boolean;
  readonly affectedStrokeIds: Set<SurfaceStrokeId>;
}

const PICK_TARGET: ProjectionTarget = Object.freeze({ kind: "pick" });

function vec2(value: Vec2): Vec2 {
  return Object.freeze([value[0], value[1]]) as Vec2;
}

function vec3(value: Vec3): Vec3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vec3;
}

function target(value: ProjectionTarget): ProjectionTarget {
  return value.kind === "mesh"
    ? Object.freeze({ kind: "mesh", targetId: value.targetId })
    : value.kind === "all"
      ? Object.freeze({ kind: "all" })
      : PICK_TARGET;
}

function sameTarget(a: ProjectionTarget, b: ProjectionTarget): boolean {
  return a.kind === b.kind
    && (a.kind !== "mesh" || (b.kind === "mesh" && a.targetId === b.targetId));
}

function point(value: NewSurfacePoint, id: SurfacePointId): SurfacePointRecord {
  return Object.freeze({
    id,
    targetId: value.targetId,
    targetPosition: vec3(value.targetPosition),
    targetNormal: vec3(value.targetNormal),
    ...(value.areaPosition ? { areaPosition: vec2(value.areaPosition) } : {}),
    surfaceOffset: value.surfaceOffset,
  });
}

function stroke(
  value: Omit<SurfaceStrokeRecord, "points"> & { points: readonly SurfacePointRecord[] },
): SurfaceStrokeRecord {
  return Object.freeze({ ...value, points: Object.freeze([...value.points]) });
}

function area(value: DrawingAreaState | null): DrawingAreaState | null {
  if (!value) return null;
  return Object.freeze({
    target: target(value.target),
    center: vec3(value.center),
    normal: vec3(value.normal),
    u: vec3(value.u),
    v: vec3(value.v),
    size: vec2(value.size),
    projectionHeight: value.projectionHeight,
    committed: value.committed,
  });
}

function sameVec(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameArea(a: DrawingAreaState | null, b: DrawingAreaState | null): boolean {
  if (!a || !b) return a === b;
  return sameTarget(a.target, b.target)
    && sameVec(a.center, b.center)
    && sameVec(a.normal, b.normal)
    && sameVec(a.u, b.u)
    && sameVec(a.v, b.v)
    && sameVec(a.size, b.size)
    && a.projectionHeight === b.projectionHeight
    && a.committed === b.committed;
}

function sameSelection(a: SurfaceSelection | null, b: SurfaceSelection | null): boolean {
  return a === b || Boolean(a && b && a.strokeId === b.strokeId && a.pointId === b.pointId);
}

function selection(value: SurfaceSelection | null): SurfaceSelection | null {
  return value ? Object.freeze({ ...value }) : null;
}

function snapshot(
  value: Omit<SurfaceDocumentSnapshot, "revision"> & { revision: number },
): SurfaceDocumentSnapshot {
  return Object.freeze({
    ...value,
    target: target(value.target),
    strokes: Object.freeze([...value.strokes]),
    selection: selection(value.selection),
  });
}

function affectedIds(...collections: readonly SurfaceStrokeId[][]): readonly SurfaceStrokeId[] {
  return Object.freeze([...new Set(collections.flat())]);
}

/**
 * Renderer-independent authoring state for the unified Surface Painting Studio.
 *
 * Snapshots and every nested record are immutable. Revisions are monotonic,
 * including across undo; history restores content, never an old revision number.
 * Generated meshes and Three.js target objects deliberately live elsewhere.
 */
export class SurfaceDocument {
  private current: SurfaceDocumentSnapshot = snapshot({
    revision: 0,
    surfaceRevision: 0,
    target: PICK_TARGET,
    drawingArea: null,
    strokes: [],
    activeStroke: null,
    selection: null,
  });

  private readonly listeners = new Set<Listener>();
  private readonly history: HistoryEntry[] = [];
  private historyGroup: OpenHistoryGroup | null = null;
  private strokeHistoryBase: SurfaceDocumentSnapshot | null = null;
  private nextStrokeId = 1;
  private nextPointId = 1;

  get snapshot(): SurfaceDocumentSnapshot {
    return this.current;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replaceSurface(surfaceRevision: number): void {
    this.finishHistoryGroup();
    const before = this.current;
    const ids = before.strokes.map(({ id }) => id);
    this.history.length = 0;
    this.strokeHistoryBase = null;
    this.publish("surface", before, {
      surfaceRevision,
      target: PICK_TARGET,
      drawingArea: null,
      strokes: [],
      activeStroke: null,
      selection: null,
    }, ids, null);
  }

  setProjectionTarget(
    value: ProjectionTarget,
    policy: "clear-dependent-state" | "reproject" = "clear-dependent-state",
  ): void {
    this.finishHistoryGroup();
    const nextTarget = target(value);
    const before = this.current;
    if (sameTarget(before.target, nextTarget)) return;

    const ids = policy === "clear-dependent-state"
      ? affectedIds(
        before.strokes.map(({ id }) => id),
        before.activeStroke ? [before.activeStroke.id] : [],
      )
      : [];
    this.strokeHistoryBase = null;
    this.publish("target", before, {
      target: nextTarget,
      drawingArea: policy === "clear-dependent-state" ? null : before.drawingArea,
      strokes: policy === "clear-dependent-state" ? [] : before.strokes,
      activeStroke: policy === "clear-dependent-state" ? null : before.activeStroke,
      selection: policy === "clear-dependent-state" ? null : before.selection,
    }, ids, "Change projection target");
  }

  setDrawingArea(value: DrawingAreaState | null): void {
    const nextArea = area(value);
    const before = this.current;
    if (sameArea(before.drawingArea, nextArea)) return;
    this.publish("area", before, { drawingArea: nextArea }, [], "Change drawing area");
  }

  beginStroke(generatorId: SurfaceGeneratorId, seed: number, cyclic = false): SurfaceStrokeId {
    this.finishHistoryGroup();
    if (this.current.activeStroke) this.cancelStroke();
    const before = this.current;
    const id = this.nextStrokeId++;
    this.strokeHistoryBase = before;
    const activeStroke = stroke({ id, generatorId, seed, cyclic, points: [] });
    this.publish("strokes", before, { activeStroke, selection: null }, [id], null);
    return id;
  }

  appendPoint(value: NewSurfacePoint): void {
    const active = this.current.activeStroke;
    if (!active) throw new Error("beginStroke() must be called before appendPoint()");
    const nextPoint = point(value, this.nextPointId++);
    const activeStroke = stroke({ ...active, points: [...active.points, nextPoint] });
    this.publish("strokes", this.current, { activeStroke }, [active.id], null);
  }

  commitStroke(minimumPoints = 2): SurfaceStrokeRecord | null {
    const active = this.current.activeStroke;
    if (!active) return null;
    const before = this.current;
    const historyBefore = this.strokeHistoryBase;
    this.strokeHistoryBase = null;
    if (active.points.length < minimumPoints) {
      this.publish("strokes", before, { activeStroke: null, selection: null }, [active.id], null);
      return null;
    }
    this.publish("strokes", before, {
      strokes: [...before.strokes, active],
      activeStroke: null,
      selection: { strokeId: active.id },
    }, [active.id], "Add stroke", historyBefore ?? before);
    return active;
  }

  cancelStroke(): void {
    const active = this.current.activeStroke;
    if (!active) return;
    this.strokeHistoryBase = null;
    this.publish("strokes", this.current, { activeStroke: null }, [active.id], null);
  }

  select(value: SurfaceSelection | null): void {
    let next = value;
    if (value) {
      const selectedStroke = this.current.strokes.find(({ id }) => id === value.strokeId);
      if (!selectedStroke
        || (value.pointId !== undefined && !selectedStroke.points.some(({ id }) => id === value.pointId))) {
        next = null;
      }
    }
    if (sameSelection(this.current.selection, next)) return;
    this.publish("selection", this.current, { selection: next }, next ? [next.strokeId] : [], null);
  }

  replaceStrokePoints(strokeId: SurfaceStrokeId, values: readonly NewSurfacePoint[]): void {
    const index = this.current.strokes.findIndex(({ id }) => id === strokeId);
    if (index < 0) return;
    const existing = this.current.strokes[index];
    const points = values.map((value, pointIndex) => point(
      value,
      existing.points[pointIndex]?.id ?? this.nextPointId++,
    ));
    const nextStroke = stroke({ ...existing, points });
    const strokes = [...this.current.strokes];
    strokes[index] = nextStroke;
    const selectedPointStillExists = this.current.selection?.strokeId !== strokeId
      || this.current.selection.pointId === undefined
      || points.some(({ id }) => id === this.current.selection?.pointId);
    this.publish("strokes", this.current, {
      strokes,
      selection: selectedPointStillExists
        ? this.current.selection
        : { strokeId },
    }, [strokeId], "Edit stroke");
  }

  beginHistoryGroup(label: string): void {
    if (this.historyGroup) throw new Error("A history group is already open");
    this.historyGroup = {
      label,
      before: this.current,
      kind: null,
      dirty: false,
      affectedStrokeIds: new Set(),
    };
  }

  commitHistoryGroup(): void {
    const group = this.historyGroup;
    this.historyGroup = null;
    if (!group?.dirty || !group.kind) return;
    this.history.push({
      label: group.label,
      kind: group.kind,
      before: group.before,
      after: this.current,
      affectedStrokeIds: Object.freeze([...group.affectedStrokeIds]),
    });
  }

  cancelHistoryGroup(): void {
    const group = this.historyGroup;
    this.historyGroup = null;
    if (!group?.dirty || !group.kind) return;
    const before = this.current;
    const after = this.restore(group.before);
    this.current = after;
    this.emit(group.kind, before, after, [...group.affectedStrokeIds]);
  }

  undo(): boolean {
    this.finishHistoryGroup();
    if (this.current.activeStroke) this.cancelStroke();
    const entry = this.history.pop();
    if (!entry) return false;
    const before = this.current;
    const after = this.restore(entry.before);
    this.current = after;
    this.emit(entry.kind, before, after, entry.affectedStrokeIds);
    return true;
  }

  clearStrokes(): void {
    this.finishHistoryGroup();
    const before = this.current;
    if (!before.strokes.length && !before.activeStroke && !before.selection) return;
    const ids = affectedIds(
      before.strokes.map(({ id }) => id),
      before.activeStroke ? [before.activeStroke.id] : [],
    );
    this.strokeHistoryBase = null;
    this.publish("strokes", before, {
      strokes: [],
      activeStroke: null,
      selection: null,
    }, ids, "Clear strokes");
  }

  private finishHistoryGroup(): void {
    if (this.historyGroup) this.commitHistoryGroup();
  }

  private publish(
    kind: SurfaceChangeKind,
    before: SurfaceDocumentSnapshot,
    patch: Partial<Omit<SurfaceDocumentSnapshot, "revision">>,
    ids: readonly SurfaceStrokeId[],
    historyLabel: string | null,
    historyBefore: SurfaceDocumentSnapshot = before,
  ): void {
    const after = snapshot({
      ...before,
      ...patch,
      revision: before.revision + 1,
    });
    this.current = after;

    const group = this.historyGroup;
    if (group && historyLabel) {
      group.dirty = true;
      group.kind ??= kind;
      for (const id of ids) group.affectedStrokeIds.add(id);
    } else if (historyLabel) {
      this.history.push({
        label: historyLabel,
        kind,
        before: historyBefore,
        after,
        affectedStrokeIds: Object.freeze([...ids]),
      });
    }
    this.emit(kind, before, after, ids);
  }

  private restore(value: SurfaceDocumentSnapshot): SurfaceDocumentSnapshot {
    return snapshot({
      ...value,
      revision: this.current.revision + 1,
    });
  }

  private emit(
    kind: SurfaceChangeKind,
    before: SurfaceDocumentSnapshot,
    after: SurfaceDocumentSnapshot,
    ids: readonly SurfaceStrokeId[],
  ): void {
    const change: SurfaceDocumentChange = Object.freeze({
      kind,
      before,
      after,
      affectedStrokeIds: Object.freeze([...ids]),
    });
    for (const listener of [...this.listeners]) listener(change);
  }
}
