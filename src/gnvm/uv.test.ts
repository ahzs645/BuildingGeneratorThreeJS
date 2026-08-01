import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Field, type Vec3 } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
import "./nodes/uv";
import { APPROXIMATIONS, REGISTRY, type EvalAPI } from "./registry";

function unwrapApi(
  selection: Field,
  margin = .001,
  seam = Field.of(0),
  method = "Angle Based",
  options: {
    group?: string;
    fillHoles?: boolean;
    iterations?: number;
    noFlip?: boolean;
  } = {},
): EvalAPI {
  const fields: Record<string, Field> = {
    Selection: selection,
    Seam: seam,
    Margin: Field.of(margin),
  };
  return {
    group: options.group,
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
    num: (name) => name === "Iterations"
      ? (options.iterations ?? 10)
      : Number(fields[name]?.value ?? 0),
    vec: () => [0, 0, 0],
    bool: (name) => name === "Fill Holes"
      ? (options.fillHoles ?? true)
      : name === "No Flip" ? (options.noFlip ?? false) : false,
    str: (name) => name === "Method" ? method : "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
}

function authoredGlyphPlayerGrid(): Geometry {
  const countX = 40;
  const countY = 40;
  const sizeX = 5.410000324249268;
  const sizeY = 5.230000019073486;
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  for (let y = 0; y < countY; y++)
    for (let x = 0; x < countX; x++)
      geometry.mesh.positions.push([
        -sizeX / 2 + sizeX * x / (countX - 1),
        -sizeY / 2 + sizeY * y / (countY - 1),
        0,
      ]);
  for (let y = 0; y < countY - 1; y++)
    for (let x = 0; x < countX - 1; x++) {
      const index = y * countX + x;
      geometry.mesh.faces.push([
        index,
        index + 1,
        index + countX + 1,
        index + countX,
      ]);
    }
  return geometry;
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

function seamHeavyCube(): Geometry {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  geometry.mesh.faces = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  return geometry;
}

function seamHeavyCubeField(): Field {
  const seamPairs = new Set([
    "0:1", "1:2", "2:3", "0:3", "0:4", "2:6",
  ]);
  return Field.perElem((edge, context) => {
    const vertices = [...(context.edgeVerts?.(edge) ?? [-1, -1])]
      .sort((a, b) => a - b);
    return seamPairs.has(`${vertices[0]}:${vertices[1]}`) ? 1 : 0;
  }).tagged("EDGE", "BOOLEAN");
}

function faceStart(mesh: Mesh, face: number): number {
  let start = 0;
  for (let index = 0; index < face; index++) start += mesh.faces[index].length;
  return start;
}

function faceCornerForVertex(mesh: Mesh, face: number, vertex: number): number {
  return faceStart(mesh, face) + mesh.faces[face].indexOf(vertex);
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

function quantizedUVHash(values: Vec3[]): string {
  const payload = values.flatMap((value) => value).map((component) =>
    (Math.abs(component) < .00005 ? 0 : component).toFixed(4)).join(",");
  return createHash("sha256").update(payload, "ascii").digest("hex");
}

test("UV Unwrap exact canonical Angle Based case packs faces and preserves winding", () => {
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
  assert.deepEqual([...APPROXIMATIONS], []);
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

test("UV Unwrap exactly matches the authored _GLYPH PLAYER planar grid", () => {
  APPROXIMATIONS.clear();
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = authoredGlyphPlayerGrid();
  const values = (handler(unwrapApi(
    Field.of(1),
    0,
    Field.of(0),
    "Conformal",
    {
      group: "_GLYPH PLAYER",
      fillHoles: true,
      iterations: 10,
      noFlip: false,
    },
  )).UV as Field).array(makeFieldCtx(geometry, "CORNER")) as Vec3[];
  const blender = new Map<number, Vec3>([
    [0, [8.778136617593191e-8, 1, 0]],
    [1, [8.666055606454393e-8, 0.9743589758872986, 0]],
    [2, [0.024787992238998413, 0.9743589758872986, 0]],
    [3, [0.024787994101643562, 1, 0]],
    [3042, [0.4957581162452698, 0.4871794581413269, 0]],
    [6080, [0.9419403672218323, 0.025640971958637238, 0]],
    [6081, [0.9419403672218323, -4.1173521481141506e-8, 0]],
    [6082, [0.9667282700538635, -4.225703520432944e-8, 0]],
    [6083, [0.9667282700538635, 0.02564097009599209, 0]],
  ]);

  assert.equal(values.length, 6084);
  for (const [corner, expected] of blender)
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs(values[corner][axis] - expected[axis]) <= 2e-7);
  assert.equal(
    quantizedUVHash(values),
    "8cd3f0ff3b425b97aa2609d48d3e95628865f8a5222401e77c30bef6ed783cc3",
  );
  assert.deepEqual([...APPROXIMATIONS], []);
});

test("UV Unwrap keeps non-proven _GLYPH PLAYER parameter variants bounded", () => {
  APPROXIMATIONS.clear();
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = authoredGlyphPlayerGrid();
  (handler(unwrapApi(
    Field.of(1),
    0,
    Field.of(0),
    "Conformal",
    {
      group: "_GLYPH PLAYER",
      fillHoles: false,
      iterations: 10,
      noFlip: false,
    },
  )).UV as Field).array(makeFieldCtx(geometry, "CORNER"));

  assert.deepEqual([...APPROXIMATIONS], [["GeometryNodeUVUnwrap", 1]]);
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
  const conformal = (handler(
    unwrapApi(Field.of(1), .001, Field.of(0), "Conformal"),
  ).UV as Field).array(context) as Vec3[];
  // Face 0 corners 2/3 are the same mesh vertices as face 1 corners 4/5.
  assert.deepEqual(continuous[2], continuous[5]);
  assert.deepEqual(continuous[3], continuous[4]);
  // Both bounded modes retain the exact rigid path when the chart has no
  // closure residual; the menu affects only genuinely curved cycles.
  assert.deepEqual(conformal, continuous);

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

test("UV Unwrap splits seam wedges inside one cyclic chart and relaxes both methods", () => {
  const handler = REGISTRY.get("GeometryNodeUVUnwrap");
  assert.ok(handler);
  const geometry = seamHeavyCube();
  const mesh = geometry.mesh!;
  const context = makeFieldCtx(geometry, "CORNER");
  const seam = seamHeavyCubeField();
  const angle = (handler(unwrapApi(Field.of(1), .001, seam, "Angle Based")).UV as Field)
    .array(context) as Vec3[];
  const conformal = (handler(unwrapApi(Field.of(1), .001, seam, "Conformal")).UV as Field)
    .array(context) as Vec3[];

  for (const values of [angle, conformal]) {
    assert.equal(values.length, 24);
    assert.ok(values.every((value) =>
      value.every(Number.isFinite)
      && value[0] >= 0 && value[0] <= 1
      && value[1] >= 0 && value[1] <= 1));
    for (let face = 0; face < mesh.faces.length; face++) {
      const start = faceStart(mesh, face);
      assert.ok(signedArea(values.slice(start, start + mesh.faces[face].length)) > 1e-5);
    }

    // Top and side faces retain one UV vertex across their non-seam edge.
    assert.deepEqual(
      values[faceCornerForVertex(mesh, 1, 4)],
      values[faceCornerForVertex(mesh, 2, 4)],
    );
    assert.deepEqual(
      values[faceCornerForVertex(mesh, 1, 5)],
      values[faceCornerForVertex(mesh, 2, 5)],
    );
    // Faces 2 and 5 remain part of the same face chart through the top. The
    // multi-seam endpoint at vertex 0 splits while the seam's lone endpoint at
    // vertex 4 stays welded through its surrounding non-seam fan, matching the
    // Blender 5.1.2 fixture's corner topology.
    assert.notDeepEqual(
      values[faceCornerForVertex(mesh, 2, 0)],
      values[faceCornerForVertex(mesh, 5, 0)],
    );
    assert.deepEqual(
      values[faceCornerForVertex(mesh, 2, 4)],
      values[faceCornerForVertex(mesh, 5, 4)],
    );
  }

  // The bounded modes intentionally solve different objectives on a curved
  // cycle instead of silently treating Blender's menu as a no-op.
  assert.notDeepEqual(angle, conformal);
});

test("UV Pack Islands exactly fits a proven axis-aligned rectangle", () => {
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
  assert.deepEqual([...APPROXIMATIONS], []);
});

test("UV Pack Islands matches Blender rectangle margins 0 and .001", () => {
  const handler = REGISTRY.get("GeometryNodeUVPackIslands");
  assert.ok(handler);
  const uvValues: Vec3[] = [
    [2, 4, 0], [6, 4, 0], [6, 6, 0], [2, 6, 0],
  ];
  const fixtures = new Map<number, Vec3[]>([
    [0, [
      [-7.549789415861596e-8, 1.0000001192092896, 0],
      [-1.1920928244535389e-7, 1.1920928955078125e-7, 0],
      [0.49999988079071045, 9.735359896012596e-8, 0],
      [0.49999991059303284, 1.0000001192092896, 0],
    ]],
    [.001, [
      [0.00007072482549119741, 0.9999294281005859, 0],
      [0.00007068111881380901, 0.00007080030627548695, 0],
      [0.5, 0.00007077844929881394, 0],
      [0.5000000596046448, 0.9999293684959412, 0],
    ]],
  ]);

  for (const [margin, blender] of fixtures) {
    APPROXIMATIONS.clear();
    const fields: Record<string, Field> = {
      UV: Field.perElem((index) => uvValues[index]),
      Selection: Field.of(1),
      Margin: Field.of(margin),
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
      num: (name: string) => name === "Margin" ? margin : 0,
      vec: (name: string) => name === "Top Right" ? [1, 1, 0] : [0, 0, 0],
    } as EvalAPI;
    const context = { size: 4, domain: "CORNER", component: "MESH" } as const;
    const values = (handler(api).UV as Field).array(context) as Vec3[];
    for (let corner = 0; corner < values.length; corner++)
      for (let axis = 0; axis < 3; axis++)
        assert.ok(Math.abs(values[corner][axis] - blender[corner][axis]) <= 3e-7);
    assert.deepEqual([...APPROXIMATIONS], []);
  }
});

test("UV Pack Islands keeps disconnected topology in separate packed cells", () => {
  APPROXIMATIONS.clear();
  const handler = REGISTRY.get("GeometryNodeUVPackIslands");
  assert.ok(handler);
  const geometry = orthogonalFaces();
  const uvValues: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [4, 0, 0], [5, 0, 0], [5, 1, 0], [4, 1, 0],
  ];
  const fields: Record<string, Field> = {
    UV: Field.perElem((corner) => uvValues[corner]).tagged("CORNER", "VECTOR"),
    Selection: Field.of(1),
    Margin: Field.of(.001),
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
    num: (name: string) => name === "Margin" ? .001 : 0,
    vec: (name: string) => name === "Top Right" ? [1, 1, 0] : [0, 0, 0],
  } as EvalAPI;
  const values = (handler(api).UV as Field)
    .array(makeFieldCtx(geometry, "CORNER")) as Vec3[];
  const first = values.slice(0, 4);
  const second = values.slice(4, 8);
  const firstMinX = Math.min(...first.map((value) => value[0]));
  const firstMaxX = Math.max(...first.map((value) => value[0]));
  const secondMinX = Math.min(...second.map((value) => value[0]));
  const secondMaxX = Math.max(...second.map((value) => value[0]));
  const firstMinY = Math.min(...first.map((value) => value[1]));
  const firstMaxY = Math.max(...first.map((value) => value[1]));
  const secondMinY = Math.min(...second.map((value) => value[1]));
  const secondMaxY = Math.max(...second.map((value) => value[1]));

  assert.ok(
    firstMaxX <= secondMinX + 1e-12
    || secondMaxX <= firstMinX + 1e-12
    || firstMaxY <= secondMinY + 1e-12
    || secondMaxY <= firstMinY + 1e-12,
  );
  assert.ok(Math.max(...first.map((value) => value[0]))
    - Math.min(...first.map((value) => value[0])) > .49);
  assert.ok(Math.max(...second.map((value) => value[0]))
    - Math.min(...second.map((value) => value[0])) > .49);
  assert.ok(values.every((value) =>
    value[0] >= 0 && value[0] <= 1 && value[1] >= 0 && value[1] <= 1));
  assert.deepEqual([...APPROXIMATIONS], [["GeometryNodeUVPackIslands", 1]]);
});
