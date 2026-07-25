import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface ComponentTruth {
  count: number;
  verts: number;
  faces: number;
  boundary_edges: number;
  bevel_result: {
    verts: number;
    faces: number;
  };
}

interface BevelTruth {
  bounds: {
    min: number[];
    max: number[];
  };
  geometry_nodes: {
    verts: number;
    faces: number;
    components: ComponentTruth[];
  };
  full_modifier_stack: {
    verts: number;
    faces: number;
  };
  contract: string;
  provenance: string;
}

const truth = JSON.parse(
  readFileSync("tools/fixtures/n03d-print-test-bevel-blender-5.1.2.json", "utf8"),
) as BevelTruth;

test("N03D Bevel truth partitions both source and result totals exactly", () => {
  const source = truth.geometry_nodes.components.reduce(
    (sum, component) => ({
      verts: sum.verts + component.count * component.verts,
      faces: sum.faces + component.count * component.faces,
    }),
    { verts: 0, faces: 0 },
  );
  const result = truth.geometry_nodes.components.reduce(
    (sum, component) => ({
      verts: sum.verts + component.count * component.bevel_result.verts,
      faces: sum.faces + component.count * component.bevel_result.faces,
    }),
    { verts: 0, faces: 0 },
  );
  assert.deepEqual(source, {
    verts: truth.geometry_nodes.verts,
    faces: truth.geometry_nodes.faces,
  });
  assert.deepEqual(result, {
    verts: truth.full_modifier_stack.verts,
    faces: truth.full_modifier_stack.faces,
  });
});

test("N03D Bevel truth records unchanged bounds and refuses strip approximation", () => {
  assert.deepEqual(truth.bounds, {
    min: [-5.86973762512207, -5.5, -5.86973762512207],
    max: [5.86973762512207, 9.126971244812012, 5.86973762512207],
  });
  assert.match(truth.contract, /strip-only approximation is forbidden/);
  assert.match(truth.provenance, /evaluated face winding/);
  const unchanged = truth.geometry_nodes.components.filter((component) =>
    component.verts === component.bevel_result.verts
    && component.faces === component.bevel_result.faces);
  assert.deepEqual(unchanged.map((component) => component.count), [240]);
});
