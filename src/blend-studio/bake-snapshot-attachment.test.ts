import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tools/attach_bake_snapshots.ts");

function fixtureDump(withObjects = true) {
  return {
    node_groups: {
      "Shared Bake Group": {
        name: "Shared Bake Group",
        type: "GeometryNodeTree",
        nodes: [{
          name: "Bake",
          type: "GeometryNodeBake",
          label: null,
          inputs: [],
          outputs: [
            { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" },
            { name: "Amount", identifier: "Amount", type: "NodeSocketFloat" },
          ],
        }],
        links: [],
        interface: [],
      },
    },
    objects: withObjects ? [
      {
        name: "Packed Object",
        modifiers: [{
          name: "GeometryNodes",
          type: "NODES",
          node_group: "Shared Bake Group",
          bake_states: [{
            bake_id: 42,
            node_group: "Shared Bake Group",
            node: "Bake",
            status: "packed",
          }],
        }],
      },
      {
        name: "Unknown Object",
        modifiers: [{
          name: "GeometryNodes",
          type: "NODES",
          node_group: "Shared Bake Group",
          bake_states: [{
            bake_id: 42,
            node_group: "Shared Bake Group",
            node: "Bake",
            status: "unknown",
          }],
        }],
      },
    ] : [],
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "node-dojo-bake-attach-"));
  const paths = {
    directory,
    input: join(directory, "input.json"),
    manifest: join(directory, "manifest.json"),
    output: join(directory, "output.json"),
    probe: join(directory, "geometry.json"),
    literal: join(directory, "amount.json"),
  };
  await writeFile(paths.probe, JSON.stringify({
    positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    edges: [[0, 1], [1, 2], [2, 0]],
    faces: [[0, 1, 2]],
  }));
  await writeFile(paths.literal, JSON.stringify({
    socket_type: "NodeSocketFloat",
    value_contract: "literal",
    value: 2.5,
  }));
  return paths;
}

function run(input: string, manifest: string, output: string) {
  return spawnSync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"),
    tool,
    input,
    manifest,
    output,
  ], { encoding: "utf8" });
}

test("snapshot attachment is modifier-owned and validates every Bake output", async () => {
  const paths = await setup();
  try {
    await writeFile(paths.input, JSON.stringify(fixtureDump()));
    await writeFile(paths.manifest, JSON.stringify({
      frame: 7,
      snapshots: [
        {
          object: "Packed Object",
          modifier: "GeometryNodes",
          bake_id: 42,
          group: "Shared Bake Group",
          node: "Bake",
          item: "Geometry",
          probe: "geometry.json",
        },
        {
          object: "Packed Object",
          modifier: "GeometryNodes",
          bake_id: 42,
          group: "Shared Bake Group",
          node: "Bake",
          item: "Amount",
          snapshot: "amount.json",
        },
      ],
    }));
    const result = run(paths.input, paths.manifest, paths.output);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(await readFile(paths.output, "utf8"));
    const packed = output.objects[0].modifiers[0].bake_states[0];
    const unknown = output.objects[1].modifiers[0].bake_states[0];
    assert.equal(packed.snapshot.frame, 7);
    assert.deepEqual(Object.keys(packed.snapshot.items).sort(), ["Amount", "Geometry"]);
    assert.equal(unknown.snapshot, undefined);
    assert.equal(output.node_groups["Shared Bake Group"].nodes[0].bake_snapshot, undefined);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("snapshot attachment fails closed for incomplete modifier snapshots", async () => {
  const paths = await setup();
  try {
    await writeFile(paths.input, JSON.stringify(fixtureDump()));
    await writeFile(paths.manifest, JSON.stringify({
      snapshots: [{
        object: "Packed Object",
        modifier: "GeometryNodes",
        group: "Shared Bake Group",
        node: "Bake",
        item: "Geometry",
        probe: "geometry.json",
      }],
    }));
    const result = run(paths.input, paths.manifest, paths.output);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /every concrete output/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("legacy node snapshots require an explicitly standalone group", async () => {
  const paths = await setup();
  try {
    const manifest = {
      snapshots: [
        {
          standalone_group: true,
          group: "Shared Bake Group",
          node: "Bake",
          item: "Geometry",
          probe: "geometry.json",
        },
        {
          standalone_group: true,
          group: "Shared Bake Group",
          node: "Bake",
          item: "Amount",
          snapshot: "amount.json",
        },
      ],
    };
    await writeFile(paths.input, JSON.stringify(fixtureDump()));
    await writeFile(paths.manifest, JSON.stringify(manifest));
    const unsafe = run(paths.input, paths.manifest, paths.output);
    assert.notEqual(unsafe.status, 0);
    assert.match(`${unsafe.stdout}\n${unsafe.stderr}`, /reachable from a modifier/);

    await writeFile(paths.input, JSON.stringify(fixtureDump(false)));
    const safe = run(paths.input, paths.manifest, paths.output);
    assert.equal(safe.status, 0, `${safe.stdout}\n${safe.stderr}`);
    const output = JSON.parse(readFileSync(paths.output, "utf8"));
    const node = output.node_groups["Shared Bake Group"].nodes[0];
    assert.equal(node.bake_snapshot.schema_version, 2);
    assert.equal(node.bake_contract.persistent_cache_portable, true);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
