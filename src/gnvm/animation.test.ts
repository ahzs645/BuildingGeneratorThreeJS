import assert from "node:assert/strict";
import test from "node:test";
import type { Dump, DumpAnimationFCurve } from "./dump-schema";
import { animationFrameRange, dumpAtFrame, evaluateFCurve } from "./animation";

const linear: DumpAnimationFCurve = {
  data_path: 'nodes["Mix"].inputs[0].default_value',
  array_index: 0,
  keyframes: [
    { frame: 1, value: 0, interpolation: "LINEAR" },
    { frame: 11, value: 1, interpolation: "LINEAR" },
  ],
};

test("evaluates constant, linear, and Blender-handle Bezier F-curves", () => {
  assert.equal(evaluateFCurve(linear, 6), .5);
  const constant = structuredClone(linear);
  constant.keyframes[0].interpolation = "CONSTANT";
  assert.equal(evaluateFCurve(constant, 6), 0);
  const bezier = structuredClone(linear);
  bezier.keyframes[0] = {
    frame: 1,
    value: 0,
    interpolation: "BEZIER",
    handle_right: [1, 0],
  };
  bezier.keyframes[1] = {
    frame: 11,
    value: 1,
    handle_left: [11, 1],
  };
  assert.ok(Math.abs(evaluateFCurve(bezier, 6) - .5) < 1e-8);
});

test("applies node-tree actions without mutating the authored dump", () => {
  const dump: Dump = {
    scene: { frame_current: 1 },
    objects: [],
    node_groups: {
      Animated: {
        name: "Animated",
        type: "GeometryNodeTree",
        interface: [],
        nodes: [{
          name: "Mix",
          type: "ShaderNodeMix",
          label: null,
          inputs: [{ name: "Factor", identifier: "Factor", type: "NodeSocketFloat", linked: false, value: 0 }],
          outputs: [],
        }],
        links: [],
        animation: {
          action: "AnimatedAction",
          frame_range: [1, 11],
          fcurves: [linear],
        },
      },
    },
  };
  assert.deepEqual(animationFrameRange(dump), [1, 11]);
  const animated = dumpAtFrame(dump, 6);
  assert.equal(dump.node_groups.Animated.nodes[0].inputs[0].value, 0);
  assert.equal(animated.node_groups.Animated.nodes[0].inputs[0].value, .5);
  assert.equal(animated.scene?.frame_current, 6);
});
