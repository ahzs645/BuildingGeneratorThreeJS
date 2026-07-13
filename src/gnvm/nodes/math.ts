// Scalar / vector / boolean field-math handlers.
import { Field, fieldMap, Vec3, Elem, asNum, asVec3, vadd, vsub, vmul, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { reg, EvalAPI, MISSING } from "../registry";

const num = (e: Elem) => asNum(e);

// Blender Smooth Min/Max (polynomial): distance-based soft blend.
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * h * k) / 6;
}
function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

// ---- Math (scalar) --------------------------------------------------------
const MATH: Record<string, (a: number, b: number, c: number) => number> = {
  ADD: (a, b) => a + b,
  SUBTRACT: (a, b) => a - b,
  MULTIPLY: (a, b) => a * b,
  DIVIDE: (a, b) => (b === 0 ? 0 : a / b),
  MULTIPLY_ADD: (a, b, c) => a * b + c,
  POWER: (a, b) => Math.pow(a, b),
  LOGARITHM: (a, b) => (b > 0 && b !== 1 ? Math.log(a) / Math.log(b) : Math.log(a)),
  SQRT: (a) => Math.sqrt(Math.max(0, a)),
  INVERSE_SQRT: (a) => (a > 0 ? 1 / Math.sqrt(a) : 0),
  ABSOLUTE: (a) => Math.abs(a),
  EXPONENT: (a) => Math.exp(a),
  MINIMUM: (a, b) => Math.min(a, b),
  MAXIMUM: (a, b) => Math.max(a, b),
  SMOOTH_MIN: (a, b, c) => smoothMin(a, b, c),
  SMOOTH_MAX: (a, b, c) => smoothMax(a, b, c),
  LESS_THAN: (a, b) => (a < b ? 1 : 0),
  GREATER_THAN: (a, b) => (a > b ? 1 : 0),
  SIGN: (a) => Math.sign(a),
  COMPARE: (a, b, c) => (Math.abs(a - b) <= c ? 1 : 0),
  ROUND: (a) => Math.round(a),
  FLOOR: (a) => Math.floor(a),
  CEIL: (a) => Math.ceil(a),
  TRUNCATE: (a) => Math.trunc(a),
  TRUNC: (a) => Math.trunc(a),
  FRACT: (a) => a - Math.floor(a),
  MODULO: (a, b) => (b === 0 ? 0 : a % b),
  FLOORED_MODULO: (a, b) => (b === 0 ? 0 : a - b * Math.floor(a / b)),
  WRAP: (a, b, c) => (b - c === 0 ? c : a - (b - c) * Math.floor((a - c) / (b - c))),
  SNAP: (a, b) => (b === 0 ? 0 : Math.floor(a / b) * b),
  PINGPONG: (a, b) => (b === 0 ? 0 : b - Math.abs(((((a - b) % (2 * b)) + 2 * b) % (2 * b)) - b)),
  SINE: (a) => Math.sin(a),
  COSINE: (a) => Math.cos(a),
  TANGENT: (a) => Math.tan(a),
  ARCSINE: (a) => Math.asin(Math.max(-1, Math.min(1, a))),
  ARCCOSINE: (a) => Math.acos(Math.max(-1, Math.min(1, a))),
  ARCTANGENT: (a) => Math.atan(a),
  ARCTAN2: (a, b) => Math.atan2(a, b),
  RADIANS: (a) => (a * Math.PI) / 180,
  DEGREES: (a) => (a * 180) / Math.PI,
};

reg("ShaderNodeMath", (api) => {
  const op = api.prop<string>("operation", "ADD");
  const f = MATH[op] ?? MATH.ADD;
  const a = api.field("Value");
  const b = api.field("Value_001");
  const c = api.field("Value_002");
  return { Value: fieldMap([a, b, c], (x, y, z) => f(num(x), num(y), num(z))) };
});

// ---- Vector Math ----------------------------------------------------------
const VECTOR_MATH_OPS = new Set([
  "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "SCALE", "CROSS_PRODUCT", "NORMALIZE",
  "DOT_PRODUCT", "LENGTH", "DISTANCE", "ABSOLUTE", "MINIMUM", "MAXIMUM",
  "FLOOR", "CEIL", "FRACTION", "MULTIPLY_ADD", "PROJECT", "REFLECT", "REFRACT",
  "FACEFORWARD", "MODULO", "SNAP", "SINE", "COSINE", "TANGENT",
]);

reg("ShaderNodeVectorMath", (api) => {
  const op = api.prop<string>("operation", "ADD");
  const a = api.field("Vector");
  const b = api.field("Vector_001");
  const c = api.field("Vector_002");
  const scale = api.field("Scale");
  const va = (e: Elem) => asVec3(e);
  let vecOut: Field | null = null;
  let valOut: Field | null = null;
  switch (op) {
    case "ADD": vecOut = fieldMap([a, b], (x, y) => vadd(va(x), va(y))); break;
    case "SUBTRACT": vecOut = fieldMap([a, b], (x, y) => vsub(va(x), va(y))); break;
    case "MULTIPLY": vecOut = fieldMap([a, b], (x, y) => vmul(va(x), va(y))); break;
    case "DIVIDE": vecOut = fieldMap([a, b], (x, y) => { const u = va(x), v = va(y); return [v[0] ? u[0] / v[0] : 0, v[1] ? u[1] / v[1] : 0, v[2] ? u[2] / v[2] : 0] as Vec3; }); break;
    case "SCALE": vecOut = fieldMap([a, scale], (x, s) => vscale(va(x), num(s))); break;
    case "CROSS_PRODUCT": vecOut = fieldMap([a, b], (x, y) => vcross(va(x), va(y))); break;
    case "NORMALIZE": vecOut = fieldMap([a], (x) => vnorm(va(x))); break;
    case "DOT_PRODUCT": valOut = fieldMap([a, b], (x, y) => vdot(va(x), va(y))); break;
    case "LENGTH": valOut = fieldMap([a], (x) => vlen(va(x))); break;
    case "DISTANCE": valOut = fieldMap([a, b], (x, y) => vlen(vsub(va(x), va(y)))); break;
    case "ABSOLUTE": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])] as Vec3; }); break;
    case "MINIMUM": vecOut = fieldMap([a, b], (x, y) => { const u = va(x), v = va(y); return [Math.min(u[0], v[0]), Math.min(u[1], v[1]), Math.min(u[2], v[2])] as Vec3; }); break;
    case "MAXIMUM": vecOut = fieldMap([a, b], (x, y) => { const u = va(x), v = va(y); return [Math.max(u[0], v[0]), Math.max(u[1], v[1]), Math.max(u[2], v[2])] as Vec3; }); break;
    case "FLOOR": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.floor(u[0]), Math.floor(u[1]), Math.floor(u[2])] as Vec3; }); break;
    case "CEIL": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.ceil(u[0]), Math.ceil(u[1]), Math.ceil(u[2])] as Vec3; }); break;
    case "FRACTION": vecOut = fieldMap([a], (x) => { const u = va(x); return [u[0] - Math.floor(u[0]), u[1] - Math.floor(u[1]), u[2] - Math.floor(u[2])] as Vec3; }); break;
    case "MULTIPLY_ADD": vecOut = fieldMap([a, b, c], (x, y, z) => vadd(vmul(va(x), va(y)), va(z))); break;
    case "MODULO": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      return [v[0] ? u[0] % v[0] : 0, v[1] ? u[1] % v[1] : 0, v[2] ? u[2] % v[2] : 0] as Vec3;
    }); break;
    case "SNAP": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      const sn = (p: number, s: number) => (s === 0 ? 0 : Math.floor(p / s) * s);
      return [sn(u[0], v[0]), sn(u[1], v[1]), sn(u[2], v[2])] as Vec3;
    }); break;
    case "SINE": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.sin(u[0]), Math.sin(u[1]), Math.sin(u[2])] as Vec3; }); break;
    case "COSINE": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.cos(u[0]), Math.cos(u[1]), Math.cos(u[2])] as Vec3; }); break;
    case "TANGENT": vecOut = fieldMap([a], (x) => { const u = va(x); return [Math.tan(u[0]), Math.tan(u[1]), Math.tan(u[2])] as Vec3; }); break;
    case "PROJECT": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      const d = vdot(v, v);
      return d > 1e-12 ? vscale(v, vdot(u, v) / d) : [0, 0, 0];
    }); break;
    case "REFLECT": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), n = vnorm(va(y));
      return vsub(u, vscale(n, 2 * vdot(u, n)));
    }); break;
    case "FACEFORWARD": vecOut = fieldMap([a, b, c], (x, y, z) => {
      const n = va(x), i = va(y), nref = va(z);
      return vdot(nref, i) < 0 ? n : vscale(n, -1);
    }); break;
    default: {
      // Never silently ADD — record a miss and no-op (pass Vector A through).
      if (!VECTOR_MATH_OPS.has(op)) {
        const key = `ShaderNodeVectorMath:${op}`;
        MISSING.set(key, (MISSING.get(key) ?? 0) + 1);
      }
      vecOut = fieldMap([a], (x) => va(x));
      break;
    }
  }
  return { Vector: vecOut ?? Field.of([0, 0, 0]), Value: valOut ?? Field.of(0) };
});

// ---- Combine / Separate ---------------------------------------------------
reg("ShaderNodeCombineXYZ", (api) => ({
  Vector: fieldMap([api.field("X"), api.field("Y"), api.field("Z")], (x, y, z) => [num(x), num(y), num(z)] as Vec3),
}));
reg("ShaderNodeSeparateXYZ", (api) => {
  const v = api.field("Vector");
  return {
    X: fieldMap([v], (e) => asVec3(e)[0]),
    Y: fieldMap([v], (e) => asVec3(e)[1]),
    Z: fieldMap([v], (e) => asVec3(e)[2]),
  };
});

// ---- Compare --------------------------------------------------------------
reg("FunctionNodeCompare", (api) => {
  const op = api.prop<string>("operation", "GREATER_THAN");
  const dt = api.prop<string>("data_type", "FLOAT");
  const aKey = dt === "INT" ? "A_INT" : "A";
  const bKey = dt === "INT" ? "B_INT" : "B";
  const a = api.field(aKey), b = api.field(bKey), eps = api.field("Epsilon");
  // INT sockets round incoming floats to integers (Blender's implicit conversion).
  const conv = dt === "INT" ? Math.round : (v: number) => v;
  const cmp = (x0: number, y0: number, e: number) => {
    const x = conv(x0), y = conv(y0);
    switch (op) {
      case "LESS_THAN": return x < y;
      case "LESS_EQUAL": return x <= y;
      case "GREATER_THAN": return x > y;
      case "GREATER_EQUAL": return x >= y;
      case "EQUAL": return Math.abs(x - y) <= e;
      case "NOT_EQUAL": return Math.abs(x - y) > e;
      default: return x > y;
    }
  };
  return { Result: fieldMap([a, b, eps], (x, y, e) => (cmp(num(x), num(y), num(e)) ? 1 : 0)) };
});

// ---- Boolean Math ---------------------------------------------------------
reg("FunctionNodeBooleanMath", (api) => {
  const op = api.prop<string>("operation", "AND");
  const a = api.field("Boolean"), b = api.field("Boolean_001");
  const bl = (e: Elem) => num(e) !== 0;
  return {
    Boolean: fieldMap([a, b], (x, y) => {
      const p = bl(x), q = bl(y);
      switch (op) {
        case "AND": return p && q ? 1 : 0;
        case "OR": return p || q ? 1 : 0;
        case "NOT": return p ? 0 : 1;
        case "NAND": return p && q ? 0 : 1;
        case "NOR": return p || q ? 0 : 1;
        case "XOR": return p !== q ? 1 : 0;
        case "XNOR": return p === q ? 1 : 0;
        case "IMPLY": return !p || q ? 1 : 0;
        case "NIMPLY": return p && !q ? 1 : 0;
        default: return p && q ? 1 : 0;
      }
    }),
  };
});

// ---- Map Range (float) ----------------------------------------------------
reg("ShaderNodeMapRange", (api) => {
  const clamp = api.prop<boolean>("clamp", true);
  const interp = api.prop<string>("interpolation_type", "LINEAR");
  const v = api.field("Value"), fmin = api.field("From Min"), fmax = api.field("From Max"), tmin = api.field("To Min"), tmax = api.field("To Max");
  return {
    Result: fieldMap([v, fmin, fmax, tmin, tmax], (a, b, c, d, e) => {
      const x = num(a), b0 = num(b), b1 = num(c), t0 = num(d), t1 = num(e);
      let f = b1 - b0 === 0 ? 0 : (x - b0) / (b1 - b0);
      if (interp === "SMOOTHSTEP") f = f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
      let r = t0 + f * (t1 - t0);
      if (clamp) r = t1 >= t0 ? Math.max(t0, Math.min(t1, r)) : Math.max(t1, Math.min(t0, r));
      return r;
    }),
  };
});

// ---- Clamp ----------------------------------------------------------------
reg("ShaderNodeClamp", (api) => {
  const v = api.field("Value"), lo = api.field("Min"), hi = api.field("Max");
  return { Result: fieldMap([v, lo, hi], (a, b, c) => Math.max(num(b), Math.min(num(c), num(a)))) };
});

// ---- Mix (float / vector) -------------------------------------------------
reg("ShaderNodeMix", (api) => {
  const dt = api.prop<string>("data_type", "FLOAT");
  const clampF = api.prop<boolean>("clamp_factor", true);
  let fac = api.field("Factor_Float");
  if (fac.isConst && fac.value === 0) fac = api.field("Factor"); // fallback socket name
  const lerp = (t: number, a: number, b: number) => a + (clampF ? Math.max(0, Math.min(1, t)) : t) * (b - a);
  const out = (result: Field) => ({
    Result: result,
    Result_Float: result,
    Result_Vector: result,
    Result_Color: result,
    Result_Rotation: result,
  });
  if (dt === "VECTOR" || dt === "RGBA" || dt === "ROTATION") {
    const aName = dt === "RGBA" ? "A_Color" : dt === "ROTATION" ? "A_Rotation" : "A_Vector";
    const bName = dt === "RGBA" ? "B_Color" : dt === "ROTATION" ? "B_Rotation" : "B_Vector";
    const a = api.field(aName), b = api.field(bName);
    return out(fieldMap([fac, a, b], (t, x, y) => { const u = asVec3(x), v = asVec3(y), tt = num(t); return [lerp(tt, u[0], v[0]), lerp(tt, u[1], v[1]), lerp(tt, u[2], v[2])] as Vec3; }));
  }
  const a = api.field("A_Float"), b = api.field("B_Float");
  return out(fieldMap([fac, a, b], (t, x, y) => lerp(num(t), num(x), num(y))));
});

// ---- Constant / input nodes ----------------------------------------------
reg("ShaderNodeValue", (api) => ({ Value: Field.of(num(outDefault(api, "Value") ?? 0)) }));
reg("FunctionNodeInputInt", (api) => ({ Integer: Field.of(Math.trunc(api.prop<number>("integer", 0))) }));
reg("FunctionNodeInputBool", (api) => ({ Boolean: Field.of(api.prop<boolean>("boolean", false) ? 1 : 0) }));
reg("FunctionNodeInputVector", (api) => ({ Vector: Field.of((api.prop<number[]>("vector", [0, 0, 0]).slice(0, 3) as Vec3)) }));
reg("FunctionNodeInputColor", (api) => ({ Color: Field.of((api.prop<number[]>("value", [0, 0, 0]).slice(0, 3) as Vec3)) }));
reg("FunctionNodeInputString", (api) => ({ String: api.prop<string>("string", "") }));

// ---- Float to Integer -----------------------------------------------------
reg("FunctionNodeFloatToInt", (api) => {
  const mode = (api.prop<string>("rounding_mode", "ROUND") || "ROUND").toUpperCase();
  const v = api.field("Float");
  const cast = (x: number) => {
    switch (mode) {
      case "FLOOR": return Math.floor(x);
      case "CEILING":
      case "CEIL": return Math.ceil(x);
      case "TRUNCATE":
      case "TRUNC": return Math.trunc(x);
      case "ROUND":
      default: return Math.round(x);
    }
  };
  return { Integer: fieldMap([v], (e) => cast(num(e))) };
});

// ---- Value to String / Join Strings ---------------------------------------
function sockToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Field) {
    if (!v.isConst) return "";
    const e = v.value;
    return Array.isArray(e) ? `${e[0]},${e[1]},${e[2]}` : String(e);
  }
  if (v == null) return "";
  return String(v);
}

reg("FunctionNodeValueToString", (api) => {
  const decimals = Math.max(0, Math.round(api.num("Decimals")));
  const value = api.num("Value");
  let s: string;
  if (decimals <= 0) s = String(Math.trunc(value));
  else s = value.toFixed(decimals);
  return { String: s };
});

reg("GeometryNodeStringJoin", (api) => {
  const delim = api.str("Delimiter");
  const parts = api.inputs("Strings").map(sockToString);
  return { String: parts.join(delim) };
});

reg("FunctionNodeStringLength", (api) => ({
  Length: Field.of(Array.from(api.str("String")).length),
}));

reg("FunctionNodeSliceString", (api) => {
  const characters = Array.from(api.str("String"));
  let position = Math.trunc(api.num("Position"));
  const length = Math.max(0, Math.trunc(api.num("Length")));
  if (position < 0) position = Math.max(0, characters.length + position);
  return { String: characters.slice(position, position + length).join("") };
});

reg("FunctionNodeInputSpecialCharacters", () => ({
  "Line Break": "\n",
  Tab: "\t",
}));

function outDefault(api: EvalAPI, name: string): any {
  const o = api.node.outputs.find((x) => x.name === name || x.identifier === name);
  return o?.default;
}

// ---- Switch (any type) ----------------------------------------------------
reg("GeometryNodeSwitch", (api) => {
  const sw = api.field("Switch");
  const on = (v: Elem) => asNum(v) > 0;
  if (sw.isConst) return { Output: api.input(on(sw.value) ? "True" : "False") };
  if (api.prop<string>("input_type", "") === "GEOMETRY") return { Output: api.input("False") };
  const falseVal = api.input("False");
  const trueVal = api.input("True");
  if (falseVal instanceof Field || trueVal instanceof Field) {
    const f = falseVal instanceof Field ? falseVal : Field.of(0);
    const t = trueVal instanceof Field ? trueVal : Field.of(0);
    return {
      Output: Field.make((ctx) => {
        const sArr = sw.array(ctx);
        const fArr = f.array(ctx);
        const tArr = t.array(ctx);
        const out: Elem[] = new Array(ctx.size);
        for (let i = 0; i < ctx.size; i++) out[i] = on(sArr[i] ?? 0) ? tArr[i] ?? 0 : fArr[i] ?? 0;
        return out;
      }),
    };
  }
  return { Output: falseVal };
});
