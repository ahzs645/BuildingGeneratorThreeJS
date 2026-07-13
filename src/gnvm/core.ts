// GN-VM core value model.
//
// Blender geometry-nodes semantics that matter here:
//  - A socket carries either a *concrete* thing (Geometry, a material ref, a string)
//    or a *field*: a lazy per-element computation resolved against a geometry domain.
//  - Number/Int/Bool/Vector/Color/Rotation sockets are modelled as Fields (constants
//    are just fields that ignore context). Geometry sockets carry a Geometry.
//
// A Field yields one Elem per domain element when evaluated in a FieldCtx.

export type Vec3 = [number, number, number];
export type Elem = number | Vec3;

export type Domain = "POINT" | "EDGE" | "FACE" | "CORNER" | "CURVE" | "INSTANCE";

export const isVec3 = (e: Elem): e is Vec3 => Array.isArray(e);

// ---- vector helpers -------------------------------------------------------
export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-12 ? vscale(a, 1 / l) : [0, 0, 0];
};
export const asVec3 = (e: Elem): Vec3 => (isVec3(e) ? e : [e, e, e]);
export const asNum = (e: Elem): number => (isVec3(e) ? e[0] : e);

// ---- fields ---------------------------------------------------------------

// Context handed to a field so it can resolve per-element values.
export interface FieldCtx {
  size: number; // number of elements in the target domain
  domain: Domain;
  component?: "MESH" | "CURVE" | "INSTANCE" | "EMPTY";
  // Same geometry evaluated on another domain, for nodes like Field at Index.
  fork?: (domain: Domain) => FieldCtx;
  // Map element i of this ctx's domain from an array resolved on another domain
  // (Blender's implicit attribute interpolation).
  toDomain?: (src: Domain, arr: (Elem | undefined)[], i: number) => Elem | undefined;
  // Per-element intrinsic accessors, supplied by the geometry being evaluated.
  position?: (i: number) => Vec3;
  normal?: (i: number) => Vec3;
  index?: (i: number) => number;
  // Named/anonymous attribute lookup on the current domain.
  attr?: (name: string, i: number) => Elem | undefined;
  // Mesh-topology queries (populated when the geometry is a mesh).
  faceVertCount?: (i: number) => number; // verts in face i (FACE domain)
  faceNeighborCount?: (i: number) => number; // faces sharing an edge with face i
  edgeVerts?: (i: number) => [number, number]; // endpoints of edge i (EDGE domain)
  edgeFaceCount?: (i: number) => number; // faces using edge i
  edgeAngle?: (i: number, signed?: boolean) => number; // angle between adjacent face normals
  islandIndex?: (i: number) => number; // connected-component id of element i
  islandCount?: () => number; // number of connected components
  // Curve spline queries (for SplineParameter): index/factor WITHIN each spline.
  splineIndex?: (i: number) => number;
  splineFactor?: (i: number) => number;
  splineCyclic?: (i: number) => boolean;
  splineLength?: (i: number) => number;
  splinePointCount?: (i: number) => number;
  splineResolution?: (i: number) => number;
  // Explicit neighborhood on the active domain (Blur Attribute).
  neighbors?: (i: number) => number[];
}

export class Field {
  // Source-domain tag for anonymous masks (CaptureAttribute outputs, extrude
  // Top/Side). Blender evaluates a boolean chain of FACE attributes ON the face
  // domain and converts only the FINAL mask to the consumer domain; converting
  // each leaf first excludes boundary verts (NOT(anyAdjacent) != noneAdjacent).
  // Tags propagate through fieldMap when all non-const inputs agree.
  srcDomain?: Domain;

  private constructor(
    public readonly fn: (ctx: FieldCtx) => Elem[],
    public readonly constant?: Elem,
  ) {}
  private readonly resolved = new WeakMap<FieldCtx, Elem[]>();

  static of(v: Elem): Field {
    return new Field(() => [], v);
  }
  // A field defined element-wise.
  static make(fn: (ctx: FieldCtx) => Elem[]): Field {
    return new Field(fn);
  }
  // A field whose value at element i is computed from i + ctx.
  static perElem(fn: (i: number, ctx: FieldCtx) => Elem): Field {
    return new Field((ctx) => {
      const out: Elem[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) out[i] = fn(i, ctx);
      return out;
    });
  }

  tagged(domain: Domain): Field {
    this.srcDomain = domain;
    return this;
  }

  get isConst(): boolean {
    return this.constant !== undefined;
  }

  // Resolve to an array of length ctx.size.
  array(ctx: FieldCtx): Elem[] {
    if (this.constant !== undefined) {
      const c = this.constant;
      const out: Elem[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) out[i] = c;
      return out;
    }
    const cached = this.resolved.get(ctx);
    if (cached) return cached;
    const result = this.fn(ctx);
    this.resolved.set(ctx, result);
    return result;
  }

  // Constant fast-path read (throws if not constant).
  get value(): Elem {
    if (this.constant === undefined) throw new Error("Field is not constant");
    return this.constant;
  }
}

// Element-wise combine of N fields; folds to a constant when all inputs are const.
export function fieldMap(inputs: Field[], op: (...vals: Elem[]) => Elem): Field {
  if (inputs.every((f) => f.isConst)) {
    return Field.of(op(...inputs.map((f) => f.value)));
  }
  const out = Field.make((ctx) => {
    const arrs = inputs.map((f) => f.array(ctx));
    const res: Elem[] = new Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) res[i] = op(...arrs.map((a) => a[i]));
    return res;
  });
  // propagate the source-domain tag when every varying input agrees
  const domains = new Set(inputs.filter((f) => !f.isConst).map((f) => f.srcDomain));
  if (domains.size === 1) {
    const d = [...domains][0];
    if (d) out.srcDomain = d;
  }
  return out;
}
