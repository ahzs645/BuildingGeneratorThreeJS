import { Elem, Field, FieldCtx, Vec3, asNum } from "../core";
import { Geometry, realizeInstances } from "../geometry";
import { makeFieldCtx } from "../evaluator";
import { reg } from "../registry";

type PathSolution = { next: number[]; cost: number[] };

class MinHeap {
  private values: [number, number][] = [];
  push(item: [number, number]): void {
    let index = this.values.push(item) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.values[parent][0] <= item[0]) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = item;
  }
  pop(): [number, number] | undefined {
    if (!this.values.length) return undefined;
    const root = this.values[0];
    const tail = this.values.pop()!;
    if (this.values.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.values.length) break;
        const right = left + 1;
        const child = right < this.values.length && this.values[right][0] < this.values[left][0] ? right : left;
        if (this.values[child][0] >= tail[0]) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = tail;
    }
    return root;
  }
}

function shortestPaths(endField: Field, edgeCostField: Field) {
  const cache = new WeakMap<FieldCtx, PathSolution>();
  return (ctx: FieldCtx): PathSolution => {
    const found = cache.get(ctx);
    if (found) return found;
    const edgeCtx = ctx.fork?.("EDGE");
    const ends = endField.array(ctx);
    const edgeCosts = edgeCtx ? edgeCostField.array(edgeCtx) : [];
    const adjacency: { vertex: number; edge: number }[][] = Array.from({ length: ctx.size }, () => []);
    for (let edge = 0; edge < (edgeCtx?.size ?? 0); edge++) {
      const [a, b] = edgeCtx?.edgeVerts?.(edge) ?? [0, 0];
      if (a < 0 || b < 0 || a >= ctx.size || b >= ctx.size) continue;
      adjacency[a].push({ vertex: b, edge });
      adjacency[b].push({ vertex: a, edge });
    }
    const cost = new Array<number>(ctx.size).fill(Infinity);
    const next = Array.from({ length: ctx.size }, (_, index) => index);
    const heap = new MinHeap();
    for (let vertex = 0; vertex < ctx.size; vertex++) {
      if (asNum(ends[vertex] ?? 0) <= 0) continue;
      cost[vertex] = 0;
      heap.push([0, vertex]);
    }
    for (let item = heap.pop(); item; item = heap.pop()) {
      const [distance, vertex] = item;
      if (distance !== cost[vertex]) continue;
      for (const neighbor of adjacency[vertex]) {
        const weight = Math.max(0, asNum(edgeCosts[neighbor.edge] ?? 1));
        const candidate = distance + weight;
        if (candidate < cost[neighbor.vertex] - 1e-12 || (Math.abs(candidate - cost[neighbor.vertex]) <= 1e-12 && vertex < next[neighbor.vertex])) {
          cost[neighbor.vertex] = candidate;
          next[neighbor.vertex] = vertex;
          heap.push([candidate, neighbor.vertex]);
        }
      }
    }
    const solution = { next, cost: cost.map((value) => Number.isFinite(value) ? value : 0) };
    cache.set(ctx, solution);
    return solution;
  };
}

reg("GeometryNodeInputShortestEdgePaths", (api) => {
  const solve = shortestPaths(api.field("End Vertex"), api.field("Edge Cost"));
  return {
    "Next Vertex Index": Field.make((ctx) => solve(ctx).next),
    "Total Cost": Field.make((ctx) => solve(ctx).cost),
  };
});

reg("GeometryNodeEdgePathsToCurves", (api) => {
  const source = realizeInstances(api.geo("Mesh"));
  const mesh = source.mesh;
  const out = new Geometry();
  if (!mesh?.positions.length) return { Curves: out };
  const ctx = makeFieldCtx(source, "POINT");
  const starts = api.field("Start Vertices").array(ctx);
  const next = api.field("Next Vertex Index").array(ctx);
  const sourceIndices: number[] = [];
  for (let start = 0; start < mesh.positions.length; start++) {
    if (asNum(starts[start] ?? 0) <= 0) continue;
    const path: number[] = [];
    const visited = new Set<number>();
    let current = start;
    while (current >= 0 && current < mesh.positions.length && !visited.has(current)) {
      path.push(current);
      visited.add(current);
      const following = Math.round(asNum(next[current] ?? current));
      if (following === current) break;
      current = following;
    }
    if (path.length < 2) continue;
    sourceIndices.push(...path);
    out.curves.push({ cyclic: false, points: path.map((vertex) => [...mesh.positions[vertex]] as Vec3) });
  }
  for (const [name, attribute] of mesh.attributes) {
    if (attribute.domain !== "POINT") continue;
    const fallback: Elem = attribute.data[0] ?? 0;
    out.curveAttributes.set(name, { domain: "POINT", data: sourceIndices.map((index) => attribute.data[index] ?? fallback) });
  }
  return { Curves: out };
});
