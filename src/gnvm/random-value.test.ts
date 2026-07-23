import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { REGISTRY } from "./registry";
import "./index";

function randomValue(linkedId: boolean, id: Field = Field.of(0)): Field {
  const handler = REGISTRY.get("FunctionNodeRandomValue");
  assert.ok(handler);
  return handler({
    field: (name: string) => {
      if (name === "ID") return id;
      if (name === "Seed") return Field.of(0);
      if (name === "Min_001") return Field.of(-3.69);
      if (name === "Max_001") return Field.of(4.16);
      return Field.of(0);
    },
    prop: (name: string, fallback: unknown) => name === "data_type" ? "FLOAT" : fallback,
    node: {
      name: "Random Value",
      inputs: [{
        name: "ID",
        identifier: "ID",
        type: "NodeSocketInt",
        linked: linkedId,
        value: linkedId ? null : 0,
      }],
    },
  } as never).Value as Field;
}

test("Random Value uses the implicit element index when ID is unconnected", () => {
  const values = randomValue(false).array({
    size: 4,
    domain: "POINT",
    index: (index) => index,
  });

  assert.equal(new Set(values).size, 4);
  assert.deepEqual(values, [
    3.063455104827881,
    2.923790454864502,
    3.9623465538024902,
    4.125792503356934,
  ]);
});

test("Random Value honors an explicitly connected ID field", () => {
  const values = randomValue(true, Field.of(0)).array({
    size: 4,
    domain: "POINT",
    index: (index) => index,
  });

  assert.deepEqual(values, Array(4).fill(values[0]));
});
