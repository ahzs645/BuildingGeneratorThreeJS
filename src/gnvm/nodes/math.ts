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
  // Blender's compatible logarithm returns zero outside its real-valued
  // domain. Propagating JavaScript NaN here tears sparse holes through volume
  // fields that intentionally feed signed trigonometric values into Logarithm.
  LOGARITHM: (a, b) => (a > 0 && b > 0 && b !== 1 ? Math.log(a) / Math.log(b) : 0),
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
  return {
    Value: fieldMap([a, b, c], (x, y, z) => {
      const result = f(num(x), num(y), num(z));
      // Float Math sockets store float32 values. ADD is especially visible in
      // generated grid dimensions, where double precision shifts every point.
      return op === "ADD" || op === "DIVIDE" ? Math.fround(result) : result;
    }),
  };
});

type CurvePoint = { location: [number, number]; handle_type?: string };
function floatCurveSample(points: CurvePoint[], value: number, extend: string): number {
  if (points.length < 2) return value;
  const sorted = [...points].sort((a, b) => a.location[0] - b.location[0]);
  const slope = (a: CurvePoint, b: CurvePoint) => {
    const dx = b.location[0] - a.location[0];
    return Math.abs(dx) > 1e-12 ? (b.location[1] - a.location[1]) / dx : 0;
  };
  if (value <= sorted[0].location[0]) return extend === "HORIZONTAL"
    ? sorted[0].location[1]
    : sorted[0].location[1] + (value - sorted[0].location[0]) * slope(sorted[0], sorted[1]);
  const last = sorted.length - 1;
  if (value >= sorted[last].location[0]) return extend === "HORIZONTAL"
    ? sorted[last].location[1]
    : sorted[last].location[1] + (value - sorted[last].location[0]) * slope(sorted[last - 1], sorted[last]);
  let segment = 0;
  while (segment + 1 < sorted.length && value > sorted[segment + 1].location[0]) segment++;
  const p0 = sorted[segment], p1 = sorted[segment + 1];
  const span = Math.max(1e-12, p1.location[0] - p0.location[0]);
  const t = (value - p0.location[0]) / span;
  // CurveMapping AUTO handles use a smooth cubic through neighboring points.
  // Hermite tangents reproduce the authored S-ramp closely while preserving
  // exact point values and linear two-point mappings.
  const m0 = segment > 0 ? slope(sorted[segment - 1], p1) : slope(p0, p1);
  const m1 = segment + 2 < sorted.length ? slope(p0, sorted[segment + 2]) : slope(p0, p1);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0.location[1]
    + (t3 - 2 * t2 + t) * span * m0
    + (-2 * t3 + 3 * t2) * p1.location[1]
    + (t3 - t2) * span * m1;
}

reg("ShaderNodeFloatCurve", (api) => {
  const mapping = api.prop<any>("curve_mapping", null);
  const points: CurvePoint[] = mapping?.curves?.[0] ?? [
    { location: [0, 0] }, { location: [1, 1] },
  ];
  const factor = api.field("Factor");
  const value = api.field("Value");
  return {
    Value: fieldMap([factor, value], (factorValue, inputValue) => {
      const f = Math.max(0, Math.min(1, num(factorValue)));
      const x = num(inputValue);
      let mapped = floatCurveSample(points, x, mapping?.extend ?? "EXTRAPOLATED");
      if (mapping?.use_clip && Array.isArray(mapping.clip)) mapped = Math.max(mapping.clip[2], Math.min(mapping.clip[3], mapped));
      return x * (1 - f) + mapped * f;
    }),
  };
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
    case "ADD": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      return [
        Math.fround(Math.fround(u[0]) + Math.fround(v[0])),
        Math.fround(Math.fround(u[1]) + Math.fround(v[1])),
        Math.fround(Math.fround(u[2]) + Math.fround(v[2])),
      ] as Vec3;
    }); break;
    case "SUBTRACT": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      return [
        Math.fround(Math.fround(u[0]) - Math.fround(v[0])),
        Math.fround(Math.fround(u[1]) - Math.fround(v[1])),
        Math.fround(Math.fround(u[2]) - Math.fround(v[2])),
      ] as Vec3;
    }); break;
    case "MULTIPLY": vecOut = fieldMap([a, b], (x, y) => {
      const u = va(x), v = va(y);
      return [
        Math.fround(Math.fround(u[0]) * Math.fround(v[0])),
        Math.fround(Math.fround(u[1]) * Math.fround(v[1])),
        Math.fround(Math.fround(u[2]) * Math.fround(v[2])),
      ] as Vec3;
    }); break;
    case "DIVIDE": vecOut = fieldMap([a, b], (x, y) => { const u = va(x), v = va(y); return [v[0] ? u[0] / v[0] : 0, v[1] ? u[1] / v[1] : 0, v[2] ? u[2] / v[2] : 0] as Vec3; }); break;
    case "SCALE": vecOut = fieldMap([a, scale], (x, s) => {
      const u = va(x), factor = Math.fround(num(s));
      return [
        Math.fround(Math.fround(u[0]) * factor),
        Math.fround(Math.fround(u[1]) * factor),
        Math.fround(Math.fround(u[2]) * factor),
      ] as Vec3;
    }); break;
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

// ---- Map Range ------------------------------------------------------------
reg("ShaderNodeMapRange", (api) => {
  const clamp = api.prop<boolean>("clamp", true);
  const interp = api.prop<string>("interpolation_type", "LINEAR");
  const dataType = api.prop<string>("data_type", "FLOAT");
  const safeDivideF32 = (numerator: number, denominator: number) => {
    const divisor = Math.fround(denominator);
    return divisor === 0 ? 0 : Math.fround(Math.fround(numerator) / divisor);
  };
  const mapFactor = (x: number, fromMin: number, fromMax: number, steps = 4) => {
    if (interp === "STEPPED") {
      // Blender evaluates Map Range sockets as floats, including each
      // intermediate in floor(factor * (steps + 1)) / steps. Keeping that
      // ordering is observable in Volume Cube fields near an iso threshold.
      const factor = safeDivideF32(
        Math.fround(Math.fround(x) - Math.fround(fromMin)),
        Math.fround(Math.fround(fromMax) - Math.fround(fromMin)),
      );
      const bucket = Math.floor(Math.fround(factor * Math.fround(Math.fround(steps) + 1)));
      return safeDivideF32(bucket, steps);
    }
    let factor = fromMax - fromMin === 0 ? 0 : (x - fromMin) / (fromMax - fromMin);
    if (interp === "SMOOTHSTEP") factor = factor <= 0 ? 0 : factor >= 1 ? 1 : factor * factor * (3 - 2 * factor);
    else if (interp === "SMOOTHERSTEP")
      factor = factor <= 0 ? 0 : factor >= 1 ? 1 : factor * factor * factor * (factor * (factor * 6 - 15) + 10);
    return factor;
  };
  const mapComponent = (x: number, fromMin: number, fromMax: number, toMin: number, toMax: number, steps = 4) => {
    const factor = mapFactor(x, fromMin, fromMax, steps);
    let result = interp === "STEPPED"
      ? Math.fround(Math.fround(toMin) + Math.fround(factor * Math.fround(Math.fround(toMax) - Math.fround(toMin))))
      : toMin + factor * (toMax - toMin);
    if (clamp) result = toMax >= toMin ? Math.max(toMin, Math.min(toMax, result)) : Math.max(toMax, Math.min(toMin, result));
    return result;
  };
  if (dataType === "FLOAT_VECTOR") {
    const vector = api.field("Vector");
    const fromMin = api.field("From_Min_FLOAT3");
    const fromMax = api.field("From_Max_FLOAT3");
    const toMin = api.field("To_Min_FLOAT3");
    const toMax = api.field("To_Max_FLOAT3");
    const steps = api.field("Steps_FLOAT3");
    const result = fieldMap([vector, fromMin, fromMax, toMin, toMax, steps], (value, f0, f1, t0, t1, stepValue) => {
      const x = asVec3(value), a = asVec3(f0), b = asVec3(f1), c = asVec3(t0), d = asVec3(t1), s = asVec3(stepValue);
      return [
        mapComponent(x[0], a[0], b[0], c[0], d[0], s[0]),
        mapComponent(x[1], a[1], b[1], c[1], d[1], s[1]),
        mapComponent(x[2], a[2], b[2], c[2], d[2], s[2]),
      ] as Vec3;
    });
    return { Vector: result, Result: result };
  }
  const v = api.field("Value"), fmin = api.field("From Min"), fmax = api.field("From Max"), tmin = api.field("To Min"), tmax = api.field("To Max"), steps = api.field("Steps");
  return {
    Result: fieldMap([v, fmin, fmax, tmin, tmax, steps], (a, b, c, d, e, stepValue) => {
      const x = num(a), b0 = num(b), b1 = num(c), t0 = num(d), t1 = num(e), stepCount = num(stepValue);
      const result = mapComponent(x, b0, b1, t0, t1, stepCount);
      // Blender's scalar linear Map Range is evaluated in float precision.
      // This is observable when a distance field drives marching-square case
      // thresholds, where one ULP can select a different edge intersection.
      return interp === "LINEAR" ? Math.fround(result) : result;
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
  // Blender's vector Mix is evaluated as float32 weighted products rather
  // than the algebraically equivalent double-precision a + t * (b - a).
  // The operation order matters for reversed mesh-edge endpoints: the two
  // orientations can intentionally land one ULP apart before Merge by Distance.
  const vectorMix = (t: number, a: number, b: number) => {
    const factor = Math.fround(clampF ? Math.max(0, Math.min(1, t)) : t);
    const inverse = Math.fround(1 - factor);
    return Math.fround(Math.fround(inverse * Math.fround(a)) + Math.fround(factor * Math.fround(b)));
  };
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
    return out(fieldMap([fac, a, b], (t, x, y) => { const u = asVec3(x), v = asVec3(y), tt = num(t); return [vectorMix(tt, u[0], v[0]), vectorMix(tt, u[1], v[1]), vectorMix(tt, u[2], v[2])] as Vec3; }));
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
