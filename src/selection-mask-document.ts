import type { ContactPatchSnapshot } from "./swept-contact-selection";

/** Boolean mask combination, matching Blender's Replace/Add/Subtract/Intersect tools. */
export type SelectionMaskOperation = "replace" | "add" | "subtract" | "intersect";

export interface SelectionMaskTopology {
  vertexCount: number;
  cellCount: number;
}

export interface SelectionMaskInput {
  vertices?: Iterable<number>;
  cells?: Iterable<number>;
}

export interface SelectionMaskSnapshot {
  vertices: readonly number[];
  cells: readonly number[];
}

export interface SelectorRecordSnapshot {
  id: string;
  name: string;
  operation: SelectionMaskOperation;
  visible: boolean;
  locked: boolean;
  editable: boolean;
  mask: SelectionMaskSnapshot;
}

export interface SelectionMaskDocumentSnapshot {
  topology: SelectionMaskTopology;
  activeSelectorId: string | null;
  selectors: readonly SelectorRecordSnapshot[];
}

export interface CreateSelectorOptions {
  name?: string;
  operation?: SelectionMaskOperation;
  visible?: boolean;
  locked?: boolean;
  editable?: boolean;
  mask?: SelectionMaskInput;
  makeActive?: boolean;
  history?: boolean;
}

export interface SelectorStateUpdate {
  name?: string;
  operation?: SelectionMaskOperation;
  visible?: boolean;
  locked?: boolean;
  editable?: boolean;
}

export interface MaskMutationOptions {
  /** Disable for live pointer updates enclosed by begin/endHistoryGroup. */
  history?: boolean;
  /** Allows an internal/import workflow to change a locked or non-editable mask. */
  force?: boolean;
}

export interface ComposeSelectionMaskOptions {
  /** Hidden selectors are skipped by default, like hidden Blender collections. */
  includeHidden?: boolean;
  /** Optional explicit subset and composition order. */
  selectorIds?: readonly string[];
}

export interface ComposedSelectionMask extends SelectionMaskSnapshot {
  appliedSelectorIds: readonly string[];
}

export interface SelectionMaskDocumentOptions {
  undoLimit?: number;
}

interface SelectorRecord {
  id: string;
  name: string;
  operation: SelectionMaskOperation;
  visible: boolean;
  locked: boolean;
  editable: boolean;
  vertices: Set<number>;
  cells: Set<number>;
}

const OPERATIONS = new Set<SelectionMaskOperation>(["replace", "add", "subtract", "intersect"]);

function cloneTopology(topology: SelectionMaskTopology): SelectionMaskTopology {
  return { vertexCount: topology.vertexCount, cellCount: topology.cellCount };
}

function assertTopology(topology: SelectionMaskTopology): void {
  if (!Number.isInteger(topology.vertexCount) || topology.vertexCount < 0) {
    throw new RangeError("vertexCount must be a non-negative integer");
  }
  if (!Number.isInteger(topology.cellCount) || topology.cellCount < 0) {
    throw new RangeError("cellCount must be a non-negative integer");
  }
}

function assertOperation(operation: SelectionMaskOperation): void {
  if (!OPERATIONS.has(operation)) throw new Error(`Unknown selection mask operation \"${operation}\"`);
}

function sorted(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function normalizeIndices(indices: Iterable<number> | undefined, count: number, channel: "vertex" | "cell"): Set<number> {
  const result = new Set<number>();
  if (!indices) return result;
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`${channel} mask index ${index} is outside 0..${Math.max(0, count - 1)}`);
    }
    result.add(index);
  }
  return result;
}

function cloneRecord(record: SelectorRecord): SelectorRecord {
  return {
    ...record,
    vertices: new Set(record.vertices),
    cells: new Set(record.cells),
  };
}

function snapshotRecord(record: SelectorRecord): SelectorRecordSnapshot {
  return {
    id: record.id,
    name: record.name,
    operation: record.operation,
    visible: record.visible,
    locked: record.locked,
    editable: record.editable,
    mask: { vertices: sorted(record.vertices), cells: sorted(record.cells) },
  };
}

function combine(target: ReadonlySet<number>, incoming: ReadonlySet<number>, operation: SelectionMaskOperation): Set<number> {
  if (operation === "replace") return new Set(incoming);
  if (operation === "add") return new Set([...target, ...incoming]);
  if (operation === "subtract") return new Set([...target].filter((index) => !incoming.has(index)));
  return new Set([...target].filter((index) => incoming.has(index)));
}

function sameSnapshot(a: SelectionMaskDocumentSnapshot, b: SelectionMaskDocumentSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Geometry-independent document for layered projector masks.
 *
 * A selector owns stable logical grid indices. Its `operation` controls how it
 * combines with selectors before it, while `editMask` controls how new contact
 * samples modify that selector's own mask. Rendering and raycasting stay with
 * the caller, so this module can be tested without Three.js or the DOM.
 */
export class SelectionMaskDocument {
  readonly undoLimit: number;

  private currentTopology: SelectionMaskTopology;
  private records = new Map<string, SelectorRecord>();
  private activeId: string | null = null;
  private undoStack: SelectionMaskDocumentSnapshot[] = [];
  private redoStack: SelectionMaskDocumentSnapshot[] = [];
  private historyGroupStart: SelectionMaskDocumentSnapshot | null = null;

  constructor(topology: SelectionMaskTopology, options: SelectionMaskDocumentOptions = {}) {
    assertTopology(topology);
    this.currentTopology = cloneTopology(topology);
    this.undoLimit = Math.max(0, Math.floor(options.undoLimit ?? 50));
  }

  get topology(): SelectionMaskTopology {
    return cloneTopology(this.currentTopology);
  }

  get activeSelectorId(): string | null {
    return this.activeId;
  }

  get selectorIds(): readonly string[] {
    return [...this.records.keys()];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get selectors(): readonly SelectorRecordSnapshot[] {
    return [...this.records.values()].map(snapshotRecord);
  }

  getSelector(id: string): SelectorRecordSnapshot {
    return snapshotRecord(this.requireSelector(id));
  }

  createSelector(id: string, options: CreateSelectorOptions = {}): SelectorRecordSnapshot {
    if (!id.trim()) throw new Error("A selector id is required");
    if (this.records.has(id)) throw new Error(`Selector \"${id}\" already exists`);
    const operation = options.operation ?? (this.records.size === 0 ? "replace" : "add");
    assertOperation(operation);
    const vertices = normalizeIndices(options.mask?.vertices, this.currentTopology.vertexCount, "vertex");
    const cells = normalizeIndices(options.mask?.cells, this.currentTopology.cellCount, "cell");

    this.mutate(() => {
      this.records.set(id, {
        id,
        name: options.name ?? `Selector ${this.records.size + 1}`,
        operation,
        visible: options.visible ?? true,
        locked: options.locked ?? false,
        editable: options.editable ?? true,
        vertices,
        cells,
      });
      if (options.makeActive ?? true) this.activeId = id;
    }, options.history);
    return this.getSelector(id);
  }

  removeSelector(id: string, options: MaskMutationOptions = {}): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.locked && !options.force) throw new Error(`Selector \"${id}\" is locked`);
    this.mutate(() => {
      this.records.delete(id);
      if (this.activeId === id) this.activeId = this.selectorIds.at(-1) ?? null;
    }, options.history);
    return true;
  }

  setActiveSelector(id: string | null, history = true): void {
    if (id !== null) this.requireSelector(id);
    if (id === this.activeId) return;
    this.mutate(() => { this.activeId = id; }, history);
  }

  updateSelector(id: string, update: SelectorStateUpdate, history = true): void {
    const record = this.requireSelector(id);
    if (update.operation !== undefined) assertOperation(update.operation);
    const changed = Object.entries(update).some(([key, value]) => record[key as keyof SelectorRecord] !== value);
    if (!changed) return;
    this.mutate(() => {
      if (update.name !== undefined) record.name = update.name;
      if (update.operation !== undefined) record.operation = update.operation;
      if (update.visible !== undefined) record.visible = update.visible;
      if (update.locked !== undefined) record.locked = update.locked;
      if (update.editable !== undefined) record.editable = update.editable;
    }, history);
  }

  isSelectorEditable(id: string): boolean {
    const selector = this.requireSelector(id);
    return selector.editable && !selector.locked;
  }

  /** Replace one selector's mask. */
  setSelectorMask(id: string, mask: SelectionMaskInput, options: MaskMutationOptions = {}): void {
    const record = this.requireEditableSelector(id, options.force);
    const vertices = normalizeIndices(mask.vertices, this.currentTopology.vertexCount, "vertex");
    const cells = normalizeIndices(mask.cells, this.currentTopology.cellCount, "cell");
    this.mutate(() => {
      record.vertices = vertices;
      record.cells = cells;
    }, options.history);
  }

  /**
   * Incrementally modify one selector's own captured contacts. Use `add` during
   * a sweep so previously contacted cells remain selected after push-through.
   */
  editMask(
    id: string,
    mask: SelectionMaskInput,
    operation: SelectionMaskOperation,
    options: MaskMutationOptions = {},
  ): void {
    assertOperation(operation);
    const record = this.requireEditableSelector(id, options.force);
    const vertices = normalizeIndices(mask.vertices, this.currentTopology.vertexCount, "vertex");
    const cells = normalizeIndices(mask.cells, this.currentTopology.cellCount, "cell");
    this.mutate(() => {
      record.vertices = combine(record.vertices, vertices, operation);
      record.cells = combine(record.cells, cells, operation);
    }, options.history);
  }

  clearSelectorMask(id: string, options: MaskMutationOptions = {}): void {
    this.setSelectorMask(id, {}, options);
  }

  /** Compose visible layers in document order, or in an explicit supplied order. */
  compose(options: ComposeSelectionMaskOptions = {}): ComposedSelectionMask {
    const ids = options.selectorIds ?? this.selectorIds;
    let vertices = new Set<number>();
    let cells = new Set<number>();
    const appliedSelectorIds: string[] = [];
    for (const id of ids) {
      const selector = this.requireSelector(id);
      if (!selector.visible && !options.includeHidden) continue;
      vertices = combine(vertices, selector.vertices, selector.operation);
      cells = combine(cells, selector.cells, selector.operation);
      appliedSelectorIds.push(id);
    }
    return { vertices: sorted(vertices), cells: sorted(cells), appliedSelectorIds };
  }

  snapshot(): SelectionMaskDocumentSnapshot {
    return {
      topology: cloneTopology(this.currentTopology),
      activeSelectorId: this.activeId,
      selectors: this.selectors,
    };
  }

  restore(snapshot: SelectionMaskDocumentSnapshot, history = true): void {
    const parsed = this.parseSnapshot(snapshot);
    this.mutate(() => this.restoreParsed(parsed), history);
  }

  /**
   * Group many live pointer edits into one undo step. Begin on pointer-down and
   * end on pointer-up. `cancelHistoryGroup` rolls the entire gesture back.
   */
  beginHistoryGroup(): void {
    if (this.historyGroupStart) throw new Error("A selection history group is already active");
    this.historyGroupStart = this.snapshot();
  }

  endHistoryGroup(): boolean {
    const start = this.historyGroupStart;
    if (!start) throw new Error("No selection history group is active");
    this.historyGroupStart = null;
    if (sameSnapshot(start, this.snapshot())) return false;
    this.pushUndo(start);
    return true;
  }

  cancelHistoryGroup(): void {
    const start = this.historyGroupStart;
    if (!start) throw new Error("No selection history group is active");
    this.historyGroupStart = null;
    this.restoreParsed(this.parseSnapshot(start));
  }

  transaction<T>(mutate: () => T): T {
    this.beginHistoryGroup();
    try {
      const result = mutate();
      this.endHistoryGroup();
      return result;
    } catch (error) {
      this.cancelHistoryGroup();
      throw error;
    }
  }

  undo(): boolean {
    if (this.historyGroupStart) throw new Error("Cannot undo while a selection history group is active");
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.redoStack.push(this.snapshot());
    this.restoreParsed(this.parseSnapshot(snapshot));
    return true;
  }

  redo(): boolean {
    if (this.historyGroupStart) throw new Error("Cannot redo while a selection history group is active");
    const snapshot = this.redoStack.pop();
    if (!snapshot) return false;
    this.pushUndo(this.snapshot(), false);
    this.restoreParsed(this.parseSnapshot(snapshot));
    return true;
  }

  private mutate(change: () => void, history = true): void {
    const previous = history && !this.historyGroupStart ? this.snapshot() : null;
    change();
    if (previous && !sameSnapshot(previous, this.snapshot())) this.pushUndo(previous);
  }

  private pushUndo(snapshot: SelectionMaskDocumentSnapshot, clearRedo = true): void {
    if (this.undoLimit > 0) {
      this.undoStack.push(snapshot);
      if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    }
    if (clearRedo) this.redoStack.length = 0;
  }

  private parseSnapshot(snapshot: SelectionMaskDocumentSnapshot): {
    topology: SelectionMaskTopology;
    activeId: string | null;
    records: Map<string, SelectorRecord>;
  } {
    assertTopology(snapshot.topology);
    const records = new Map<string, SelectorRecord>();
    for (const selector of snapshot.selectors) {
      if (!selector.id || records.has(selector.id)) throw new Error(`Duplicate or empty selector id \"${selector.id}\"`);
      assertOperation(selector.operation);
      records.set(selector.id, {
        id: selector.id,
        name: selector.name,
        operation: selector.operation,
        visible: selector.visible,
        locked: selector.locked,
        editable: selector.editable,
        vertices: normalizeIndices(selector.mask.vertices, snapshot.topology.vertexCount, "vertex"),
        cells: normalizeIndices(selector.mask.cells, snapshot.topology.cellCount, "cell"),
      });
    }
    if (snapshot.activeSelectorId !== null && !records.has(snapshot.activeSelectorId)) {
      throw new Error(`Snapshot active selector \"${snapshot.activeSelectorId}\" does not exist`);
    }
    return { topology: cloneTopology(snapshot.topology), activeId: snapshot.activeSelectorId, records };
  }

  private restoreParsed(parsed: {
    topology: SelectionMaskTopology;
    activeId: string | null;
    records: Map<string, SelectorRecord>;
  }): void {
    this.currentTopology = cloneTopology(parsed.topology);
    this.activeId = parsed.activeId;
    this.records = new Map([...parsed.records].map(([id, record]) => [id, cloneRecord(record)]));
  }

  private requireSelector(id: string): SelectorRecord {
    const selector = this.records.get(id);
    if (!selector) throw new Error(`Unknown selector \"${id}\"`);
    return selector;
  }

  private requireEditableSelector(id: string, force = false): SelectorRecord {
    const selector = this.requireSelector(id);
    if (!force && selector.locked) throw new Error(`Selector \"${id}\" is locked`);
    if (!force && !selector.editable) throw new Error(`Selector \"${id}\" is not editable`);
    return selector;
  }
}

/** Bridge a persistent swept-contact patch into a selector mask. */
export function selectionMaskFromContactPatch(patch: ContactPatchSnapshot): SelectionMaskSnapshot {
  return {
    vertices: patch.vertices.map(([index]) => index).sort((a, b) => a - b),
    cells: patch.cells.map(([index]) => index).sort((a, b) => a - b),
  };
}
