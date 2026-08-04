/**
 * Geometry-agnostic persistence for a projector that sweeps through a surface.
 *
 * The projector owns stable logical vertex/cell indices. Each call to
 * `accumulate` contributes the contacts observed in one frame; indices omitted
 * from later frames stay selected until their patch is explicitly cleared,
 * removed, invalidated, or remapped.
 */

export type ContactPoint = readonly [x: number, y: number, z: number];

export interface ContactTopology {
  vertexCount: number;
  cellCount: number;
}

export interface ContactSample {
  index: number;
  /** Normalized instantaneous contact strength. Values are clamped to 0..1. */
  weight?: number;
  /** Surface-space or world-space point chosen by the caller. */
  point?: ContactPoint;
}

export interface ContactFrame {
  vertices?: readonly ContactSample[];
  cells?: readonly ContactSample[];
}

export type ContactPointMode = "strongest" | "latest" | "weighted-mean";

export interface ContactRecord {
  /** Strongest instantaneous contact observed, in the range 0..1. */
  strength: number;
  /** Sum of every positive contact weight observed for this index. */
  accumulatedWeight: number;
  touches: number;
  firstFrame: number;
  lastFrame: number;
  point: ContactPoint | null;
  /** Weight represented by `point`; useful when continuing a weighted mean. */
  pointWeight: number;
}

export interface ContactPatchSnapshot {
  id: string;
  topology: ContactTopology;
  vertices: readonly (readonly [index: number, record: ContactRecord])[];
  cells: readonly (readonly [index: number, record: ContactRecord])[];
}

export interface SweptContactSnapshot {
  activePatchId: string | null;
  frame: number;
  patches: readonly ContactPatchSnapshot[];
}

export interface ContactAccumulateResult {
  patchId: string;
  frame: number;
  newVertices: number;
  newCells: number;
  selectedVertices: number;
  selectedCells: number;
}

export interface ContactRemap {
  vertexIndex?: (oldIndex: number, oldTopology: ContactTopology, newTopology: ContactTopology) => number | null;
  cellIndex?: (oldIndex: number, oldTopology: ContactTopology, newTopology: ContactTopology) => number | null;
  point?: (point: ContactPoint, channel: "vertex" | "cell", oldIndex: number) => ContactPoint;
}

interface ContactPatch {
  id: string;
  topology: ContactTopology;
  vertices: Map<number, ContactRecord>;
  cells: Map<number, ContactRecord>;
}

export interface SweptContactSelectionOptions {
  pointMode?: ContactPointMode;
  undoLimit?: number;
}

const clonePoint = (point: ContactPoint | null): ContactPoint | null =>
  point ? [point[0], point[1], point[2]] : null;

const cloneRecord = (record: ContactRecord): ContactRecord => ({
  ...record,
  point: clonePoint(record.point),
});

const cloneTopology = (topology: ContactTopology): ContactTopology => ({ ...topology });

function assertTopology(topology: ContactTopology): void {
  if (!Number.isInteger(topology.vertexCount) || topology.vertexCount < 0) {
    throw new RangeError("vertexCount must be a non-negative integer");
  }
  if (!Number.isInteger(topology.cellCount) || topology.cellCount < 0) {
    throw new RangeError("cellCount must be a non-negative integer");
  }
}

function validPoint(point: ContactPoint | undefined): point is ContactPoint {
  return Boolean(point?.every(Number.isFinite));
}

function normalizedWeight(weight: number | undefined): number {
  const value = weight ?? 1;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

function checkIndex(index: number, count: number, channel: "vertex" | "cell"): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`${channel} contact index ${index} is outside 0..${Math.max(0, count - 1)}`);
  }
}

function updateRecord(
  previous: ContactRecord | undefined,
  sample: ContactSample,
  weight: number,
  frame: number,
  pointMode: ContactPointMode,
): ContactRecord {
  const point = validPoint(sample.point) ? clonePoint(sample.point) : null;
  if (!previous) {
    return {
      strength: weight,
      accumulatedWeight: weight,
      touches: 1,
      firstFrame: frame,
      lastFrame: frame,
      point,
      pointWeight: point ? weight : 0,
    };
  }

  let nextPoint = previous.point;
  let nextPointWeight = previous.pointWeight;
  if (point) {
    if (pointMode === "latest" || (pointMode === "strongest" && weight >= previous.strength) || !previous.point) {
      nextPoint = point;
      nextPointWeight = weight;
    } else if (pointMode === "weighted-mean") {
      const total = previous.pointWeight + weight;
      nextPoint = total > 0
        ? [
            (previous.point[0] * previous.pointWeight + point[0] * weight) / total,
            (previous.point[1] * previous.pointWeight + point[1] * weight) / total,
            (previous.point[2] * previous.pointWeight + point[2] * weight) / total,
          ]
        : point;
      nextPointWeight = total;
    }
  }

  return {
    strength: Math.max(previous.strength, weight),
    accumulatedWeight: previous.accumulatedWeight + weight,
    touches: previous.touches + 1,
    firstFrame: previous.firstFrame,
    lastFrame: frame,
    point: clonePoint(nextPoint),
    pointWeight: nextPointWeight,
  };
}

function snapshotPatch(patch: ContactPatch): ContactPatchSnapshot {
  return {
    id: patch.id,
    topology: cloneTopology(patch.topology),
    vertices: [...patch.vertices].map(([index, record]) => [index, cloneRecord(record)] as const),
    cells: [...patch.cells].map(([index, record]) => [index, cloneRecord(record)] as const),
  };
}

function patchFromSnapshot(snapshot: ContactPatchSnapshot): ContactPatch {
  assertTopology(snapshot.topology);
  return {
    id: snapshot.id,
    topology: cloneTopology(snapshot.topology),
    vertices: new Map(snapshot.vertices.map(([index, record]) => [index, cloneRecord(record)])),
    cells: new Map(snapshot.cells.map(([index, record]) => [index, cloneRecord(record)])),
  };
}

function mergeRemappedRecord(
  existing: ContactRecord | undefined,
  incoming: ContactRecord,
  pointMode: ContactPointMode,
): ContactRecord {
  if (!existing) return cloneRecord(incoming);
  const incomingPoint = incoming.point;
  const merged = updateRecord(
    existing,
    { index: 0, weight: incoming.strength, point: incomingPoint ?? undefined },
    incoming.strength,
    Math.max(existing.lastFrame, incoming.lastFrame),
    pointMode,
  );
  return {
    ...merged,
    accumulatedWeight: existing.accumulatedWeight + incoming.accumulatedWeight,
    touches: existing.touches + incoming.touches,
    firstFrame: Math.min(existing.firstFrame, incoming.firstFrame),
  };
}

export class SweptContactSelection {
  readonly pointMode: ContactPointMode;
  readonly undoLimit: number;

  private patches = new Map<string, ContactPatch>();
  private undoStack: SweptContactSnapshot[] = [];
  private frame = 0;
  private activePatchId: string | null = null;

  constructor(options: SweptContactSelectionOptions = {}) {
    this.pointMode = options.pointMode ?? "strongest";
    this.undoLimit = Math.max(0, Math.floor(options.undoLimit ?? 20));
  }

  get activePatch(): string | null {
    return this.activePatchId;
  }

  get patchIds(): readonly string[] {
    return [...this.patches.keys()];
  }

  createPatch(id: string, topology: ContactTopology, makeActive = true): void {
    if (!id) throw new Error("A contact patch id is required");
    if (this.patches.has(id)) throw new Error(`Contact patch \"${id}\" already exists`);
    assertTopology(topology);
    this.patches.set(id, {
      id,
      topology: cloneTopology(topology),
      vertices: new Map(),
      cells: new Map(),
    });
    if (makeActive) this.activePatchId = id;
  }

  setActivePatch(id: string): void {
    this.requirePatch(id);
    this.activePatchId = id;
  }

  removePatch(id: string): boolean {
    const removed = this.patches.delete(id);
    if (removed && this.activePatchId === id) {
      this.activePatchId = this.patchIds.at(-1) ?? null;
    }
    return removed;
  }

  /** Clear contact history but retain the patch and its topology. */
  clearPatch(id = this.requireActivePatch().id): void {
    const patch = this.requirePatch(id);
    patch.vertices.clear();
    patch.cells.clear();
  }

  /** Alias that documents intentional invalidation after an incompatible edit. */
  invalidatePatch(id = this.requireActivePatch().id): void {
    this.clearPatch(id);
  }

  accumulate(frame: ContactFrame, patchId = this.requireActivePatch().id): ContactAccumulateResult {
    const patch = this.requirePatch(patchId);
    const nextFrame = ++this.frame;
    let newVertices = 0;
    let newCells = 0;

    for (const sample of frame.vertices ?? []) {
      checkIndex(sample.index, patch.topology.vertexCount, "vertex");
      const weight = normalizedWeight(sample.weight);
      if (weight === 0) continue;
      const previous = patch.vertices.get(sample.index);
      if (!previous) newVertices += 1;
      patch.vertices.set(sample.index, updateRecord(previous, sample, weight, nextFrame, this.pointMode));
    }

    for (const sample of frame.cells ?? []) {
      checkIndex(sample.index, patch.topology.cellCount, "cell");
      const weight = normalizedWeight(sample.weight);
      if (weight === 0) continue;
      const previous = patch.cells.get(sample.index);
      if (!previous) newCells += 1;
      patch.cells.set(sample.index, updateRecord(previous, sample, weight, nextFrame, this.pointMode));
    }

    return {
      patchId,
      frame: nextFrame,
      newVertices,
      newCells,
      selectedVertices: patch.vertices.size,
      selectedCells: patch.cells.size,
    };
  }

  vertexContacts(id = this.requireActivePatch().id): ReadonlyMap<number, ContactRecord> {
    return this.requirePatch(id).vertices;
  }

  cellContacts(id = this.requireActivePatch().id): ReadonlyMap<number, ContactRecord> {
    return this.requirePatch(id).cells;
  }

  hasContact(id = this.requireActivePatch().id): boolean {
    const patch = this.requirePatch(id);
    return patch.vertices.size > 0 || patch.cells.size > 0;
  }

  topology(id = this.requireActivePatch().id): ContactTopology {
    return cloneTopology(this.requirePatch(id).topology);
  }

  /**
   * Change grid topology while explicitly deciding how old logical indices map.
   * Missing mapping callbacks default to identity for still-valid indices.
   */
  remapPatch(id: string, topology: ContactTopology, remap: ContactRemap = {}): void {
    assertTopology(topology);
    const patch = this.requirePatch(id);
    const oldTopology = patch.topology;
    const nextVertices = new Map<number, ContactRecord>();
    const nextCells = new Map<number, ContactRecord>();

    const remapChannel = (
      channel: "vertex" | "cell",
      source: ReadonlyMap<number, ContactRecord>,
      target: Map<number, ContactRecord>,
      count: number,
      indexMap: ContactRemap["vertexIndex"] | ContactRemap["cellIndex"],
    ) => {
      for (const [oldIndex, oldRecord] of source) {
        const fallbackIndex = oldIndex < count ? oldIndex : null;
        const nextIndex = indexMap?.(oldIndex, oldTopology, topology) ?? fallbackIndex;
        if (nextIndex === null) continue;
        checkIndex(nextIndex, count, channel);
        const record = cloneRecord(oldRecord);
        if (record.point && remap.point) record.point = clonePoint(remap.point(record.point, channel, oldIndex));
        target.set(nextIndex, mergeRemappedRecord(target.get(nextIndex), record, this.pointMode));
      }
    };

    remapChannel("vertex", patch.vertices, nextVertices, topology.vertexCount, remap.vertexIndex);
    remapChannel("cell", patch.cells, nextCells, topology.cellCount, remap.cellIndex);
    patch.topology = cloneTopology(topology);
    patch.vertices = nextVertices;
    patch.cells = nextCells;
  }

  /** Transform retained contact points without changing their logical indices. */
  transformPoints(
    id: string,
    transform: (point: ContactPoint, channel: "vertex" | "cell", index: number) => ContactPoint,
  ): void {
    const patch = this.requirePatch(id);
    const transformChannel = (channel: "vertex" | "cell", records: Map<number, ContactRecord>) => {
      for (const [index, record] of records) {
        if (!record.point) continue;
        const point = transform(record.point, channel, index);
        if (!validPoint(point)) throw new Error("Contact point transforms must return finite coordinates");
        records.set(index, { ...record, point: clonePoint(point) });
      }
    };
    transformChannel("vertex", patch.vertices);
    transformChannel("cell", patch.cells);
  }

  snapshot(): SweptContactSnapshot {
    return {
      activePatchId: this.activePatchId,
      frame: this.frame,
      patches: [...this.patches.values()].map(snapshotPatch),
    };
  }

  restore(snapshot: SweptContactSnapshot): void {
    const patches = new Map(snapshot.patches.map((patch) => [patch.id, patchFromSnapshot(patch)]));
    if (snapshot.activePatchId !== null && !patches.has(snapshot.activePatchId)) {
      throw new Error(`Snapshot active patch \"${snapshot.activePatchId}\" does not exist`);
    }
    this.patches = patches;
    this.activePatchId = snapshot.activePatchId;
    this.frame = snapshot.frame;
  }

  /** Save one explicit undo boundary; accumulation itself does not spam history. */
  checkpoint(): void {
    if (this.undoLimit === 0) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.restore(snapshot);
    return true;
  }

  private requireActivePatch(): ContactPatch {
    if (!this.activePatchId) throw new Error("No active contact patch");
    return this.requirePatch(this.activePatchId);
  }

  private requirePatch(id: string): ContactPatch {
    const patch = this.patches.get(id);
    if (!patch) throw new Error(`Unknown contact patch \"${id}\"`);
    return patch;
  }
}
