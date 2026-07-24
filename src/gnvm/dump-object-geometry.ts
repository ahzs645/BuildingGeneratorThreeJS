import { evaluateBezierSpline } from "./bezier";
import type { Vec3 } from "./core";
import type { Dump, DumpObject } from "./dump-schema";
import { Geometry, Mesh } from "./geometry";

function transformByMatrix(point: [number, number, number], matrix: number[][]): [number, number, number] {
  return [
    matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2] * point[2] + matrix[0][3],
    matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2] * point[2] + matrix[1][3],
    matrix[2][0] * point[0] + matrix[2][1] * point[1] + matrix[2][2] * point[2] + matrix[2][3],
  ];
}

function inverseTransformByMatrix(point: [number, number, number], matrix: number[][]): [number, number, number] {
  const x = point[0] - matrix[0][3], y = point[1] - matrix[1][3], z = point[2] - matrix[2][3];
  const a = matrix[0][0], b = matrix[0][1], c = matrix[0][2];
  const d = matrix[1][0], e = matrix[1][1], f = matrix[1][2];
  const g = matrix[2][0], h = matrix[2][1], i = matrix[2][2];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) return [0, 0, 0];
  const inverse = 1 / determinant;
  return [
    ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) * inverse,
    ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) * inverse,
    ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) * inverse,
  ];
}

function applyPreNodesHooks(dump: Dump, object: DumpObject, geometry: Geometry): void {
  const objectMatrix = object.matrix_world;
  if (!objectMatrix || (!geometry.mesh && !geometry.curves.length)) return;
  const modifiers = object.modifiers ?? [];
  let deformedCurve = false;
  for (const modifier of modifiers) {
    if (modifier.type === "NODES") break;
    if (modifier.type !== "HOOK" || !modifier.object || !modifier.matrix_inverse) continue;
    const hookObject = dump.objects?.find((candidate) => candidate.name === modifier.object);
    if (!hookObject?.matrix_world) continue;
    const selected = new Set(modifier.vertex_indices ?? []);
    const strength = Math.max(0, Math.min(1, Number(modifier.strength ?? 1)));
    if (object.type === "MESH" && geometry.mesh) {
      for (const vertexIndex of selected) {
        const point = geometry.mesh.positions[vertexIndex];
        if (!point) continue;
        const hookLocal = transformByMatrix(point, modifier.matrix_inverse);
        const world = transformByMatrix(hookLocal, hookObject.matrix_world);
        const deformed = inverseTransformByMatrix(world, objectMatrix);
        point[0] = Math.fround(point[0] + (deformed[0] - point[0]) * strength);
        point[1] = Math.fround(point[1] + (deformed[1] - point[1]) * strength);
        point[2] = Math.fround(point[2] + (deformed[2] - point[2]) * strength);
      }
      continue;
    }
    let dataIndex = 0;
    for (const spline of geometry.curves) {
      const controlPoints = spline.controlPoints?.length ? spline.controlPoints : spline.points;
      const isBezier = Boolean(spline.bezierLeft?.length && spline.bezierRight?.length && spline.controlPoints?.length);
      for (let pointIndex = 0; pointIndex < controlPoints.length; pointIndex++) {
        const slots = isBezier
          ? [spline.bezierLeft![pointIndex], controlPoints[pointIndex], spline.bezierRight![pointIndex]]
          : [controlPoints[pointIndex]];
        for (const point of slots) {
          if (selected.has(dataIndex)) {
            const hookLocal = transformByMatrix(point, modifier.matrix_inverse);
            const world = transformByMatrix(hookLocal, hookObject.matrix_world);
            const deformed = inverseTransformByMatrix(world, objectMatrix);
            deformedCurve ||= strength > 0 && deformed.some((value, axis) => value !== point[axis]);
            point[0] += (deformed[0] - point[0]) * strength;
            point[1] += (deformed[1] - point[1]) * strength;
            point[2] += (deformed[2] - point[2]) * strength;
          }
          dataIndex++;
        }
      }
      if (isBezier)
        spline.points = evaluateBezierSpline(controlPoints, spline.cyclic, spline.bezierLeft!, spline.bezierRight!, spline.resolution);
    }
  }
  if (deformedCurve) {
    geometry.curveAttributes.delete("__curve_tangent");
    geometry.curveAttributes.delete("__curve_imported_tangent");
    geometry.curveAttributes.delete("__curve_normal");
  }
}

/**
 * Build the pre-Geometry-Nodes geometry Blender supplies to a modifier.
 *
 * This deliberately excludes the object's evaluated mesh. It is suitable both
 * for normal modifier evaluation and for seeding an asset-only node group.
 */
export function baseGeometryOf(dump: Dump, objectName: string): Geometry | null {
  const object = dump.objects?.find((candidate) => candidate.name === objectName);
  const geometry = new Geometry();
  if (object?.mesh) {
    const mesh = new Mesh();
    mesh.positions = object.mesh.verts.map((point) => [point[0], point[1], point[2]] as Vec3);
    mesh.faces = object.mesh.faces.map((face) => [...face]);
    mesh.faceMaterial = object.mesh.face_materials ? [...object.mesh.face_materials] : mesh.faces.map(() => 0);
    mesh.materialSlots = object.materials?.length ? [...object.materials] : [null];
    const highestMaterialSlot = mesh.faceMaterial.reduce((highest, slot) => Math.max(highest, slot), -1);
    while (mesh.materialSlots.length <= highestMaterialSlot) mesh.materialSlots.push(null);
    mesh.edges = (object.mesh.edges ?? []).map((edge) => [edge[0], edge[1]] as [number, number]);
    if (mesh.edges.length) mesh.attributes.set("__gnvm_stored_edge_order", { domain: "CORNER", data: [] });
    for (const [name, attribute] of Object.entries(object.mesh.attributes ?? {}))
      mesh.attributes.set(name, { domain: attribute.domain ?? "POINT", data: [...attribute.data] });
    geometry.mesh = mesh;
  }
  if (object?.curves) {
    geometry.curves = object.curves.map((spline) => {
      const copy = (points: number[][] | undefined): Vec3[] | undefined =>
        points?.map((point) => [point[0], point[1], point[2]] as Vec3);
      const controlPoints = copy(spline.control_points);
      const bezierLeft = copy(spline.bezier_left);
      const bezierRight = copy(spline.bezier_right);
      const evaluatedPoints = copy(spline.points) ?? [];
      const authoredBezier = Boolean(
        controlPoints?.length
          && bezierLeft?.length === controlPoints.length
          && bezierRight?.length === controlPoints.length,
      );
      const evaluatedPointsAreFloat32 = evaluatedPoints.length > 0 && evaluatedPoints.every((point) =>
        point.every((component) => Object.is(component, Math.fround(component))));
      return {
        cyclic: Boolean(spline.cyclic),
        resolution: spline.resolution,
        points: authoredBezier && !evaluatedPointsAreFloat32
          ? evaluateBezierSpline(controlPoints!, Boolean(spline.cyclic), bezierLeft!, bezierRight!, spline.resolution)
          : evaluatedPoints,
        controlPoints,
        bezierLeft,
        bezierRight,
      };
    });
    const tilts = object.curves.flatMap((spline) => spline.tilts ?? spline.points.map(() => 0));
    if (tilts.some((value) => value !== 0)) geometry.curveAttributes.set("tilt", { domain: "POINT", data: tilts });
    const radii = object.curves.flatMap((spline) => spline.radii ?? spline.points.map(() => 1));
    if (radii.some((value) => value !== 1)) geometry.curveAttributes.set("radius", { domain: "POINT", data: radii });
    const tangents = object.curves.flatMap((spline) =>
      spline.tangents?.map((point) => [point[0], point[1], point[2]] as Vec3) ?? []);
    if (tangents.length === geometry.curvePointCount()) {
      geometry.curveAttributes.set("__curve_tangent", { domain: "POINT", data: tangents });
      geometry.curveAttributes.set("__curve_imported_tangent", {
        domain: "CURVE",
        data: geometry.curves.map(() => 1),
      });
    }
    const normals = object.curves.flatMap((spline) =>
      spline.normals?.map((point) => [point[0], point[1], point[2]] as Vec3) ?? []);
    if (normals.length === geometry.curvePointCount())
      geometry.curveAttributes.set("__curve_normal", { domain: "POINT", data: normals });
  }
  if (!object) return null;
  applyPreNodesHooks(dump, object, geometry);
  return geometry.mesh || geometry.curves.length ? geometry : null;
}
