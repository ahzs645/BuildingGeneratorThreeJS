import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import {
  nodePropertyCatalogTypes,
  nodePropertyControls,
  nodePropertyDescriptors,
} from "./node-property-catalog";

const gnvmDir = fileURLToPath(new URL("../gnvm/nodes/", import.meta.url));
const handlerSource = (await Promise.all(
  (await readdir(gnvmDir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFile(`${gnvmDir}${name}`, "utf8")),
)).join("\n");

const loadDump = async (relativeUrl: string): Promise<Dump> => JSON.parse(await readFile(
  fileURLToPath(new URL(relativeUrl, import.meta.url)),
  "utf8",
)) as Dump;

test("every catalogued option identifier occurs in the handler that would consume it", () => {
  // A floor, not a proof: it cannot tell ADD-the-Math-key from ADD-the-Vector-
  // Math-case. It does catch the failure mode that matters — an option copied
  // from Blender's enum that no GN-VM handler mentions at all, which would
  // evaluate as some silent fallback.
  const missing: string[] = [];
  for (const type of nodePropertyCatalogTypes()) {
    for (const descriptor of nodePropertyDescriptors(type)) {
      assert.ok(new RegExp(`"${descriptor.prop}"`).test(handlerSource), `no handler reads ${type}.${descriptor.prop}`);
      for (const option of descriptor.options) {
        if (!new RegExp(`(^|[^A-Z_0-9])${option.value}([^A-Za-z_0-9]|$)`, "m").test(handlerSource)) {
          missing.push(`${type}.${descriptor.prop}=${option.value}`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("properties that would silently re-point a handler at another socket stay out", () => {
  // Each of these switches which socket identifier the handler reads, while the
  // dump's `enabled` flags stay frozen at whatever Blender exported. Offering
  // them would leave the editor drawing the old sockets over an evaluator that
  // had moved on to the unlinked new ones.
  const excluded: [string, string][] = [
    ["FunctionNodeCompare", "data_type"],
    ["ShaderNodeMix", "data_type"],
    ["ShaderNodeMix", "factor_mode"],
    ["ShaderNodeMapRange", "data_type"],
    ["FunctionNodeRandomValue", "data_type"],
    ["GeometryNodeStoreNamedAttribute", "data_type"],
    ["GeometryNodeSwitch", "input_type"],
    // No handler reads these at all.
    ["ShaderNodeMix", "blend_type"],
    ["ShaderNodeMath", "use_clamp"],
    // Superseded by a menu input socket in current dumps.
    ["GeometryNodeResampleCurve", "mode"],
    ["GeometryNodeFillCurve", "mode"],
    ["GeometryNodeMergeByDistance", "mode"],
  ];
  for (const [type, prop] of excluded) {
    assert.ok(
      !nodePropertyDescriptors(type).some((descriptor) => descriptor.prop === prop),
      `${type}.${prop} must not be offered`,
    );
  }
});

test("no catalogued option is a duplicate and labels stay human", () => {
  for (const type of nodePropertyCatalogTypes()) {
    for (const descriptor of nodePropertyDescriptors(type)) {
      const values = descriptor.options.map((option) => option.value);
      assert.equal(new Set(values).size, values.length, `${type}.${descriptor.prop} repeats an option`);
      assert.ok(descriptor.options.length > 1, `${type}.${descriptor.prop} needs a real choice`);
      for (const option of descriptor.options) assert.ok(option.label && !option.label.includes("_"), `${type}.${descriptor.prop}=${option.value}`);
    }
  }
  const math = nodePropertyDescriptors("ShaderNodeMath")[0];
  assert.equal(math.label, "Operation");
  assert.deepEqual(math.options.find((option) => option.value === "MULTIPLY_ADD"), { value: "MULTIPLY_ADD", label: "Multiply Add" });
  assert.deepEqual(math.options.find((option) => option.value === "SQRT"), { value: "SQRT", label: "Square Root" });
});

test("uncatalogued node types and absent properties produce no control at all", () => {
  assert.deepEqual(nodePropertyDescriptors("GeometryNodeJoinGeometry"), []);
  assert.deepEqual(nodePropertyControls("GeometryNodeJoinGeometry", { operation: "ADD" }), []);
  // Blender writes bl_* metadata onto every node; only catalogued keys count.
  assert.deepEqual(nodePropertyControls("ShaderNodeMath", { bl_label: "Math" }), []);
  assert.deepEqual(nodePropertyControls("ShaderNodeMath", undefined), []);
  // A non-string value means the dump disagrees with the catalog about the
  // property's shape; rendering a dropdown over it would rewrite it as text.
  assert.deepEqual(nodePropertyControls("ShaderNodeMath", { operation: 3 }), []);
});

test("a value the VM never implemented is preserved instead of silently rewritten", () => {
  const [control] = nodePropertyControls("GeometryNodeMeshToPoints", { mode: "CORNERS" });
  assert.equal(control.value, "CORNERS");
  assert.equal(control.options[0].value, "CORNERS");
  assert.equal(control.options[0].label, "Corners (as authored)");
  assert.deepEqual(control.options.slice(1).map((option) => option.value), ["VERTICES", "EDGES", "FACES"]);
});

test("the catalog covers every value the extracted graphs actually use", async () => {
  // GN-VM folds Mesh to Points' CORNERS onto the POINT domain rather than
  // implementing it, so it is the one authored value with no option of its own.
  const documentedGaps = new Set(["GeometryNodeMeshToPoints.mode=CORNERS"]);
  const dumps = await Promise.all([
    "../../public/dojo/crayon/dump.json",
    "../../public/dojo/typewriter/dump.json",
    "../../public/dojo/chrome-assets/type-pixel-brush/dump.json",
  ].map(loadDump));

  const unsupported = new Set<string>();
  const exercised = new Set<string>();
  for (const dump of dumps) {
    for (const group of Object.values(dump.node_groups)) {
      for (const node of group.nodes) {
        for (const control of nodePropertyControls(node.type, node.props)) {
          exercised.add(`${node.type}.${control.prop}`);
          const authored = control.options[0].label.endsWith("(as authored)");
          if (authored) unsupported.add(`${node.type}.${control.prop}=${control.value}`);
        }
      }
    }
  }
  assert.deepEqual([...unsupported].filter((entry) => !documentedGaps.has(entry)), []);
  assert.ok(exercised.has("ShaderNodeMath.operation"));
  assert.ok(exercised.has("GeometryNodeCaptureAttribute.domain"));
  assert.ok(exercised.size >= 15, `only ${exercised.size} catalogued properties appear in the sampled dumps`);
});
