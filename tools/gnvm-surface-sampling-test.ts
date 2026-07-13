import { Elem, Field, Vec3, asNum, asVec3 } from "../src/gnvm/core";
import { makeFieldCtx } from "../src/gnvm/evaluator";
import { Geometry, Mesh } from "../src/gnvm/geometry";
import { EvalAPI, REGISTRY, SockVal } from "../src/gnvm/registry";
import "../src/gnvm/index";

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) console.log(`PASS  ${label}`);
  else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const nearVec = (a: Vec3, b: Vec3) => a.every((value, index) => near(value, b[index]));

function field(value: SockVal): Field {
  if (value instanceof Field) return value;
  if (typeof value === "number") return Field.of(value);
  if (Array.isArray(value)) return Field.of(value as Vec3);
  return Field.of(0);
}
function run(type: string, inputs: Record<string, SockVal>, props: Record<string, unknown> = {}, linked: string[] = []): Record<string, SockVal> {
  const handler = REGISTRY.get(type);
  if (!handler) throw new Error(`missing handler ${type}`);
  const api: EvalAPI = {
    node: {
      name: type, type, label: null,
      props,
      inputs: Object.keys(inputs).map((name, index) => ({ name, identifier: name, idx: index, type: "", linked: linked.includes(name), value: null })),
      outputs: [],
    },
    input: (name) => inputs[name], inputs: (name) => [inputs[name]],
    geoInputs: (name) => inputs[name] instanceof Geometry ? [inputs[name] as Geometry] : [],
    geo: (name) => inputs[name] instanceof Geometry ? inputs[name] as Geometry : new Geometry(),
    field: (name) => field(inputs[name]),
    num: (name) => asNum(field(inputs[name]).value), vec: (name) => asVec3(field(inputs[name]).value),
    bool: (name) => asNum(field(inputs[name]).value) !== 0,
    str: (name) => String(inputs[name] ?? ""), ref: () => null,
    prop: <T>(name: string, fallback?: T) => (props[name] as T | undefined) ?? fallback as T,
    resolve: (value, geometry, domain) => value.array(makeFieldCtx(geometry, domain)),
  };
  return handler(api);
}

const triangle = new Geometry();
triangle.mesh = new Mesh();
triangle.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
triangle.mesh.faces = [[0, 1, 2]];
const position = Field.perElem((index, ctx) => ctx.position?.(index) ?? [0, 0, 0]);
const sampled = run("GeometryNodeSampleNearestSurface", {
  Mesh: triangle, Value: position, "Sample Position": Field.of([0.25, 0.25, 2]),
}, {}, ["Sample Position"]);
const sampleCtx = makeFieldCtx(triangle, "FACE");
const sampledValue = (sampled.Value as Field).array(sampleCtx)[0] as Vec3;
check("Sample Nearest Surface interpolates a triangle field", nearVec(sampledValue, [0.25, 0.25, 0]), JSON.stringify(sampledValue));
check("Sample Nearest Surface reports a valid hit", asNum((sampled["Is Valid"] as Field).array(sampleCtx)[0]) === 1);

const curve = new Geometry();
curve.curves = [{ cyclic: false, points: [[0, 0, 0], [1, 0, 0]] }];
const radiusResult = run("GeometryNodeSetCurveRadius", {
  Curve: curve, Selection: Field.perElem((index) => index === 0 ? 1 : 0), Radius: Field.of(0.25),
});
const radii = (radiusResult.Curve as Geometry).curveAttributes.get("radius")?.data ?? [];
check("Set Curve Radius changes selected controls", near(asNum(radii[0] as Elem), 0.25));
check("Set Curve Radius preserves unselected defaults", near(asNum(radii[1] as Elem), 1));

const objectRotation = run("FunctionNodeRotateEuler", {
  Rotation: [Math.PI / 2, 0, 0], "Rotate By": [0, Math.PI / 2, 0],
}, { space: "OBJECT" }).Rotation as Field;
const localRotation = run("FunctionNodeRotateEuler", {
  Rotation: [Math.PI / 2, 0, 0], "Rotate By": [0, Math.PI / 2, 0],
}, { space: "LOCAL" }).Rotation as Field;
check("Rotate Euler distinguishes Object and Local composition", !nearVec(asVec3(objectRotation.value), asVec3(localRotation.value)));

if (failures) process.exit(1);
console.log("SURFACE_SAMPLING_TEST_OK 5 passed");
