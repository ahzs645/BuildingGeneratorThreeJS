import assert from "node:assert/strict";
import test from "node:test";
import { Elem, Field, FieldCtx } from "./core";
import "./nodes/crayon";
import { EvalAPI, REGISTRY } from "./registry";

const chainNeighbors = [[1], [0, 2], [1]];
const context: FieldCtx = {
  size: 3,
  domain: "POINT",
  neighbors: (index) => chainNeighbors[index],
};

function blurOnce(values: Elem[], weights: Elem[]): Elem[] {
  const handler = REGISTRY.get("GeometryNodeBlurAttribute");
  assert.ok(handler);
  const output = handler({
    field: (name: string) => Field.make(() => name === "Value" ? values : weights),
    num: () => 1,
    node: { name: "Blur Attribute", inputs: [] },
  } as unknown as EvalAPI);
  return (output.Value as Field).array(context);
}

test("Blur Attribute uses the current element's Weight for every neighbor", () => {
  assert.deepEqual(blurOnce([10, 20, 40], [0, 2, 0.5]), [
    10,
    24,
    33.333335876464844,
  ]);
});

test("Blur Attribute applies the same Blender mixer rule to vectors", () => {
  assert.deepEqual(blurOnce(
    [[10, 0, 1], [20, 3, 2], [40, 9, 4]],
    [0, 2, 0.5],
  ), [
    [10, 0, 1],
    [24, 4.200000286102295, 2.4000000953674316],
    [33.333335876464844, 7, 3.3333334922790527],
  ]);
});
