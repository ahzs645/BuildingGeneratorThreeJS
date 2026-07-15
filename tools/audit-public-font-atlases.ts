/**
 * Audit reusable font-outline atlases published in public/dojo JSON files.
 *
 * By default, any atlas with at least 95 glyphs fails the audit unless its
 * normalized Blender font name appears in OPEN_FONT_ALLOWLIST below. A
 * trailing Blender datablock suffix such as `.001` is ignored for matching.
 *
 * Run:
 *   npx tsx tools/audit-public-font-atlases.ts
 *
 * Temporary inventory waiver:
 *   npx tsx tools/audit-public-font-atlases.ts \
 *     --temporary-waiver known-inventory-2026-07-14
 *
 * The waiver is intentionally narrow and expires. It never suppresses a
 * finding: every commercial/unknown atlas is still printed and counted, but
 * the process exits successfully so the current inventory can be measured
 * while remediation is underway. Do not extend or replace the waiver token
 * instead of removing or licensing the reported atlases.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REUSABLE_GLYPH_THRESHOLD = 95;
const TEMPORARY_WAIVER = {
  token: "known-inventory-2026-07-14",
  expiresAt: "2026-08-14T23:59:59-07:00",
  reason: "Inventory the reusable atlases already present while they are removed or relicensed.",
} as const;

type OpenFontPolicy = {
  license: string;
  evidence: string;
  source: string;
};

/**
 * Keep this table deliberately small. Add a font only after its exact source
 * and redistribution terms have been verified; name resemblance is not
 * evidence. Keys are Blender font datablock names without numeric suffixes.
 */
const OPEN_FONT_ALLOWLIST: Readonly<Record<string, OpenFontPolicy>> = {
  "DejaVu Sans ExtraLight": {
    license: "Bitstream Vera / Arev permissive font licenses",
    evidence: "public/dojo/fonts/LICENSE-DejaVu.txt",
    source: "https://dejavu-fonts.github.io/License.html",
  },
  "Dogica Regular": {
    license: "SIL Open Font License 1.1 (Reserved Font Name: Dogica)",
    evidence: "The recovered source OTF embeds the complete OFL 1.1 notice and Roberto Mocci copyright.",
    source: "https://www.dafont.com/dogica.font",
  },
  "Dogica Pixel Regular": {
    license: "SIL Open Font License 1.1 (Reserved Font Name: Dogica)",
    evidence: "Dogica's distributed family license covers its Pixel variant; preserve the OFL notice and reserved name rules.",
    source: "https://www.dafont.com/dogica.font",
  },
};

type FontAtlasShape = {
  glyphs?: unknown;
};

type AtlasFinding = {
  file: string;
  font: string;
  normalizedFont: string;
  glyphCount: number;
  policy?: OpenFontPolicy;
};

type AuditResult = {
  jsonFiles: number;
  filesWithFonts: number;
  fontEntries: number;
  reusableAtlases: AtlasFinding[];
  parseErrors: { file: string; message: string }[];
};

function usage(): string {
  return [
    "Usage: npx tsx tools/audit-public-font-atlases.ts [options]",
    "",
    "Options:",
    "  --temporary-waiver <token>  Keep reporting known violations but exit 0 until the waiver expires.",
    "  --help                      Show this help.",
    "",
    `Current temporary token: ${TEMPORARY_WAIVER.token}`,
    `Expires: ${TEMPORARY_WAIVER.expiresAt}`,
  ].join("\n");
}

function parseArgs(argv: string[]): { waiverToken?: string; help: boolean } {
  let waiverToken: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--temporary-waiver") {
      waiverToken = argv[++index];
      if (!waiverToken) throw new Error("--temporary-waiver requires a token");
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { waiverToken, help };
}

function normalizeBlenderFontName(name: string): string {
  return name.replace(/\.\d{3}$/, "");
}

async function jsonFilesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFilesUnder(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(absolute);
  }
  return files;
}

function glyphCount(atlas: FontAtlasShape): number {
  if (!atlas.glyphs || typeof atlas.glyphs !== "object" || Array.isArray(atlas.glyphs)) return 0;
  return Object.keys(atlas.glyphs as Record<string, unknown>).length;
}

async function audit(root: string): Promise<AuditResult> {
  const files = await jsonFilesUnder(root);
  const result: AuditResult = {
    jsonFiles: files.length,
    filesWithFonts: 0,
    fontEntries: 0,
    reusableAtlases: [],
    parseErrors: [],
  };

  for (const file of files) {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      result.parseErrors.push({
        file: path.relative(root, file),
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!document || typeof document !== "object" || Array.isArray(document)) continue;
    const fonts = (document as { fonts?: unknown }).fonts;
    if (!fonts || typeof fonts !== "object" || Array.isArray(fonts)) continue;

    const entries = Object.entries(fonts as Record<string, FontAtlasShape>);
    if (entries.length) result.filesWithFonts++;
    result.fontEntries += entries.length;
    for (const [font, atlas] of entries) {
      const count = glyphCount(atlas);
      if (count < REUSABLE_GLYPH_THRESHOLD) continue;
      const normalizedFont = normalizeBlenderFontName(font);
      result.reusableAtlases.push({
        file: path.relative(root, file),
        font,
        normalizedFont,
        glyphCount: count,
        policy: OPEN_FONT_ALLOWLIST[normalizedFont],
      });
    }
  }

  result.reusableAtlases.sort((left, right) =>
    left.file.localeCompare(right.file) || left.font.localeCompare(right.font));
  return result;
}

function validateWaiver(token: string | undefined): boolean {
  if (!token) return false;
  if (token !== TEMPORARY_WAIVER.token) throw new Error("temporary waiver token is not recognized");
  if (Date.now() > Date.parse(TEMPORARY_WAIVER.expiresAt)) {
    throw new Error(`temporary waiver expired at ${TEMPORARY_WAIVER.expiresAt}`);
  }
  return true;
}

function printAudit(root: string, result: AuditResult, waiverActive: boolean): number {
  const allowed = result.reusableAtlases.filter((finding) => finding.policy);
  const violations = result.reusableAtlases.filter((finding) => !finding.policy);

  console.log("Public font-atlas audit");
  console.log(`Root: ${root}`);
  console.log(`Reusable threshold: >= ${REUSABLE_GLYPH_THRESHOLD} glyphs`);
  console.log(`Scanned: ${result.jsonFiles} JSON files; ${result.filesWithFonts} files contain ${result.fontEntries} font entries`);
  console.log("");

  for (const finding of result.reusableAtlases) {
    if (finding.policy) {
      console.log(`OPEN       ${finding.file} :: ${finding.font} :: ${finding.glyphCount} glyphs`);
      console.log(`           ${finding.policy.license}`);
      console.log(`           evidence: ${finding.policy.evidence}`);
    } else {
      const marker = waiverActive ? "VIOLATION*" : "VIOLATION ";
      console.log(`${marker} ${finding.file} :: ${finding.font} :: ${finding.glyphCount} glyphs`);
      console.log("           commercial/unknown reusable atlas; remove, replace, subset under verified terms, or license it");
    }
  }

  for (const error of result.parseErrors) {
    console.error(`PARSE ERROR ${error.file} :: ${error.message}`);
  }

  console.log("");
  console.log(`Summary: ${result.reusableAtlases.length} reusable atlases; ${allowed.length} explicitly open; ${violations.length} commercial/unknown; ${result.parseErrors.length} parse errors`);
  if (waiverActive && violations.length) {
    console.log(`TEMPORARILY WAIVED: ${violations.length} violations remain visible above.`);
    console.log(`Waiver expires: ${TEMPORARY_WAIVER.expiresAt}`);
    console.log(`Reason: ${TEMPORARY_WAIVER.reason}`);
  }

  if (result.parseErrors.length) return 1;
  if (violations.length && !waiverActive) return 1;
  return 0;
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }

  let waiverActive: boolean;
  try {
    waiverActive = validateWaiver(options.waiverToken);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const publicDojoRoot = path.join(repositoryRoot, "public", "dojo");
  const result = await audit(publicDojoRoot);
  return printAudit(publicDojoRoot, result, waiverActive);
}

process.exitCode = await main();
