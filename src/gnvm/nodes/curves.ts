// Curve subsystem handlers: primitives, resample, fillet, sweep-to-mesh, fill.
import { Field, Vec3 } from "../core";
import { Geometry, Mesh, Spline } from "../geometry";
import { reg } from "../registry";
import { resampleSpline, filletSpline, sweep, fillCurves, meshEdgesToChains } from "../curves";

function curveGeo(splines: Spline[]): Geometry {
  const g = new Geometry();
  g.curves = splines;
  return g;
}

// ---- primitives -----------------------------------------------------------
reg("GeometryNodeCurvePrimitiveQuadrilateral", (api) => {
  const w = (api.num("Width") || 1) / 2;
  const h = (api.num("Height") || 1) / 2;
  const pts: Vec3[] = [[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]];
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
  const mode = api.prop<string>("mode", "COUNT");
  const count = api.num("Count") || 10;
  const out = new Geometry();
  out.curves = g.curves.map((s) => (mode === "EVALUATED" ? { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic } : resampleSpline(s, count)));
  return { Curve: out };
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
  const out = new Geometry();
  const mesh = new Mesh();
  mesh.materialSlots = [null];
  const profiles = prof.curves;
  for (const r of rail.curves) {
    if (!profiles.length) {
      // no profile: emit the rail as an edge-only wire
      const base = mesh.positions.length;
      for (const p of r.points) mesh.positions.push([...p] as Vec3);
      for (let i = 0; i + 1 < r.points.length; i++) mesh.edges.push([base + i, base + i + 1]);
      if (r.cyclic && r.points.length > 2) mesh.edges.push([base + r.points.length - 1, base]);
      continue;
    }
    for (const p of profiles) {
      const sm = sweep(r, p, caps);
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
  const mode = (api.prop<string>("mode", "TRIANGLES") as "NGONS" | "TRIANGLES");
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
  return { Curve: out };
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
