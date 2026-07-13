// Curve subsystem handlers: primitives, resample, fillet, sweep-to-mesh, fill.
import { Field, Vec3, Elem, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { Geometry, Mesh, Spline, buildTopology } from "../geometry";
import { DUMP_CONTEXT, reg } from "../registry";
import { makeFieldCtx } from "../evaluator";
import { resampleSpline, filletSpline, sweep, fillCurves, meshEdgesToChains, splineLength, splineFrames } from "../curves";

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

reg("GeometryNodeCurveArc", (api) => {
  const resolution = Math.max(2, Math.round(api.num("Resolution") || 16));
  const mode = api.prop<string>("mode", "RADIUS");
  if (mode !== "RADIUS") {
    // Three-points mode is retained as the authored polyline until a graph
    // requires its circumcircle outputs.
    const points = [api.vec("Start"), api.vec("Middle"), api.vec("End")];
    return { Curve: curveGeo([{ points, cyclic: false }]), Center: Field.of([0, 0, 0]), Normal: Field.of([0, 0, 1]), Radius: Field.of(0) };
  }
  const radius = api.num("Radius");
  const start = api.num("Start Angle");
  const sweep = api.num("Sweep Angle");
  const invert = api.bool("Invert Arc");
  const points: Vec3[] = [];
  for (let i = 0; i < resolution; i++) {
    const factor = i / (resolution - 1);
    const angle = start + sweep * (invert ? 1 - factor : factor);
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  const connect = api.bool("Connect Center");
  if (connect) points.push([0, 0, 0]);
  return {
    Curve: curveGeo([{ points, cyclic: connect }]),
    Center: Field.of([0, 0, 0]), Normal: Field.of([0, 0, 1]), Radius: Field.of(radius),
  };
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
      // Blender fits the largest whole number of segments at or below the
      // requested spacing, then includes both endpoints for open splines.
      const n = Math.max(1, Math.floor(splineLength(s) / Math.max(1e-9, length)));
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
    if (o.curvePointCount() !== geo.curvePointCount()) {
      const samplePointAttribute = (s: Spline, targets: Vec3[], values: Elem[]): Elem[] => targets.map((point) => {
        let bestDistance = Infinity;
        let best: Elem = values[0] ?? 0;
        const segmentCount = s.cyclic ? s.points.length : Math.max(0, s.points.length - 1);
        for (let i = 0; i < segmentCount; i++) {
          const j = (i + 1) % s.points.length;
          const a = s.points[i], delta = vsub(s.points[j], a);
          const denom = Math.max(1e-12, vdot(delta, delta));
          const t = Math.max(0, Math.min(1, vdot(vsub(point, a), delta) / denom));
          const distance = vlen(vsub(point, vadd(a, vscale(delta, t))));
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          const va = values[i] ?? values[0] ?? 0;
          const vb = values[j] ?? va;
          best = Array.isArray(va) || Array.isArray(vb)
            ? vnorm(vadd(vscale(asVec3(va), 1 - t), vscale(asVec3(vb), t)))
            : asNum(va) * (1 - t) + asNum(vb) * t;
        }
        return best;
      });
      o.curveAttributes.clear();
      for (const [name, attribute] of geo.curveAttributes) {
        if (attribute.domain !== "POINT") {
          o.curveAttributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
          continue;
        }
        const data: Elem[] = [];
        let offset = 0;
        for (let splineIndex = 0; splineIndex < geo.curves.length; splineIndex++) {
          const source = geo.curves[splineIndex];
          const values = attribute.data.slice(offset, offset + source.points.length);
          data.push(...samplePointAttribute(source, o.curves[splineIndex].points, values));
          offset += source.points.length;
        }
        o.curveAttributes.set(name, { domain: "POINT", data });
      }
      // Resample Curve outputs a poly spline. Blender derives its tangent frame
      // from that new polyline, and later Curve to Points interpolates this
      // frame instead of deriving a fresh chord from its coarser samples.
      const tangents: Vec3[] = [];
      const normals: Vec3[] = [];
      const rotate = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
        const c = Math.cos(angle), sn = Math.sin(angle);
        return vadd(vadd(vscale(v, c), vscale(vcross(axis, v), sn)), vscale(axis, vdot(axis, v) * (1 - c)));
      };
      for (const spline of o.curves) {
        const frames = splineFrames(spline.points, spline.cyclic);
        const localTangents = frames.map((frame) => frame.tangent);
        let normal = vcross(localTangents[0] ?? [0, 0, 1], [0, 0, 1]);
        if (vlen(normal) < 1e-8) normal = [1, 0, 0];
        normal = vnorm(normal);
        for (let i = 0; i < localTangents.length; i++) {
          if (i) {
            const axis = vcross(localTangents[i - 1], localTangents[i]);
            const sin = vlen(axis);
            if (sin > 1e-8) normal = rotate(normal, vscale(axis, 1 / sin), Math.atan2(sin, vdot(localTangents[i - 1], localTangents[i])));
            normal = vnorm(vsub(normal, vscale(localTangents[i], vdot(normal, localTangents[i]))));
          }
          tangents.push(localTangents[i]);
          normals.push(normal);
        }
      }
      o.curveAttributes.set("__curve_tangent", { domain: "POINT", data: tangents });
      o.curveAttributes.set("__curve_normal", { domain: "POINT", data: normals });
    }
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

reg("GeometryNodeReverseCurve", (api) => {
  const g = api.geo("Curve").clone();
  const ctx = makeFieldCtx(g, "CURVE");
  const selected = api.field("Selection").array(ctx);
  let pointOffset = 0;
  for (let splineIndex = 0; splineIndex < g.curves.length; splineIndex++) {
    const spline = g.curves[splineIndex];
    const count = spline.points.length;
    if (asNum(selected[splineIndex] ?? 1) > 0) {
      spline.points.reverse();
      for (const attribute of g.curveAttributes.values()) {
        if (attribute.domain !== "POINT") continue;
        const reversed = attribute.data.slice(pointOffset, pointOffset + count).reverse();
        attribute.data.splice(pointOffset, count, ...reversed);
      }
    }
    pointOffset += count;
  }
  return { Curve: g };
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
  const tangentAttribute = rail.curveAttributes.get("__curve_tangent")?.data;
  let flatBase = 0;
  for (const r of rail.curves) {
    const scales = scaleArr ? scaleArr.slice(flatBase, flatBase + r.points.length) : undefined;
    const tangentOverrides = tangentAttribute?.slice(flatBase, flatBase + r.points.length).map(asVec3);
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
      if (r.points.length === 1) {
        // Blender retains one transformed profile ring for an isolated curve
        // point. It has vertices but no faces; downstream Bounding Box nodes
        // still use it to size grids (Soft Pixel Marker relies on this).
        const center = r.points[0];
        const scale = scales?.[0] ?? 1;
        for (const point of p.points) mesh.positions.push([
          center[0] + point[0] * scale,
          center[1] + point[1] * scale,
          center[2] + point[2] * scale,
        ]);
        continue;
      }
      const sm = sweep(r, p, caps, scales, tangentOverrides);
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
  const fillGeometry = (source: Geometry, instancePayload = false): Geometry => {
    const out = new Geometry();
    // Blender's Fill Curve operates in the curve component's local XY plane;
    // Z is discarded rather than carried through from the control points. This
    // matters when a translated mesh is converted to curves before filling (the
    // Dojo bin deliberately moves its source grid to z=-0.019, then Fill Curve
    // creates the bin floors back at z=0).
    const planar = source.curves.map((s) => {
      let points = s.points.map((p) => [p[0], p[1], 0] as Vec3);
      if (s.cyclic && points.length >= 3) {
        let area2 = 0;
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          area2 += a[0] * b[1] - b[0] * a[1];
        }
        // Fill Curve emits front-facing (+Z) polygons for local-XY loops even
        // when Mesh to Curve supplied the boundary in clockwise order.
        if (area2 < 0) points = [points[0], ...points.slice(1).reverse()];
      }
      return { cyclic: s.cyclic, points };
    });
    if (planar.length) {
      if (instancePayload && mode === "NGONS") {
        // Fill Curve preserves String to Curves' glyph instances. In N-gon
        // mode Blender emits one face for every cyclic outline inside each
        // instance (including counter-wound inner outlines); it does not bridge
        // those loops into a triangulated hole until the instances are realized
        // before filling.
        const mesh = new Mesh();
        mesh.materialSlots = [null];
        for (const spline of planar) {
          if (!spline.cyclic || spline.points.length < 3) continue;
          const base = mesh.positions.length;
          mesh.positions.push(...spline.points.map((point) => [...point] as Vec3));
          mesh.faces.push(spline.points.map((_, index) => base + index));
          mesh.faceMaterial.push(0);
        }
        out.mesh = mesh;
      } else {
        out.mesh = fillCurves(planar, mode);
      }
    }
    // String to Curves outputs one curve instance per glyph. Fill Curve keeps
    // those instances and fills each payload in local space; dropping them made
    // the Node Dojo Typewriter animate strings internally but output no text.
    out.instances = source.instances.map((instance) => ({ ...instance, geometry: fillGeometry(instance.geometry, true) }));
    return out;
  };
  return { Mesh: fillGeometry(g) };
});

// ---- mesh -> curve --------------------------------------------------------
reg("GeometryNodeMeshToCurve", (api) => {
  const g = api.geo("Mesh");
  const out = new Geometry();
  if (!g.mesh) return { Curve: out };
  let source = g.mesh;
  const selectionLinked = api.node.inputs.find((s) => s.identifier === "Selection")?.linked ?? false;
  if (selectionLinked) {
    const ctx = makeFieldCtx(g, "EDGE");
    const selected = api.field("Selection").array(ctx);
    const topology = buildTopology(g.mesh);
    const filtered = new Mesh();
    filtered.positions = g.mesh.positions.map((p) => [...p] as Vec3);
    filtered.edges = topology.edges
      .filter((_, i) => asNum(selected[i] ?? 0) > 0)
      .map((edge) => [...edge.verts] as [number, number]);
    filtered.materialSlots = [...g.mesh.materialSlots];
    filtered.attributes = new Map([...g.mesh.attributes].filter(([, attr]) => attr.domain === "POINT"));
    source = filtered;
  }
  const chains = meshEdgesToChains(source);
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

reg("GeometryNodeCurveStar", (api) => {
  const count = Math.max(2, Math.round(api.num("Points") || 8));
  const inner = api.num("Inner Radius");
  const outer = api.num("Outer Radius");
  const twist = api.num("Twist");
  const points: Vec3[] = [];
  for (let i = 0; i < count * 2; i++) {
    const isOuter = i % 2 === 0;
    const angle = twist + (i / (count * 2)) * Math.PI * 2;
    const radius = isOuter ? outer : inner;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  return {
    Curve: curveGeo([{ points, cyclic: true }]),
    "Outer Points": Field.perElem((i) => i % 2 === 0 ? 1 : 0).tagged("POINT"),
  };
});

reg("GeometryNodeCurveEndpointSelection", (api) => {
  const startN = Math.max(0, Math.round(api.num("Start Size")));
  const endN = Math.max(0, Math.round(api.num("End Size")));
  return {
    Selection: Field.perElem((i, ctx) => (i < startN || i >= ctx.size - endN ? 1 : 0)),
  };
});

// ---- String to Curves (minimal polyline font) -----------------------------
// Produces one curve-instance per character. Glyph outlines are simplified
// unit-height strokes (not Blender font fidelity) but yield non-empty curves.

/** Unit-box (x∈[0,0.6], y∈[0,1]) stroke polylines for common glyphs. */
const GLYPHS: Record<string, Vec3[][]> = (() => {
  const g: Record<string, Vec3[][]> = {};
  const L = (pts: number[][]): Vec3[] => pts.map((p) => [p[0], p[1], 0] as Vec3);
  // Digits
  g["0"] = [L([[0.05, 0], [0.55, 0], [0.55, 1], [0.05, 1], [0.05, 0]])];
  g["1"] = [L([[0.15, 0.8], [0.3, 1], [0.3, 0]])];
  g["2"] = [L([[0.05, 1], [0.55, 1], [0.55, 0.5], [0.05, 0.5], [0.05, 0], [0.55, 0]])];
  g["3"] = [L([[0.05, 1], [0.55, 1], [0.55, 0.5], [0.2, 0.5], [0.55, 0.5], [0.55, 0], [0.05, 0]])];
  g["4"] = [L([[0.05, 1], [0.05, 0.5], [0.55, 0.5]]), L([[0.45, 1], [0.45, 0]])];
  g["5"] = [L([[0.55, 1], [0.05, 1], [0.05, 0.5], [0.55, 0.5], [0.55, 0], [0.05, 0]])];
  g["6"] = [L([[0.55, 1], [0.05, 1], [0.05, 0], [0.55, 0], [0.55, 0.5], [0.05, 0.5]])];
  g["7"] = [L([[0.05, 1], [0.55, 1], [0.2, 0]])];
  g["8"] = [L([[0.05, 0], [0.55, 0], [0.55, 0.5], [0.05, 0.5], [0.05, 1], [0.55, 1], [0.55, 0.5], [0.05, 0.5], [0.05, 0]])];
  g["9"] = [L([[0.05, 0], [0.55, 0], [0.55, 1], [0.05, 1], [0.05, 0.5], [0.55, 0.5]])];
  // Letters (uppercase + map lowercase)
  g["A"] = [L([[0, 0], [0.3, 1], [0.6, 0]]), L([[0.12, 0.4], [0.48, 0.4]])];
  g["B"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.5, 0.75], [0.4, 0.5], [0.05, 0.5], [0.45, 0.5], [0.55, 0.25], [0.45, 0], [0.05, 0]])];
  g["C"] = [L([[0.55, 0.85], [0.4, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0], [0.4, 0], [0.55, 0.15]])];
  g["D"] = [L([[0.05, 0], [0.05, 1], [0.35, 1], [0.55, 0.7], [0.55, 0.3], [0.35, 0], [0.05, 0]])];
  g["E"] = [L([[0.55, 1], [0.05, 1], [0.05, 0], [0.55, 0]]), L([[0.05, 0.5], [0.4, 0.5]])];
  g["F"] = [L([[0.05, 0], [0.05, 1], [0.55, 1]]), L([[0.05, 0.5], [0.4, 0.5]])];
  g["G"] = [L([[0.55, 0.85], [0.4, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0], [0.4, 0], [0.55, 0.2], [0.55, 0.45], [0.3, 0.45]])];
  g["H"] = [L([[0.05, 0], [0.05, 1]]), L([[0.55, 0], [0.55, 1]]), L([[0.05, 0.5], [0.55, 0.5]])];
  g["I"] = [L([[0.15, 1], [0.45, 1]]), L([[0.3, 1], [0.3, 0]]), L([[0.15, 0], [0.45, 0]])];
  g["J"] = [L([[0.1, 1], [0.5, 1], [0.5, 0.25], [0.35, 0], [0.15, 0], [0.05, 0.15]])];
  g["K"] = [L([[0.05, 0], [0.05, 1]]), L([[0.55, 1], [0.05, 0.5], [0.55, 0]])];
  g["L"] = [L([[0.05, 1], [0.05, 0], [0.55, 0]])];
  g["M"] = [L([[0, 0], [0, 1], [0.3, 0.4], [0.6, 1], [0.6, 0]])];
  g["N"] = [L([[0.05, 0], [0.05, 1], [0.55, 0], [0.55, 1]])];
  g["O"] = [L([[0.1, 0], [0.5, 0], [0.6, 0.2], [0.6, 0.8], [0.5, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0]])];
  g["P"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.55, 0.75], [0.4, 0.5], [0.05, 0.5]])];
  g["Q"] = [L([[0.1, 0.15], [0.5, 0.15], [0.6, 0.35], [0.6, 0.8], [0.5, 1], [0.1, 1], [0, 0.8], [0, 0.35], [0.1, 0.15]]), L([[0.35, 0.35], [0.6, 0]])];
  g["R"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.55, 0.75], [0.4, 0.5], [0.05, 0.5], [0.3, 0.5], [0.55, 0]])];
  g["S"] = [L([[0.55, 0.85], [0.4, 1], [0.15, 1], [0.05, 0.8], [0.15, 0.55], [0.45, 0.45], [0.55, 0.2], [0.4, 0], [0.1, 0], [0.05, 0.15]])];
  g["T"] = [L([[0, 1], [0.6, 1]]), L([[0.3, 1], [0.3, 0]])];
  g["U"] = [L([[0.05, 1], [0.05, 0.2], [0.15, 0], [0.45, 0], [0.55, 0.2], [0.55, 1]])];
  g["V"] = [L([[0, 1], [0.3, 0], [0.6, 1]])];
  g["W"] = [L([[0, 1], [0.15, 0], [0.3, 0.5], [0.45, 0], [0.6, 1]])];
  g["X"] = [L([[0, 1], [0.6, 0]]), L([[0.6, 1], [0, 0]])];
  g["Y"] = [L([[0, 1], [0.3, 0.5], [0.6, 1]]), L([[0.3, 0.5], [0.3, 0]])];
  g["Z"] = [L([[0.05, 1], [0.55, 1], [0.05, 0], [0.55, 0]])];
  g["."] = [L([[0.25, 0], [0.35, 0], [0.35, 0.1], [0.25, 0.1], [0.25, 0]])];
  g[":"] = [L([[0.25, 0.2], [0.35, 0.2], [0.35, 0.3], [0.25, 0.3], [0.25, 0.2]]), L([[0.25, 0.7], [0.35, 0.7], [0.35, 0.8], [0.25, 0.8], [0.25, 0.7]])];
  g["-"] = [L([[0.1, 0.5], [0.5, 0.5]])];
  g["/"] = [L([[0.1, 0], [0.5, 1]])];
  g[" "] = [];
  // lowercase aliases
  for (const k of Object.keys(g)) {
    if (k.length === 1 && k >= "A" && k <= "Z") g[k.toLowerCase()] = g[k];
  }
  return g;
})();

function glyphGeometry(ch: string, size: number): Geometry {
  const fallback: Vec3[][] = [[[0.05, 0, 0], [0.55, 0, 0], [0.55, 1, 0], [0.05, 1, 0], [0.05, 0, 0]]];
  const polys: Vec3[][] = GLYPHS[ch] ?? fallback;
  const g = new Geometry();
  const stroke = .065 * size;
  for (const raw of polys) {
    const pts = raw.map((p) => [p[0] * size, p[1] * size, 0] as Vec3);
    const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1e-9 * Math.max(size, 1e-9);
    if (closed) {
      g.curves.push({ cyclic: true, points: pts.slice(0, -1) });
      continue;
    }
    // Blender fonts output closed outline curves. The portable glyph table is
    // stored as compact centerline strokes, so expand each segment to a thin
    // closed quad before Fill Curve consumes it.
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (length < 1e-12) continue;
      const nx = -dy / length * stroke, ny = dx / length * stroke;
      g.curves.push({ cyclic: true, points: [
        [a[0] + nx, a[1] + ny, 0], [b[0] + nx, b[1] + ny, 0],
        [b[0] - nx, b[1] - ny, 0], [a[0] - nx, a[1] - ny, 0],
      ] });
    }
  }
  return g;
}

function atlasGlyphGeometry(fontName: string | undefined, ch: string, size: number): Geometry | null {
  const entry = fontName ? DUMP_CONTEXT.fonts[fontName]?.glyphs[ch] : undefined;
  if (!entry) return null;
  const geometry = new Geometry();
  geometry.curves = entry.curves.map((curve) => ({
    cyclic: curve.cyclic,
    points: curve.points.map((point) => [Number(point[0] ?? 0) * size, Number(point[1] ?? 0) * size, Number(point[2] ?? 0) * size] as Vec3),
  }));
  return geometry;
}

reg("GeometryNodeStringToCurves", (api) => {
  const text = api.str("String") || "";
  const size = api.num("Size") || 1;
  const charSpacing = api.num("Character Spacing");
  // Blender: character spacing multiplies the advance; 1.0 is default full advance.
  // Values < 1 pack tighter (bin uses 0.17–0.39). Treat as advance scale with a
  // floor so tiny values still separate glyphs.
  const advanceScale = charSpacing > 0 ? charSpacing : 1;
  const wordSpacing = api.num("Word Spacing") || 1;
  const lineSpacing = api.num("Line Spacing") || 1;
  const textBoxWidth = Math.max(0, api.num("Text Box Width"));
  const alignX = (api.str("Align X") || api.prop<string>("align_x", "LEFT") || "LEFT").toUpperCase();
  const alignY = api.str("Align Y") || "Top Baseline";
  const fontName = api.ref("Font")?.name;
  const atlas = fontName ? DUMP_CONTEXT.fonts[fontName] : undefined;
  const alignYOffset = size * (atlas?.align_offsets?.[alignY] ?? 0);
  const inkWidths = new Map<string, number>();
  const inkWidthOf = (ch: string): number => {
    const cached = inkWidths.get(ch);
    if (cached !== undefined) return cached;
    const curves = atlas?.glyphs[ch]?.curves ?? [];
    let min = Infinity, max = -Infinity;
    for (const curve of curves) for (const point of curve.points) {
      min = Math.min(min, Number(point[0] ?? 0));
      max = Math.max(max, Number(point[0] ?? 0));
    }
    // Use the forward ink extent from the glyph origin. A negative left-side
    // overhang does not push the following glyph to the right in Blender.
    const width = Number.isFinite(min) && Number.isFinite(max) ? Math.max(0, max) : 0;
    inkWidths.set(ch, width);
    return width;
  };
  const advanceOf = (ch: string) => {
    const base = size * (atlas?.glyphs[ch]?.advance ?? .7) * (ch === " " ? wordSpacing : 1);
    if (advanceScale <= 1 || !atlas) return base * advanceScale;
    // Blender compresses using the full advance below 1.0, but extra spacing
    // above 1.0 is based on the glyph's visible ink width. This preserves
    // overhanging fonts and does not add character spacing to blank spaces.
    return base + size * inkWidthOf(ch) * (advanceScale - 1);
  };

  const wrapLine = (line: string): string[] => {
    if (textBoxWidth <= 0 || !line.includes(" ")) return [line];
    const words = line.split(" ");
    const wrapped: string[] = [];
    let current = "";
    let currentWidth = 0;
    const spaceWidth = advanceOf(" ");
    for (const word of words) {
      // Blender wraps only at word boundaries. A word wider than the text box
      // remains intact on its own line instead of being split into glyphs.
      const wordWidth = [...word].reduce((total, ch) => total + advanceOf(ch), 0);
      if (current && currentWidth + spaceWidth + wordWidth > textBoxWidth) {
        // Wrapping changes layout, but Blender keeps the separator as an empty
        // character instance in the domain. Preserve it at the end of the
        // previous line so downstream indexing follows the original string.
        wrapped.push(`${current} `);
        current = word;
        currentWidth = wordWidth;
      } else if (current) {
        current += ` ${word}`;
        currentWidth += spaceWidth + wordWidth;
      } else {
        current = word;
        currentWidth = wordWidth;
      }
    }
    wrapped.push(current);
    return wrapped;
  };
  const lines = text.split("\n").flatMap(wrapLine);
  const out = new Geometry();
  const cellH = size * lineSpacing;
  const blockHeight = Math.max(0, lines.length - 1) * cellH;
  const alignYKey = alignY.toUpperCase().replace(/[^A-Z]/g, "");
  const blockOffset = alignYKey === "MIDDLE" || alignYKey === "CENTER"
    ? blockHeight / 2
    : alignYKey.startsWith("BOTTOM") ? blockHeight : 0;

  let lineIdx = 0;
  for (const line of lines) {
    const chars = [...line];
    // measure line width for alignment
    let lineWidth = 0;
    for (const ch of chars) {
      lineWidth += advanceOf(ch);
    }
    let x = 0;
    if (alignX === "CENTER") x = -lineWidth / 2;
    else if (alignX === "RIGHT") x = -lineWidth;
    const y = alignYOffset + blockOffset - lineIdx * cellH;
    for (const ch of chars) {
      // Blender keeps whitespace as an empty instance. It has no visible
      // curves, but it remains part of the instance domain and therefore of
      // Pick Instance indexing. Text Soup maps "YOUR TEXT HERE" onto 14 guide
      // points and relies on the two empty space entries staying in the list.
      const glyph = atlasGlyphGeometry(fontName, ch, size) ?? glyphGeometry(ch, size);
      out.instances.push({
        geometry: glyph,
        position: [x, y, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      x += advanceOf(ch);
    }
    lineIdx++;
  }
  // Also expose flattened curves for consumers that expect Curve geometry
  // (realize is typically applied downstream via Instance on Points / realize).
  return {
    "Curve Instances": out,
    Curve: out, // alias some dumps may read
    Remainder: "",
    Line: Field.of(0),
    "Pivot Point": Field.of([0, 0, 0] as Vec3),
  };
});
