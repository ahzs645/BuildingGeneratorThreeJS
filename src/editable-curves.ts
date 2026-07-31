import * as THREE from "three";

export type CurveLocalPoint = [number, number];

export type EditableCurvePoint = {
  id: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  local?: CurveLocalPoint;
};

export type EditableCurveStroke = {
  id: number;
  cyclic: boolean;
  points: EditableCurvePoint[];
};

export type EditableCurveSelection = {
  strokeId: number;
  pointId?: number;
};

export type ProjectedCurvePoint = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  local?: CurveLocalPoint;
};

export type CurvePointProjector = (
  proposed: THREE.Vector3,
  source: EditableCurvePoint,
) => ProjectedCurvePoint;

/**
 * Mutable curve authoring document shared by pen-driven Three.js tools.
 *
 * Generated meshes are deliberately not stored here. The document owns the
 * durable source splines, stable point/stroke identities, and selection state;
 * a procedural backend can evaluate a fresh mesh from `toCurves()` whenever
 * this source changes.
 */
export class EditableCurveDocument {
  readonly strokes: EditableCurveStroke[] = [];
  activeStroke: EditableCurveStroke | null = null;
  selection: EditableCurveSelection | null = null;

  private nextStrokeId = 1;
  private nextPointId = 1;

  beginStroke(cyclic = false): EditableCurveStroke {
    this.cancelStroke();
    this.activeStroke = { id: this.nextStrokeId++, cyclic, points: [] };
    return this.activeStroke;
  }

  appendPoint(value: Omit<EditableCurvePoint, "id">): EditableCurvePoint {
    if (!this.activeStroke) throw new Error("beginStroke() must be called before appendPoint()");
    const point = this.makePoint(value);
    this.activeStroke.points.push(point);
    return point;
  }

  addStroke(values: Array<Omit<EditableCurvePoint, "id">>, cyclic = false): EditableCurveStroke {
    const stroke: EditableCurveStroke = {
      id: this.nextStrokeId++,
      cyclic,
      points: values.map((value) => this.makePoint(value)),
    };
    this.strokes.push(stroke);
    return stroke;
  }

  commitStroke(minimumPoints = 2): EditableCurveStroke | null {
    const stroke = this.activeStroke;
    this.activeStroke = null;
    if (!stroke || stroke.points.length < minimumPoints) return null;
    this.strokes.push(stroke);
    this.selection = { strokeId: stroke.id };
    return stroke;
  }

  cancelStroke(): void {
    this.activeStroke = null;
  }

  clear(): void {
    this.strokes.length = 0;
    this.activeStroke = null;
    this.selection = null;
  }

  undo(): EditableCurveStroke | undefined {
    const removed = this.strokes.pop();
    if (removed && this.selection?.strokeId === removed.id) this.selection = null;
    return removed;
  }

  stroke(id: number): EditableCurveStroke | undefined {
    return this.strokes.find((candidate) => candidate.id === id);
  }

  selectedStroke(): EditableCurveStroke | undefined {
    return this.selection ? this.stroke(this.selection.strokeId) : undefined;
  }

  selectedPoint(): EditableCurvePoint | undefined {
    const selection = this.selection;
    if (!selection || selection.pointId === undefined) return undefined;
    return this.stroke(selection.strokeId)?.points.find((point) => point.id === selection.pointId);
  }

  selectStroke(strokeId: number): boolean {
    if (!this.stroke(strokeId)) return false;
    this.selection = { strokeId };
    return true;
  }

  selectPoint(strokeId: number, pointId: number): boolean {
    const stroke = this.stroke(strokeId);
    if (!stroke?.points.some((point) => point.id === pointId)) return false;
    this.selection = { strokeId, pointId };
    return true;
  }

  deselect(): void {
    this.selection = null;
  }

  translateSelection(delta: THREE.Vector3, project: CurvePointProjector): boolean {
    const stroke = this.selectedStroke();
    if (!stroke) return false;
    const selectedPoint = this.selectedPoint();
    const points = selectedPoint ? [selectedPoint] : stroke.points;
    for (const point of points) {
      const projected = project(point.point.clone().add(delta), point);
      point.point.copy(projected.point);
      point.normal.copy(projected.normal);
      point.local = projected.local;
    }
    return true;
  }

  moveSelectedPoint(target: THREE.Vector3, project: CurvePointProjector): boolean {
    const point = this.selectedPoint();
    if (!point) return false;
    const projected = project(target, point);
    point.point.copy(projected.point);
    point.normal.copy(projected.normal);
    point.local = projected.local;
    return true;
  }

  toCurves(
    mapPoint: (point: EditableCurvePoint, stroke: EditableCurveStroke) => number[],
  ): Array<{ points: number[][]; cyclic: boolean }> {
    return this.strokes
      .filter((stroke) => stroke.points.length > 1)
      .map((stroke) => ({
        cyclic: stroke.cyclic,
        points: stroke.points.map((point) => mapPoint(point, stroke)),
      }));
  }

  get pointCount(): number {
    return this.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)
      + (this.activeStroke?.points.length ?? 0);
  }

  private makePoint(value: Omit<EditableCurvePoint, "id">): EditableCurvePoint {
    return {
      id: this.nextPointId++,
      point: value.point.clone(),
      normal: value.normal.clone(),
      local: value.local ? [...value.local] : undefined,
    };
  }
}
