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
  const fillGeometry = (source: Geometry): Geometry => {
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
    if (planar.length) out.mesh = fillCurves(planar, mode);
    // String to Curves outputs one curve instance per glyph. Fill Curve keeps
    // those instances and fills each payload in local space; dropping them made
    // the Node Dojo Typewriter animate strings internally but output no text.
    out.instances = source.instances.map((instance) => ({ ...instance, geometry: fillGeometry(instance.geometry) }));
    return out;
  };
  return { Mesh: fillGeometry(g) };
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
  const alignX = (api.prop<string>("align_x", "LEFT") || "LEFT").toUpperCase();

  const lines = text.split("\n");
  const out = new Geometry();
  const cellW = size * 0.7;
  const cellH = size * 1.2 * lineSpacing;

  let lineIdx = 0;
  for (const line of lines) {
    const chars = [...line];
    // measure line width for alignment
    let lineWidth = 0;
    for (const ch of chars) {
      if (ch === " ") lineWidth += cellW * wordSpacing;
      else lineWidth += cellW * advanceScale;
    }
    let x = 0;
    if (alignX === "CENTER") x = -lineWidth / 2;
    else if (alignX === "RIGHT") x = -lineWidth;
    const y = -lineIdx * cellH;
    for (const ch of chars) {
      if (ch === " ") {
        x += cellW * wordSpacing;
        continue;
      }
      const glyph = glyphGeometry(ch, size);
      out.instances.push({
        geometry: glyph,
        position: [x, y, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      x += cellW * advanceScale;
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
