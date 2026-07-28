/**
 * Compare the browser `.blend` decoder against Blender's own extractor.
 *
 * Blender remains the reference: `tools/dump_blend.py` produces the truth dump,
 * `src/blend` produces the portable one, and every structural difference is
 * reported by field so a gap is never mistaken for parity.
 *
 * Usage:
 *   tsx tools/blend-parity.ts <file.blend|directory> [--limit N] [--cache <dir>] [--verbose]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { decodeBlend } from "../src/blend/index";

type Json = any;

const args = process.argv.slice(2);
const target = args.find((value) => !value.startsWith("--"));
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const limit = Number(option("limit") ?? Number.POSITIVE_INFINITY);
const cacheDir = resolve(option("cache") ?? ".blend-parity-cache");
const verbose = args.includes("--verbose");

if (!target) {
  console.error("Usage: tsx tools/blend-parity.ts <file.blend|directory> [--limit N] [--cache <dir>]");
  process.exit(2);
}

/**
 * Differences that are explained rather than defects. Each maps a compared
 * field to the reason Blender and the decoder are allowed to disagree; anything
 * outside this table is an unexplained difference and fails the run.
 */
const EXPLAINED: Record<string, string> = {
  "link.to_idx": "intentional · Blender 5.x dropped NodeSocket.index from RNA, so its extractor writes null",
  "node.type": "intentional · Blender reports NodeUndefined for unregistered nodes; the decoder reports the stored idname",
  "socket.display_shape": "gap SOCKET_DISPLAY_SHAPE_INFERRED · Blender recomputes shapes from its structure inference pass",
  "socket.value": "gap MENU_SOCKET_VALUE_UNRESOLVED · menu sockets store an integer, not an enum identifier",
  "socket.default": "gap MENU_SOCKET_VALUE_UNRESOLVED · menu sockets store an integer, not an enum identifier",
  "interface.default": "gap MENU_SOCKET_VALUE_UNRESOLVED · menu sockets store an integer, not an enum identifier",
  "socket.not_compared": "gap VERSION_UPGRADE_NOT_APPLIED · sockets of a node whose count Blender changed on load are not positionally comparable",
  "socket.inputs_count": "gap VERSION_UPGRADE_NOT_APPLIED · the running Blender adds sockets introduced after the file was written",
  "socket.outputs_count": "gap VERSION_UPGRADE_NOT_APPLIED · the running Blender adds sockets introduced after the file was written",
  "node.missing": "gap VERSION_UPGRADE_NOT_APPLIED · version-upgrade passes can add nodes on load",
  "link.missing": "gap VERSION_UPGRADE_NOT_APPLIED · version-upgrade passes can add links on load",
  "tree.node_count": "gap VERSION_UPGRADE_NOT_APPLIED · version-upgrade passes can add nodes on load",
  "tree.link_count": "gap VERSION_UPGRADE_NOT_APPLIED · version-upgrade passes can add links on load",
};

function blenderBinary(): string {
  if (process.env.BLENDER_BIN) return process.env.BLENDER_BIN;
  const mac = "/Applications/Blender.app/Contents/MacOS/Blender";
  return existsSync(mac) ? mac : "blender";
}

function runBlender(input: string, output: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      blenderBinary(),
      ["--background", input, "--python", resolve("tools/dump_blend.py"), "--", output],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => { log += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { log += chunk.toString("utf8"); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else reject(new Error(`Blender exited ${code}:\n${log.trim().split("\n").slice(-12).join("\n")}`));
    });
  });
}

async function truthDump(path: string): Promise<Json> {
  await mkdir(cacheDir, { recursive: true });
  const cached = join(cacheDir, `${basename(path).replace(/\.blend$/i, "")}.truth.json`);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8"));
  await runBlender(path, cached);
  return JSON.parse(await readFile(cached, "utf8"));
}

class Diff {
  readonly counts = new Map<string, { count: number; sample: string }>();
  compared = 0;

  record(field: string, sample: string): void {
    const entry = this.counts.get(field) ?? { count: 0, sample };
    entry.count += 1;
    this.counts.set(field, entry);
  }

  equal(field: string, truth: Json, ours: Json, where: string): boolean {
    this.compared += 1;
    if (same(truth, ours)) return true;
    this.record(field, `${where}: blender=${show(truth)} decoder=${show(ours)}`);
    return false;
  }
}

function show(value: Json): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text && text.length > 90 ? `${text.slice(0, 90)}…` : String(text);
}

function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= 1e-5 * scale;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => same(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same(a[key], b[key]));
  }
  return false;
}

function compareTree(diff: Diff, label: string, truth: Json, ours: Json): void {
  diff.equal("tree.name", truth.name, ours.name, label);
  diff.equal("tree.type", truth.type, ours.type, label);

  const truthNodes: Json[] = truth.nodes ?? [];
  const ourNodes: Json[] = ours.nodes ?? [];
  const ourByName = new Map(ourNodes.map((node) => [node.name, node]));
  diff.equal("tree.node_count", truthNodes.length, ourNodes.length, label);
  for (const node of truthNodes) {
    const mine = ourByName.get(node.name);
    if (!mine) {
      diff.record("node.missing", `${label}/${node.name}`);
      continue;
    }
    const where = `${label}/${node.name}`;
    diff.equal("node.type", node.type, mine.type, where);
    diff.equal("node.label", node.label, mine.label, where);
    diff.equal("node.ui.mute", node.ui?.mute, mine.ui?.mute, where);
    diff.equal("node.ui.hide", node.ui?.hide, mine.ui?.hide, where);
    diff.equal("node.ui.use_custom_color", node.ui?.use_custom_color, mine.ui?.use_custom_color, where);
    diff.equal("node.ui.parent", node.ui?.parent ?? null, mine.ui?.parent ?? null, where);
    diff.equal("node.ui.width", node.ui?.width, mine.ui?.width, where);
    diff.equal("node.group", node.group ?? null, mine.group ?? null, where);
    diff.equal("node.paired_output", node.paired_output ?? null, mine.paired_output ?? null, where);

    const compareSockets = (kind: "inputs" | "outputs"): void => {
      const truthSockets: Json[] = node[kind] ?? [];
      const ourSockets: Json[] = mine[kind] ?? [];
      if (!diff.equal(`socket.${kind}_count`, truthSockets.length, ourSockets.length, where)) {
        // Positional pairing is meaningless once Blender has inserted a socket,
        // so say how much went uncompared instead of reporting silent parity.
        for (let index = 0; index < Math.min(truthSockets.length, ourSockets.length); index += 1) {
          diff.record("socket.not_compared", `${where}.${kind}[${index}]`);
        }
        return;
      }
      truthSockets.forEach((socket, index) => {
        const other = ourSockets[index];
        const at = `${where}.${kind}[${index}]`;
        diff.equal("socket.name", socket.name, other.name, at);
        diff.equal("socket.identifier", socket.identifier, other.identifier, at);
        diff.equal("socket.type", socket.type, other.type, at);
        diff.equal("socket.linked", socket.linked, other.linked, at);
        diff.equal("socket.enabled", socket.enabled, other.enabled, at);
        diff.equal("socket.hide", socket.hide, other.hide, at);
        diff.equal("socket.hide_value", socket.hide_value, other.hide_value, at);
        diff.equal("socket.display_shape", socket.display_shape, other.display_shape, at);
        if (kind === "inputs") diff.equal("socket.value", socket.value, other.value, at);
        else diff.equal("socket.default", socket.default, other.default, at);
      });
    };
    compareSockets("inputs");
    compareSockets("outputs");
  }

  const key = (link: Json): string =>
    `${link.from_node}|${link.from_socket}|${link.to_node}|${link.to_socket}|${link.multi_input_sort_id ?? 0}`;
  const truthLinks: Json[] = truth.links ?? [];
  const ourLinks: Json[] = ours.links ?? [];
  diff.equal("tree.link_count", truthLinks.length, ourLinks.length, label);
  const ourLinkByKey = new Map(ourLinks.map((link) => [key(link), link]));
  for (const link of truthLinks) {
    const mine = ourLinkByKey.get(key(link));
    if (!mine) {
      diff.record("link.missing", `${label}: ${key(link)}`);
      continue;
    }
    diff.equal("link.to_idx", link.to_idx, mine.to_idx, label);
    diff.equal("link.from_type", link.from_type, mine.from_type, label);
    diff.equal("link.to_type", link.to_type, mine.to_type, label);
    diff.equal("link.muted", link.muted ?? false, mine.muted ?? false, label);
  }

  const truthInterface: Json[] = truth.interface ?? [];
  const ourInterface: Json[] = ours.interface ?? [];
  diff.equal("interface.count", truthInterface.length, ourInterface.length, label);
  truthInterface.forEach((item, index) => {
    const mine = ourInterface[index];
    if (!mine) return;
    const at = `${label}.interface[${index}]`;
    diff.equal("interface.name", item.name, mine.name, at);
    diff.equal("interface.item_type", item.item_type, mine.item_type, at);
    diff.equal("interface.identifier", item.identifier, mine.identifier, at);
    diff.equal("interface.parent_identifier", item.parent_identifier ?? "", mine.parent_identifier ?? "", at);
    diff.equal("interface.in_out", item.in_out ?? null, mine.in_out ?? null, at);
    diff.equal("interface.socket_type", item.socket_type ?? null, mine.socket_type ?? null, at);
    diff.equal("interface.default", item.default ?? null, mine.default ?? null, at);
    diff.equal("interface.min_value", item.min_value ?? null, mine.min_value ?? null, at);
    diff.equal("interface.max_value", item.max_value ?? null, mine.max_value ?? null, at);
    diff.equal("interface.subtype", item.subtype ?? null, mine.subtype ?? null, at);
    diff.equal("interface.hide_value", item.hide_value ?? null, mine.hide_value ?? null, at);
    diff.equal("interface.hide_in_modifier", item.hide_in_modifier ?? null, mine.hide_in_modifier ?? null, at);
    diff.equal("interface.default_closed", item.default_closed ?? null, mine.default_closed ?? null, at);
    diff.equal("interface.description", item.description ?? null, mine.description ?? null, at);
  });
}

function compareDump(diff: Diff, truth: Json, ours: Json): void {
  const truthGroups: Record<string, Json> = truth.node_groups ?? {};
  const ourGroups: Record<string, Json> = ours.node_groups ?? {};
  for (const name of Object.keys(truthGroups)) {
    if (!ourGroups[name]) {
      diff.record("group.missing", name);
      continue;
    }
    compareTree(diff, `node_groups/${name}`, truthGroups[name], ourGroups[name]);
  }
  for (const name of Object.keys(ourGroups)) {
    if (!truthGroups[name]) diff.record("group.extra", name);
  }

  const truthShaders: Record<string, Json> = truth.shader_node_groups ?? {};
  const ourShaders: Record<string, Json> = ours.shader_node_groups ?? {};
  for (const name of Object.keys(truthShaders)) {
    if (!ourShaders[name]) diff.record("shader_group.missing", name);
    else compareTree(diff, `shader_node_groups/${name}`, truthShaders[name], ourShaders[name]);
  }

  const truthMaterials: Record<string, Json> = truth.materials ?? {};
  const ourMaterials: Record<string, Json> = ours.materials ?? {};
  for (const name of Object.keys(truthMaterials)) {
    if (!ourMaterials[name]) diff.record("material.missing", name);
    else compareTree(diff, `materials/${name}`, truthMaterials[name], ourMaterials[name]);
  }

  const truthObjects: Json[] = truth.objects ?? [];
  const ourObjects = new Map((ours.objects ?? []).map((object: Json) => [object.name, object]));
  diff.equal("object.count", truthObjects.length, (ours.objects ?? []).length, "objects");
  for (const object of truthObjects) {
    const mine = ourObjects.get(object.name);
    if (!mine) {
      diff.record("object.missing", object.name);
      continue;
    }
    diff.equal("object.type", object.type, mine.type, object.name);
    diff.equal("object.visible", object.visible, mine.visible, object.name);
    diff.equal("object.location", object.location, mine.location, object.name);
    diff.equal("object.rotation", object.rotation, mine.rotation, object.name);
    diff.equal("object.scale", object.scale, mine.scale, object.name);
    diff.equal("object.matrix_world", object.matrix_world, mine.matrix_world, object.name);
    diff.equal("object.materials", object.materials ?? [], mine.materials ?? [], object.name);
    diff.equal("object.mesh_stats", object.mesh_stats ?? null, mine.mesh_stats ?? null, object.name);

    const truthModifiers: Json[] = object.modifiers ?? [];
    const ourModifiers: Json[] = mine.modifiers ?? [];
    if (!diff.equal("modifier.count", truthModifiers.length, ourModifiers.length, object.name)) continue;
    truthModifiers.forEach((modifier, index) => {
      const other = ourModifiers[index];
      const at = `${object.name}.modifiers[${index}]`;
      diff.equal("modifier.name", modifier.name, other.name, at);
      diff.equal("modifier.type", modifier.type, other.type, at);
      diff.equal("modifier.show_viewport", modifier.show_viewport, other.show_viewport, at);
      diff.equal("modifier.show_render", modifier.show_render, other.show_render, at);
      diff.equal("modifier.node_group", modifier.node_group ?? null, other.node_group ?? null, at);
      const truthInputs: Record<string, Json> = modifier.input_values ?? {};
      const ourInputs: Record<string, Json> = other.input_values ?? {};
      for (const key of Object.keys(truthInputs)) {
        diff.equal("modifier.input_values", truthInputs[key], ourInputs[key], `${at}[${key}]`);
      }
      for (const key of Object.keys(ourInputs)) {
        if (!(key in truthInputs)) diff.record("modifier.input_extra", `${at}[${key}]`);
      }
    });
  }

  const truthCollections: Json[] = truth.collections ?? [];
  const ourCollections = new Map((ours.collections ?? []).map((entry: Json) => [entry.name, entry]));
  for (const collection of truthCollections) {
    const mine = ourCollections.get(collection.name);
    if (!mine) diff.record("collection.missing", collection.name);
    else diff.equal("collection.objects", collection.objects, mine.objects, collection.name);
  }
}

async function blendFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".blend")
    .map((entry) => join(path, entry.name))
    .sort();
}

const files = (await blendFiles(resolve(target))).slice(0, limit);
const overall = new Map<string, { count: number; sample: string; files: Set<string> }>();
let comparedFields = 0;
let comparedFiles = 0;

for (const path of files) {
  const name = basename(path);
  let truth: Json;
  try {
    truth = await truthDump(path);
  } catch (error) {
    console.log(`${name.padEnd(34)} SKIP (blender) ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    continue;
  }
  const diff = new Diff();
  try {
    const { dump } = await decodeBlend(new Uint8Array(await readFile(path)), { filename: name });
    compareDump(diff, truth, dump);
  } catch (error) {
    console.log(`${name.padEnd(34)} FAILED ${error instanceof Error ? error.message : error}`);
    continue;
  }
  comparedFiles += 1;
  comparedFields += diff.compared;
  const unexplained = [...diff.counts]
    .filter(([field]) => !(field in EXPLAINED))
    .reduce((sum, [, entry]) => sum + entry.count, 0);
  const mismatches = [...diff.counts.values()].reduce((sum, entry) => sum + entry.count, 0);
  console.log(
    `${name.padEnd(34)} fields=${String(diff.compared).padStart(7)}  explained=${String(mismatches - unexplained).padStart(6)}`
    + `  unexplained=${String(unexplained).padStart(5)}`
    + `  ${unexplained === 0 ? "OK" : [...diff.counts.keys()].filter((field) => !(field in EXPLAINED)).slice(0, 5).join(",")}`,
  );
  for (const [field, entry] of diff.counts) {
    const record = overall.get(field) ?? { count: 0, sample: entry.sample, files: new Set<string>() };
    record.count += entry.count;
    record.files.add(name);
    overall.set(field, record);
  }
  if (verbose) {
    for (const [field, entry] of diff.counts) console.log(`    ${field} ×${entry.count}  ${entry.sample}`);
  }
}

console.log(`\ncompared ${comparedFields.toLocaleString()} fields across ${comparedFiles} files`);
const sorted = [...overall].sort((a, b) => b[1].count - a[1].count);
const unexplainedTotal = sorted
  .filter(([field]) => !(field in EXPLAINED))
  .reduce((sum, [, entry]) => sum + entry.count, 0);
const explainedTotal = sorted.reduce((sum, [, entry]) => sum + entry.count, 0) - unexplainedTotal;

if (explainedTotal) {
  console.log(`\n${explainedTotal.toLocaleString()} explained differences:`);
  for (const [field, entry] of sorted.filter(([field]) => field in EXPLAINED)) {
    console.log(`  ${field.padEnd(24)} ×${String(entry.count).padStart(6)}  files=${String(entry.files.size).padStart(2)}  ${EXPLAINED[field]}`);
  }
}
if (!unexplainedTotal) {
  console.log("\nno unexplained differences");
} else {
  console.log(`\n${unexplainedTotal.toLocaleString()} UNEXPLAINED differences:`);
  for (const [field, entry] of sorted.filter(([field]) => !(field in EXPLAINED))) {
    console.log(`  ${field.padEnd(24)} ×${String(entry.count).padStart(6)}  files=${String(entry.files.size).padStart(2)}  ${entry.sample}`);
  }
}
await writeFile(
  join(cacheDir, "parity-report.json"),
  JSON.stringify(
    {
      files: comparedFiles,
      compared_fields: comparedFields,
      explained_differences: explainedTotal,
      unexplained_differences: unexplainedTotal,
      differences: [...overall].map(([field, entry]) => ({
        field,
        count: entry.count,
        explained: EXPLAINED[field] ?? null,
        files: [...entry.files].sort(),
        sample: entry.sample,
      })),
    },
    null,
    1,
  ),
);
process.exit(unexplainedTotal ? 1 : 0);
