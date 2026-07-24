import assert from "node:assert/strict";
import test from "node:test";
import { Field, type Vec3 } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
import "./nodes/uv";
import { APPROXIMATIONS, REGISTRY, type EvalAPI } from "./registry";

function unwrapApi(selection: Field, margin = .001, seam = Field.of(0)): EvalAPI {
  const fields: Record<string, Field> = {
    Selection: selection,
    Seam: seam,
    Margin: Field.of(margin),
  };
  return {
    node: {
      name: "UV Unwrap",
      type: "GeometryNodeUVUnwrap",
      label: null,
      inputs: [],
      outputs: [],
    },
    input: (name) => fields[name],
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: (name) => fields[name] ?? Field.of(0),
    num: (name) => Number(fields[name]?.value ?? 0),
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
}

function bentStrip(): Geometry {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [
    [0, 0, 0], [1, 0, 0],
    [0, 1, 0], [1, 1, 0],
    [0, 2, .5], [1, 2, .5],
    [0, 3, 1.5], [1, 3, 1.5],
  ];
  geometry.mesh.faces = [
    [0, 1, 3, 2],
    [2, 3, 5, 4],
    [4, 5, 7, 6],
  ];
  return geometry;
}

function orthogonalFaces(): Geometry {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [2, 0, 0], [2, 1, 0], [2, 1, 1], [2, 0, 1],
  ];
  geometry.mesh.faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ];
  return geometry;
}

function signedArea(points: Vec3[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

test("UV Unwrap approximation packs selected faces and preserves winding", () => {
  APPROXIMATIONS.clear();
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = orthogonalFaces();
  const uv = handler(unwrapApi(Field.of(1))).UV as Field;
  const values = uv.array(makeFieldCtx(geometry, "CORNER")) as Vec3[];

  assert.equal(values.length, 8);
  assert.ok(values.every((value) =>
    value[0] >= 0 && value[0] <= 1 && value[1] >= 0 && value[1] <= 1));
  assert.ok(signedArea(values.slice(0, 4)) > 0);
  assert.ok(signedArea(values.slice(4, 8)) > 0);
  assert.deepEqual([...APPROXIMATIONS], [["GeometryNodeUVUnwrap", 1]]);
});

test("UV Unwrap matches Blender 5.1.2 for two orthogonal unit islands", () => {
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const values = (handler(unwrapApi(Field.of(1))).UV as Field)
    .array(makeFieldCtx(orthogonalFaces(), "CORNER")) as Vec3[];
  const blender = [
    [9.998068708227947e-05, 0.00010001508780987933, 0],
    [0.49990007281303406, 9.99505864456296e-05, 0],
    [0.49990007281303406, 0.4999000132083893, 0],
    [0.00010000218753702939, 0.49990010261535645, 0],
    [9.998068708227947e-05, 0.5001000761985779, 0],
    [0.49990007281303406, 0.5001000761985779, 0],
    [0.49990007281303406, 0.9999001622200012, 0],
    [9.996348671847954e-05, 0.9999001622200012, 0],
  ];
  for (let corner = 0; corner < values.length; corner++)
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs(values[corner][axis] - blender[corner][axis]) <= 2e-7);
});

test("UV Unwrap approximation leaves unselected face corners at zero", () => {
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = orthogonalFaces();
  const selection = Field.perElem((face) => face === 0 ? 1 : 0).tagged("FACE", "BOOLEAN");
  const values = (handler(unwrapApi(selection)).UV as Field)
    .array(makeFieldCtx(geometry, "CORNER")) as Vec3[];

  assert.ok(signedArea(values.slice(0, 4)) > 0);
  assert.deepEqual(values.slice(4), [
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ]);
});

test("UV Unwrap keeps non-seam strip corners continuous and cuts a requested seam", () => {
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = bentStrip();
  const context = makeFieldCtx(geometry, "CORNER");
  const continuous = (handler(unwrapApi(Field.of(1))).UV as Field).array(context) as Vec3[];
  // Face 0 corners 2/3 are the same mesh vertices as face 1 corners 4/5.
  assert.deepEqual(continuous[2], continuous[5]);
  assert.deepEqual(continuous[3], continuous[4]);

  const middleSeam = Field.perElem((edge, edgeContext) => {
    const vertices = [...(edgeContext.edgeVerts?.(edge) ?? [-1, -1])].sort((a, b) => a - b);
    return vertices[0] === 2 && vertices[1] === 3 ? 1 : 0;
  }).tagged("EDGE", "BOOLEAN");
  const cut = (handler(unwrapApi(Field.of(1), .001, middleSeam)).UV as Field)
    .array(context) as Vec3[];
  assert.notDeepEqual(cut[2], cut[5]);
  assert.notDeepEqual(cut[3], cut[4]);
  assert.ok(cut.every((value) =>
    value[0] >= 0 && value[0] <= 1 && value[1] >= 0 && value[1] <= 1));
});

test("UV Pack Islands approximation fits selected UV bounds and preserves unselected values", () => {
  APPROXIMATIONS.clear();
  const handler = REGISTRY.get("GeometryNodeUVPackIslands");
  assert.ok(handler);
  const uvValues: Vec3[] = [
    [2, 4, 0], [6, 4, 0], [6, 6, 0], [2, 6, 0], [20, 20, 0],
  ];
  const fields: Record<string, Field> = {
    UV: Field.perElem((index) => uvValues[index]),
    Selection: Field.perElem((index) => index < 4 ? 1 : 0),
    Margin: Field.of(.1),
  };
  const api = {
    node: {
      name: "Pack UV Islands",
      type: "GeometryNodeUVPackIslands",
      label: null,
      inputs: [],
      outputs: [],
    },
    field: (name: string) => fields[name] ?? Field.of(0),
    num: (name: string) => name === "Margin" ? .1 : 0,
    vec: (name: string) => name === "Top Right" ? [1, 1, 0] : [0, 0, 0],
  } as EvalAPI;
  const context = { size: 5, domain: "CORNER", component: "MESH" } as const;
  const values = (handler(api).UV as Field).array(context);

  assert.deepEqual(values[4], [20, 20, 0]);
  const blender = [
    [0.006972515489906073, 0.9930277466773987, 0],
    [0.00697247264906764, 0.006972648203372955, 0],
    [0.5, 0.006972626782953739, 0],
    [0.5000000596046448, 0.9930276870727539, 0],
  ];
  for (let corner = 0; corner < blender.length; corner++) {
    assert.ok(Array.isArray(values[corner]));
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs((values[corner] as Vec3)[axis] - blender[corner][axis]) <= 3e-7);
  }
  assert.deepEqual([...APPROXIMATIONS], [["GeometryNodeUVPackIslands", 1]]);
});
