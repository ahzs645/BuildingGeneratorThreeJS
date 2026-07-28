/**
 * Derive DNA flag bits and enum tables from Blender's own extraction.
 *
 * `src/blend/enums.ts` has to translate integers Blender only documents in C
 * headers. Rather than trusting a remembered constant, this script pairs raw
 * DNA values with the identifiers `tools/dump_blend.py` reports for the same
 * socket, node, and interface item, then solves for the mapping and prints any
 * value that is ambiguous or unseen.
 *
 * Usage:
 *   tsx tools/blend-calibrate-enums.ts <truth-dump-dir> <blend-dir>
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { decompressBlend } from "../src/blend/decompress";
import { readBlendFile, type BlendStruct } from "../src/blend/blend-file";

type Json = any;

const [truthDir, blendDir] = process.argv.slice(2);
if (!truthDir || !blendDir) {
  console.error("Usage: tsx tools/blend-calibrate-enums.ts <truth-dump-dir> <blend-dir>");
  process.exit(2);
}

/** Observations of one integer field paired with the identifier Blender shows. */
class EnumTable {
  readonly seen = new Map<number, Map<string, number>>();

  observe(value: number, identifier: string): void {
    const bucket = this.seen.get(value) ?? new Map<string, number>();
    bucket.set(identifier, (bucket.get(identifier) ?? 0) + 1);
    this.seen.set(value, bucket);
  }

  report(label: string): void {
    console.log(`\n${label}`);
    for (const [value, bucket] of [...this.seen].sort((a, b) => a[0] - b[0])) {
      const entries = [...bucket].sort((a, b) => b[1] - a[1]);
      const flag = entries.length > 1 ? "  AMBIGUOUS" : "";
      console.log(`  ${String(value).padStart(4)} -> ${entries.map(([name, count]) => `${name}(${count})`).join(" ")}${flag}`);
    }
  }
}

/** Observations of one integer field paired with a boolean Blender reports. */
class BitTable {
  private readonly onlyWhenTrue = new Set<number>(Array.from({ length: 32 }, (_, bit) => bit));
  private readonly neverWhenFalse = new Set<number>(Array.from({ length: 32 }, (_, bit) => bit));
  private trueCount = 0;
  private falseCount = 0;

  observe(flags: number, value: boolean): void {
    if (value) {
      this.trueCount += 1;
      for (const bit of [...this.onlyWhenTrue]) if ((flags & (1 << bit)) === 0) this.onlyWhenTrue.delete(bit);
    } else {
      this.falseCount += 1;
      for (const bit of [...this.neverWhenFalse]) if ((flags & (1 << bit)) !== 0) this.neverWhenFalse.delete(bit);
    }
  }

  report(label: string): void {
    const candidates = [...this.onlyWhenTrue].filter((bit) => this.neverWhenFalse.has(bit));
    console.log(
      `\n${label}: true=${this.trueCount} false=${this.falseCount} -> `
      + (candidates.length
        ? candidates.map((bit) => `1 << ${bit} (${1 << bit})`).join(" or ")
        : "no single bit explains the observations"),
    );
  }
}

const displayShape = new EnumTable();
const interfaceSubtype = new EnumTable();
const objectType = new EnumTable();
const modifierType = new EnumTable();
const socketHidden = new BitTable();
const socketHideValue = new BitTable();
const socketEnabled = new BitTable();
const nodeHidden = new BitTable();
const nodeMuted = new BitTable();
const nodeCustomColor = new BitTable();
const linkMuted = new BitTable();
const interfaceInput = new BitTable();
const interfaceHideValue = new BitTable();
const interfaceHideInModifier = new BitTable();
const panelDefaultClosed = new BitTable();
const objectVisible = new BitTable();
const modifierViewport = new BitTable();
const modifierRender = new BitTable();

const truthFiles = (await readdir(resolve(truthDir))).filter((name) => name.endsWith(".truth.json"));

for (const truthName of truthFiles) {
  const stem = truthName.replace(/\.truth\.json$/, "");
  const blendPath = join(resolve(blendDir), `${stem}.blend`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(blendPath));
  } catch {
    continue;
  }
  const truth: Json = JSON.parse(await readFile(join(resolve(truthDir), truthName), "utf8"));
  const { bytes: raw } = await decompressBlend(bytes);
  const file = readBlendFile(raw);
  const idName = (struct: BlendStruct | null): string => struct?.child("id")?.string("name").slice(2) ?? "";

  const trees: { truth: Json; dna: BlendStruct }[] = [];
  for (const block of file.idBlocks("NT")) {
    const tree = file.structOf(block);
    if (!tree) continue;
    const name = idName(tree);
    const source = truth.node_groups?.[name] ?? truth.shader_node_groups?.[name];
    if (source) trees.push({ truth: source, dna: tree });
  }
  for (const block of file.idBlocks("MA")) {
    const material = file.structOf(block);
    const tree = material?.follow("nodetree");
    const source = truth.materials?.[idName(material)];
    if (tree && source) trees.push({ truth: source, dna: tree });
  }

  for (const { truth: truthTree, dna } of trees) {
    const truthNodes = new Map<string, Json>((truthTree.nodes ?? []).map((node: Json) => [node.name, node]));
    for (const node of dna.list("nodes")) {
      const truthNode = truthNodes.get(node.string("name"));
      if (!truthNode) continue;
      const flag = node.number("flag");
      nodeHidden.observe(flag, Boolean(truthNode.ui?.hide));
      nodeMuted.observe(flag, Boolean(truthNode.ui?.mute));
      nodeCustomColor.observe(flag, Boolean(truthNode.ui?.use_custom_color));
      const walk = (kind: "inputs" | "outputs"): void => {
        node.list(kind).forEach((socket, index) => {
          const truthSocket = truthNode[kind]?.[index];
          if (!truthSocket || truthSocket.identifier !== socket.string("identifier")) return;
          const socketFlag = socket.number("flag");
          socketHidden.observe(socketFlag, Boolean(truthSocket.hide));
          socketHideValue.observe(socketFlag, Boolean(truthSocket.hide_value));
          socketEnabled.observe(socketFlag, !truthSocket.enabled);
          displayShape.observe(socket.number("display_shape"), String(truthSocket.display_shape));
        });
      };
      walk("inputs");
      walk("outputs");
    }

    const truthLinks: Json[] = truthTree.links ?? [];
    const dnaLinks = dna.list("links");
    if (truthLinks.length === dnaLinks.length) {
      dnaLinks.forEach((link, index) => linkMuted.observe(link.number("flag"), Boolean(truthLinks[index]?.muted)));
    }

    // Interface items, in the same depth-first order the extractor walks.
    const truthInterface: Json[] = truthTree.interface ?? [];
    const items: BlendStruct[] = [];
    const walkPanel = (panel: BlendStruct, depth: number): void => {
      if (depth > 32) return;
      for (const address of file.pointersAt(panel.pointer("items_array"), panel.number("items_num"))) {
        const item = file.structAt(address);
        if (!item) continue;
        items.push(item);
        if (item.type === "bNodeTreeInterfacePanel") walkPanel(item, depth + 1);
      }
    };
    const root = dna.child("tree_interface")?.child("root_panel");
    if (root) walkPanel(root, 0);
    if (items.length === truthInterface.length) {
      items.forEach((item, index) => {
        const source = truthInterface[index];
        const flag = item.number("flag");
        if (item.type === "bNodeTreeInterfacePanel") {
          panelDefaultClosed.observe(flag, Boolean(source.default_closed));
          return;
        }
        interfaceInput.observe(flag, source.in_out === "INPUT");
        interfaceHideValue.observe(flag, Boolean(source.hide_value));
        interfaceHideInModifier.observe(flag, Boolean(source.hide_in_modifier));
        const data = item.follow("socket_data");
        if (data?.has("subtype") && typeof source.subtype === "string") {
          interfaceSubtype.observe(data.number("subtype"), source.subtype);
        }
      });
    }
  }

  const truthObjects = new Map<string, Json>((truth.objects ?? []).map((object: Json) => [object.name, object]));
  for (const block of file.idBlocks("OB")) {
    const object = file.structOf(block);
    if (!object) continue;
    const source = truthObjects.get(idName(object));
    if (!source) continue;
    objectType.observe(object.number("type"), String(source.type));
    objectVisible.observe(object.number("restrictflag"), !source.visible);
    const modifiers = object.list("modifiers");
    const truthModifiers: Json[] = source.modifiers ?? [];
    if (modifiers.length !== truthModifiers.length) continue;
    modifiers.forEach((modifier, index) => {
      modifierType.observe(modifier.number("type"), String(truthModifiers[index].type));
      modifierViewport.observe(modifier.number("mode"), Boolean(truthModifiers[index].show_viewport));
      modifierRender.observe(modifier.number("mode"), Boolean(truthModifiers[index].show_render));
    });
  }
  console.log(`calibrated against ${basename(blendPath)}`);
}

displayShape.report("bNodeSocket.display_shape");
interfaceSubtype.report("bNodeSocketValue*.subtype (interface)");
objectType.report("Object.type");
modifierType.report("ModifierData.type");
socketHidden.report("bNodeSocket.flag -> hide");
socketHideValue.report("bNodeSocket.flag -> hide_value");
socketEnabled.report("bNodeSocket.flag -> unavailable");
nodeHidden.report("bNode.flag -> hide");
nodeMuted.report("bNode.flag -> mute");
nodeCustomColor.report("bNode.flag -> use_custom_color");
linkMuted.report("bNodeLink.flag -> muted");
interfaceInput.report("interface flag -> INPUT");
interfaceHideValue.report("interface flag -> hide_value");
interfaceHideInModifier.report("interface flag -> hide_in_modifier");
panelDefaultClosed.report("panel flag -> default_closed");
objectVisible.report("Object.restrictflag -> hidden in render");
modifierViewport.report("ModifierData.mode -> show_viewport");
modifierRender.report("ModifierData.mode -> show_render");
