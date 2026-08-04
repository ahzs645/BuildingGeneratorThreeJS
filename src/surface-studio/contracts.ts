export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export type SurfaceTargetId = string;
export type SurfaceStrokeId = number;
export type SurfacePointId = number;

/** Stable ids shared by the generator selector, document, and adapters. */
export type SurfaceGeneratorId =
  | "ivy"
  | "tree"
  | "crystals"
  | "molten"
  | "aurora"
  | "reef"
  | "chrome-crayon"
  | "periodic-brush"
  | "typewriter"
  | "stamp";

/** No magic select values leak into the authoring document. */
export type ProjectionTarget =
  | { readonly kind: "pick" }
  | { readonly kind: "all" }
  | { readonly kind: "mesh"; readonly targetId: SurfaceTargetId };

export type SurfaceInteractionMode =
  | "orbit"
  | "pick-target"
  | "place-area"
  | "draw"
  | "select"
  | "interact"
  | "flower";

/**
 * Renderer-independent attachment of one authored point to one target mesh.
 * Target-local position/normal are authoritative; world-space values are
 * materialized by SurfaceProjector when a generator evaluates the document.
 */
export interface SurfacePointRecord {
  readonly id: SurfacePointId;
  readonly targetId: SurfaceTargetId;
  readonly targetPosition: Vec3;
  readonly targetNormal: Vec3;
  readonly areaPosition?: Vec2;
  readonly surfaceOffset: number;
}

export interface SurfaceStrokeRecord {
  readonly id: SurfaceStrokeId;
  readonly generatorId: SurfaceGeneratorId;
  readonly seed: number;
  readonly cyclic: boolean;
  readonly points: readonly SurfacePointRecord[];
}

export interface SurfaceSelection {
  readonly strokeId: SurfaceStrokeId;
  readonly pointId?: SurfacePointId;
}

export interface DrawingAreaState {
  readonly target: ProjectionTarget;
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly size: Vec2;
  readonly projectionHeight: number;
  readonly committed: boolean;
}

export interface SurfaceDocumentSnapshot {
  readonly revision: number;
  readonly surfaceRevision: number;
  readonly target: ProjectionTarget;
  readonly drawingArea: DrawingAreaState | null;
  readonly strokes: readonly SurfaceStrokeRecord[];
  readonly activeStroke: SurfaceStrokeRecord | null;
  readonly selection: SurfaceSelection | null;
}

export type SurfaceChangeKind =
  | "surface"
  | "target"
  | "area"
  | "strokes"
  | "selection";

export interface SurfaceDocumentChange {
  readonly kind: SurfaceChangeKind;
  readonly before: SurfaceDocumentSnapshot;
  readonly after: SurfaceDocumentSnapshot;
  readonly affectedStrokeIds: readonly SurfaceStrokeId[];
}
