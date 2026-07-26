import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import {
  blenderUnitsToMillimeters,
  millimetersToBlenderUnits,
  sceneUnits,
} from "./units";

const dump = {
  node_groups: {},
  scene: {
    unit_settings: {
      system: "METRIC",
      length_unit: "MILLIMETERS",
      scale_length: .001,
    },
  },
} as Dump;

test("normalizes Blender scene length settings into explicit millimetres", () => {
  assert.deepEqual(sceneUnits(dump), {
    system: "METRIC",
    lengthUnit: "MILLIMETERS",
    scaleLength: .001,
    millimetersPerBlenderUnit: 1,
  });
  assert.equal(blenderUnitsToMillimeters(dump, 25.4), 25.4);
  assert.equal(millimetersToBlenderUnits(dump, 25.4), 25.4);
  const metreScene = structuredClone(dump);
  metreScene.scene!.unit_settings!.scale_length = 1;
  assert.equal(blenderUnitsToMillimeters(metreScene, 1), 1_000);
});
