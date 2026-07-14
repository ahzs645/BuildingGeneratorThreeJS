// Per-node test harness for the GN-VM (inspired by ThreeGN's per-node tests, but
// built against our EvalAPI directly — no graph machinery needed).
// Run: npx tsx tools/gnvm-nodetest.ts
import { Field, Vec3 } from "../src/gnvm/core";
import { Geometry, Mesh, orientClosedSurface, realizeInstances, toTriSoup, topologyOf, transformPoint, triangulateFaceIndices } from "../src/gnvm/geometry";
import { DUMP_CONTEXT, EvalAPI, REGISTRY, SockVal, RawSocket } from "../src/gnvm/registry";
import { Evaluator, gradientDirectionField, makeFieldCtx } from "../src/gnvm/evaluator";
import "../src/gnvm/index"; // registers all handlers

type Input = SockVal | number | number[] | boolean;
const wrap = (v: Input): SockVal =>
  v instanceof Geometry || v instanceof Field ? v :
  typeof v === "number" ? Field.of(v) :
  typeof v === "boolean" ? Field.of(v ? 1 : 0) :
  Array.isArray(v) ? Field.of(v as Vec3) :
  (v as SockVal);

// `linked` marks which named inputs should report as connected (for nodes that
// branch on socket.linked, e.g. SetPosition / InstanceOnPoints).
function runNode(type: string, inputs: Record<string, Input>, props: Record<string, any> = {}, linked: string[] = []) {
  const h = REGISTRY.get(type);
  if (!h) throw new Error(`no handler: ${type}`);
  const rawInputs: RawSocket[] = Object.keys(inputs).map((name, idx) => ({
    name, identifier: name, idx, type: "NodeSocketFloat", linked: linked.includes(name), value: null,
  }));
  const raw = (n: string) => inputs[n];
  const api: EvalAPI = {
    node: { name: "t", type, label: null, inputs: rawInputs, outputs: [], props },
    input: (n) => wrap(raw(n)),
    inputs: (n) => (n in inputs ? [wrap(raw(n))] : []),
    geoInputs: (n) => { const v = wrap(raw(n)); return v instanceof Geometry ? [v] : []; },
    geo: (n) => { const v = raw(n); return v instanceof Geometry ? v : new Geometry(); },
    field: (n) => { const v = wrap(raw(n)); return v instanceof Field ? v : Field.of(0); },
    num: (n) => { const v = raw(n); return typeof v === "number" ? v : Array.isArray(v) ? v[0] : 0; },
    vec: (n) => (Array.isArray(raw(n)) ? raw(n) : [0, 0, 0]) as Vec3,
    bool: (n) => !!raw(n),
    str: (n) => (typeof raw(n) === "string" ? (raw(n) as string) : ""),
    ref: (n) => { const v = raw(n); return v && typeof v === "object" ? (v as any) : null; },
    prop: (n, d) => (n in props ? props[n] : d),
    resolve: (f, g, dom) => f.array(makeFieldCtx(g, dom)),
  };
  return h(api) as Record<string, SockVal>;
}

const curve = (points: Vec3[], cyclic: boolean): Geometry =>
  Object.assign(new Geometry(), { curves: [{ points, cyclic }] });

const curves = (items: { points: Vec3[]; cyclic: boolean }[]): Geometry =>
  Object.assign(new Geometry(), { curves: items });

const box = (min: Vec3, max: Vec3): Geometry => {
  const m = new Mesh();
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  m.positions = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  m.faces = [
    [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
    [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
  ];
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
};

const openCylinder = (segments: number, zs: number[], radius: number): Geometry => {
  const m = new Mesh();
  for (const z of zs) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      m.positions.push([Math.cos(a) * radius, Math.sin(a) * radius, z]);
    }
  }
  for (let r = 0; r + 1 < zs.length; r++) {
    const base = r * segments;
    const next = (r + 1) * segments;
    for (let i = 0; i < segments; i++) {
      m.faces.push([base + i, base + ((i + 1) % segments), next + ((i + 1) % segments), next + i]);
      m.faceMaterial.push(0);
    }
  }
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
};

// ---- assertions -----------------------------------------------------------
let pass = 0, fail = 0;
const approx = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "   " + detail}`);
  cond ? pass++ : fail++;
}

function meshSignedAreaXY(m: Mesh): number {
  let area = 0;
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const p = m.positions[f[i]];
      const q = m.positions[f[(i + 1) % f.length]];
      area += p[0] * q[1] - q[0] * p[1];
    }
  }
  return area * 0.5;
}

// (A) CurveCircle: res=4, r=1 -> 4 pts, cyclic, +X start, CCW (Blender-correct)
{
  const c = runNode("GeometryNodeCurvePrimitiveCircle", { Resolution: 4, Radius: 1 }).Curve as Geometry;
  const s = c.curves[0];
  check("CurveCircle res=4 -> 4 cyclic pts", s.points.length === 4 && s.cyclic === true, `got ${s.points.length}`);
  check("CurveCircle p0=(1,0,0)", approx(s.points[0], [1, 0, 0]));
  check("CurveCircle p1=(0,1,0) CCW", approx(s.points[1], [0, 1, 0]), JSON.stringify(s.points[1]));
}

{
  const collapsed = runNode("GeometryNodeCurvePrimitiveCircle", { Resolution: 12, Radius: 0 }).Curve as Geometry;
  check("CurveCircle preserves an authored zero radius",
    collapsed.curves[0].points.length === 12
      && collapsed.curves[0].points.every((point) => approx(point, [0, 0, 0])));
}

{
  const socket = (name: string, identifier: string, type: string) => ({
    name, identifier, type, linked: true, enabled: true, hide: false,
    hide_value: false, display_shape: "CIRCLE", idx: 0, value: null,
  });
  const program = {
    Root: {
      name: "Root", type: "GeometryNodeTree", interface: [],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", inputs: [], outputs: [
          socket("Value", "Input_0", "NodeSocketInt"),
          socket("1", "Input_1", "NodeSocketGeometry"),
          socket("2", "Input_2", "NodeSocketGeometry"),
        ], props: {}, label: null },
        { name: "Accumulate", type: "GeometryNodeGroup", group: "_SWITCH.accumalative geo", inputs: [
          socket("Value", "Input_0", "NodeSocketInt"),
          socket("1", "Input_1", "NodeSocketGeometry"),
          socket("2", "Input_2", "NodeSocketGeometry"),
        ], outputs: [socket("Output", "Output_19", "NodeSocketGeometry")], props: {}, label: null },
        { name: "Group Output", type: "NodeGroupOutput", inputs: [
          socket("Geometry", "Output_0", "NodeSocketGeometry"),
        ], outputs: [], props: {}, label: null },
      ],
      links: [
        { from_node: "Group Input", from_socket: "Input_0", to_node: "Accumulate", to_socket: "Input_0" },
        { from_node: "Group Input", from_socket: "Input_1", to_node: "Accumulate", to_socket: "Input_1" },
        { from_node: "Group Input", from_socket: "Input_2", to_node: "Accumulate", to_socket: "Input_2" },
        { from_node: "Accumulate", from_socket: "Output_19", to_node: "Group Output", to_socket: "Output_0" },
      ],
    },
  } as any;
  const accumulated = new Evaluator(program).evalGroup("Root", {
    Input_0: Field.of(1),
    Input_1: box([0, 0, 0], [1, 1, 1]),
    Input_2: box([0, 0, 0], [1, 1, 1]),
  }).Output_0 as Geometry;
  check("Legacy cumulative switch includes and offsets the selected row",
    accumulated.mesh?.positions.length === 16
      && accumulated.mesh.faces.length === 12
      && Math.abs(Math.min(...accumulated.mesh.positions.map((point) => point[2])) + .6299998760223389) < 1e-7);
}

{
  const socket = (name: string, identifier: string, type: string) => ({
    name, identifier, type, linked: true, enabled: true, hide: false,
    hide_value: false, display_shape: "CIRCLE", idx: 0, value: null,
  });
  const program = {
    Root: {
      name: "Root", type: "GeometryNodeTree", interface: [],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", inputs: [], outputs: [
          socket("Active", "Input_0", "NodeSocketGeometry"),
          socket("Lesson Alternative", "Input_1", "NodeSocketGeometry"),
        ], props: {}, label: null },
        { name: "Join", type: "GeometryNodeJoinGeometry", inputs: [socket("Geometry", "Geometry", "NodeSocketGeometry")], outputs: [socket("Geometry", "Geometry", "NodeSocketGeometry")], props: {}, label: null },
        { name: "Group Output", type: "NodeGroupOutput", inputs: [socket("Geometry", "Output_0", "NodeSocketGeometry")], outputs: [], props: {}, label: null },
      ],
      links: [
        { from_node: "Group Input", from_socket: "Input_0", to_node: "Join", to_socket: "Geometry", multi_input_sort_id: 1 },
        { from_node: "Group Input", from_socket: "Input_1", to_node: "Join", to_socket: "Geometry", multi_input_sort_id: 2, muted: true },
        { from_node: "Join", from_socket: "Geometry", to_node: "Group Output", to_socket: "Output_0" },
      ],
    },
  } as any;
  const joined = new Evaluator(program).evalGroup("Root", {
    Input_0: box([0, 0, 0], [1, 1, 1]),
    Input_1: box([2, 0, 0], [3, 1, 1]),
  }).Output_0 as Geometry;
  check("Muted links do not participate in multi-input evaluation", joined.mesh?.positions.length === 8 && joined.mesh.faces.length === 6);
}

{
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  payload.mesh.faces = [[0, 1, 2, 3]];
  const instanced = new Geometry();
  instanced.instances = [{ geometry: payload, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const subdivided = runNode("GeometryNodeSubdivideMesh", { Mesh: instanced, Level: 2 }).Mesh as Geometry;
  check("Subdivide Mesh evaluates inside instance payloads",
    subdivided.instances[0].geometry.mesh?.positions.length === 25
      && subdivided.instances[0].geometry.mesh?.faces.length === 16);
}

{
  const sphere = runNode("GeometryNodeMeshIcoSphere", { Radius: 2, Subdivisions: 3 }).Mesh as Geometry;
  check("Ico Sphere subdivision 3 topology", sphere.mesh?.positions.length === 162 && sphere.mesh.faces.length === 320);
  check("Ico Sphere applies radius", !!sphere.mesh && sphere.mesh.positions.every((point) => Math.abs(Math.hypot(...point) - 2) < 1e-6));
}

{
  let neighborReads = 0;
  const blurred = runNode("GeometryNodeBlurAttribute", {
    Value: 3,
    Weight: 1,
    Iterations: 1111,
  }).Value as Field;
  const values = blurred.array({
    size: 1,
    domain: "POINT",
    neighbors: () => {
      neighborReads++;
      return [];
    },
  });
  check("Blur Attribute honors authored iterations above 512",
    neighborReads === 1111 && Number(values[0]) === 3,
    `neighbor reads=${neighborReads}`);
}

{
  const cube = runNode("GeometryNodeMeshCube", { Size: [2, 3, 4], "Vertices X": 4, "Vertices Y": 3, "Vertices Z": 2 }).Mesh as Geometry;
  const topology = topologyOf(cube.mesh!);
  check("Subdivided Cube welds shared face borders", cube.mesh?.positions.length === 24 && cube.mesh.faces.length === 22);
  check("Subdivided Cube is a closed manifold", topology.edges.every((edge) => edge.faces.length === 2));
  check("Subdivided Cube uses Blender vertex order", !!cube.mesh
    && approx(cube.mesh.positions[0], [-1, -1.5, -2])
    && approx(cube.mesh.positions[1], [-1 / 3, -1.5, -2])
    && approx(cube.mesh.positions[4], [-1, 0, -2]));
  check("Subdivided Cube uses Blender face order", JSON.stringify(cube.mesh?.faces.slice(0, 3)) === JSON.stringify([
    [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3],
  ]));
}

{
  const random = runNode("FunctionNodeRandomValue", {
    Min_001: 2, Max_001: 4, ID: Field.perElem((index) => index), Seed: 17,
  }, { data_type: "FLOAT" }).Value_001 as Field;
  const values = random.array({ size: 3, domain: "POINT", index: (index) => index });
  check("Random Value is deterministic and index-varying", values.every((value) => Number(value) >= 2 && Number(value) < 4) && new Set(values).size === 3);
}

// Curve to Mesh without a profile must preserve curve POINT attributes. Loft
// groups use this path to carry captured source positions into Sample Index.
{
  const source = curve([[1, 2, 3], [4, 5, 6]], false);
  source.curveAttributes.set("captured_position", {
    domain: "POINT",
    data: [[1, 2, 3], [4, 5, 6]],
  });
  const wire = runNode("GeometryNodeCurveToMesh", {
    Curve: source,
    "Profile Curve": new Geometry(),
    "Fill Caps": false,
    Scale: 1,
  }).Mesh as Geometry;
  const captured = wire.mesh?.attributes.get("captured_position")?.data as Vec3[] | undefined;
  check("CurveToMesh wire preserves POINT attributes", !!captured && approx(captured.flat(), [1, 2, 3, 4, 5, 6]));
}

{
  const source = curves([
    { points: [[0, 0, 0], [1, 0, 0]], cyclic: false },
    { points: [[0, 1, 0], [1, 1, 0], [2, 1, 0]], cyclic: false },
  ]);
  const index = Field.make((ctx) => Array.from({ length: ctx.size }, (_, i) => i));
  const captured = runNode("GeometryNodeCaptureAttribute", { Geometry: source, Value: index }, { domain: "CURVE" });
  const values = (captured.Attribute as Field).array(makeFieldCtx(captured.Geometry as Geometry, "POINT")) as number[];
  check("Capture Attribute broadcasts CURVE values to points", approx(values, [0, 0, 1, 1, 1]), JSON.stringify(values));
}

// Anonymous capture IDs must not collide when identically named nodes from
// different nested groups meet at Instance on Points / Realize Instances.
{
  const prototype = new Geometry();
  prototype.mesh = new Mesh();
  prototype.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  prototype.mesh.faces = [[0, 1, 2]];
  const localIndex = Field.perElem((i) => i);
  const prototypeCapture = runNode("GeometryNodeCaptureAttribute", { Geometry: prototype, Value: localIndex }, { domain: "POINT" });

  const pointSource = new Geometry();
  pointSource.mesh = new Mesh();
  pointSource.mesh.positions = [[2, 0, 0]];
  const pointCapture = runNode("GeometryNodeCaptureAttribute", { Geometry: pointSource, Value: [0, 0, 1] }, { domain: "POINT" });
  const placed = runNode("GeometryNodeInstanceOnPoints", {
    Points: pointCapture.Geometry as Geometry, Selection: true, Instance: prototypeCapture.Geometry as Geometry,
    "Pick Instance": false, "Instance Index": 0, Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, {}, ["Points", "Instance"]).Instances as Geometry;
  const realized = realizeInstances(placed);
  const restored = (prototypeCapture.Attribute as Field).array(makeFieldCtx(realized, "POINT")) as number[];
  check("Capture Attribute IDs survive nested instance attribute collisions", approx(restored, [0, 1, 2]), JSON.stringify(restored));
}

{
  const source = curve([[5, 5, 0], [6, 5, 0]], false);
  source.mesh = new Mesh(); // Join Geometry can leave this empty component.
  const position = Field.make((ctx) => Array.from({ length: ctx.size }, (_, i) => [i, 0, 0] as Vec3));
  const moved = runNode("GeometryNodeSetPosition", {
    Geometry: source,
    Selection: true,
    Position: position,
    Offset: [0, 0, 0],
  }, {}, ["Position"]).Geometry as Geometry;
  check("Set Position targets curves beside an empty mesh", approx(moved.curves[0].points.flat(), [0, 0, 0, 1, 0, 0]));
}

// Curve Line Direction mode stores the second input as a vector from Start,
// rather than an absolute End point.
{
  const c = runNode("GeometryNodeCurvePrimitiveLine", {
    Start: [1, 2, 3], End: [99, 99, 99], Direction: [0, -2, 0], Length: 6,
  }, { mode: "DIRECTION" }).Curve as Geometry;
  check("CurveLine direction mode applies normalized direction and length", approx(c.curves[0].points[1], [1, -4, 3]), JSON.stringify(c.curves[0].points));
}

{
  const arc = runNode("GeometryNodeCurveArc", {
    Resolution: 4, Radius: 2, "Start Angle": 0, "Sweep Angle": Math.PI / 2,
    "Connect Center": true, "Invert Arc": false,
  }, { mode: "RADIUS" }).Curve as Geometry;
  check("Curve Arc connects center into a cyclic fill loop", arc.curves[0].cyclic && arc.curves[0].points.length === 5);
  check("Curve Arc preserves radius endpoints", approx(arc.curves[0].points[0], [2, 0, 0]) && approx(arc.curves[0].points[3], [0, 2, 0]));
}

{
  const star = runNode("GeometryNodeCurveStar", { Points: 5, "Inner Radius": .5, "Outer Radius": 1, Twist: 0 }).Curve as Geometry;
  check("Curve Star alternates ten cyclic points", star.curves[0].cyclic && star.curves[0].points.length === 10);
  check("Curve Star starts on outer +X", approx(star.curves[0].points[0], [1, 0, 0]));
  const collapsed = curve([[0, 0, 0], [0, 0, 0], [0, 0, 0]], true);
  const filleted = runNode("GeometryNodeFilletCurve", { Curve: collapsed, Radius: .2, Count: 3, "Limit Radius": true }).Curve as Geometry;
  check("Fillet Curve retains count on collapsed corners", filleted.curvePointCount() === 12, `points=${filleted.curvePointCount()}`);
  const filled = runNode("GeometryNodeFillCurve", { Curve: filleted, Mode: "Triangles" as any }).Mesh as Geometry;
  check("Fill Curve retains one collapsed center point", filled.mesh?.positions.length === 1 && filled.mesh.faces.length === 0);
}

// (B) CombineXYZ / SeparateXYZ round-trip
{
  const v = runNode("ShaderNodeCombineXYZ", { X: 2, Y: 3, Z: 4 }).Vector as Field;
  check("CombineXYZ -> (2,3,4)", approx(v.value as number[], [2, 3, 4]));
}

{
  const mapped = runNode("ShaderNodeMapRange", {
    Value: 2, "From Min": 0, "From Max": 1, "To Min": 0, "To Max": 3,
  }, { interpolation_type: "SMOOTHERSTEP", clamp: false }).Result as Field;
  check("Map Range Smoother Step clamps its interpolation factor", Math.abs(Number(mapped.value) - 3) < 1e-9, `got ${mapped.value}`);

  const mappedVector = runNode("ShaderNodeMapRange", {
    Vector: [0.5, 0.25, 0.75],
    From_Min_FLOAT3: [0, 0, 0], From_Max_FLOAT3: [1, 1, 1],
    To_Min_FLOAT3: [-2, 10, 100], To_Max_FLOAT3: [2, 14, 108],
  }, { data_type: "FLOAT_VECTOR", interpolation_type: "LINEAR", clamp: false }).Vector as Field;
  check("Map Range vector mode uses FLOAT3 sockets component-wise", approx(mappedVector.value as number[], [0, 11, 106]), `got ${mappedVector.value}`);

  const wave = runNode("ShaderNodeTexWave", {
    Vector: [0.5, 0, 0], Scale: 1, Distortion: 0, Detail: 2,
    "Detail Scale": 1, "Detail Roughness": 0.5, "Phase Offset": 0,
  }, { wave_type: "BANDS", bands_direction: "X", wave_profile: "SIN" }, ["Vector"]).Fac as Field;
  const waveValue = Number(wave.array({ size: 1, domain: "POINT" })[0]);
  check("Wave Texture SIN matches Blender's fixed-20 phase", Math.abs(waveValue - 0.91953576) < 1e-6, `got ${waveValue}`);

  const noiseGeometry = new Geometry();
  noiseGeometry.instances = [{ geometry: new Geometry(), position: [-2.9740545749664307, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const noise = runNode("ShaderNodeTexNoise", {
    Vector: [0, 0, 0], W: 1 / 1111, Scale: 18.709999084472656,
    Detail: 2, Roughness: .5, Lacunarity: 2, Distortion: 0,
  }, { noise_dimensions: "4D", noise_type: "FBM", normalize: true }).Fac as Field;
  const noiseValue = Number(noise.array(makeFieldCtx(noiseGeometry, "INSTANCE"))[0]);
  check("Noise Texture 4D matches Blender's driven header sample", Math.abs(noiseValue - 0.4700492322444916) < 2e-5, `got ${noiseValue}`);

  const rotatedVector = runNode("FunctionNodeRotateVector", {
    Vector: [1, 0, 0], Rotation: [0, 0, Math.PI / 2],
  }).Vector as Field;
  check("Rotate Vector applies Euler rotation", approx(rotatedVector.value as number[], [0, 1, 0]), JSON.stringify(rotatedVector.value));
}

// (B2) Align Euler antiparallel AUTO pivot remains a proper rotation. A tiny
// Mesh Circle cosine at -Y must not normalize to a zero axis / reflection.
{
  const rotation = runNode(
    "FunctionNodeAlignEulerToVector",
    { Vector: [-3.7e-16, -1, 0], Factor: 1 },
    { axis: "Y", pivot_axis: "AUTO" },
  ).Rotation as Field;
  const value = rotation.array({ size: 1, domain: "POINT" })[0] as Vec3;
  check("AlignEuler antiparallel Y uses stable Z pivot", Math.abs(Math.abs(value[2]) - Math.PI) < 1e-6 && Math.abs(value[0]) < 1e-6, JSON.stringify(value));

  const twistedRotation = runNode(
    "FunctionNodeAlignEulerToVector",
    { Rotation: [0, 0, Math.PI / 2], Vector: [0, 0, 1], Factor: 1 },
    { axis: "Z", pivot_axis: "AUTO" },
  ).Rotation as Field;
  const twistedValue = twistedRotation.array({ size: 1, domain: "POINT" })[0] as Vec3;
  check("AlignEuler preserves incoming roll around the aligned axis", Math.abs(twistedValue[2] - Math.PI / 2) < 1e-6, JSON.stringify(twistedValue));

  const modernRotation = runNode(
    "FunctionNodeAlignRotationToVector",
    { Rotation: [0, 0, 0], Vector: [0, -1, 0], Factor: 1 },
    { axis: "Y", pivot_axis: "AUTO" },
  ).Rotation as Field;
  const modernValue = modernRotation.array({ size: 1, domain: "POINT" })[0] as Vec3;
  check("AlignRotation antiparallel Y keeps AUTO roll around Z", Math.abs(Math.abs(modernValue[2]) - Math.PI) < 1e-6 && Math.abs(modernValue[0]) < 1e-6, JSON.stringify(modernValue));
}

// (C) MeshCube size (1,1,1) -> 8 verts, spans +/-0.5
{
  const g = runNode("GeometryNodeMeshCube", { Size: [1, 1, 1], "Vertices X": 2, "Vertices Y": 2, "Vertices Z": 2 }).Mesh as Geometry;
  const xs = g.mesh!.positions.map((p) => p[0]);
  check("MeshCube -> 8 verts", g.mesh!.positions.length === 8);
  check("MeshCube spans +/-0.5", Math.abs(Math.min(...xs) + 0.5) < 1e-6 && Math.abs(Math.max(...xs) - 0.5) < 1e-6);
}

{
  const dual = runNode("GeometryNodeDualMesh", { Mesh: box([-1, -1, -1], [1, 1, 1]) })["Dual Mesh"] as Geometry;
  let volume = 0;
  for (const face of dual.mesh?.faces ?? []) for (let corner = 1; corner + 1 < face.length; corner++) {
    const a = dual.mesh!.positions[face[0]], b = dual.mesh!.positions[face[corner]], c = dual.mesh!.positions[face[corner + 1]];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  check("Dual Mesh keeps a closed surface outward", dual.mesh?.positions.length === 6 && dual.mesh.faces.length === 8 && volume > 0, `${dual.mesh?.positions.length}v/${dual.mesh?.faces.length}f volume=${volume}`);

  const openGrid = new Geometry();
  openGrid.mesh = new Mesh();
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) openGrid.mesh.positions.push([x, y, 0]);
  const gi = (x: number, y: number) => y * 3 + x;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    openGrid.mesh.faces.push([gi(x, y), gi(x + 1, y), gi(x + 1, y + 1)], [gi(x, y), gi(x + 1, y + 1), gi(x, y + 1)]);
  }
  const openDual = runNode("GeometryNodeDualMesh", { Mesh: openGrid })["Dual Mesh"] as Geometry;
  check("Dual Mesh omits open boundary fans by default", openDual.mesh?.positions.length === 8 && openDual.mesh.faces.length === 1 && openDual.mesh.faces[0].length === 6,
    `${openDual.mesh?.positions.length}v/${openDual.mesh?.faces.length}f ${JSON.stringify(openDual.mesh?.faces[0])}`);
}

// (D) FilletCurve: 90deg open corner A(0,0,0) B(1,0,0) C(1,1,0), radius .5, count 2
{
  const f = runNode("GeometryNodeFilletCurve", { Curve: curve([[0, 0, 0], [1, 0, 0], [1, 1, 0]], false), Radius: 0.5, Count: 2 }).Curve as Geometry;
  const fp = f.curves[0].points;
  check("FilletCurve -> 5 pts (endpoint + arc + endpoint)", fp.length === 5, `got ${fp.length}`);
  check("FilletCurve endpoints preserved", approx(fp[0], [0, 0, 0]) && approx(fp[4], [1, 1, 0]));
  check("FilletCurve tangent pt on BA = (0.5,0,0)", approx(fp[1], [0.5, 0, 0]), JSON.stringify(fp[1]));
  check("FilletCurve arc mid = (0.85355,0.14645,0)", approx(fp[2], [0.85355, 0.14645, 0]), JSON.stringify(fp[2]));
  check("FilletCurve tangent pt on BC = (1,0.5,0)", approx(fp[3], [1, 0.5, 0]), JSON.stringify(fp[3]));
}

// (D2) Set Spline Type NURBS: open cubic smoothing approximates interior controls
{
  const c = runNode(
    "GeometryNodeCurveSplineType",
    { Curve: curve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], false) },
    { spline_type: "NURBS" },
  ).Curve as Geometry;
  const pts = c.curves[0].points;
  const maxX = Math.max(...pts.map((p) => p[0]));
  check("SetSplineType NURBS uses Blender's non-zero knot spans", pts.length === 13, `got ${pts.length}`);
  check("SetSplineType NURBS endpoints preserved", approx(pts[0], [0, 0, 0]) && approx(pts[pts.length - 1], [0, 1, 0]));
  check("SetSplineType NURBS cuts inward from control corner", maxX < 0.76 && maxX > 0.74, `maxX=${maxX}`);
}

{
  const source = curve([[0, 0, 0], [.5, .25, 0], [1, 0, 0]], false);
  const resolved = runNode("GeometryNodeSetSplineResolution", { Geometry: source, Selection: true, Resolution: 12 }).Geometry as Geometry;
  check("Set Spline Resolution preserves imported evaluated samples", resolved.curvePointCount() === 3);
}

// Imported Bezier objects retain both evaluated samples and authored controls.
// Converting them to Poly uses the controls, matching Blender's 14-point Text
// Soup guide instead of instancing over all 157 evaluated Bezier samples.
{
  const source = curve([[0, 0, 0], [.25, 0, 0], [.5, 0, 0], [.75, 0, 0], [1, 0, 0]], false);
  source.curves[0].controlPoints = [[0, 0, 0], [1, 0, 0]];
  const converted = runNode("GeometryNodeCurveSplineType", { Curve: source }, { spline_type: "POLY" }).Curve as Geometry;
  check("SetSplineType POLY restores authored controls", converted.curves[0].points.length === 2, `got ${converted.curves[0].points.length}`);
}

{
  const source = curve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], true);
  const converted = runNode("GeometryNodeCurveSplineType", { Curve: source }, { spline_type: "BEZIER" }).Curve as Geometry;
  check("SetSplineType BEZIER preserves poly evaluated topology before handle edits",
    converted.curves[0].points.length === 4 && converted.curves[0].controlPoints?.length === 4,
    `points=${converted.curves[0].points.length}`);
}

// (E) CurveToMesh: straight Z rail (open) + diamond profile (cyclic), no caps
{
  const rail = curve([[0, 0, 0], [0, 0, 2]], false);
  const prof = curve([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], true);
  const m = (runNode("GeometryNodeCurveToMesh", { Curve: rail, "Profile Curve": prof, "Fill Caps": false }).Mesh as Geometry).mesh!;
  check("CurveToMesh -> 8 verts / 4 faces", m.positions.length === 8 && m.faces.length === 4, `got ${m.positions.length}v/${m.faces.length}f`);
  const zs = m.positions.map((p) => p[2]);
  check("CurveToMesh spans rail z 0..2", Math.abs(Math.min(...zs)) < 1e-6 && Math.abs(Math.max(...zs) - 2) < 1e-6);
}

// Blender maps a profile's local +X to the negative transported normal and
// local +Y to the negative binormal. This intentionally asymmetric case was
// measured with tools/blender_curve_to_mesh_axes_probe.py.
{
  const rail = curve([[0, 0, 0], [1, 0, 0]], false);
  const profile = curve([[2, 3, 0], [4, 5, 0]], false);
  const mesh = (runNode("GeometryNodeCurveToMesh", { Curve: rail, "Profile Curve": profile, "Fill Caps": false }).Mesh as Geometry).mesh!;
  check(
    "CurveToMesh preserves Blender profile axes",
    approx(mesh.positions.flat(), [0, -2, -3, 0, -4, -5, 1, -2, -3, 1, -4, -5]),
    JSON.stringify(mesh.positions),
  );
  check(
    "CurveToMesh preserves Blender face winding",
    JSON.stringify(mesh.faces) === JSON.stringify([[0, 1, 3, 2]]),
    JSON.stringify(mesh.faces),
  );
}

{
  const rail = curve([[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]], true);
  const profile = curve([[0, 0, 0], [1, 0, 0]], false);
  const mesh = (runNode("GeometryNodeCurveToMesh", { Curve: rail, "Profile Curve": profile, "Fill Caps": false }).Mesh as Geometry).mesh!;
  check(
    "CurveToMesh sweeps positive planar profiles toward loop interior",
    mesh.positions.every((point) => point[0] >= -1e-6 && point[0] <= 4 + 1e-6 && point[1] >= -1e-6 && point[1] <= 3 + 1e-6),
    JSON.stringify(mesh.positions),
  );
}

// Blender Grid is X-major, and Mesh to Curve follows its stored edge order.
{
  const grid = runNode("GeometryNodeMeshGrid", { "Size X": 2, "Size Y": 2, "Vertices X": 2, "Vertices Y": 2 }).Mesh as Geometry;
  check("MeshGrid uses Blender X-major vertex order", JSON.stringify(grid.mesh!.positions) === JSON.stringify([[-1, -1, 0], [-1, 1, 0], [1, -1, 0], [1, 1, 0]]));
  const boundary = runNode("GeometryNodeMeshToCurve", { Mesh: grid, Selection: true }).Curve as Geometry;
  check("MeshToCurve follows stored Grid edge order", JSON.stringify(boundary.curves[0]?.points) === JSON.stringify([[-1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, -1, 0]]));
}

// (F) FillCurve NGON: triangle -> 1 face, 3 verts
{
  const g = runNode("GeometryNodeFillCurve", { Curve: curve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve NGON triangle -> 1 face", g.mesh!.faces.length === 1 && g.mesh!.positions.length === 3);
}

// (F2) FillCurve NGONS: single simple loop keeps exact ngon vertex order
{
  const pts: Vec3[] = [[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curve(pts, true) }, { mode: "NGONS" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve NGON single loop keeps one ngon", m.faces.length === 1 && m.positions.length === 4);
  check("FillCurve NGON single loop preserves vertex order", JSON.stringify(m.faces[0]) === JSON.stringify([0, 1, 2, 3]) && m.positions.every((p, i) => approx(p, pts[i])));
}

{
  const clockwise = [[-1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, -1, 0]] as Vec3[];
  const g = runNode("GeometryNodeFillCurve", { Curve: curve(clockwise, true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve NGON normalizes clockwise loops to +Z",
    JSON.stringify(g.mesh!.faces[0]) === JSON.stringify([3, 2, 1, 0]) && g.mesh!.positions.every((p, i) => approx(p, clockwise[i])),
    JSON.stringify({ face: g.mesh!.faces[0], positions: g.mesh!.positions }));
}

{
  const collinear = runNode("GeometryNodeFillCurve", {
    Curve: curve([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]], true),
  }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const used = new Set(collinear.mesh!.faces.flat());
  check("Fill Curve retains collinear boundary points in triangulation",
    collinear.mesh!.faces.length === 3 && used.size === 5,
    `${used.size} used / ${collinear.mesh!.faces.length} faces`);
}

{
  const duplicateCorners = curve([[0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]], true);
  const welded = runNode("GeometryNodeFillCurve", { Curve: duplicateCorners }, { mode: "NGONS" }).Mesh as Geometry;
  check("Fill Curve welds adjacent cyclic duplicates", welded.mesh?.positions.length === 4 && welded.mesh.faces[0]?.length === 4, `${welded.mesh?.positions.length}/${welded.mesh?.faces[0]?.length}`);
}

// Blender splits crossing cyclic outlines before its even-odd triangle fill.
// Two overlapping 2x2 squares therefore retain their eight authored corners,
// add two boundary intersections, and omit the doubly covered unit square.
{
  const crossing = curves([
    { points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], cyclic: true },
    { points: [[1, -1, 0], [3, -1, 0], [3, 1, 0], [1, 1, 0]], cyclic: true },
  ]);
  const filled = runNode("GeometryNodeFillCurve", { Curve: crossing }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const m = filled.mesh!;
  check("Fill Curve splits crossing cyclic outlines", m.positions.length === 10, `${m.positions.length} verts`);
  check("Fill Curve applies even-odd overlap fill", Math.abs(meshSignedAreaXY(m) - 6) < 1e-6, `${m.faces.length} faces / area ${meshSignedAreaXY(m)}`);
}

// Fill Curve is defined in the curve component's local XY plane.
{
  const g = runNode("GeometryNodeFillCurve", { Curve: curve([[0, 0, -0.019], [1, 0, -0.019], [0, 1, -0.019]], true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve projects translated curves onto local XY", g.mesh!.positions.every((p) => Math.abs(p[2]) < 1e-9));
}

{
  const density = Field.perElem((i, ctx) => {
    const point = ctx.position?.(i) ?? [0, 0, 0];
    return Math.hypot(point[0], point[1], point[2]);
  });
  const volume = runNode("GeometryNodeVolumeCube", {
    Density: density,
    Background: 1,
    Min: [-1, -1, -1],
    Max: [1, 1, 1],
    "Resolution X": 24,
    "Resolution Y": 24,
    "Resolution Z": 24,
  }).Volume as any;
  const surface = runNode("GeometryNodeVolumeToMesh", {
    Volume: volume,
    "Voxel Size": 0.1,
    Threshold: 0.5,
  }).Mesh as Geometry;
  check("Volume Cube to Mesh extracts a welded SDF surface", !!surface.mesh && surface.mesh.positions.length > 100 && surface.mesh.faces.length > 100);
  const volumeFaceSizes = (surface.mesh?.faces ?? []).reduce<Record<string, number>>((counts, face) => {
    counts[String(face.length)] = (counts[String(face.length)] ?? 0) + 1;
    return counts;
  }, {});
  check("Volume to Mesh reconstructs Blender quad topology", !!surface.mesh && surface.mesh.faces.every((face) => face.length === 4),
    JSON.stringify(volumeFaceSizes));
  const volumeEdges = new Map<string, number>();
  for (const face of surface.mesh?.faces ?? []) for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    volumeEdges.set(key, (volumeEdges.get(key) ?? 0) + 1);
  }
  check("Volume to Mesh surface nets are manifold", [...volumeEdges.values()].every((uses) => uses === 2));

  // Volume Cube stores voxel-center samples when it executes. Later changes to
  // a source field closure must not leak through the cache boundary.
  let cachedRadius = 0.45;
  const cachedDensity = Field.perElem((i, ctx) => {
    const point = ctx.position?.(i) ?? [0, 0, 0];
    return Math.hypot(point[0], point[1], point[2]) - cachedRadius;
  });
  const cachedVolume = runNode("GeometryNodeVolumeCube", {
    Density: cachedDensity, Background: 1, Min: [-1, -1, -1], Max: [1, 1, 1],
    "Resolution X": 18, "Resolution Y": 18, "Resolution Z": 18,
  }).Volume as any;
  cachedRadius = 0.9;
  const cachedSurface = runNode("GeometryNodeVolumeToMesh", {
    Volume: cachedVolume, "Resolution Mode": "Grid", "Voxel Size": 0.1, Threshold: 0,
  }).Mesh as Geometry;
  const cachedExtent = Math.max(...cachedSurface.mesh!.positions.flatMap((point) => point.map(Math.abs)));
  check("Volume Cube caches voxel-center field samples", cachedExtent < 0.6, `extent=${cachedExtent}`);

  const refinedSurface = runNode("GeometryNodeVolumeToMesh", {
    Volume: volume, "Resolution Mode": "Size", "Voxel Size": 0.04, Threshold: 0.5,
  }).Mesh as Geometry;
  check("Volume to Mesh Size mode resamples the stored grid", (refinedSurface.mesh?.faces.length ?? 0) > (surface.mesh?.faces.length ?? 0),
    `grid=${surface.mesh?.faces.length} size=${refinedSurface.mesh?.faces.length}`);
}

{
  const target = new Geometry();
  target.mesh = new Mesh();
  target.mesh.positions = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
  target.mesh.faces = [[0, 1, 2]];
  const source = new Geometry();
  source.mesh = new Mesh();
  source.mesh.positions = [[0.5, 0.5, 1]];
  const position = runNode("GeometryNodeProximity", { Target: target }, { target_element: "FACES" }).Position as Field;
  check("Geometry Proximity FACES projects onto triangle interiors", approx(position.array(makeFieldCtx(source, "POINT"))[0] as number[], [0.5, 0.5, 0]));
}

{
  const concave = new Mesh();
  concave.positions = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [1, 1, 0], [0, 2, 0]];
  const triangles = triangulateFaceIndices(concave, [0, 1, 2, 3, 4]);
  const area = triangles.reduce((sum, [a, b, c]) => {
    const p = concave.positions[a], q = concave.positions[b], r = concave.positions[c];
    return sum + Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) * 0.5;
  }, 0);
  check("concave n-gons use ear-clipped ray triangles", triangles.length === 3 && Math.abs(area - 3) < 1e-9, `${triangles.length} triangles / area ${area}`);
}

// (F3) FillCurve nested squares: inner loop is a hole and ring triangulates
{
  const outer: Vec3[] = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]];
  const inner: Vec3[] = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curves([{ points: outer, cyclic: true }, { points: inner, cyclic: true }]) }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve nested squares -> original loop verts only", m.positions.length === 8, `got ${m.positions.length}`);
  check("FillCurve nested squares -> triangles only", m.faces.length > 0 && m.faces.every((f) => f.length === 3));
  check("FillCurve nested squares area subtracts hole", Math.abs(meshSignedAreaXY(m) - 12) < 1e-6, `area=${meshSignedAreaXY(m)}`);
}

// Blender's N-gons mode preserves one face per authored outline, but partitions
// nested outlines into an annulus so glyph counters remain open.
{
  const outer: Vec3[] = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]];
  const inner: Vec3[] = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curves([{ points: outer, cyclic: true }, { points: inner, cyclic: true }]) }, { mode: "NGONS" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve NGONS keeps one face per nested outline", m.positions.length === 8 && m.faces.length === 2, `got ${m.positions.length}v/${m.faces.length}f`);
  check("FillCurve NGONS subtracts the nested hole", Math.abs(meshSignedAreaXY(m) - 12) < 1e-6, `area=${meshSignedAreaXY(m)}`);
}

// (F4) FillCurve three-level nesting: middle is a hole, inner is an island
{
  const outer: Vec3[] = [[-3, -3, 0], [3, -3, 0], [3, 3, 0], [-3, 3, 0]];
  const middle: Vec3[] = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]];
  const inner: Vec3[] = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curves([{ points: outer, cyclic: true }, { points: middle, cyclic: true }, { points: inner, cyclic: true }]) }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve three-level nesting -> triangles only", m.faces.length > 0 && m.faces.every((f) => f.length === 3));
  check("FillCurve three-level nesting keeps inner island", Math.abs(meshSignedAreaXY(m) - 24) < 1e-6, `area=${meshSignedAreaXY(m)}`);
}

// (G) SetPosition with linked offset moves points
{
  const grid = runNode("GeometryNodeMeshGrid", { "Size X": 2, "Size Y": 2, "Vertices X": 2, "Vertices Y": 2 }).Mesh as Geometry;
  const moved = runNode("GeometryNodeSetPosition", { Geometry: grid, Selection: true, Position: [0, 0, 0], Offset: [0, 0, 5] }, {}, ["Offset"]).Geometry as Geometry;
  check("SetPosition offset z+5", moved.mesh!.positions.every((p) => Math.abs(p[2] - 5) < 1e-6));
}

// (H) Switch: linked numeric fields convert to bool with Blender's >0 rule
{
  const sw = Field.perElem((i) => i - 1);
  const out = runNode("GeometryNodeSwitch", { Switch: sw, False: 10, True: 20 }, { input_type: "FLOAT" }).Output as Field;
  const arr = out.array({ size: 3, domain: "POINT" });
  check("Switch field uses >0 truthiness", approx(arr as number[], [10, 10, 20]));
}

// (I) Mix RGBA: dumped graphs link the active output as Result_Color
{
  const mixed = runNode("ShaderNodeMix", { Factor_Float: 0.25, A_Color: [0, 0, 0], B_Color: [4, 8, 12] }, { data_type: "RGBA" }).Result_Color as Field;
  check("Mix RGBA exposes Result_Color", approx(mixed.value as number[], [1, 2, 3]));
}

// (I2) MenuSwitch: string menu selects the matching enum item
{
  const out = runNode(
    "GeometryNodeMenuSwitch",
    { Menu: "Beta", Item_0: 10, Item_1: 20 },
    { data_type: "FLOAT", enum_items: [{ name: "Alpha" }, { name: "Beta" }] },
  ).Output as Field;
  check("MenuSwitch picks enum string item", out.value === 20, `got ${out.value}`);
}

{
  const a = curve([[0, 0, 0], [1, 0, 0]], false);
  const b = curve([[0, 1, 0], [1, 1, 0]], false);
  const out = runNode(
    "GeometryNodeMenuSwitch",
    { Menu: 2, Item_0: a, Item_1: b },
    { data_type: "GEOMETRY" },
  ).Output as Geometry;
  check("MenuSwitch unmatched enum item outputs empty geometry", out.curves.length === 0 && out.instances.length === 0 && !out.mesh);
}

// (I3) VectorRotate: axis-angle 90deg around +Z
{
  const out = runNode("ShaderNodeVectorRotate", { Vector: [1, 0, 0], Center: [0, 0, 0], Axis: [0, 0, 1], Angle: Math.PI / 2, Rotation: [0, 0, 0] }, { rotation_type: "AXIS_ANGLE", invert: false }).Vector as Field;
  check("VectorRotate axis-angle z90", approx(out.value as number[], [0, 1, 0]));
}

// (I4) TrimCurve: factor range interpolates endpoints on a straight segment
{
  const out = runNode("GeometryNodeTrimCurve", { Curve: curve([[0, 0, 0], [4, 0, 0]], false), Start: 0.25, End: 0.75, Start_001: 0, End_001: 1 }, { mode: "FACTOR" }).Curve as Geometry;
  const pts = out.curves[0].points;
  check("TrimCurve factor keeps two interpolated endpoints", pts.length === 2 && approx(pts[0], [1, 0, 0]) && approx(pts[1], [3, 0, 0]), JSON.stringify(pts));
}

{
  const out = runNode("GeometryNodeTrimCurve", {
    Curve: curve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], true),
    Start: 0,
    End: 1,
    Start_001: 0,
    End_001: 1,
  }, { mode: "FACTOR" }).Curve as Geometry;
  check("TrimCurve full cyclic range opens at a duplicated endpoint",
    !out.curves[0].cyclic && out.curves[0].points.length === 5 && approx(out.curves[0].points[0], out.curves[0].points[4]));
}

// (I5) ScaleElements: one selected quad scales as an island about its center
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  m.faceMaterial = [0];
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeScaleElements", { Geometry: g, Selection: true, Scale: 2, Center: [0, 0, 0], "Scale Mode": "Uniform", Axis: [1, 0, 0] }, { domain: "FACE" }).Geometry as Geometry;
  const p = out.mesh!.positions;
  check("ScaleElements quad scale 2 about center", approx(p[0], [-0.5, -0.5, 0]) && approx(p[2], [1.5, 1.5, 0]), JSON.stringify(p));
}

// (I6) AttributeStatistic: scalar mean/min/max on a known POINT attribute
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  m.attributes.set("a", { domain: "POINT", data: [2, 4, 8] });
  const g = new Geometry();
  g.mesh = m;
  const attr = Field.perElem((i, ctx) => ctx.attr?.("a", i) ?? 0);
  const out = runNode("GeometryNodeAttributeStatistic", { Geometry: g, Selection: true, Attribute: attr }, { domain: "POINT", data_type: "FLOAT" });
  check("AttributeStatistic mean/min/max", (out.Mean as Field).value === 14 / 3 && (out.Min as Field).value === 2 && (out.Max as Field).value === 8);
}

// (J) FieldAtIndex samples Value on its declared source domain, not the consumer domain
{
  const value = Field.perElem((i) => i * 10);
  const index = Field.perElem((i) => i + 1);
  const out = runNode("GeometryNodeFieldAtIndex", { Value: value, Index: index }, { domain: "POINT" }).Value as Field;
  const arr = out.array({
    size: 2,
    domain: "FACE",
    fork: (domain) => ({ size: domain === "POINT" ? 4 : 2, domain }),
  });
  check("FieldAtIndex samples source domain", approx(arr as number[], [10, 20]));
}

{
  const source = new Geometry();
  source.mesh = new Mesh();
  source.mesh.positions = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  const value = Field.perElem((i) => i * 10);
  const index = Field.make((ctx) => Array.from({ length: ctx.size }, (_, i) => [0, .5, 1, 1.5][i]));
  const sampled = runNode("GeometryNodeSampleIndex", { Geometry: source, Value: value, Index: index }, { domain: "POINT", clamp: true }).Value as Field;
  check("Sample Index truncates float fields connected to its integer socket",
    approx(sampled.array({ size: 4, domain: "POINT" }) as number[], [0, 0, 10, 10]));
}

// (K) MeshToCurve carries FACE attrs to curve POINT attrs for captured factors
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  m.faceMaterial = [0];
  m.attributes.set("split", { domain: "FACE", data: [[0.25, 0.75, 0]] });
  const g = new Geometry();
  g.mesh = m;
  const c = runNode("GeometryNodeMeshToCurve", { Mesh: g }).Curve as Geometry;
  const carried = c.curveAttributes.get("split")?.data ?? [];
  check("MeshToCurve maps FACE attr to curve points", carried.length === 4 && carried.every((v) => approx(v as number[], [0.25, 0.75, 0])));
}

// (L) MergeByDistance welds duplicated quad seams and carries attrs/materials
{
  const m = new Mesh();
  m.positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0],
  ];
  m.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
  m.edges = [[1, 4], [4, 7], [1, 2], [5, 6]];
  m.faceMaterial = [1, 2];
  m.materialSlots = [null, "left", "right"];
  m.attributes.set("pid", { domain: "POINT", data: [0, 1, 2, 3, 4, 5, 6, 7] });
  m.attributes.set("fid", { domain: "FACE", data: [100, 200] });
  m.attributes.set("cid", { domain: "CORNER", data: [10, 11, 12, 13, 20, 21, 22, 23] });
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: true, Distance: 1e-4, Mode: "All" }).Geometry as Geometry;
  const om = out.mesh!;
  const edgeKeys = om.edges.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)).sort();
  check("MergeByDistance welds two quad seam verts", om.positions.length === 6 && om.faces.length === 2, `got ${om.positions.length}v/${om.faces.length}f`);
  check("MergeByDistance carries POINT attrs from first reps", approx(om.attributes.get("pid")!.data as number[], [0, 1, 2, 3, 5, 6]));
  check("MergeByDistance carries FACE attrs/materials", approx(om.attributes.get("fid")!.data as number[], [100, 200]) && approx(om.faceMaterial, [1, 2]));
  check("MergeByDistance carries CORNER attrs and remaps edges", approx(om.attributes.get("cid")!.data as number[], [10, 11, 12, 13, 20, 21, 22, 23]) && edgeKeys.join(",") === "1_2,4_5");
  check("MergeByDistance preserves material slots", JSON.stringify(om.materialSlots) === JSON.stringify([null, "left", "right"]));
}

// Coincident joined meshes weld to one polygon in Blender; keeping both face
// copies doubles downstream extrusions without adding any vertices.
{
  const m = new Mesh();
  m.positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0],
  ];
  m.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
  m.faceMaterial = [2, 7];
  m.attributes.set("fid", { domain: "FACE", data: [10, 20] });
  m.attributes.set("cid", { domain: "CORNER", data: [0, 1, 2, 3, 4, 5, 6, 7] });
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: true, Distance: 1e-4, Mode: "All" }).Geometry as Geometry;
  const om = out.mesh!;
  check("MergeByDistance removes coincident duplicate faces", om.positions.length === 4 && om.faces.length === 1, `got ${om.positions.length}v/${om.faces.length}f`);
  check("MergeByDistance keeps first coincident face data", approx(om.faceMaterial, [2]) && approx(om.attributes.get("fid")!.data as number[], [10]) && approx(om.attributes.get("cid")!.data as number[], [0, 1, 2, 3]));
}

// A collapsed long quad still carries a valid center-to-rim triangle after
// Blender's triangulation; the exporter must preserve that topology.
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [0, 0, 0], [10, 0, 0], [10, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  const g = new Geometry();
  g.mesh = m;
  const soup = toTriSoup(g);
  check("toTriSoup preserves a collapsed long fan quad", soup.indices.length === 6, `tris=${soup.indices.length / 3}`);
}

// (M) MergeByDistance selection=false vertices do not participate in welding
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [0, 0, 0]];
  m.edges = [[0, 1]];
  const g = new Geometry();
  g.mesh = m;
  const sel = Field.perElem((i) => (i === 0 ? 1 : 0));
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: sel, Distance: 1e-4, Mode: "All" }).Geometry as Geometry;
  check("MergeByDistance leaves unselected coincident verts separate", out.mesh!.positions.length === 2 && out.mesh!.edges.length === 1);
}

// All-selected Split Edges reconstructs face boundaries in linear time and
// retains only genuinely loose explicit edges outside those boundaries.
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [3, 0, 0]];
  m.faces = [[0, 1, 2], [0, 2, 3]];
  m.faceMaterial = [0, 0];
  m.edges = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 0], [4, 5]];
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeSplitEdges", { Mesh: g, Selection: true }).Mesh as Geometry;
  check("Split Edges rebuilds selected face edges without quadratic duplicates", out.mesh?.positions.length === 8 && out.mesh.faces.length === 2 && out.mesh.edges.length === 7, `got ${out.mesh?.positions.length}v/${out.mesh?.edges.length}e`);
}

// EDGE-domain deletion removes faces incident to selected edges but preserves
// the other face boundaries as loose wire geometry.
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2], [0, 2, 3]];
  const g = new Geometry();
  g.mesh = m;
  const interior = Field.perElem((i, ctx) => (ctx.edgeFaceCount?.(i) === 2 ? 1 : 0)).tagged("EDGE");
  const out = runNode("GeometryNodeDeleteGeometry", { Geometry: g, Selection: interior }, { domain: "EDGE" }).Geometry as Geometry;
  check("Delete Geometry EDGE retains unselected boundary wire", out.mesh?.positions.length === 4 && out.mesh.edges.length === 4 && out.mesh.faces.length === 0, `got ${out.mesh?.positions.length}v/${out.mesh?.edges.length}e/${out.mesh?.faces.length}f`);
}

// POINT-domain deletion applies to curve components too. Cyclic is a
// spline-domain property, so deleting points preserves it and remaps point
// attributes in source order (the Blender-style node panel relies on this to
// fill only the rounded rectangle's lower arc).
{
  const g = curve([[-1, 0, 0], [0, 1, 0], [1, 0, 0], [0, -1, 0]], true);
  g.curveAttributes.set("id", { domain: "POINT", data: [10, 20, 30, 40] });
  const upper = Field.perElem((i, ctx) => (ctx.position?.(i)[1] ?? 0) > 0 ? 1 : 0);
  const out = runNode("GeometryNodeDeleteGeometry", { Geometry: g, Selection: upper }, { domain: "POINT" }).Geometry as Geometry;
  check("Delete Geometry POINT preserves cyclic spline property", out.curves.length === 1 && out.curves[0].cyclic && approx(out.curves[0].points.flat() as number[], [-1, 0, 0, 1, 0, 0, 0, -1, 0]), JSON.stringify(out.curves[0]));
  check("Delete Geometry POINT remaps curve attributes", approx(out.curveAttributes.get("id")?.data as number[], [10, 30, 40]), JSON.stringify(out.curveAttributes.get("id")?.data));
}

// (N) MergeByDistance checks neighboring hash cells
{
  const d = 1e-5;
  const m = new Mesh();
  m.positions = [[0.49 * d, 0, 0], [1.01 * d, 0, 0]];
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: true, Distance: d, Mode: "All" }).Geometry as Geometry;
  const crossesCell = Math.floor(m.positions[0][0] / d) !== Math.floor(m.positions[1][0] / d);
  check("MergeByDistance merges cross-cell pair within distance", crossesCell && out.mesh!.positions.length === 1, `got ${out.mesh!.positions.length} verts`);
}

// (O) Derived topology is cached per Mesh instance and invalidated by clone mutation
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  const t1 = topologyOf(m);
  const t2 = topologyOf(m);
  const c = m.clone();
  const ct1 = topologyOf(c);
  c.faces = [...c.faces, [0, 2, 3]];
  const ct2 = topologyOf(c);
  check("topologyOf returns same object for same mesh", t1 === t2);
  check("mutated clone gets fresh topology", ct1 !== ct2 && t1 !== ct2 && ct2.edges.length === 5, `edges=${ct2.edges.length}`);
}

// (O2) Vertex normals split opposing face-normal fans instead of canceling.
{
  const m = new Mesh();
  m.positions = [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, -1, 0], [1, 0, -1], [0, 0, 0]];
  m.faces = [[0, 2, 1], [0, 3, 2], [0, 4, 1], [0, 3, 4]];
  m.edges = [[0, 5]];
  const n = m.vertexNormals()[0];
  check("vertex normal chooses outward opposing fan", approx(n, [1, 0, 0]), JSON.stringify(n));
}

// (P) MeshBoolean respects Blender's FLOAT / EXACT solver selection.
{
  const { ensureManifold } = await import("../src/gnvm/boolean");
  await ensureManifold();

  const hullSource = box([-1, -1, -1], [1, 1, 1]);
  hullSource.mesh!.positions.push(...box([3, -1, -1], [5, 1, 1]).mesh!.positions);
  const hull = runNode("GeometryNodeConvexHull", { Geometry: hullSource })["Convex Hull"] as Geometry;
  const hullX = hull.mesh?.positions.map((point) => point[0]) ?? [];
  check("Convex Hull encloses disconnected point sets", (hull.mesh?.faces.length ?? 0) > 0 && Math.min(...hullX) === -1 && Math.max(...hullX) === 5,
    `verts=${hull.mesh?.positions.length} faces=${hull.mesh?.faces.length}`);
  check("Convex Hull dissolves coplanar triangles into Blender-style polygons",
    hull.mesh?.faces.length === 6 && hull.mesh.faces.every((face) => face.length === 4),
    `faces=${hull.mesh?.faces.length} sizes=${hull.mesh?.faces.map((face) => face.length)}`);

  const cylinderPair = new Geometry();
  cylinderPair.mesh = new Mesh();
  for (const offset of [-4, 4]) {
    const cylinder = runNode("GeometryNodeMeshCylinder", {
      Vertices: 32, "Side Segments": 1, "Fill Segments": 1, Radius: 2, Depth: 2,
    }, { fill_type: "NGON" }).Mesh as Geometry;
    const base = cylinderPair.mesh.positions.length;
    cylinderPair.mesh.positions.push(...cylinder.mesh!.positions.map(([x, y, z]) => [x, y + offset, z] as Vec3));
    cylinderPair.mesh.faces.push(...cylinder.mesh!.faces.map((face) => face.map((vertex) => vertex + base)));
    cylinderPair.mesh.faceMaterial.push(...cylinder.mesh!.faces.map(() => 0));
  }
  const pillHull = runNode("GeometryNodeConvexHull", { Geometry: cylinderPair })["Convex Hull"] as Geometry;
  check("Convex Hull retains Blender's two-cylinder pill panels",
    pillHull.mesh?.positions.length === 98 && pillHull.mesh.faces.length === 72,
    `${pillHull.mesh?.positions.length}v/${pillHull.mesh?.faces.length}f`);

  const denseCylinderPair = new Geometry();
  denseCylinderPair.mesh = new Mesh();
  for (const [x, y] of [[-35, 35], [35, -35]]) {
    const cylinder = runNode("GeometryNodeMeshCylinder", {
      Vertices: 82, "Side Segments": 1, "Fill Segments": 1, Radius: 11.25, Depth: 80,
    }, { fill_type: "NGON" }).Mesh as Geometry;
    const base = denseCylinderPair.mesh.positions.length;
    denseCylinderPair.mesh.positions.push(...cylinder.mesh!.positions.map(([px, py, pz]) => [px + x, py + y, pz] as Vec3));
    denseCylinderPair.mesh.faces.push(...cylinder.mesh!.faces.map((face) => face.map((vertex) => vertex + base)));
    denseCylinderPair.mesh.faceMaterial.push(...cylinder.mesh!.faces.map(() => 0));
  }
  const denseHull = runNode("GeometryNodeConvexHull", { Geometry: denseCylinderPair })["Convex Hull"] as Geometry;
  check("Dense two-cylinder hull uses Blender strict extrema",
    denseHull.mesh?.positions.length === 168 && denseHull.mesh.faces.length === 86,
    `${denseHull.mesh?.positions.length}v/${denseHull.mesh?.faces.length}f`);

  const taperedPair = new Geometry();
  taperedPair.mesh = new Mesh();
  for (const [offset, zOffset] of [[-4, -2e-6], [4, 2e-6]]) {
    const cone = runNode("GeometryNodeMeshCone", {
      Vertices: 32, "Side Segments": 1, "Fill Segments": 1,
      "Radius Top": 4, "Radius Bottom": 1.5, Depth: 2,
    }, { fill_type: "NGON" }).Mesh as Geometry;
    const base = taperedPair.mesh.positions.length;
    taperedPair.mesh.positions.push(...cone.mesh!.positions.map(([x, y, z]) => [x, y + offset, z + zOffset] as Vec3));
    taperedPair.mesh.faces.push(...cone.mesh!.faces.map((face) => face.map((vertex) => vertex + base)));
    taperedPair.mesh.faceMaterial.push(...cone.mesh!.faces.map(() => 0));
  }
  const taperedHull = runNode("GeometryNodeConvexHull", { Geometry: taperedPair })["Convex Hull"] as Geometry;
  check("Convex Hull retains strict tapered-pill extrema and face pairing",
    taperedHull.mesh?.positions.length === 98 && taperedHull.mesh.faces.length === 110,
    `${taperedHull.mesh?.positions.length}v/${taperedHull.mesh?.faces.length}f`);

  // Blender's FLOAT solver performs solid CSG for closed operands too. The VM
  // uses Manifold for that safe subset, including curved/non-AABB cutters.
  const a = box([-1, -1, -1], [1, 1, 1]);
  const tilted = box([-1, -1, -1], [1, 1, 1]);
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  tilted.mesh!.positions = tilted.mesh!.positions.map(([x, y, z]) => [
    x * c - y * s + 0.75,
    x * s + y * c,
    z,
  ]);
  const floatInter = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": a, "Mesh 2": tilted },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const floatMinX = Math.min(...floatInter.mesh!.positions.map((p) => p[0]));
  check("MeshBoolean FLOAT intersects closed non-AABB solids", floatInter.mesh!.faces.length > 0 && floatMinX > -0.99, `faces=${floatInter.mesh!.faces.length} minX=${floatMinX}`);

  const exactInter = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": a, "Mesh 2": tilted },
    { operation: "INTERSECT", solver: "EXACT" },
  ).Mesh as Geometry;
  const exactMinX = Math.min(...exactInter.mesh!.positions.map((p) => p[0]));
  check("MeshBoolean EXACT uses solid CSG", exactInter.mesh!.faces.length > 0 && exactMinX > -0.99, `faces=${exactInter.mesh!.faces.length} minX=${exactMinX}`);

  // FLOAT still clips an axis-aligned box using the local fallback.
  const solid = box([-1, -1, -1], [1, 1, 1]);
  const cutter = box([-2, -2, 0], [2, 2, 2]); // 8 verts, 6 faces — axis box
  const clipped = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": solid, "Mesh 2": cutter },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const m = clipped.mesh!;
  const maxZ = Math.max(...m.positions.map((p) => p[2]));
  const minZ = Math.min(...m.positions.map((p) => p[2]));
  check("MeshBoolean box INTERSECT keeps upper half", minZ >= -1e-3 && maxZ <= 1 + 1e-3 && m.faces.length > 0, `z=[${minZ},${maxZ}] f=${m.faces.length}`);

  // A clipped hollow shell has two large nested boundary loops. FLOAT should
  // bridge them with an annulus at the cutter plane, not leave a jagged open
  // rim and not fill the inner opening with a disk.
  const tube = new Geometry();
  const tm = new Mesh();
  const segments = 12;
  const zs = [-1, -0.2, 0.2];
  for (const radius of [2, 1]) for (const z of zs) for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2;
    tm.positions.push([Math.cos(angle) * radius, Math.sin(angle) * radius, z]);
  }
  const ring = (inner: number, zi: number, i: number) => ((inner * zs.length + zi) * segments + i);
  for (const inner of [0, 1]) for (let zi = 0; zi + 1 < zs.length; zi++) for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const face = [ring(inner, zi, i), ring(inner, zi, j), ring(inner, zi + 1, j), ring(inner, zi + 1, i)];
    tm.faces.push(inner ? face.reverse() : face);
    tm.faceMaterial.push(0);
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    tm.faces.push([ring(0, 0, i), ring(1, 0, i), ring(1, 0, j), ring(0, 0, j)]);
    tm.faceMaterial.push(0);
  }
  tube.mesh = tm;
  const tubeClip = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": tube, "Mesh 2": box([-3, -3, -2], [3, 3, 0]) },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const cutFaces = tubeClip.mesh!.faces.filter((f) => {
    const zs = f.map((vi) => tubeClip.mesh!.positions[vi][2]);
    return Math.max(...zs) - Math.min(...zs) < 1e-6 && Math.max(...zs) > -0.5;
  });
  const cutMinRadius = Math.min(...cutFaces.flatMap((f) => f.map((vi) => Math.hypot(tubeClip.mesh!.positions[vi][0], tubeClip.mesh!.positions[vi][1]))));
  check("MeshBoolean FLOAT caps a clipped hollow shell with an annulus", cutFaces.length > 0 && cutMinRadius > 0.9, `faces=${cutFaces.length} minRadius=${cutMinRadius}`);

  // A non-AABB cutter must still leave an open shell on the guarded fallback;
  // passing either operand through solid-only CSG would erase or cap it.
  const tiltedOpenClip = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": openCylinder(12, [-1, 0, 1], 1), "Mesh 2": tilted },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  check("MeshBoolean FLOAT preserves open shell for non-AABB cutter", tiltedOpenClip.mesh!.faces.length === 24,
    `faces=${tiltedOpenClip.mesh!.faces.length}`);

  // EXACT gracefully falls back when Manifold rejects an open shell.
  const cyl = openCylinder(12, [-2, -1, 0.5, 1.5], 1);
  const openClip = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": cyl, "Mesh 2": box([-2, -2, 0], [2, 2, 2]) },
    { operation: "INTERSECT", solver: "EXACT" },
  ).Mesh as Geometry;
  check("MeshBoolean open-shell INTERSECT non-empty", (openClip.mesh?.faces.length ?? 0) > 0, `faces=${openClip.mesh?.faces.length}`);

  // Blender's Exact solver can cut a swept closed tube through an open shell
  // before that shell is mirrored. Preserve the two cap ngons as annuli and
  // add the reversed tunnel wall instead of silently returning the input.
  const openSlab = new Geometry();
  openSlab.mesh = new Mesh();
  openSlab.mesh.positions = [
    [-2, -.5, -2], [2, -.5, -2], [2, -.5, 2], [-2, -.5, 2],
    [-2, .5, -2], [2, .5, -2], [2, .5, 2], [-2, .5, 2],
  ];
  openSlab.mesh.faces = [
    [0, 1, 2, 3], [4, 7, 6, 5],
    [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3],
  ]; // deliberately omit the fourth side wall
  openSlab.mesh.faceMaterial = openSlab.mesh.faces.map(() => 0);
  const tubeCutter = new Geometry();
  tubeCutter.mesh = new Mesh();
  const sweepSegments = 12;
  for (const y of [-1, 1]) for (let i = 0; i < sweepSegments; i++) {
    const angle = i / sweepSegments * Math.PI * 2;
    tubeCutter.mesh.positions.push([Math.cos(angle), y, Math.sin(angle)]);
  }
  for (let i = 0; i < sweepSegments; i++) {
    const next = (i + 1) % sweepSegments;
    tubeCutter.mesh.faces.push([i, next, sweepSegments + next, sweepSegments + i]);
  }
  tubeCutter.mesh.faces.push(
    Array.from({ length: sweepSegments }, (_, i) => sweepSegments - 1 - i),
    Array.from({ length: sweepSegments }, (_, i) => sweepSegments + i),
  );
  tubeCutter.mesh.faceMaterial = tubeCutter.mesh.faces.map(() => 0);
  const sweptCut = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": openSlab, "Mesh 2": tubeCutter },
    { operation: "DIFFERENCE", solver: "EXACT" },
  ).Mesh as Geometry;
  check("MeshBoolean EXACT cuts ring-swept solids through open shells",
    sweptCut.mesh?.positions.length === 32 && sweptCut.mesh.faces.length === 19,
    `${sweptCut.mesh?.positions.length}v/${sweptCut.mesh?.faces.length}f`);

  const denseCutter = new Geometry();
  denseCutter.mesh = new Mesh();
  const denseSegments = 64;
  for (const y of [-1, 1]) for (let i = 0; i < denseSegments; i++) {
    const angle = i / denseSegments * Math.PI * 2;
    denseCutter.mesh.positions.push([Math.cos(angle), y, Math.sin(angle)]);
  }
  for (let i = 0; i < denseSegments; i++) {
    const next = (i + 1) % denseSegments;
    denseCutter.mesh.faces.push([i, next, denseSegments + next, denseSegments + i]);
  }
  denseCutter.mesh.faces.push(
    Array.from({ length: denseSegments }, (_, i) => denseSegments - 1 - i),
    Array.from({ length: denseSegments }, (_, i) => denseSegments + i),
  );
  denseCutter.mesh.faceMaterial = denseCutter.mesh.faces.map(() => 0);
  const denseCut = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": openSlab, "Mesh 2": denseCutter },
    { operation: "DIFFERENCE", solver: "EXACT" },
  ).Mesh as Geometry;
  check("MeshBoolean EXACT retains dense swept-panel boundary samples",
    denseCut.mesh?.positions.length === 138 && denseCut.mesh.faces.length === 71,
    `${denseCut.mesh?.positions.length}v/${denseCut.mesh?.faces.length}f`);

  // A partial prism cut through a sampled annulus keeps the authored radial
  // panels and Blender's two-ngon step instead of returning a triangle soup.
  const annulus = new Geometry();
  annulus.mesh = new Mesh();
  const annulusSegments = 12;
  const annulusRing = (level: number, inner: number, i: number) => (level * 2 + inner) * annulusSegments + i;
  for (const z of [0, 2]) for (const radius of [3, 1]) for (let i = 0; i < annulusSegments; i++) {
    const theta = i / annulusSegments * Math.PI * 2;
    annulus.mesh.positions.push([Math.cos(theta) * radius, Math.sin(theta) * radius, z]);
  }
  for (let i = 0; i < annulusSegments; i++) {
    const next = (i + 1) % annulusSegments;
    annulus.mesh.faces.push(
      [annulusRing(0, 0, i), annulusRing(0, 1, i), annulusRing(0, 1, next), annulusRing(0, 0, next)],
      [annulusRing(0, 0, i), annulusRing(0, 0, next), annulusRing(1, 0, next), annulusRing(1, 0, i)],
      [annulusRing(0, 1, i), annulusRing(1, 1, i), annulusRing(1, 1, next), annulusRing(0, 1, next)],
      [annulusRing(1, 0, i), annulusRing(1, 0, next), annulusRing(1, 1, next), annulusRing(1, 1, i)],
    );
  }
  annulus.mesh.faceMaterial = annulus.mesh.faces.map(() => 0);
  const recess = new Geometry();
  recess.mesh = new Mesh();
  for (const z of [1, -1, 1]) for (let i = 0; i < 6; i++) {
    const theta = i / 6 * Math.PI * 2;
    recess.mesh.positions.push([Math.cos(theta) * 2, Math.sin(theta) * 2, z]);
  }
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    recess.mesh.faces.push([i, next, 6 + next, 6 + i]);
  }
  recess.mesh.faces.push([6, 7, 8, 9, 10, 11], [17, 16, 15, 14, 13, 12]);
  recess.mesh.faceMaterial = recess.mesh.faces.map(() => 0);
  const recessed = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": annulus, "Mesh 2": recess },
    { operation: "DIFFERENCE", solver: "EXACT" },
  ).Mesh as Geometry;
  const recessedSizes = recessed.mesh!.faces.map((face) => face.length).sort((a, b) => a - b);
  check("MeshBoolean EXACT preserves partial annular-prism panel topology",
    recessed.mesh?.positions.length === 66 && recessed.mesh.faces.length === 56
      && recessedSizes.filter((size) => size === 4).length === 48
      && recessedSizes.at(-1) === 17,
    `${recessed.mesh?.positions.length}v/${recessed.mesh?.faces.length}f sizes=${JSON.stringify(recessedSizes)}`);

  // EXACT treats an open planar mesh as a knife. A 3x3 grid oriented +Y keeps
  // the positive half-space and contributes four cap quadrants.
  const knife = new Geometry();
  const km = new Mesh();
  for (const x of [-2, 0, 2]) for (const z of [-2, 0, 2]) km.positions.push([x, 0, z]);
  const ki = (x: number, z: number) => x * 3 + z;
  for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) {
    km.faces.push([ki(x, z + 1), ki(x + 1, z + 1), ki(x + 1, z), ki(x, z)]);
    km.faceMaterial.push(0);
  }
  knife.mesh = km;
  const sliced = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": box([-1, -1, -1], [1, 1, 1]), "Mesh 2": knife },
    { operation: "DIFFERENCE", solver: "EXACT" },
  ).Mesh as Geometry;
  const slicedMinY = Math.min(...sliced.mesh!.positions.map((point) => point[1]));
  const capFaces = sliced.mesh!.faces.filter((face) => face.every((vertex) => Math.abs(sliced.mesh!.positions[vertex][1]) < 1e-6));
  check("MeshBoolean EXACT planar knife keeps oriented half-space", slicedMinY >= -1e-6, `minY=${slicedMinY}`);
  check("MeshBoolean EXACT planar grid contributes four cap faces", capFaces.length === 4, `caps=${capFaces.length}`);

  // A planar first operand is a surface difference, not a solid CSG. Preserve
  // its face accounting, remove enclosed lattice vertices, and expose the
  // clipped wire network consumed by a following Mesh to Curve node.
  const plate = new Geometry();
  plate.mesh = new Mesh();
  for (const y of [-1, 0, 1]) for (const x of [-1, 0, 1]) plate.mesh.positions.push([x, y, 0]);
  const pi = (x: number, y: number) => y * 3 + x;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) plate.mesh.faces.push([
    pi(x, y), pi(x + 1, y), pi(x + 1, y + 1), pi(x, y + 1),
  ]);
  const perforated = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": plate, "Mesh 2": box([-.4, -.4, -1], [.4, .4, 1]) },
    { operation: "DIFFERENCE", solver: "EXACT" },
  ).Mesh as Geometry;
  check("MeshBoolean EXACT planar difference removes enclosed source points",
    !perforated.mesh!.positions.some(([x, y]) => Math.abs(x) < 1e-8 && Math.abs(y) < 1e-8) && perforated.mesh!.faces.length === 4,
    `${perforated.mesh!.positions.length}v/${perforated.mesh!.faces.length}f`);
}

// (Q) Critical-path: ValueToString / StringJoin / StringToCurves
{
  const s = runNode("FunctionNodeValueToString", { Value: 12.6, Decimals: 0 }).String as string;
  check("ValueToString decimals=0 truncates", s === "12", `got ${s}`);
  const s2 = runNode("FunctionNodeValueToString", { Value: Math.PI, Decimals: 2 }).String as string;
  check("ValueToString decimals=2", s2 === "3.14", `got ${s2}`);
  // Multi-input join via direct REGISTRY harness: inputs() returns one value per key;
  // exercise the handler by feeding a synthetic multi-input through a custom api below.
  const joinH = REGISTRY.get("GeometryNodeStringJoin")!;
  const joinOut = joinH({
    node: { name: "j", type: "GeometryNodeStringJoin", label: null, inputs: [
      { name: "Delimiter", identifier: "Delimiter", type: "NodeSocketString", linked: false, value: ":" },
      { name: "Strings", identifier: "Strings", type: "NodeSocketString", linked: true, value: null },
    ], outputs: [], props: {} },
    input: (n) => (n === "Delimiter" ? ":" : ""),
    inputs: (n) => (n === "Strings" ? ["W", "12"] : n === "Delimiter" ? [":"] : []),
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: (n) => (n === "Delimiter" ? ":" : ""),
    ref: () => null,
    prop: (_n, d) => d,
    resolve: (f, g, dom) => f.array(makeFieldCtx(g, dom)),
  }) as Record<string, SockVal>;
  check("StringJoin joins with delimiter", joinOut.String === "W:12", `got ${joinOut.String}`);

  const curves = runNode("GeometryNodeStringToCurves", { String: "AB", Size: 1, "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": 1 }, { align_x: "LEFT" })["Curve Instances"] as Geometry;
  check("StringToCurves yields one instance per char", curves.instances.length === 2, `got ${curves.instances.length}`);
  check("StringToCurves instances carry glyph curves", curves.instances.every((inst) => inst.geometry.curves.length > 0));
  const spaced = runNode("GeometryNodeStringToCurves", { String: "A B", Size: 1, "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": 1 }, { align_x: "LEFT" })["Curve Instances"] as Geometry;
  check("StringToCurves preserves whitespace as empty instances", spaced.instances.length === 3 && spaced.instances[1].geometry.curves.length === 0, `got ${spaced.instances.length}`);

  const savedFonts = DUMP_CONTEXT.fonts;
  DUMP_CONTEXT.fonts = {
    TestFont: {
      name: "TestFont",
      glyphs: {
        A: { advance: .8, curves: [{ cyclic: true, points: [[0, 0, 0], [.6, 0, 0], [.6, 1, 0], [0, 1, 0]] }] },
        B: { advance: .7, curves: [{ cyclic: true, points: [[0, 0, 0], [.5, 0, 0], [.5, 1, 0], [0, 1, 0]] }] },
        S: { advance: 1, curves: [{ cyclic: true, points: [
          ...Array.from({ length: 13 }, (_, index) => [index / 12, 0, 0]),
          ...Array.from({ length: 11 }, (_, index) => {
            const angle = (index + 1) / 12 * Math.PI;
            return [0.5 + 0.5 * Math.cos(angle), 0.5 * Math.sin(angle), 0];
          }),
        ] }] },
      },
    },
  };
  const atlasCurves = runNode("GeometryNodeStringToCurves", {
    String: "AB", Size: 2, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Left", "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": 1,
  })["Curve Instances"] as Geometry;
  check("StringToCurves uses extracted font outlines", atlasCurves.instances[0].geometry.curves[0].points[2][1] === 2);
  check("StringToCurves uses extracted font advances", Math.abs(atlasCurves.instances[1].position[0] - 1.6) < 1e-9);
  const expandedAtlasCurves = runNode("GeometryNodeStringToCurves", {
    String: "AB", Size: 2, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Left", "Character Spacing": 1.5, "Word Spacing": 1, "Line Spacing": 1,
  })["Curve Instances"] as Geometry;
  check("StringToCurves expands spacing by glyph ink width above one", Math.abs(expandedAtlasCurves.instances[1].position[0] - 2.2) < 1e-9);
  const wrappedAtlasCurves = runNode("GeometryNodeStringToCurves", {
    String: "A B", Size: 2, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Left", "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": .5,
    "Text Box Width": 2,
  })["Curve Instances"] as Geometry;
  check("StringToCurves wraps whole words at Text Box Width", wrappedAtlasCurves.instances.length === 3 && wrappedAtlasCurves.instances[1].geometry.curves.length === 0 && Math.abs(wrappedAtlasCurves.instances[2].position[1] + 1) < 1e-9);
  const centeredWrap = runNode("GeometryNodeStringToCurves", {
    String: "A B", Size: 2, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Center", "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": .5,
    "Text Box Width": 2,
  })["Curve Instances"] as Geometry;
  check("StringToCurves center alignment ignores trailing wrap space", Math.abs(centeredWrap.instances[0].position[0] + .8) < 1e-9, `x=${centeredWrap.instances[0].position[0]}`);
  const centeredWrappedAtlas = runNode("GeometryNodeStringToCurves", {
    String: "A B", Size: 2, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Left", "Align Y": "Middle", "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": .5,
    "Text Box Width": 2,
  })["Curve Instances"] as Geometry;
  check("StringToCurves vertically centers wrapped Middle text", Math.abs(centeredWrappedAtlas.instances[0].position[1] - .5) < 1e-9 && Math.abs(centeredWrappedAtlas.instances[2].position[1] + .5) < 1e-9);
  const sampledFontCurve = runNode("GeometryNodeStringToCurves", {
    String: "S", Size: 1, Font: { datablock: "VectorFont", name: "TestFont" },
    "Align X": "Left", "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": 1,
  })["Curve Instances"] as Geometry;
  const sampledFontFill = runNode("GeometryNodeFillCurve", { Curve: sampledFontCurve, Mode: "N-gons" }).Mesh as Geometry;
  check("Fill Curve dissolves straight evaluated font samples", sampledFontFill.instances[0].geometry.mesh?.positions.length === 13, `got ${sampledFontFill.instances[0].geometry.mesh?.positions.length}`);
  DUMP_CONTEXT.fonts = savedFonts;

  const outlinedGlyph = new Geometry();
  outlinedGlyph.curves = [
    { cyclic: true, points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] },
    { cyclic: true, points: [[.5, .5, 0], [.5, 1.5, 0], [1.5, 1.5, 0], [1.5, .5, 0]] },
  ];
  const glyphInstances = new Geometry();
  glyphInstances.instances = [{ geometry: outlinedGlyph, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const filledGlyphs = runNode("GeometryNodeFillCurve", { Curve: glyphInstances, Mode: "N-gons" }).Mesh as Geometry;
  check("Fill Curve keeps one N-gon per glyph outline", filledGlyphs.instances[0].geometry.mesh?.faces.length === 2);
  const glyphArea = meshSignedAreaXY(filledGlyphs.instances[0].geometry.mesh!);
  check("Fill Curve keeps glyph counters open", Math.abs(glyphArea - 3) < 1e-6, `area=${glyphArea}`);
}

// (R) InputTangent on a straight curve segment
{
  const c = curve([[0, 0, 0], [2, 0, 0], [4, 0, 0]], false);
  const tan = runNode("GeometryNodeInputTangent", {}).Tangent as Field;
  const arr = tan.array(makeFieldCtx(c, "POINT")) as number[][];
  check("InputTangent mid-point ~ +X", arr.length === 3 && approx(arr[1] as number[], [1, 0, 0]), JSON.stringify(arr[1]));

  const loop = curve([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], true);
  const cyclic = tan.array(makeFieldCtx(loop, "POINT")) as number[][];
  check("InputTangent wraps cyclic endpoints", approx(cyclic[0], [0, 1, 0]) && approx(cyclic[3], [1, 0, 0]), JSON.stringify(cyclic));
}

// Planar cyclic curve normals stay in the curve plane and point inward, as in
// Blender. This lets negative normal offsets expand font outlines in XY.
{
  const square = curve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], true);
  const normal = runNode("GeometryNodeInputNormal", {}).Normal as Field;
  const arr = normal.array(makeFieldCtx(square, "POINT")) as number[][];
  check("InputNormal planar loop stays in XY", arr.every((value) => Math.abs(value[2]) < 1e-9), JSON.stringify(arr));
  check("InputNormal planar CCW loop points inward", arr[0][0] > 0 && arr[0][1] > 0, JSON.stringify(arr[0]));

  const wire = runNode("GeometryNodeCurveToMesh", { Curve: square, "Profile Curve": new Geometry(), "Fill Caps": false }).Mesh as Geometry;
  const wireNormals = normal.array(makeFieldCtx(wire, "POINT")) as number[][];
  check("Curve to Mesh wire uses Blender radial loose-vertex normals",
    approx(wireNormals[0], [0, 0, 0]) && approx(wireNormals[1], [1, 0, 0]) && approx(wireNormals[2], [Math.SQRT1_2, Math.SQRT1_2, 0]),
    JSON.stringify(wireNormals));
}

// Node Dojo's Gradient Direction group derives a point direction from the
// first triangle of each face and rotates it back into the scalar gradient.
{
  const plane = new Geometry();
  plane.mesh = new Mesh();
  plane.mesh.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  plane.mesh.faces = [[0, 1, 2, 3]];
  const xGradient = Field.perElem((i, ctx) => ctx.position?.(i)[0] ?? 0);
  const directions = gradientDirectionField(xGradient, false).array(makeFieldCtx(plane, "POINT")) as Vec3[];
  check("Gradient Direction reconstructs a planar +X scalar gradient", directions.every((value) => approx(value, [1, 0, 0])), JSON.stringify(directions));
}

// (S) MeshCone frustum
{
  const cone = runNode("GeometryNodeMeshCone", {
    Vertices: 8, "Side Segments": 1, "Fill Segments": 1,
    "Radius Top": 0, "Radius Bottom": 1, Depth: 2,
  }, { fill_type: "NGON" }).Mesh as Geometry;
  const m = cone.mesh!;
  check("MeshCone collapses its zero-radius apex", m.positions.length === 9 && m.faces.length === 9, `v=${m.positions.length} f=${m.faces.length}`);
  const zs = m.positions.map((p) => p[2]);
  check("MeshCone spans depth from zero", Math.abs(Math.min(...zs)) < 1e-6 && Math.abs(Math.max(...zs) - 2) < 1e-6);
}

// (T) FloatToInt floor mode
{
  const out = runNode("FunctionNodeFloatToInt", { Float: 3.9 }, { rounding_mode: "FLOOR" }).Integer as Field;
  check("FloatToInt FLOOR 3.9 -> 3", out.value === 3, `got ${out.value}`);
}

// (U) CornersOfFace on a quad: unlinked face index uses context index
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]];
  m.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
  m.faceMaterial = [0, 0];
  const g = new Geometry();
  g.mesh = m;
  // Build API with unlinked Face Index
  const h = REGISTRY.get("GeometryNodeCornersOfFace")!;
  const result = h({
    node: {
      name: "c", type: "GeometryNodeCornersOfFace", label: null,
      inputs: [
        { name: "Face Index", identifier: "Face Index", type: "NodeSocketInt", linked: false, value: 0 },
        { name: "Weights", identifier: "Weights", type: "NodeSocketFloat", linked: false, value: 0 },
        { name: "Sort Index", identifier: "Sort Index", type: "NodeSocketInt", linked: false, value: 0 },
      ],
      outputs: [], props: {},
    },
    input: () => Field.of(0),
    inputs: () => [],
    geoInputs: () => [],
    geo: () => g,
    field: (n) => Field.of(n === "Sort Index" ? 0 : 0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_n, d) => d,
    resolve: (f, geo, dom) => f.array(makeFieldCtx(geo, dom)),
  }) as Record<string, SockVal>;
  const corner = result["Corner Index"] as Field;
  const total = result.Total as Field;
  const ctx = makeFieldCtx(g, "FACE");
  const corners = corner.array(ctx) as number[];
  const totals = total.array(ctx) as number[];
  check("CornersOfFace totals are 4 per quad", totals[0] === 4 && totals[1] === 4, JSON.stringify(totals));
  check("CornersOfFace corner indices start each face", corners[0] === 0 && corners[1] === 4, JSON.stringify(corners));
}

// (V) SubdivisionSurface densifies a cube
{
  const cube = runNode("GeometryNodeMeshCube", { Size: [1, 1, 1], "Vertices X": 2, "Vertices Y": 2, "Vertices Z": 2 }).Mesh as Geometry;
  const before = cube.mesh!.faces.length;
  const sub = runNode("GeometryNodeSubdivisionSurface", { Mesh: cube, Level: 1 }).Mesh as Geometry;
  check("SubdivisionSurface densifies faces", (sub.mesh?.faces.length ?? 0) > before, `before=${before} after=${sub.mesh?.faces.length}`);
  check("SubdivisionSurface densifies verts", (sub.mesh?.positions.length ?? 0) > 8, `verts=${sub.mesh?.positions.length}`);
}

// (W) Scalar math follows Blender's safe domains; unknown VectorMath is not ADD
{
  // |a-b| < k so the smooth term subtracts from min
  const sm = runNode("ShaderNodeMath", { Value: 0.4, Value_001: 0.5, Value_002: 0.5 }, { operation: "SMOOTH_MIN" }).Value as Field;
  const mn = runNode("ShaderNodeMath", { Value: 0.4, Value_001: 0.5, Value_002: 0.5 }, { operation: "MINIMUM" }).Value as Field;
  check("SMOOTH_MIN finite and < raw min for close values", Number.isFinite(sm.value as number) && (sm.value as number) < (mn.value as number), `smooth=${sm.value} min=${mn.value}`);
  const validLog = runNode("ShaderNodeMath", { Value: 8, Value_001: 2, Value_002: 0 }, { operation: "LOGARITHM" }).Value as Field;
  const negativeLog = runNode("ShaderNodeMath", { Value: -8, Value_001: 2, Value_002: 0 }, { operation: "LOGARITHM" }).Value as Field;
  const invalidBaseLog = runNode("ShaderNodeMath", { Value: 8, Value_001: -2, Value_002: 0 }, { operation: "LOGARITHM" }).Value as Field;
  check("Logarithm evaluates valid real domain", Math.abs((validLog.value as number) - 3) < 1e-6, `value=${validLog.value}`);
  check("Logarithm zeroes invalid real domains", negativeLog.value === 0 && invalidBaseLog.value === 0,
    `negative=${negativeLog.value} base=${invalidBaseLog.value}`);
  const unk = runNode("ShaderNodeVectorMath", { Vector: [1, 2, 3], Vector_001: [10, 20, 30] }, { operation: "NOT_A_REAL_OP" }).Vector as Field;
  const got = unk.value as number[];
  check("unknown VectorMath does not ADD", !approx(got, [11, 22, 33]) && approx(got, [1, 2, 3]), JSON.stringify(got));
}

// (X) A linked float entering a group Int socket is rounded at the boundary.
// Spin uses the same socket both for Repeat Input's count and its angle divisor;
// retaining the incoming fraction in only the divisor leaves a closure gap.
{
  const socket = (name: string, identifier: string, in_out: "INPUT" | "OUTPUT", socket_type: string, dflt = 0) => ({ name, identifier, item_type: "SOCKET", in_out, socket_type, default: dflt });
  const program: any = {
    inner: {
      name: "inner", type: "GeometryNodeTree",
      interface: [socket("Steps", "Steps", "INPUT", "NodeSocketInt"), socket("Result", "Result", "OUTPUT", "NodeSocketInt")],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [{ name: "Steps", identifier: "Steps" }], props: {} },
        { name: "Group Output", type: "NodeGroupOutput", label: null, inputs: [{ name: "Result", identifier: "Result", type: "NodeSocketInt", linked: true, value: null }], outputs: [], props: {} },
      ],
      links: [{ from_node: "Group Input", from_socket: "Steps", to_node: "Group Output", to_socket: "Result" }],
    },
    outer: {
      name: "outer", type: "GeometryNodeTree",
      interface: [socket("Density", "Density", "INPUT", "NodeSocketFloat"), socket("Result", "Result", "OUTPUT", "NodeSocketInt")],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [{ name: "Density", identifier: "Density" }], props: {} },
        { name: "Inner", type: "GeometryNodeGroup", label: null, group: "inner", inputs: [{ name: "Steps", identifier: "Steps", type: "NodeSocketInt", linked: true, value: null }], outputs: [{ name: "Result", identifier: "Result" }], props: {} },
        { name: "Group Output", type: "NodeGroupOutput", label: null, inputs: [{ name: "Result", identifier: "Result", type: "NodeSocketInt", linked: true, value: null }], outputs: [], props: {} },
      ],
      links: [
        { from_node: "Group Input", from_socket: "Density", to_node: "Inner", to_socket: "Steps" },
        { from_node: "Inner", from_socket: "Result", to_node: "Group Output", to_socket: "Result" },
      ],
    },
  };
  const result = new Evaluator(program).evalGroup("outer", { Density: Field.of(349.78) }).Result as Field;
  check("Group input coerces linked float to Int", result.value === 349, `got ${result.value}`);
}

// Mesh nodes operate on mesh components inside instances. String to Curves
// keeps one instance per glyph, and Blender extrudes each filled glyph payload
// before the instances are realized downstream.
{
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  payload.mesh.faces = [[0, 1, 2]];
  const instanced = new Geometry();
  instanced.instances = [{ geometry: payload, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const out = runNode(
    "GeometryNodeExtrudeMesh",
    { Mesh: instanced, Selection: true, Offset: [0, 0, 0], "Offset Scale": 1, Individual: false },
    { mode: "FACES" },
  ).Mesh as Geometry;
  const extruded = out.instances[0]?.geometry.mesh;
  check("Extrude Mesh evaluates instance payloads", extruded?.positions.length === 6 && extruded.faces.length === 4, `got ${extruded?.positions.length ?? 0}v/${extruded?.faces.length ?? 0}f`);
}

{
  const payload = curve([[1, 0, 0], [2, 0, 0]], false);
  const instanced = new Geometry();
  instanced.instances = [{ geometry: payload, position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const out = runNode("GeometryNodeTransform", {
    Geometry: instanced, Translation: [0, 0, 0], Rotation: [0, 0, Math.PI / 2], Scale: [2, 3, 1],
  }).Geometry as Geometry;
  check("Transform Geometry composes instance rotation", approx(out.instances[0].rotation, [0, 0, Math.PI / 2]));
  check("Transform Geometry composes instance scale", approx(out.instances[0].scale, [2, 3, 1]));
  check("Transform Geometry transforms instance origin", approx(out.instances[0].position, [0, 2, 0]));
}

// (Y) Repeated EDGE extrude must carry the source profile's direction through
// every new top edge. Spin rotates that top edge and welds the last ring to the
// first; alternating the direction makes the two faces at an odd-step closure
// both point inward, producing a bad seam normal after Solidify.
{
  const wire = new Geometry();
  wire.mesh = new Mesh();
  wire.mesh.positions = [[0, 0, 0], [1, 0, 0]];
  wire.mesh.edges = [[0, 1]];
  const edgeExtrude = runNode(
    "GeometryNodeExtrudeMesh",
    { Mesh: wire, Selection: true, Offset: [0, 0, 0], "Offset Scale": 1, Individual: true },
    { mode: "EDGES" },
  ).Mesh as Geometry;
  check("EDGE extrude stores Blender's generated edge order",
    JSON.stringify(edgeExtrude.mesh!.edges) === JSON.stringify([[0, 1], [0, 2], [1, 3], [2, 3]])
      && JSON.stringify(topologyOf(edgeExtrude.mesh!).edges.map((edge) => edge.verts)) === JSON.stringify([[0, 1], [0, 2], [1, 3], [2, 3]]),
    JSON.stringify(edgeExtrude.mesh!.edges));

  const m = new Mesh();
  // At -X, a top-to-bottom profile extruded around +Z produces outward faces.
  m.positions = [[-1, 0, 3], [-1, 0, 2], [-1, 0, 1], [-1, 0, 0]];
  m.edges = [[0, 1], [1, 2], [2, 3]];
  let spun = new Geometry();
  spun.mesh = m;
  let selection: Field = Field.of(1);
  const steps = 5;
  const angle = (Math.PI * 2) / steps;
  const turn = Field.perElem((i, ctx) => {
    const [x, y, z] = ctx.position?.(i) ?? [0, 0, 0];
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
  });
  for (let step = 0; step < steps; step++) {
    const extruded = runNode(
      "GeometryNodeExtrudeMesh",
      { Mesh: spun, Selection: selection, Offset: [0, 0, 0], "Offset Scale": 0, Individual: true },
      { mode: "EDGES" },
    );
    spun = extruded.Mesh as Geometry;
    selection = extruded.Top as Field;
    spun = runNode(
      "GeometryNodeSetPosition",
      { Geometry: spun, Selection: selection, Position: turn, Offset: [0, 0, 0] },
      {},
      ["Position"],
    ).Geometry as Geometry;
  }
  spun = runNode(
    "GeometryNodeMergeByDistance",
    { Geometry: spun, Selection: true, Distance: 1e-4, Mode: "All" as any },
  ).Geometry as Geometry;
  spun = runNode("GeometryNodeFlipFaces", { Mesh: spun, Selection: true }).Mesh as Geometry;
  const sm = spun.mesh!;
  const radialDots = sm.faces.map((f, fi) => {
    const c = sm.faceCenter(fi);
    const n = sm.faceNormal(fi);
    return { z: c[2], dot: c[0] * n[0] + c[1] * n[1] };
  }).filter(({ z }) => z > 1 && z < 2).map(({ dot }) => dot);
  check(
    "repeated EDGE extrude keeps outward winding through closure",
    sm.faces.length === 15 && radialDots.length === steps && radialDots.every((d) => d > 0.5),
    `faces=${sm.faces.length} radialDots=${radialDots.map((d) => d.toFixed(3)).join(",")}`,
  );
  check(
    "repeated EDGE extrude weld has no boundary seam",
    topologyOf(sm).edges.every((e) => {
      const [a, b] = e.verts;
      const crossesProfile = Math.abs(sm.positions[a][2] - sm.positions[b][2]) > 0.5;
      return !crossesProfile || e.faces.length === 2;
    }),
  );
  const ringAt = (z: number) => sm.positions
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Math.abs(p[2] - z) < 1e-6)
    .sort((a, b) => Math.atan2(a.p[1], a.p[0]) - Math.atan2(b.p[1], b.p[0]))
    .map(({ i }) => i);
  sm.faces.push(ringAt(3), ringAt(0).reverse());
  sm.faceMaterial.push(0, 0);
  const repairedFaces = orientClosedSurface(sm);
  const directedEdges = new Map<string, { direction: number; face: number }[]>();
  for (let fi = 0; fi < sm.faces.length; fi++) {
    const face = sm.faces[fi];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const directions = directedEdges.get(key) ?? [];
      directions.push({ direction: a < b ? 1 : -1, face: fi });
      directedEdges.set(key, directions);
    }
  }
  const windingConflicts = [...directedEdges.entries()].filter(
    ([, edges]) => edges.length === 2 && edges[0].direction === edges[1].direction,
  );
  check(
    "closed repeated EDGE extrude repairs endpoint-strip winding",
    repairedFaces > 0 && windingConflicts.length === 0 && topologyOf(sm).edges.every((edge) => edge.faces.length === 2),
    `repaired=${repairedFaces} conflicts=${windingConflicts.length} ${JSON.stringify(windingConflicts.slice(0, 6))}`,
  );
}

// (Z) A realized geometry set may retain an allocated empty Mesh alongside
// populated curves. Field evaluation must select the populated component.
{
  const mixed = curve([[0, 0, 0], [1, 0, 0], [2, 0, 0]], false);
  mixed.mesh = new Mesh();
  const ctx = makeFieldCtx(mixed, "POINT");
  const split = runNode(
    "GeometryNodeSeparateGeometry",
    { Geometry: mixed, Selection: Field.of(1) },
    { domain: "POINT" },
  ).Selection as Geometry;
  check("empty mesh does not mask populated curve field domain", ctx.size === 3, `size=${ctx.size}`);
  check("Separate Geometry retains curve points beside empty mesh", split.curvePointCount() === 3, `points=${split.curvePointCount()}`);
}

// (AA) String nodes use Unicode characters rather than UTF-16 code units.
{
  const length = runNode("FunctionNodeStringLength", { String: "A🙂B" }).Length as Field;
  const slice = runNode("FunctionNodeSliceString", { String: "A🙂BC", Position: 1, Length: 2 }).String;
  const special = runNode("FunctionNodeInputSpecialCharacters", {});
  check("String Length counts Unicode characters", length.value === 3, `length=${length.value}`);
  check("Slice String extracts Unicode characters", slice === "🙂B", `slice=${String(slice)}`);
  check("Special Characters exposes newline and tab", special["Line Break"] === "\n" && special.Tab === "\t");
}

// (AB) Length-mode curve resampling floors the number of fitted segments and
// includes both endpoints. This is the count rule used by Periodic Brush.
{
  const source = curve([[0, 0, 0], [4.9, 0, 0]], false);
  const sampled = runNode("GeometryNodeResampleCurve", { Curve: source, Mode: "Length" as any, Count: 12, Length: 2 }).Curve as Geometry;
  check("Resample Curve length mode floors fitted segments", sampled.curvePointCount() === 3, `points=${sampled.curvePointCount()}`);
  const cyclic = curve([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], true);
  const cyclicSampled = runNode("GeometryNodeResampleCurve", { Curve: cyclic, Mode: "Length" as any, Count: 12, Length: 2 }).Curve as Geometry;
  check("Resample Curve cyclic length mode adds a redistributed sample", cyclicSampled.curvePointCount() === 5, `points=${cyclicSampled.curvePointCount()}`);
  const degenerate = new Geometry();
  degenerate.curves = [{ points: [], cyclic: false }, { points: [[2, 3, 4]], cyclic: false }];
  const degenerateSampled = runNode("GeometryNodeResampleCurve", { Curve: degenerate, Mode: "Count" as any, Count: 8, Length: 1 }).Curve as Geometry;
  check("Resample Curve preserves empty and single-point splines", degenerateSampled.curves[0].points.length === 0 && degenerateSampled.curves[1].points.length === 1);
}

// (AC) Blender 5 treats an instances component as position-bearing points.
{
  const payload = box([0, 0, 0], [1, 1, 1]);
  const instances = new Geometry();
  instances.instances = [0, 1, 2].map((i) => ({ geometry: payload, position: [i, 0, 0] as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] }));
  const moved = runNode("GeometryNodeSetPosition", {
    Geometry: instances,
    Selection: true,
    Position: [0, 0, 0],
    Offset: Field.perElem((i) => [0, 0, i * .01]),
  }).Geometry as Geometry;
  check("Set Position offsets instance points", approx(moved.instances[2].position, [2, 0, .02]));

  const mixed = box([0, 0, 0], [1, 1, 1]);
  mixed.instances.push({ geometry: payload, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const mixedMoved = runNode("GeometryNodeSetPosition", {
    Geometry: mixed,
    Selection: true,
    Offset: [0, 0, 2],
  }).Geometry as Geometry;
  check("Set Position moves instances beside a mesh component",
    approx(mixedMoved.mesh!.positions[0], [0, 0, 2]) && approx(mixedMoved.instances[0].position, [3, 0, 2]));
}

// Bounding Box does not realize/open instances. Text Soup depends on the zero
// bounds here so its Set Center group leaves glyph instances in place.
{
  const instances = new Geometry();
  instances.instances = [{
    geometry: box([-2, -3, -4], [5, 6, 7]),
    position: [10, 20, 30], rotation: [0, 0, 0], scale: [1, 1, 1],
  }];
  const bounds = runNode("GeometryNodeBoundBox", { Geometry: instances });
  const min = (bounds.Min as Field).value as Vec3;
  const max = (bounds.Max as Field).value as Vec3;
  check("Bounding Box ignores unrealized instances", approx(min, [0, 0, 0]) && approx(max, [0, 0, 0]), `${JSON.stringify(min)}..${JSON.stringify(max)}`);
}

// (AD) Collection Info materializes evaluated child geometry as pickable
// instances and Reset Children strips authored object transforms.
{
  const savedObjects = DUMP_CONTEXT.objects;
  const savedCollections = DUMP_CONTEXT.collections;
  const savedActiveObject = DUMP_CONTEXT.activeObject;
  DUMP_CONTEXT.objects = [
    { name: "dot-a", location: [5, 0, 0], evaluated_mesh: { verts: [[0, 0, 0]], faces: [] } },
    { name: "dot-b", location: [8, 0, 0], evaluated_mesh: { verts: [[1, 0, 0]], faces: [] } },
  ];
  DUMP_CONTEXT.collections = [{ name: "period pack", objects: ["dot-a", "dot-b"] }];
  const collection = runNode("GeometryNodeCollectionInfo", {
    Collection: { datablock: "Collection", name: "period pack" },
    "Separate Children": true,
    "Reset Children": true,
  }).Instances as Geometry;
  check("Collection Info emits one instance per evaluated child", collection.instances.length === 2, `instances=${collection.instances.length}`);
  check("Collection Info Reset Children clears transforms", collection.instances.every((instance) => approx(instance.position, [0, 0, 0])));
  DUMP_CONTEXT.objects = [{
    name: "rotated-child",
    matrix_world: [[0, 0, 1, 4], [1, 0, 0, 5], [0, 1, 0, 6], [0, 0, 0, 1]],
    evaluated_mesh: { verts: [[0, 0, 2]], faces: [] },
  } as any];
  DUMP_CONTEXT.collections = [{ name: "rotated-pack", objects: ["rotated-child"] }];
  DUMP_CONTEXT.activeObject = {
    name: "active", matrix_world: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  } as any;
  const rotatedCollection = runNode("GeometryNodeCollectionInfo", {
    Collection: { datablock: "Collection", name: "rotated-pack" },
    "Separate Children": true, "Reset Children": false,
  }, { transform_space: "RELATIVE" }).Instances as Geometry;
  const rotatedChild = rotatedCollection.instances[0];
  check("Collection Info preserves combined matrix rotations",
    approx(transformPoint([0, 0, 2], rotatedChild.position, rotatedChild.rotation, rotatedChild.scale), [6, 5, 6]));
  DUMP_CONTEXT.objects = savedObjects;
  DUMP_CONTEXT.collections = savedCollections;
  DUMP_CONTEXT.activeObject = savedActiveObject;
}

// INSTANCE-domain For Each evaluates its body in element-local space and
// reapplies the source transform to generated geometry at the zone boundary.
// A body that converts an element to points exposes the difference: carrying
// the source transform into the body loses its rotation on the new instance.
{
  const node = (name: string, type: string, inputs: any[], outputs: any[], extra: Record<string, unknown> = {}) => ({
    name, type, label: null, inputs, outputs, ...extra,
  });
  const geometryInput = (name: string, identifier = name, value: unknown = null) => ({
    name, identifier, type: "NodeSocketGeometry", linked: value === null, value,
  });
  const geometryOutput = (name: string, identifier = name) => ({ name, identifier, type: "NodeSocketGeometry" });
  const foreachProgram: any = {
    foreach_instance_test: {
      name: "foreach_instance_test", type: "GeometryNodeTree", interface: [],
      nodes: [
        node("Group Input", "NodeGroupInput", [], [geometryOutput("Geometry")]),
        node("For Each Input", "GeometryNodeForeachGeometryElementInput", [
          geometryInput("Geometry"), { name: "Selection", identifier: "Selection", type: "NodeSocketBool", linked: false, value: true },
        ], [geometryOutput("Element"), { name: "Index", identifier: "Index", type: "NodeSocketInt" }], { paired_output: "For Each Output" }),
        node("Instances to Points", "GeometryNodeInstancesToPoints", [
          geometryInput("Instances"), { name: "Selection", identifier: "Selection", type: "NodeSocketBool", linked: false, value: true },
          { name: "Position", identifier: "Position", type: "NodeSocketVector", linked: false, value: [0, 0, 0] },
          { name: "Radius", identifier: "Radius", type: "NodeSocketFloat", linked: false, value: 0.05 },
        ], [geometryOutput("Points")]),
        node("Local Point", "GeometryNodeMeshLine", [
          { name: "Count", identifier: "Count", type: "NodeSocketInt", linked: false, value: 1 },
          { name: "Start Location", identifier: "Start Location", type: "NodeSocketVector", linked: false, value: [0, 0, 1] },
          { name: "Offset", identifier: "Offset", type: "NodeSocketVector", linked: false, value: [0, 0, 0] },
        ], [geometryOutput("Mesh")]),
        node("Instance on Points", "GeometryNodeInstanceOnPoints", [
          geometryInput("Points"), { name: "Selection", identifier: "Selection", type: "NodeSocketBool", linked: false, value: true },
          geometryInput("Instance"), { name: "Pick Instance", identifier: "Pick Instance", type: "NodeSocketBool", linked: false, value: false },
          { name: "Instance Index", identifier: "Instance Index", type: "NodeSocketInt", linked: false, value: 0 },
          { name: "Rotation", identifier: "Rotation", type: "NodeSocketRotation", linked: false, value: [0, 0, 0] },
          { name: "Scale", identifier: "Scale", type: "NodeSocketVector", linked: false, value: [1, 1, 1] },
        ], [geometryOutput("Instances")]),
        node("For Each Output", "GeometryNodeForeachGeometryElementOutput", [
          geometryInput("Generation", "Generation_0"),
        ], [geometryOutput("Generation", "Generation_0")], { props: { domain: "INSTANCE" } }),
        node("Group Output", "NodeGroupOutput", [geometryInput("Output")], []),
      ],
      links: [
        { from_node: "Group Input", from_socket: "Geometry", to_node: "For Each Input", to_socket: "Geometry" },
        { from_node: "For Each Input", from_socket: "Element", to_node: "Instances to Points", to_socket: "Instances" },
        { from_node: "Instances to Points", from_socket: "Points", to_node: "Instance on Points", to_socket: "Points" },
        { from_node: "Local Point", from_socket: "Mesh", to_node: "Instance on Points", to_socket: "Instance" },
        { from_node: "Instance on Points", from_socket: "Instances", to_node: "For Each Output", to_socket: "Generation_0" },
        { from_node: "For Each Output", from_socket: "Generation_0", to_node: "Group Output", to_socket: "Output" },
      ],
    },
  };
  const source = new Geometry();
  source.instances.push({ geometry: new Geometry(), position: [4, 5, 6], rotation: [Math.PI / 2, 0, Math.PI / 2], scale: [1, 1, 1] });
  const generated = new Evaluator(foreachProgram).evalGroup("foreach_instance_test", { Geometry: source }).Output as Geometry;
  const generatedPoint = realizeInstances(generated).mesh?.positions[0];
  check("For Each generation reapplies source instance transform", approx(generatedPoint ?? [], [5, 5, 6]), JSON.stringify(generatedPoint));
}

// (AE) Curve Tilt and Radius are point fields, and an unlinked Instance Index
// follows point index and wraps beyond a Geometry-to-Instance list.
{
  const points = curve([[0, 0, 0], [2, 0, 0]], false);
  points.curveAttributes.set("tilt", { domain: "POINT", data: [.2, -.4] });
  points.curveAttributes.set("radius", { domain: "POINT", data: [.75, 1.25] });
  const tilt = runNode("GeometryNodeInputCurveTilt", {}).Tilt as Field;
  const radius = runNode("GeometryNodeInputRadius", {}).Radius as Field;
  check("Curve Tilt reads curve point attributes", approx(tilt.array(makeFieldCtx(points, "POINT")) as number[], [.2, -.4]));
  check("Curve Radius reads curve point attributes", approx(radius.array(makeFieldCtx(points, "POINT")) as number[], [.75, 1.25]));
  const defaultRadius = runNode("GeometryNodeInputRadius", {}).Radius as Field;
  const plainPoints = curve([[0, 0, 0]], false);
  check("Curve Radius defaults to one", approx(defaultRadius.array(makeFieldCtx(plainPoints, "POINT")) as number[], [1]));
  const sourceA = box([0, 0, 0], [1, 1, 1]);
  const sourceB = box([0, 0, 0], [2, 2, 2]);
  const choices = new Geometry();
  choices.instances = [sourceA, sourceB].map((geometry, i) => ({ geometry, position: [i ? -2 : 1, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 }));
  const placed = runNode("GeometryNodeInstanceOnPoints", {
    Points: points, Selection: true, Instance: choices, "Pick Instance": true,
    "Instance Index": 0, Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, {}, ["Points", "Instance"]).Instances as Geometry;
  check("unlinked Pick Instance index cycles by point", placed.instances[0].geometry === sourceA && placed.instances[1].geometry === sourceB);
  check("Pick Instance preserves child transforms", approx(placed.instances[0].position, [1, 0, 0]) && approx(placed.instances[1].position, [0, 0, 0]));
  const baked = runNode("GeometryNodeInstanceOnPoints", {
    Points: new Geometry(), Selection: true, Instance: sourceA, "Pick Instance": false,
    "Instance Index": 0, Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, { baked_instances: [
    { position: [2, 3, 4], scale: [.5, .5, .5] },
    { position: [-1, 0, 1], rotation: [0, 0, 1], scale: [2, 2, 2] },
  ] }).Instances as Geometry;
  check("Instance on Points restores extracted authored transforms",
    baked.instances.length === 2 && approx(baked.instances[0].position, [2, 3, 4]) && approx(baked.instances[1].scale, [2, 2, 2]));
  const overflowPoints = curve([[0, 0, 0], [1, 0, 0], [2, 0, 0]], false);
  const overflow = runNode("GeometryNodeInstanceOnPoints", {
    Points: overflowPoints, Selection: true, Instance: choices, "Pick Instance": true,
    "Instance Index": 0, Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, {}, ["Points", "Instance"]).Instances as Geometry;
  check("unlinked Pick Instance wraps overflow points", overflow.instances.length === 3 && overflow.instances[2].geometry === sourceA, `got ${overflow.instances.length}`);
  const fractionalPick = runNode("GeometryNodeInstanceOnPoints", {
    Points: overflowPoints, Selection: true, Instance: choices, "Pick Instance": true,
    "Instance Index": Field.perElem((i) => i < 2 ? 0.9 : 1.9), Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, {}, ["Points", "Instance", "Instance Index"]).Instances as Geometry;
  check("linked Instance Index truncates fractional fields", fractionalPick.instances[0].geometry === sourceA && fractionalPick.instances[2].geometry === sourceB);
}

// (AF) Nested asset generators depend on Object Info's evaluated modifier mesh,
// then rotate those payloads as instances.
{
  const savedObjects = DUMP_CONTEXT.objects;
  const savedActiveObject = DUMP_CONTEXT.activeObject;
  const savedLegacyCurvePassthroughObjects = new Set(DUMP_CONTEXT.legacyCurvePassthroughObjects);
  DUMP_CONTEXT.objects = [{
    name: "nested", mesh: { verts: [[0, 0, 0]], faces: [] },
    evaluated_mesh: { verts: [[0, 0, 0], [1, 0, 0]], faces: [] },
  }];
  const nested = runNode("GeometryNodeObjectInfo", { Object: { datablock: "Object", name: "nested" }, "As Instance": false }).Geometry as Geometry;
  check("Object Info uses evaluated modifier geometry", nested.mesh?.positions.length === 2, `verts=${nested.mesh?.positions.length}`);
  const nestedInstance = runNode("GeometryNodeObjectInfo", { Object: { datablock: "Object", name: "nested" }, "As Instance": true }).Geometry as Geometry;
  check("Object Info As Instance preserves an instance component", !nestedInstance.mesh && nestedInstance.instances.length === 1 && nestedInstance.instances[0].geometry.mesh?.positions.length === 2);
  DUMP_CONTEXT.objects = [{
    name: "legacy-check", type: "CURVE",
    curves: [{
      cyclic: false, resolution: 12,
      points: [[0, 0, 0], [.25, 0, 0], [.5, 0, 0], [.75, 0, 0], [1, 0, 0]],
      control_points: [[0, 0, 0], [.5, 0, 0], [1, 0, 0]],
      bezier_left: [[0, 0, 0], [.25, 0, 0], [.75, 0, 0]],
      bezier_right: [[.25, 0, 0], [.75, 0, 0], [1, 0, 0]],
    }],
  }];
  DUMP_CONTEXT.legacyCurvePassthroughObjects.clear();
  DUMP_CONTEXT.legacyCurvePassthroughObjects.add("legacy-check");
  const legacyCheck = runNode("GeometryNodeObjectInfo", {
    Object: { datablock: "Object", name: "legacy-check" }, "As Instance": false,
  }).Geometry as Geometry;
  check("Object Info uses the control domain after a legacy curve pass-through modifier",
    legacyCheck.curves[0]?.points.length === 3 && legacyCheck.curves[0]?.resolution === 1,
    `points=${legacyCheck.curves[0]?.points.length}`);
  DUMP_CONTEXT.objects = [{
    name: "parented", mesh: { verts: [[1, 2, 3]], faces: [] },
    matrix_world: [[0, 2, 0, 10], [3, 0, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]],
  } as any];
  DUMP_CONTEXT.activeObject = {
    name: "active", matrix_world: [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]],
  } as any;
  const relative = runNode("GeometryNodeObjectInfo", {
    Object: { datablock: "Object", name: "parented" }, "As Instance": false,
  }, { transform_space: "RELATIVE" }).Geometry as Geometry;
  check("Object Info uses inherited world matrix", approx(relative.mesh?.positions[0] ?? [], [10, 18, 36]), JSON.stringify(relative.mesh?.positions[0]));
  DUMP_CONTEXT.objects = savedObjects;
  DUMP_CONTEXT.activeObject = savedActiveObject;
  DUMP_CONTEXT.legacyCurvePassthroughObjects.clear();
  for (const name of savedLegacyCurvePassthroughObjects) DUMP_CONTEXT.legacyCurvePassthroughObjects.add(name);
  const instances = new Geometry();
  instances.instances = [{ geometry: box([0, 0, 0], [1, 1, 1]), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }];
  const rotated = runNode("GeometryNodeRotateInstances", {
    Instances: instances, Selection: true, Rotation: [0, 0, Math.PI / 2], "Pivot Point": [0, 0, 0], "Local Space": true,
  }, {}, ["Instances", "Rotation"]).Instances as Geometry;
  check("Rotate Instances composes local rotation", approx(rotated.instances[0].rotation, [0, 0, Math.PI / 2]));
  const scaled = runNode("GeometryNodeScaleInstances", {
    Instances: instances, Selection: true, Scale: [2, 3, 4], Center: [0, 0, 0], "Local Space": true,
  }, {}, ["Scale"]).Instances as Geometry;
  check("Scale Instances composes per-axis scale", approx(scaled.instances[0].scale, [2, 3, 4]));
  const mixedInstances = instances.clone();
  mixedInstances.mesh = box([0, 0, 0], [1, 1, 1]).mesh;
  const scaledMixed = runNode("GeometryNodeScaleInstances", {
    Instances: mixedInstances, Selection: true, Scale: 0.5, Center: [0, 0, 0], "Local Space": true,
  }, {}, ["Scale"]).Instances as Geometry;
  check("instance fields use INSTANCE domain beside a mesh component", approx(scaledMixed.instances[0].scale, [0.5, 0.5, 0.5]));
  const wireInstances = runNode("GeometryNodeMeshToCurve", { Mesh: instances, Selection: true }).Curve as Geometry;
  check("Mesh to Curve preserves instance transforms", wireInstances.instances.length === 1 && wireInstances.instances[0].geometry.curves.length > 0);
}

// (AG) Packed images remain available to worker-side image fields. Repeated
// field reads on the same geometry context reuse the resolved array.
{
  const savedImages = DUMP_CONTEXT.images;
  DUMP_CONTEXT.images = [{ name: "two pixels", size: [2, 1], channels: 4, pixels_rgba8: "/wAA/wD/AP8=" }];
  const imageRef = { datablock: "Image", name: "two pixels" };
  const info = runNode("GeometryNodeImageInfo", { Image: imageRef, Frame: 0 });
  check("Image Info exposes packed dimensions", (info.Width as Field).value === 2 && (info.Height as Field).value === 1);
  const sampled = runNode("GeometryNodeImageTexture", {
    Image: imageRef, Vector: Field.perElem((i) => [i, 0, 0]), Frame: 0,
  }, { extension: "CLIP", interpolation: "Closest" }, ["Vector"]);
  const imageCtx = makeFieldCtx(curve([[0, 0, 0], [1, 0, 0]], false), "POINT");
  const colorsA = (sampled.Color as Field).array(imageCtx);
  const colorsB = (sampled.Color as Field).array(imageCtx);
  check("Image Texture samples CLIP edge pixels", approx(colorsA[0] as number[], [1, 0, 0]) && approx(colorsA[1] as number[], [0, 1, 0]));
  check("field arrays memoize per context", colorsA === colorsB);
  DUMP_CONTEXT.images = savedImages;
}

// (AH) Bradley/printing-library parity nodes.
{
  const attributed = box([0, 0, 0], [1, 1, 1]);
  attributed.mesh!.attributes.set("top edge", { domain: "POINT", data: attributed.mesh!.positions.map((_, index) => index < 4 ? 0 : 1) });
  const modifierProgram: any = {
    modifier_attribute_test: {
      name: "modifier_attribute_test",
      type: "GeometryNodeTree",
      interface: [
        { item_type: "SOCKET", in_out: "INPUT", name: "Geometry", identifier: "Geometry", socket_type: "NodeSocketGeometry", default: null },
        { item_type: "SOCKET", in_out: "INPUT", name: "Selection", identifier: "Selection", socket_type: "NodeSocketBool", default: false },
        { item_type: "SOCKET", in_out: "OUTPUT", name: "Geometry", identifier: "Output", socket_type: "NodeSocketGeometry", default: null },
      ],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", inputs: [], outputs: [
          { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" },
          { name: "Selection", identifier: "Selection", type: "NodeSocketBool" },
        ] },
        { name: "Set Position", type: "GeometryNodeSetPosition", inputs: [
          { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, value: null },
          { name: "Selection", identifier: "Selection", type: "NodeSocketBool", linked: true, value: null },
          { name: "Position", identifier: "Position", type: "NodeSocketVector", linked: false, value: [0, 0, 0] },
          { name: "Offset", identifier: "Offset", type: "NodeSocketVector", linked: false, value: [0, 0, 2] },
        ], outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }] },
        { name: "Group Output", type: "NodeGroupOutput", props: { is_active_output: true }, inputs: [
          { name: "Geometry", identifier: "Output", type: "NodeSocketGeometry", linked: true, value: null },
        ], outputs: [] },
      ],
      links: [
        { from_node: "Group Input", from_socket: "Geometry", to_node: "Set Position", to_socket: "Geometry" },
        { from_node: "Group Input", from_socket: "Selection", to_node: "Set Position", to_socket: "Selection" },
        { from_node: "Set Position", from_socket: "Geometry", to_node: "Group Output", to_socket: "Output" },
      ],
    },
  };
  const modifierResult = new Evaluator(modifierProgram).evalModifierGroup("modifier_attribute_test", {
    Geometry: attributed,
    Selection: { attribute: "top edge", value: false },
  }).geometry;
  check("modifier named-attribute inputs preserve per-point selections",
    modifierResult.mesh!.positions.slice(0, 4).every((point) => point[2] <= 1)
      && modifierResult.mesh!.positions.slice(4).every((point) => point[2] >= 2));

  const cylinder = runNode("GeometryNodeMeshCylinder", {
    Vertices: 8, "Side Segments": 2, "Fill Segments": 1, Radius: 2, Depth: 4,
  }, { fill_type: "NGON" }).Mesh as Geometry;
  check("Mesh Cylinder builds rings and caps", cylinder.mesh?.positions.length === 24 && cylinder.mesh.faces.length === 18,
    `verts=${cylinder.mesh?.positions.length} faces=${cylinder.mesh?.faces.length}`);
  const cylinderZ = cylinder.mesh!.positions.map((position) => position[2]);
  check("Mesh Cylinder remains centered on Z", Math.abs(Math.min(...cylinderZ) + 2) < 1e-6 && Math.abs(Math.max(...cylinderZ) - 2) < 1e-6);

  const faceArea = runNode("GeometryNodeInputMeshFaceArea", {}).Area as Field;
  const areaValues = faceArea.array(makeFieldCtx(box([0, 0, 0], [2, 3, 4]), "FACE"));
  check("Face Area reads polygon areas", approx(areaValues as number[], [6, 6, 8, 12, 8, 12]), `areas=${areaValues}`);

  const quad = box([0, 0, 0], [1, 1, 0]);
  const triangulated = runNode("GeometryNodeTriangulate", { Mesh: quad, Selection: true }).Mesh as Geometry;
  check("Triangulate splits six box quads", triangulated.mesh?.faces.length === 12 && triangulated.mesh.faces.every((face) => face.length === 3));
  const symmetricQuad = new Geometry();
  symmetricQuad.mesh = new Mesh();
  symmetricQuad.mesh.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  symmetricQuad.mesh.faces = [[0, 1, 2, 3]];
  symmetricQuad.mesh.faceMaterial = [0];
  const symmetricTriangles = runNode("GeometryNodeTriangulate", { Mesh: symmetricQuad, Selection: true }).Mesh as Geometry;
  check("Triangulate BEAUTY ties use Blender's 1-3 diagonal", JSON.stringify(symmetricTriangles.mesh!.faces) === JSON.stringify([[0, 1, 3], [1, 2, 3]]), JSON.stringify(symmetricTriangles.mesh!.faces));

  const line = curve([[0, 0, 0], [2, 0, 0]], false);
  line.curveAttributes.set("weight", { domain: "POINT", data: [0, 2] });
  const subdivided = runNode("GeometryNodeSubdivideCurve", { Curve: line, Cuts: 1 }).Curve as Geometry;
  check("Subdivide Curve inserts linear cuts", subdivided.curves[0].points.length === 3 && approx(subdivided.curves[0].points[1], [1, 0, 0]));
  check("Subdivide Curve interpolates attributes", approx(subdivided.curveAttributes.get("weight")!.data as number[], [0, 1, 2]));

  const spiral = runNode("GeometryNodeCurveSpiral", {
    Resolution: 8, Rotations: 2, "Start Radius": 1, "End Radius": 2, Height: 4, Reverse: false,
  }).Curve as Geometry;
  check("Curve Spiral uses samples per rotation", spiral.curves[0].points.length === 17, `got ${spiral.curves[0].points.length}`);
  check("Curve Spiral endpoints", approx(spiral.curves[0].points[0], [1, 0, 0]) && approx(spiral.curves[0].points[16], [2, 0, 4]));

  line.curves[0].resolution = 7;
  const splineResolution = runNode("GeometryNodeInputSplineResolution", {}).Resolution as Field;
  check("Spline Resolution reads authored value", approx(splineResolution.array(makeFieldCtx(line, "POINT")) as number[], [7, 7]));
  const handles = runNode("GeometryNodeCurveSetHandles", { Curve: line, Selection: true }, { handle_type: "AUTO" }).Curve as Geometry;
  check("Set Handle Type preserves evaluated curve", handles !== line && approx(handles.curves[0].points[1], [2, 0, 0]));
  check("Is Viewport selects browser path", (runNode("GeometryNodeIsViewport", {})["Is Viewport"] as Field).value === 1);

  const mapped = runNode("ShaderNodeFloatCurve", { Factor: 1, Value: Field.of(0.5) }, {
    curve_mapping: { extend: "EXTRAPOLATED", use_clip: true, clip: [0, 1, 0, 1], curves: [[
      { location: [0, 0] }, { location: [0.25, 0.1] }, { location: [0.75, 0.9] }, { location: [1, 1] },
    ]] },
  }).Value as Field;
  check("Float Curve evaluates portable mapping", Math.abs((mapped.value as number) - 0.5) < 1e-6, `got ${mapped.value}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
