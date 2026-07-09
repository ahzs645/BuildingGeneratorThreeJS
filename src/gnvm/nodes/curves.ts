// Curve subsystem handlers: primitives, resample, fillet, sweep-to-mesh, fill.
import { Field, Vec3, Elem, asNum } from "../core";
import { Geometry, Mesh, Spline } from "../geometry";
import { reg } from "../registry";
import { makeFieldCtx } from "../evaluator";
import { resampleSpline, filletSpline, sweep, fillCurves, meshEdgesToChains, splineLength } from "../curves";

function curveGeo(splines: Spline[]): Geometry {
  const g = new Geometry();
  g.curves = splines;
  return g;
}

// ---- primitives -----------------------------------------------------------
reg("GeometryNodeCurvePrimitiveQuadrilateral", (api) => {
  const w = (api.num("Width") || 1) / 2;
  const h = (api.num("Height") || 1) / 2;
  // Blender's rectangle mode starts on the positive-height edge. Edge index 0
  // must be the +Y side for downstream EDGE Index selections (the drawer handle
  // deletes edge 0 to open its rail on the back side).
  const pts: Vec3[] = [[w, h, 0], [-w, h, 0], [-w, -h, 0], [w, -h, 0]];
  return { Curve: curveGeo([{ points: pts, cyclic: true }]) };
});

reg("GeometryNodeCurvePrimitiveCircle", (api) => {
  const res = Math.max(3, Math.floor(api.num("Resolution") || 32));
  const r = api.num("Radius") || 1;
  const pts: Vec3[] = [];
  for (let i = 0; i < res; i++) {
    const a = (i / res) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  return { Curve: curveGeo([{ points: pts, cyclic: true }]), Center: Field.of([0, 0, 0]) };
});

reg("GeometryNodeCurvePrimitiveLine", (api) => {
  const s = api.vec("Start");
  const e = api.vec("End");
  return { Curve: curveGeo([{ points: [s, e], cyclic: false }]) };
});

// ---- resample / fillet ----------------------------------------------------
reg("GeometryNodeResampleCurve", (api) => {
  const g = api.geo("Curve");
  // Blender 4+/5 exposes the mode as a menu input socket; older dumps use a prop.
  const menu = api.str("Mode").toUpperCase().replace(/[^A-Z]/g, "");
  const mode = menu || api.prop<string>("mode", "COUNT");
  // Blender's implicit float->int socket conversion rounds (148.6 -> 149).
  const count = Math.round(api.num("Count")) || 10;
  const length = api.num("Length") || 0.1;
  const resampleOne = (s: Spline): Spline => {
    if (mode === "EVALUATED") return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
    if (mode === "LENGTH") {
      // segments of ~`length`: n = max(1, round(total/length)) segments
      const n = Math.max(1, Math.round(splineLength(s) / Math.max(1e-9, length)));
      return resampleSpline(s, s.cyclic ? n : n + 1);
    }
    return resampleSpline(s, count);
  };
  // Resample applies to real curves AND to curves inside instances — measured
  // against Blender: the vase's 58 instanced profile copies come out at
  // Count=19 points each (551-pt proximity target), not their original 149.
  const resampleGeo = (geo: Geometry, seen: Map<Geometry, Geometry>): Geometry => {
    const cached = seen.get(geo);
    if (cached) return cached;
    const o = geo.clone();
    seen.set(geo, o);
    o.curves = geo.curves.map(resampleOne);
    if (o.curvePointCount() !== geo.curvePointCount()) o.curveAttributes.clear();
    o.instances = geo.instances.map((inst) => ({ ...inst, geometry: resampleGeo(inst.geometry, seen) }));
    return o;
  };
  return { Curve: resampleGeo(g, new Map()) };
});

reg("GeometryNodeFilletCurve", (api) => {
  const g = api.geo("Curve");
  const radius = api.num("Radius");
  const count = api.num("Count") || 1;
  const limit = api.bool("Limit Radius");
  const out = new Geometry();
  out.curves = g.curves.map((s) => filletSpline(s, radius, count, limit));
  return { Curve: out };
});

reg("GeometryNodeSetSplineCyclic", (api) => {
  const g = api.geo("Geometry").clone();
  const cyclic = api.bool("Cyclic");
  for (const s of g.curves) s.cyclic = cyclic;
  return { Geometry: g };
});

// ---- curve -> mesh --------------------------------------------------------
reg("GeometryNodeCurveToMesh", (api) => {
  const rail = api.geo("Curve");
  const prof = api.geo("Profile Curve");
  const caps = api.bool("Fill Caps");
  // Blender 5 "Scale": per-rail-point profile scale (the curve radius mechanism).
  // Resolved on the rail's flattened POINT domain; unlinked non-1 constants apply
  // uniformly. Requires NamedAttribute.Exists to be real — the handle drives this
  // with Switch(Exists("radius") ? radius : 1).
  const scaleLinked = api.node.inputs.find((s) => s.identifier === "Scale")?.linked ?? false;
  let scaleArr: number[] | null = null;
  if (scaleLinked) {
    const ctx = makeFieldCtx(rail, "POINT");
    scaleArr = api.field("Scale").array(ctx).map((v) => asNum(v ?? 1));
  } else {
    const u = api.num("Scale");
    if (u && u !== 1) scaleArr = rail.curves.flatMap((s) => s.points.map(() => u));
  }
  const out = new Geometry();
  const mesh = new Mesh();
  mesh.materialSlots = [null];
  const profiles = prof.curves;
  let flatBase = 0;
  for (const r of rail.curves) {
    const scales = scaleArr ? scaleArr.slice(flatBase, flatBase + r.points.length) : undefined;
    flatBase += r.points.length;
    if (!profiles.length) {
      // no profile: emit the rail as an edge-only wire
      const base = mesh.positions.length;
      for (const p of r.points) mesh.positions.push([...p] as Vec3);
      for (let i = 0; i + 1 < r.points.length; i++) mesh.edges.push([base + i, base + i + 1]);
      if (r.cyclic && r.points.length > 2) mesh.edges.push([base + r.points.length - 1, base]);
      continue;
    }
    for (const p of profiles) {
      const sm = sweep(r, p, caps, scales);
      const base = mesh.positions.length;
      for (const pos of sm.positions) mesh.positions.push(pos);
      for (let fi = 0; fi < sm.faces.length; fi++) { mesh.faces.push(sm.faces[fi].map((v) => v + base)); mesh.faceMaterial.push(0); }
    }
  }
  out.mesh = mesh;
  return { Mesh: out };
});

reg("GeometryNodeFillCurve", (api) => {
  const g = api.geo("Curve");
  // Blender 4+/5 exposes the mode as a menu input socket ("N-gons"/"Triangles");
  // older dumps carry it as a `mode` prop.
  const menu = api.str("Mode").toUpperCase().replace(/[^A-Z]/g, "");
  const mode = (menu === "NGONS" || menu === "TRIANGLES" ? menu : api.prop<string>("mode", "TRIANGLES")) as "NGONS" | "TRIANGLES";
  const out = new Geometry();
  out.mesh = fillCurves(g.curves, mode);
  return { Mesh: out };
});

// ---- mesh -> curve --------------------------------------------------------
reg("GeometryNodeMeshToCurve", (api) => {
  const g = api.geo("Mesh");
  const out = new Geometry();
  if (!g.mesh) return { Curve: out };
  const chains = meshEdgesToChains(g.mesh);
  out.curves = chains.map((c) => c.spline);
  // carry the mesh's POINT attributes onto the flattened curve control points
  const pointAttrs = [...g.mesh.attributes].filter(([, a]) => a.domain === "POINT");
  for (const [name, a] of pointAttrs) {
    const data: any[] = [];
    for (const c of chains) for (const vi of c.verts) data.push(a.data[vi]);
    out.curveAttributes.set(name, { domain: "POINT", data });
  }
  // FACE attributes captured before Mesh to Curve are sampled onto the emitted
  // control points. The subdivision graph stores its X/Y split factors this way.
  const faceAttrs = [...g.mesh.attributes].filter(([, a]) => a.domain === "FACE");
  if (faceAttrs.length) {
    const pointFaces: number[][] = g.mesh.positions.map(() => []);
    for (let fi = 0; fi < g.mesh.faces.length; fi++) for (const vi of g.mesh.faces[fi]) pointFaces[vi]?.push(fi);
    for (const [name, a] of faceAttrs) {
      const data: Elem[] = [];
      for (const c of chains) for (const vi of c.verts) data.push(avgElems(pointFaces[vi]?.map((fi) => a.data[fi])));
      out.curveAttributes.set(name, { domain: "POINT", data });
    }
  }
  return { Curve: out };
});

function avgElems(vals: (Elem | undefined)[] | undefined): Elem {
  if (!vals?.length) return 0;
  const first = vals.find((v) => v !== undefined);
  if (Array.isArray(first)) {
    const acc: Vec3 = [0, 0, 0];
    let n = 0;
    for (const v of vals) if (Array.isArray(v)) { acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2]; n++; }
    return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : [0, 0, 0];
  }
  let s = 0, n = 0;
  for (const v of vals) if (typeof v === "number") { s += v; n++; }
  return n ? s / n : 0;
}

reg("GeometryNodeCurveLength", (api) => {
  const g = api.geo("Curve");
  let L = 0;
  for (const s of g.curves) L += splineLength(s);
  return { Length: Field.of(L) };
});

// ---- curve field inputs (light) ------------------------------------------
reg("GeometryNodeSplineParameter", () => ({
  Factor: Field.perElem((i, ctx) => (ctx.splineFactor ? ctx.splineFactor(i) : 0)),
  Length: Field.perElem((i, ctx) => (ctx.splineFactor ? ctx.splineFactor(i) : 0)),
  Index: Field.perElem((i, ctx) => (ctx.splineIndex ? ctx.splineIndex(i) : i)),
}));

reg("GeometryNodeCurveEndpointSelection", (api) => {
  const startN = Math.max(0, Math.round(api.num("Start Size")));
  const endN = Math.max(0, Math.round(api.num("End Size")));
  return {
    Selection: Field.perElem((i, ctx) => (i < startN || i >= ctx.size - endN ? 1 : 0)),
  };
});
