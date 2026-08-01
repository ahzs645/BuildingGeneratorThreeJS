import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import {
  boundedApproximationBadgeLabel,
  compatibilityForBlendStudioTarget,
  discoverBlendStudioTargets,
} from "./model";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicRoot = `${workspaceRoot}/public`;
const bakeBadge = "Bounded approximation · GeometryNodeBake ×1";
const blender = [
  process.env.BLENDER_BIN,
  "/Applications/Blender.app/Contents/MacOS/Blender",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

type CatalogAsset = {
  id: string;
  object: string;
  dump: string;
};

type ComparisonReport = {
  captures: {
    blender: string;
    webgl: string;
    resolution: [number, number];
  };
  comparison: {
    surface_mask_iou: number;
    surface_corner_rmse_pixels: number;
  };
};

const publishedBakeAssets = [
  {
    id: "chain-and-mace",
    bakeOwner: "spikey link",
    modifierStateCount: 1,
    bakeStatus: "unbaked",
    showsBakeBadge: false,
    comparison: "dojo/chrome-assets/chain-and-mace/shader-comparison.json",
    blender: "dojo/references/chrome-assets/chain-and-mace-shader.png",
    webgl: "dojo/references/chrome-assets/chain-and-mace-shader-webgl.png",
    minimumIou: 0.97,
    maximumCornerRmse: 0.7,
    freshMinimumIou: 0.98,
    freshMaximumCornerRmse: 3.3,
  },
  {
    id: "chain-link-spikey",
    bakeOwner: "spikey link",
    modifierStateCount: 1,
    bakeStatus: "unbaked",
    showsBakeBadge: false,
    comparison: "dojo/chrome-assets/chain-link-spikey/authored-comparison.json",
    blender: "dojo/references/chrome-assets/chain-link-spikey-authored.png",
    webgl: "dojo/references/chrome-assets/chain-link-spikey-authored-webgl.png",
    minimumIou: 0.98,
    maximumCornerRmse: 0.6,
    freshMinimumIou: 0.99,
    freshMaximumCornerRmse: 0.3,
  },
  {
    id: "joint-bubble-putty",
    bakeOwner: "PUTTY.002",
    modifierStateCount: 11,
    bakeStatus: "unknown",
    showsBakeBadge: true,
    comparison: "dojo/joints/bubble-putty/material-comparison.json",
    blender: "dojo/references/joints/bubble-putty-authored.png",
    webgl: "dojo/references/joints/bubble-putty-authored-webgl.png",
    minimumIou: 0.99,
    maximumCornerRmse: 1.2,
    freshMinimumIou: 0.995,
    freshMaximumCornerRmse: 0.6,
  },
] as const;

async function catalog(): Promise<CatalogAsset[]> {
  return JSON.parse(await readFile(
    `${publicRoot}/dojo/chrome-assets/catalog.json`,
    "utf8",
  )) as CatalogAsset[];
}

async function selectedCatalogTarget(asset: CatalogAsset): Promise<{
  dump: Dump;
  target: ReturnType<typeof discoverBlendStudioTargets>[number];
}> {
  const dump = JSON.parse(await readFile(`${publicRoot}/${asset.dump}`, "utf8")) as Dump;
  const target = discoverBlendStudioTargets(dump).find((candidate) =>
    candidate.kind === "object" && candidate.objectName === asset.object);
  assert.ok(target, `${asset.id} must expose catalog object ${asset.object} as a Studio target`);
  return { dump, target };
}

function pngDimensions(bytes: Buffer): [number, number] {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("published Bake assets preserve modifier-specific cache state and the corresponding UI badge", async () => {
  const assets = await catalog();
  for (const expected of publishedBakeAssets) {
    const asset = assets.find((candidate) => candidate.id === expected.id);
    assert.ok(asset, `${expected.id} must remain in the lesson catalog`);
    const { dump, target } = await selectedCatalogTarget(asset);
    assert.equal(target.kind, "object");
    if (target.kind !== "object") continue;
    const modifier = dump.objects
      ?.find((object) => object.name === expected.bakeOwner)
      ?.modifiers?.find((candidate) =>
        candidate.type === "NODES" && (candidate.bake_states?.length ?? 0) > 0);
    const states = modifier?.bake_states ?? [];
    assert.ok(
      states.length > 0,
      `${expected.id} must export Bake state on owning modifier ${expected.bakeOwner}`,
    );
    assert.ok(
      states.every((state) => state.status === expected.bakeStatus),
      `${expected.id} must retain its extracted ${expected.bakeStatus} state`,
    );
    const modifierStates = (dump.objects ?? []).flatMap((object) =>
      (object.modifiers ?? []).flatMap((candidate, modifierIndex) =>
        (candidate.bake_states?.length ?? 0) > 0
          ? [{ object: object.name, modifierIndex, states: candidate.bake_states! }]
          : []));
    assert.equal(
      modifierStates.length,
      expected.modifierStateCount,
      `${expected.id} must preserve Bake state separately on every owning modifier`,
    );
    assert.ok(modifierStates.every(({ states: ownedStates }) =>
      ownedStates.every((state) => state.status === expected.bakeStatus)));

    const compatibility = compatibilityForBlendStudioTarget(dump, target);
    assert.equal(
      compatibility.report.approximatedNodeTypes.some((entry) =>
        entry.type === "GeometryNodeBake"),
      expected.showsBakeBadge,
      `${expected.id} Bake capability must follow its modifier cache evidence`,
    );
    assert.equal(compatibility.gaps.includes(bakeBadge), expected.showsBakeBadge);
  }
});

test("Studio renders one canonical Bake badge label for static and runtime approximations", () => {
  const entry = { type: "GeometryNodeBake", count: 1 };
  assert.equal(boundedApproximationBadgeLabel(entry), bakeBadge);

  const approximateDump = bakeFixture("unknown");
  const approximateTarget = discoverBlendStudioTargets(approximateDump)[0];
  assert.ok(approximateTarget);
  assert.deepEqual(
    compatibilityForBlendStudioTarget(approximateDump, approximateTarget).gaps,
    [boundedApproximationBadgeLabel(entry)],
  );

  const exactDump = bakeFixture("unknown");
  const exactTarget = discoverBlendStudioTargets(exactDump)[0];
  assert.ok(exactTarget);
  const modifier = exactDump.objects?.[0].modifiers?.[0];
  assert.ok(modifier?.bake_states?.[0]);
  modifier.bake_states[0].status = "unbaked";
  assert.deepEqual(
    compatibilityForBlendStudioTarget(exactDump, exactTarget).gaps,
    [],
  );

  modifier.bake_states[0].status = "packed";
  modifier.bake_states[0].snapshot = {
    schema_version: 2,
    source: "blender-evaluated",
    frame: 1,
    items: {
      Item_0: {
        socket_type: "NodeSocketGeometry",
        value_contract: "geometry-set",
        geometry: { mesh: { positions: [], edges: [], faces: [] } },
      },
    },
  };
  assert.deepEqual(
    compatibilityForBlendStudioTarget(exactDump, exactTarget).gaps,
    [],
    "a validated snapshot is exact even when Blender reports a packed cache",
  );
});

test("Bake badges include modifier-specific Object Info dependencies cooked by the runtime", () => {
  const dependency = bakeFixture("packed");
  const dependencyObject = dependency.objects?.[0];
  assert.ok(dependencyObject);
  dependencyObject.name = "Cached dependency";
  dependency.node_groups.TargetRoot = {
    name: "TargetRoot",
    type: "GeometryNodeTree",
    interface: [],
    nodes: [{
      name: "Object Info",
      type: "GeometryNodeObjectInfo",
      label: null,
      inputs: [{
        name: "Object",
        identifier: "Object",
        type: "NodeSocketObject",
        linked: false,
        value: { datablock: "object", name: "Cached dependency" },
      }],
      outputs: [],
    }],
    links: [],
  };
  dependency.objects?.push({
    name: "Target",
    modifiers: [{ type: "NODES", node_group: "TargetRoot" }],
  });
  const target = discoverBlendStudioTargets(dependency).find((candidate) =>
    candidate.kind === "object" && candidate.objectName === "Target");
  assert.ok(target);
  assert.deepEqual(
    compatibilityForBlendStudioTarget(dependency, target).gaps,
    [bakeBadge],
  );
});

function bakeFixture(status: "packed" | "disk-backed" | "unknown"): Dump {
  return {
    node_groups: {
      Root: {
        name: "Root",
        type: "GeometryNodeTree",
        interface: [{
          item_type: "SOCKET",
          in_out: "OUTPUT",
          identifier: "OutputGeometry",
          name: "Geometry",
          socket_type: "NodeSocketGeometry",
        }],
        nodes: [{
          name: "Bake",
          type: "GeometryNodeBake",
          label: null,
          inputs: [{
            name: "Geometry",
            identifier: "Item_0",
            type: "NodeSocketGeometry",
            linked: true,
          }],
          outputs: [{
            name: "Geometry",
            identifier: "Item_0",
            type: "NodeSocketGeometry",
          }],
        }],
        links: [],
      },
    },
    objects: [{
      name: "Target",
      modifiers: [{
        type: "NODES",
        name: "GeometryNodes",
        node_group: "Root",
        bake_states: [{
          bake_id: 1,
          node_group: "Root",
          node: "Bake",
          status,
          reason: `${status} fixture intentionally has no portable snapshot`,
        }],
      }],
    }],
  };
}

for (const status of ["packed", "disk-backed", "unknown"] as const) {
  test(`${status} Bake without a portable snapshot keeps its approximation badge`, () => {
    const dump = bakeFixture(status);
    const target = discoverBlendStudioTargets(dump)[0];
    assert.ok(target);
    const compatibility = compatibilityForBlendStudioTarget(dump, target);
    assert.deepEqual(compatibility.report.approximatedNodeTypes, [{
      type: "GeometryNodeBake",
      count: 1,
    }]);
    assert.ok(compatibility.gaps.includes(bakeBadge));
  });
}

test("published Bake assets retain their Blender-versus-browser visual evidence", async () => {
  for (const expected of publishedBakeAssets) {
    const comparison = JSON.parse(await readFile(
      `${publicRoot}/${expected.comparison}`,
      "utf8",
    )) as ComparisonReport;
    assert.equal(comparison.captures.blender, basename(expected.blender));
    assert.equal(comparison.captures.webgl, basename(expected.webgl));
    assert.ok(
      comparison.comparison.surface_mask_iou >= expected.minimumIou,
      `${expected.id} silhouette IoU regressed below ${expected.minimumIou}`,
    );
    assert.ok(
      comparison.comparison.surface_corner_rmse_pixels <= expected.maximumCornerRmse,
      `${expected.id} corner RMSE regressed above ${expected.maximumCornerRmse}px`,
    );

    const [blender, webgl] = await Promise.all([
      readFile(`${publicRoot}/${expected.blender}`),
      readFile(`${publicRoot}/${expected.webgl}`),
    ]);
    assert.deepEqual(
      pngDimensions(webgl),
      pngDimensions(blender),
      `${expected.id} comparison images must keep the same viewport`,
    );
    assert.deepEqual(pngDimensions(blender), comparison.captures.resolution);
    assert.ok((await stat(`${publicRoot}/${expected.blender}`)).size > 1_000);
    assert.ok((await stat(`${publicRoot}/${expected.webgl}`)).size > 1_000);
  }
});

test("Bake assets pass a fresh Blender-versus-browser pixel comparison", {
  skip: blender ? false : "Blender is not installed",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-dojo-bake-visual-"));
  try {
    for (const expected of publishedBakeAssets) {
      const output = join(directory, `${expected.id}.json`);
      const comparison = spawnSync(blender!, [
        "--background",
        "--factory-startup",
        "--python-exit-code", "1",
        "--python", resolve("tools/compare_stippler_shader_masks.py"),
        "--",
        `${publicRoot}/${expected.blender}`,
        `${publicRoot}/${expected.webgl}`,
        output,
      ], { encoding: "utf8" });
      assert.equal(comparison.status, 0, `${comparison.stdout}\n${comparison.stderr}`);
      const fresh = JSON.parse(await readFile(output, "utf8")) as ComparisonReport;
      assert.deepEqual(fresh.captures.resolution, [768, 768]);
      assert.ok(
        fresh.comparison.surface_mask_iou >= expected.freshMinimumIou,
        `${expected.id} fresh silhouette IoU regressed below ${expected.freshMinimumIou}`,
      );
      assert.ok(
        fresh.comparison.surface_corner_rmse_pixels <= expected.freshMaximumCornerRmse,
        `${expected.id} fresh corner RMSE regressed above ${expected.freshMaximumCornerRmse}px`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
