import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function runAuditIn(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("./audit-no3d-dumps.ts", import.meta.url)),
    directory,
    ...args,
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
}

const runAudit = (...args: string[]) => runAuditIn(".", ...args);

test("audit rejects a non-positive or non-finite timeout before scheduling", () => {
  for (const value of ["0", "-1", "NaN", "Infinity"]) {
    const result = runAudit("--timeout-ms", value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--timeout-ms must be a finite positive number/);
  }
  const missing = runAudit("--timeout-ms");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--timeout-ms must be a finite positive number/);
});

test("audit requires concurrency to be a positive integer", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
    const result = runAudit("--concurrency", value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--concurrency must be a finite positive integer/);
  }
  const missing = runAudit("--concurrency");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--concurrency must be a finite positive integer/);
});

test("audit applies Studio compatibility to earlier GN and intervening non-GN modifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "no3d-stack-audit-"));
  const group = (name: string, unsupported = false) => ({
    name,
    type: "GeometryNodeTree",
    interface: [{
      name: "Geometry",
      identifier: "Socket_0",
      item_type: "SOCKET",
      in_out: "OUTPUT",
      socket_type: "NodeSocketGeometry",
    }],
    nodes: unsupported ? [{
      name: "Unsupported",
      type: "GeometryNodeFutureUnsupported",
      label: null,
      inputs: [],
      outputs: [],
    }] : [],
    links: [],
  });
  const base = {
    node_groups: {
      Earlier: group("Earlier"),
      Selected: group("Selected"),
    },
  };
  await writeFile(join(directory, "earlier-gn.json"), JSON.stringify({
    ...base,
    node_groups: {
      ...base.node_groups,
      Earlier: group("Earlier", true),
    },
    objects: [{
      name: "Earlier GN",
      modifiers: [
        { type: "NODES", node_group: "Earlier" },
        { type: "NODES", node_group: "Selected" },
      ],
    }],
  }));
  await writeFile(join(directory, "intervening.json"), JSON.stringify({
    ...base,
    objects: [{
      name: "Intervening",
      modifiers: [
        { type: "NODES", node_group: "Earlier" },
        { type: "BEVEL", name: "Intervening Bevel" },
        { type: "NODES", node_group: "Selected" },
      ],
    }],
  }));
  const output = join(directory, "audit.json");
  const result = runAuditIn(
    directory,
    "--output",
    output,
    "--timeout-ms",
    "5000",
    "--concurrency",
    "1",
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(output, "utf8"));
  const earlierGn = report.targets.find((target: any) =>
    target.file === "earlier-gn.json" && target.modifierIndex === 1);
  const intervening = report.targets.find((target: any) =>
    target.file === "intervening.json" && target.modifierIndex === 2);

  assert.equal(earlierGn.portable, false);
  assert.equal(earlierGn.exact, false);
  assert.deepEqual(earlierGn.unsupported, [{
    type: "GeometryNodeFutureUnsupported",
    count: 1,
  }]);
  assert.deepEqual(earlierGn.modifierStackIssues, []);
  assert.equal(earlierGn.runtime.status, "not-run");
  assert.equal(intervening.portable, false);
  assert.equal(intervening.exact, false);
  assert.deepEqual(intervening.modifierStackIssues, [{
    modifierIndex: 1,
    modifierType: "BEVEL",
    modifierName: "Intervening Bevel",
    reason: "BEVEL between Geometry Nodes modifiers is not executed by GN-VM",
  }]);
  assert.equal(intervening.runtime.status, "not-run");
});
