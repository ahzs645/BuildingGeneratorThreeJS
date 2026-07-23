import assert from "node:assert/strict";
import test from "node:test";
import { MATERIAL_BACKENDS, resolveMaterialBackend } from "../material-backend";

test("material backend contract keeps the requested portable backend when available", () => {
  assert.deepEqual(MATERIAL_BACKENDS, ["materialx", "baked-pbr", "legacy-authored", "normalized"]);
  assert.deepEqual(resolveMaterialBackend("materialx", { materialx: true, "legacy-authored": true }), {
    requested: "materialx",
    resolved: "materialx",
    attempted: ["materialx"],
    fallbackReason: null,
  });
});

test("material backend contract preserves authored materials before normalized fallback", () => {
  assert.deepEqual(resolveMaterialBackend("materialx", {
    materialx: false,
    "baked-pbr": false,
    "legacy-authored": true,
    normalized: true,
  }), {
    requested: "materialx",
    resolved: "legacy-authored",
    attempted: ["materialx", "baked-pbr", "legacy-authored"],
    fallbackReason: "materialx unavailable; selected legacy-authored",
  });
});

test("normalized is a total terminal fallback", () => {
  const resolution = resolveMaterialBackend("baked-pbr", {});
  assert.equal(resolution.resolved, "normalized");
  assert.deepEqual(resolution.attempted, ["baked-pbr", "legacy-authored", "normalized"]);
});
