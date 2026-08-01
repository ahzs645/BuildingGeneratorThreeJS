import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DumpValidationError, normalizeDump, validateDump } from "../gnvm/dump-schema";

const group = {
  name: "Shared Bake Group",
  type: "GeometryNodeTree",
  nodes: [],
  links: [],
  interface: [],
};

interface BlenderBakeTruth {
  contract: string;
  shared_node_group: string;
  cases: {
    bake_id: number;
    expected_status: string;
    operator_result?: string[];
    configured_target?: string;
    configured_directory?: string;
    live_input_vertices_after_bake?: number;
    cached_output_vertices?: number;
    expected_cache_frames?: number[];
    live_frame_3_apex_y_after_bake?: number;
    cached_frame_3_apex_y?: number;
    packed_pointer: boolean;
    disk_meta_files: number;
  }[];
  provenance: string;
}

const blenderTruth = JSON.parse(readFileSync(
  "tools/fixtures/geometry-node-bake-state-blender-5.1.2.json",
  "utf8",
)) as BlenderBakeTruth;

const blender = [
  process.env.BLENDER_BIN,
  "/Applications/Blender.app/Contents/MacOS/Blender",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

test("Blender fixture proves cache states and animation ownership", () => {
  assert.equal(blenderTruth.contract, "modifier-instance GeometryNodeBake cache state");
  assert.match(blenderTruth.provenance, /geometry_node_bake_single/);
  assert.deepEqual(
    blenderTruth.cases.map((fixture) => fixture.expected_status),
    ["unbaked", "disk-backed", "packed", "packed", "unknown"],
  );
  assert.equal(new Set(blenderTruth.cases.map((fixture) => fixture.bake_id)).size, 1);
  assert.deepEqual(
    blenderTruth.cases.map((fixture) => fixture.packed_pointer),
    [false, false, true, true, false],
  );
  assert.deepEqual(blenderTruth.cases.map((fixture) => fixture.disk_meta_files), [0, 1, 0, 0, 0]);
  assert.deepEqual(blenderTruth.cases.slice(1, 4).map((fixture) => fixture.operator_result), [
    ["FINISHED"],
    ["FINISHED"],
    ["FINISHED"],
  ]);
  assert.deepEqual(
    blenderTruth.cases.slice(1, 3).map((fixture) => [
      fixture.live_input_vertices_after_bake,
      fixture.cached_output_vertices,
    ]),
    [[4, 3], [4, 3]],
  );
  assert.deepEqual(blenderTruth.cases[3].expected_cache_frames, [1, 2, 3]);
  assert.equal(blenderTruth.cases[3].live_frame_3_apex_y_after_bake, 9);
  assert.equal(blenderTruth.cases[3].cached_frame_3_apex_y, 3);
  assert.deepEqual(
    blenderTruth.cases.slice(-1).map((fixture) => [
      fixture.configured_target,
      fixture.configured_directory,
    ]),
    [["DISK", ""]],
  );
});

test("Blender extractor classifies modifier-instance Bake state end to end", {
  skip: blender ? false : "Blender is not installed",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-dojo-bake-extraction-"));
  try {
    const work = join(directory, "work");
    const truthPath = join(directory, "truth.json");
    const dumpPath = join(directory, "dump.json");
    const fixture = spawnSync(blender!, [
      "--background",
      "--factory-startup",
      "--python-exit-code", "1",
      "--python", resolve("tools/blender_bake_state_fixture.py"),
      "--", truthPath, work,
    ], { encoding: "utf8" });
    assert.equal(fixture.status, 0, `${fixture.stdout}\n${fixture.stderr}`);

    const extraction = spawnSync(blender!, [
      "--background",
      join(work, "bake-state-fixture.blend"),
      "--python-exit-code", "1",
      "--python", resolve("tools/dump_blend.py"),
      "--", dumpPath,
    ], { encoding: "utf8" });
    assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);

    const dump = JSON.parse(await readFile(dumpPath, "utf8"));
    const statuses = Object.fromEntries(dump.objects.map((object: any) => [
      object.name,
      object.modifiers.flatMap((modifier: any) => modifier.bake_states ?? [])
        .map((state: any) => state.status),
    ]));
    assert.deepEqual(statuses, {
      "Bake Fixture animation-packed": ["packed"],
      "Bake Fixture disk-backed": ["disk-backed"],
      "Bake Fixture packed": ["packed"],
      "Bake Fixture unbaked": ["unbaked"],
      "Bake Fixture unknown-default-disk": ["unknown"],
    });
    const objectFor = (name: string) => dump.objects.find((object: any) => object.name === name);
    const stateFor = (name: string) => objectFor(name).modifiers
      .flatMap((modifier: any) => modifier.bake_states ?? [])[0];
    for (const name of ["Bake Fixture disk-backed", "Bake Fixture packed"]) {
      assert.equal(objectFor(name).mesh.verts.length, 4, `${name} live input changed after baking`);
      assert.equal(
        stateFor(name).snapshots[0].items.Item_0.geometry.mesh.positions.length,
        3,
        `${name} snapshot came from its persistent cache`,
      );
      assert.equal(stateFor(name).reason, undefined);
    }
    const animation = stateFor("Bake Fixture animation-packed");
    assert.deepEqual(animation.snapshots.map((snapshot: any) => snapshot.frame), [1, 2, 3]);
    assert.deepEqual(
      animation.snapshots.map((snapshot: any) =>
        snapshot.items.Item_0.geometry.mesh.positions[2][1]),
      [1, 2, 3],
    );
    assert.equal(stateFor("Bake Fixture unbaked").reason, undefined);
    assert.equal(dump.extraction_metadata.extractor.version, "1.8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("modifier bake states stay separate for objects sharing one node group", () => {
  const dump = normalizeDump({
    node_groups: { "Shared Bake Group": group },
    objects: [
      {
        name: "Live Instance",
        modifiers: [{
          name: "GeometryNodes",
          type: "NODES",
          node_group: "Shared Bake Group",
          bake_states: [{
            bake_id: 4312,
            node_group: "Nested Bake Group",
            node: "Bake",
            status: "unbaked",
          }],
        }],
      },
      {
        name: "Packed Instance",
        modifiers: [{
          name: "GeometryNodes",
          type: "NODES",
          node_group: "Shared Bake Group",
          bake_states: [{
            bake_id: 4312,
            node_group: "Nested Bake Group",
            node: "Bake",
            status: "packed",
            snapshot: {
              schema_version: 2,
              source: "blender-evaluated",
              frame: 1,
              items: {},
            },
          }],
        }],
      },
    ],
  });

  assert.equal(dump.objects?.[0].modifiers?.[0].bake_states?.[0].status, "unbaked");
  assert.equal(dump.objects?.[1].modifiers?.[0].bake_states?.[0].status, "packed");
  assert.equal(
    dump.objects?.[1].modifiers?.[0].bake_states?.[0].snapshot?.source,
    "blender-evaluated",
  );
});

test("dump validation rejects ambiguous or malformed modifier bake states", () => {
  const invalid = {
    node_groups: { "Shared Bake Group": group },
    objects: [{
      name: "Broken",
      modifiers: [{
        type: "NODES",
        node_group: "Shared Bake Group",
        bake_states: [{
          bake_id: -1,
          node_group: "Nested Bake Group",
          node: "Bake",
          status: "maybe-packed",
        }],
      }],
    }],
  };

  assert.deepEqual(validateDump(invalid).map((issue) => issue.code), [
    "EXPECTED_NONNEGATIVE_INTEGER",
    "INVALID_BAKE_STATUS",
  ]);
  assert.throws(() => normalizeDump(invalid), DumpValidationError);
});
